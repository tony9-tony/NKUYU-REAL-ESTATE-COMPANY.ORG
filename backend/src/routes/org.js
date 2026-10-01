import { Router } from "express";
import { query, queryOne, withTransaction } from "../db.js";
import { BUSINESS_PERMISSIONS, organizationId, permissionKeys, requirePermission, requireAdmin, requireModuleAccess, requireScope } from "../org/rbac.js";
import { addRecordShare, can, canAccessModule, canReadModule, isReadOnlyModule, clearAccessCache, currentAccess, isScope, isVisibility, listRecordShares, ownershipFields, removeRecordShare, scopeCondition } from "../org/access.js";
import { audit } from "../org/audit.js";
import { attentionCount } from "../tasks/tasks.js";
import { hashPassword, publicUser, revokeUserSessions } from "../auth.js";
import { isProduction } from "../security.js";
import { demoPasswordFor } from "../org/demoCredentials.js";
import { UNPAGED_LIMIT, paginatedList, paginationRequested, parsePagination, searchTerm } from "../pagination.js";
import { Project } from "../models/project.js";
import { Contract } from "../models/contract.js";
import { Debt } from "../models/debt.js";
import { Payment } from "../models/payment.js";
import { Reminder } from "../models/reminder.js";
import { Report } from "../models/report.js";
import { Appointment, Client, Document, Property } from "../models/catalog.js";
import { REPORT_TYPES, PAYMENT_METHODS, reportTypeIsFinancial } from "../models/reportTypes.js";
import { CONTRACT_ACTIONS, WORKFLOW_STAGES, WORKFLOW_EXCEPTIONS, availableActions, canTransition, workflowGraph, workflowStagePermissions } from "../contracts/workflow.js";
import { ROLE_DUTIES, CONTRACT_OWNERSHIP, ROLE_HOME_DEPARTMENT, TASK_HANDOFF, SYSTEM_PERMISSIONS, departmentDutyTree, checkRoleDuties, checkContractOwnership, checkNoSystemAdminLeak, checkDeadPermissions } from "../org/duties.js";
import taskRoutes from "./tasks.js";
import { EXISTING_CLIENT_SQL, findExistingClient } from "../org/clientMatch.js";
import { APPOINTMENT_TYPES, arrangeRequestAppointment } from "../org/requestAppointment.js";
import { cleanupUploadedFile, profileImageExtensions, profileUploadsDir, removeStoredFile, resolveStoredFile, uploadProfileImageFile, validateUploadedFile } from "../uploads.js";

const router = Router();

// The task-assignment workflow is additive and hangs off the organization router
// so it inherits the same session, access profile and audit plumbing. It
// authorizes itself per request and never reuses or weakens the contract
// workflow.
router.use("/tasks", taskRoutes);
// Same int4 ceiling as parseId() in ./api.js: these keys are all
// `INTEGER GENERATED ... AS IDENTITY`, so a larger number can never exist and
// would otherwise reach PostgreSQL and come back as a 500.
const MAX_INT4 = 2147483647;
const id = (value, field = "id") => { const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > MAX_INT4) { const e = new Error(`${field} must be a positive integer`); e.status = 400; throw e; } return n; };
const text = (value, field, max = 160) => { if (typeof value !== "string" || !value.trim() || value.trim().length > max) { const e = new Error(`${field} is required`); e.status = 400; throw e; } return value.trim(); };
const rank = (value, fallback = 0) => { const n = value === undefined || value === null || value === "" ? fallback : Number(value); if (!Number.isInteger(n) || n < 0 || n > 100) { const e = new Error("rank must be an integer between 0 and 100"); e.status = 400; throw e; } return n; };
const scope = (value, fallback = "own") => { const selected = value === undefined || value === null || value === "" ? fallback : String(value); if (!isScope(selected)) { const e = new Error("scope must be own, department or organization"); e.status = 400; throw e; } return selected; };
const rows = async (sql, values = []) => (await query(sql, values)).rows;

// ---------------------------------------------------------------------------
// Staff administration by duty.
//
// The administrator account may do anything below. A staff member whose role
// carries manage_users / manage_roles / manage_permissions (the ICT Officer)
// runs staff, departments and roles day to day, but can never lift anyone,
// themselves included, above their own standing:
//   * never assign, edit or reset an account ranked above them, or the admin account
//   * never change their own roles or deactivate themselves
//   * only change custom roles: built-in roles are rewritten from the duty
//     catalogue on every start, so an edit there would be silently lost anyway
//   * never grant a role the contract decision points or system administration
// ---------------------------------------------------------------------------
const USER_ROLES_JSON = "COALESCE((SELECT json_agg(json_build_object('id',r.id,'name',r.name,'rank',r.rank) ORDER BY r.rank DESC) FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id),'[]'::json)";
const USER_DEPARTMENTS_JSON = "COALESCE((SELECT json_agg(json_build_object('id',d.id,'name',d.name)) FROM user_departments ud JOIN departments d ON d.id=ud.department_id WHERE ud.user_id=u.id),'[]'::json)";
const RESERVED_ROLE_PERMISSIONS = new Set([...SYSTEM_PERMISSIONS, "view_audit", "approve_management", "approve_legal", "validate_finance"]);
const isAdminAccount = (req) => req.user?.role === "admin";
const callerRank = (req) => Number(req.access?.rank ?? 0);
const refuse = (message, status = 403) => { const e = new Error(message); e.status = status; throw e; };

/** Every role must exist, be active and, for a staff administrator, sit at or below their rank. */
async function assignableRoles(req, roleIds, org) {
  const found = await rows("SELECT id,name,rank FROM roles WHERE organization_id=$1 AND id=ANY($2::int[]) AND active=TRUE", [org, roleIds]);
  if (found.length !== roleIds.length) refuse("one or more selected roles are invalid", 400);
  if (!isAdminAccount(req)) {
    for (const role of found) {
      if (role.name === "System Administrator" || Number(role.rank) > callerRank(req)) refuse(`you cannot assign the "${role.name}" role: it is ranked above your own`);
    }
  }
  return found;
}

/** The account a staff administrator is about to change must not outrank them. */
async function guardTargetUser(req, userId, org, { allowSelf = true } = {}) {
  const target = await queryOne("SELECT u.id,u.email,u.role,COALESCE((SELECT MAX(r.rank) FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id),0)::int AS rank FROM users u WHERE u.id=$1 AND u.organization_id=$2", [userId, org]);
  if (!target) refuse("user not found", 404);
  if (isAdminAccount(req)) return target;
  if (!allowSelf && target.id === req.user.id) refuse("you cannot change your own access; ask the System Administrator");
  if (target.role === "admin" || target.rank > callerRank(req)) refuse("this account is ranked above your own");
  return target;
}

/** A staff administrator may only change custom roles at or below their rank that they do not hold. */
async function guardRoleChange(req, roleId, org) {
  const role = await queryOne("SELECT id,name,rank,system_role FROM roles WHERE id=$1 AND organization_id=$2", [roleId, org]);
  if (!role) refuse("role not found", 404);
  if (isAdminAccount(req)) return role;
  if (role.system_role) refuse(`"${role.name}" is a built-in role; its permissions come from the duty catalogue`);
  if (Number(role.rank) > callerRank(req)) refuse(`"${role.name}" is ranked above your own`);
  if (await queryOne("SELECT 1 FROM user_roles WHERE user_id=$1 AND role_id=$2", [req.user.id, roleId])) refuse("you cannot change a role you hold yourself");
  return role;
}

function guardRank(req, value) {
  if (!isAdminAccount(req) && value > callerRank(req)) refuse("a role cannot be ranked above your own");
  return value;
}
// Express 4 does not catch rejected promises from async middleware, so this
// wrapper must always funnel errors into next() or the process dies.
const requireAnyPermission = (...permissions) => async (req, res, next) => {
  try {
    if (req.access?.isAdmin) return next();
    const granted = await permissionKeys(req.user.id);
    if (!permissions.some((permission) => granted.includes(permission))) return res.status(403).json({ error: "permission denied" });
    next();
  } catch (error) { next(error); }
};

/**
 * Audit modules that describe the SYSTEM rather than the business.
 *
 * A `view_audit` holder (the ICTO) may read these to investigate access and
 * security incidents, but never the business trail. Declared here, before any
 * route that uses it, because the workspace route and /org/audit both filter on
 * it at request time.
 */
const AUDIT_SYSTEM_MODULES = [
  "auth", "user", "department", "role", "role_permissions", "settings", "backup",
  "contract_permissions", "allocation", "share", "approval",
];

// Record types that carry ownership metadata, used by the sharing endpoints.
// `module` is the permission key suffix used for module access.
const recordTables = {
  project: { table: "projects", module: "projects" },
  client: { table: "clients", module: "clients" },
  contract: { table: "contracts", module: "contracts" },
  property: { table: "properties", module: "properties" },
  appointment: { table: "appointments", module: "appointments" },
  document: { table: "documents", module: "documents" },
  debt: { table: "debts", module: "debts" },
  payment: { table: "payments", module: "payments" },
  // Reminders are a real module with their own access key and endpoint, so they
  // belong in the list or Finance never sees them in its workspace.
  //
  // `ownable: false` is load-bearing: a reminder has no owner_id/created_by/
  // department_id/visibility columns because it inherits the scope of the
  // installment (debt) it belongs to. It therefore cannot be allocated or shared
  // in its own right, and any query that assumed those columns would 500.
  reminder: { table: "reminders", module: "reminders", ownable: false },
  report: { table: "reports", module: "reports" },
  lead: { table: "leads", module: "leads" },
  follow_up: { table: "follow_ups", module: "follow_ups" },
};

/**
 * Resolve an entity name to its table and alias.
 *
 * Records without their own ownership columns (reminders inherit the scope of
 * the installment they belong to) cannot be allocated or shared, so they are
 * rejected here with a clear 400. Without this guard the ownership SQL would
 * reference columns that do not exist and surface as a 500.
 */
function recordTable(entity) {
  const entry = recordTables[entity];
  if (!entry) { const e = new Error("unknown record type"); e.status = 404; throw e; }
  if (entry.ownable === false) { const e = new Error(`${entity} records cannot be allocated or shared on their own`); e.status = 400; throw e; }
  return { table: entry.table, alias: entry.table.charAt(0) };
}

/** Authorization bootstrap payload: permissions, effective scope, allowed modules. */
async function buildMe(req) {
  const granted = req.access?.permissions || (await permissionKeys(req.user.id));
  // The System Administrator never carries business permissions (see rbac.js).
  const permissions = req.access?.isAdmin ? granted.filter((key) => !BUSINESS_PERMISSIONS.has(key)) : granted;
  // `modules` uses the same keys as the `access_<module>` permission keys.
  const modules = [...new Set(Object.entries(recordTables)
    .filter(([, entry]) => canReadModule(req.access, entry.module))
    .map(([, entry]) => entry.module))]
    .sort();
  // Modules the caller may look at but not change (e.g. Finance on properties).
  const readonlyModules = modules.filter((module) => isReadOnlyModule(req.access, module));
  return {
    organization_id: await organizationId(),
    permissions,
    financial: can(req.access, "view_financial"),
    scope: req.access?.scope || "own",
    rank: req.access?.rank ?? 0,
    modules,
    readonly_modules: readonlyModules,
    // The navigation attention badge. A real count computed from task rows the
    // caller is party to, not a decoration - it is 0 for a user with nothing
    // outstanding and never counts another department's private work.
    attention: await attentionCount(req.access),
    user: {
      ...await publicUser(req.user),
      profile_photo_url: req.user.photo_stored_name ? `/api/v1/org/users/${req.user.id}/photo` : null,
    },
  };
}

/**
 * Scoped row list for tables that do not have their own model module.
 *
 * `fragment` is the WHERE tail (filters only) and `orderBy` is the sort. They
 * are separate parameters because this helper appends `ORDER BY` itself: a
 * caller that passed a combined "AND ... ORDER BY ..." string produced two
 * ORDER BY clauses and a 500. `fragment` is deliberately the only place a
 * caller can add conditions.
 */
async function scopedList(table, alias, entity, fragment = "", orderBy = "") {
  const values = [await organizationId()];
  const visible = scopeCondition(alias, entity, currentAccess(), values);
  return rows(`SELECT ${alias}.* FROM ${table} ${alias} WHERE ${alias}.organization_id=$1 AND ${visible}${fragment ? ` AND ${fragment.replace(/^\s*AND\s+/i, "")}` : ""}${orderBy ? ` ORDER BY ${orderBy}` : ""}`, values);
}

/**
 * Paginated twin of `scopedList`, built with the same discipline: the record
 * scope and the caller's `fragment` are assembled ONCE into a single `where`
 * string, and both the page query and the count are built from it. A count
 * assembled separately would be free to drift from the filter and disclose how
 * many records the caller is not allowed to see.
 *
 * The `id` tiebreaker is appended so the ordering is total: without it two rows
 * sharing a `created_at` could swap between pages, showing a record twice and
 * hiding another.
 */
async function scopedListPaged(table, alias, entity, orderBy, search = null, searchColumns = []) {
  const values = [await organizationId()];
  const visible = scopeCondition(alias, entity, currentAccess(), values);
  const conditions = [`${alias}.organization_id=$1`, visible];
  // Server-side search inside the same scoped statement, so it can only narrow
  // the caller's own records.
  if (search && searchColumns.length) {
    values.push(`%${search}%`);
    const placeholder = `$${values.length}`;
    conditions.push(`(${searchColumns.map((column) => `COALESCE(${column},'') ILIKE ${placeholder}`).join(" OR ")})`);
  }
  const where = ` WHERE ${conditions.join(" AND ")}`;
  return {
    sql: `SELECT ${alias}.* FROM ${table} ${alias}${where} ORDER BY ${orderBy}, ${alias}.id DESC`,
    countSql: `SELECT COUNT(*)::int AS total FROM ${table} ${alias}${where}`,
    values,
  };
}

/**
 * The workflow steps this caller may take on this contract right now. Derived
 * server-side from the caller's own permissions, so the UI never has to guess
 * and a hidden button is also a request the API would refuse.
 */
function contractActionsFor(contract, req) {
  if (!contract?.status) return [];
  const names = req.access?.isAdmin
    ? Object.keys(CONTRACT_ACTIONS)
    : availableActions(contract.status, req.access?.permissions || []).map((entry) => entry.action);
  return names
    .filter((name) => canTransition(contract.status, name))
    .map((name) => ({ action: name, label: CONTRACT_ACTIONS[name].label, to: CONTRACT_ACTIONS[name].to }));
}

/** Organization/management counters, scoped and financially gated. */
async function dashboardMetrics(req) {
  const access = req.access;
  const count = async (table, alias, entity, extra = "") => {
    const values = [await organizationId()];
    const visible = scopeCondition(alias, entity, access, values);
    return Number((await queryOne(`SELECT COUNT(*) AS value FROM ${table} ${alias} WHERE ${alias}.organization_id=$1 AND ${visible}${extra}`, values)).value || 0);
  };
  const total = async (table, alias, entity, extra = "") => {
    const values = [await organizationId()];
    const visible = scopeCondition(alias, entity, access, values);
    return Number((await queryOne(`SELECT COALESCE(SUM(${alias}.amount),0) AS value FROM ${table} ${alias} WHERE ${alias}.organization_id=$1 AND ${visible}${extra}`, values)).value || 0);
  };
  const financial = can(access, "view_financial");
  return {
    financial,
    projects: await count("projects", "p", "project"),
    properties: await count("properties", "p", "property"),
    available_properties: await count("properties", "p", "property", " AND p.status='available'"),
    clients: await count("clients", "c", "client"),
    leads: await count("leads", "l", "lead", " AND l.status<>'converted'"),
    contracts: await count("contracts", "c", "contract"),
    follow_ups: await count("follow_ups", "f", "follow_up", " AND f.status='open'"),
    payments: financial ? await total("payments", "p", "payment") : null,
    outstanding: financial ? await total("debts", "d", "debt", " AND d.status <> 'paid'") : null,
    overdue: financial ? await total("debts", "d", "debt", " AND d.status <> 'paid' AND d.due_date<CURRENT_DATE") : null,
  };
}

/** Collections buckets used by the finance and administration panels. */
async function collections(req) {
  const access = req.access;
  const debts = (extra) => scopedList("debts", "d", "debt", `d.status<>'paid'${extra}`, "d.due_date");
  return {
    outstanding: await debts(""),
    overdue: await debts(" AND d.due_date<CURRENT_DATE"),
    due_soon: await debts(" AND d.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE+INTERVAL '14 days'"),
    follow_ups: await scopedList("follow_ups", "f", "follow_up", "f.status='open'", "f.due_at"),
  };
}

/**
 * Scoped, per-module row counts in ONE statement.
 *
 * These replace `array.length` in the dashboard. Once the workspace stops
 * shipping whole collections, a `.length` taken from a truncated page would
 * report "12 clients" when the caller may in fact read 12,000 - silently wrong
 * rather than obviously broken. Every count here is computed with the SAME
 * `scopeCondition` the matching list query uses, so a count can never exceed
 * what the caller is actually allowed to page through.
 *
 * One statement rather than nine so the dashboard does not fan out again.
 * A `NULL::int` column means "this module is not in scope for you" and is
 * deliberately different from 0, which means "in scope, and there are none".
 */
const COUNT_MODULES = [
  ["projects", "projects", "project", "p", "projects"],
  ["clients", "clients", "client", "c", "clients"],
  ["contracts", "contracts", "contract", "k", "contracts"],
  ["properties", "properties", "property", "pr", "properties"],
  ["appointments", "appointments", "appointment", "ap", "appointments"],
  ["documents", "documents", "document", "dc", "documents"],
  ["leads", "leads", "lead", "l", "leads"],
  ["follow_ups", "follow_ups", "follow_up", "f", "follow_ups"],
  // Financial registers are counted only for a caller who may see them, which
  // mirrors the gate the money lists themselves sit behind.
  ["debts", "debts", "debt", "d", "debts"],
  ["payments", "payments", "payment", "pm", "payments"],
];

async function scopedCounts({ financial, has }) {
  const access = currentAccess();
  const org = await organizationId();
  const counts = {};
  const columns = [];
  // `scopeCondition` APPENDS its own placeholders to the values array, so each
  // subquery needs its own array; numbering them all from one shared list would
  // make every subquery after the first read the first subquery's scope
  // parameters. Each is built and numbered independently, then the parameter
  // lists are concatenated in the same order as the columns.
  const allValues = [org];
  // `has` is the same module gate the lists sit behind. A module this caller
  // does not hold reports NULL ("you may not know about this"), never 0 and
  // never the organization's true total - the workspace must not tell Customer
  // Service how many contracts exist in the office.
  const held = typeof has === "function" ? has : () => true;
  COUNT_MODULES.forEach(([key, table, entity, alias, module]) => {
    if (((key === "debts" || key === "payments") && !financial) || !held(module)) {
      // Not merely zero: NULL says "you are not authorised to see this at all",
      // so the UI can hide the figure rather than imply the office has none.
      counts[key] = null;
      columns.push(`NULL::int AS ${key}`);
      return;
    }
    const values = [org];
    const scope = scopeCondition(alias, entity, access, values);
    // The subquery's own placeholders start at $2 ($1 is the organization id).
    // Shifting them past everything already collected lets the whole rollup be
    // one statement with one parameter list, in column order.
    const shift = allValues.length - 1;
    const body = `${table} ${alias} WHERE ${alias}.organization_id = $1 AND ${scope.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + shift}`)}`;
    columns.push(`(SELECT COUNT(*)::int FROM ${body}) AS ${key}`);
    allValues.push(...values.slice(1));
  });
  // A caller holding none of these modules gets only NULL columns, and a
  // statement with no placeholder must be sent no parameters - binding the
  // organization id anyway made PostgreSQL reject it and the whole workspace
  // (ICTO, IT support) failed to load with a 500.
  const usesParameters = columns.some((column) => column.includes("$"));
  const row = await queryOne(`SELECT ${columns.join(", ")}`, usesParameters ? allValues : []);
  for (const [key] of COUNT_MODULES) if (row[key] !== null && row[key] !== undefined) counts[key] = Number(row[key]);
  return counts;
}

/**
 * Authorization bootstrap. The frontend uses this to build navigation and
 * dashboards, so it also reports the effective scope and allowed modules.
 */
/**
 * One-call workspace bootstrap - the FIRST PAINT payload, not a data dump.
 *
 * The dashboard used to fire nine parallel requests and then received EVERY
 * contract, property, client, document, installment, payment, appointment, lead
 * and follow-up in one response - about 1.95 MB at a thousand rows per table.
 * That cost is paid on every workspace load, by every user, before anything can
 * be drawn, and it grew without limit as the office grew.
 *
 * What it returns now:
 *   - `me`, `summary`, `projectReports`  : the identity and the server-computed
 *     dashboard figures (unchanged, and already scope-aware).
 *   - `counts`                           : per-module SCOPED row counts, so the
 *     dashboard never derives a total from a truncated array.
 *   - `projects`                         : still complete. Projects are the
 *     spine of the app - every filter, selector and per-project rollup hangs off
 *     them - and the table is small by nature.
 *   - one bounded FIRST PAGE per list, plus `pages` metadata, so the first paint
 *     has real rows to draw. The remaining pages are fetched on demand from the
 *     already-paginated list endpoints, which is where searching now happens.
 *
 * Authorization is unchanged and still happens in SQL: each page goes through
 * the same `scopeCondition` as the matching list endpoint, and the counts use
 * the identical predicate. Nothing is fetched-then-filtered, and no count can
 * describe a record the caller may not read.
 *
 * The response is private to the caller (per-user), so it is marked no-store.
 */
const WORKSPACE_PAGE_SIZE = 50;

/** One bounded, scoped first page for a list module. */
function firstPage(build) {
  return paginatedList({ build, page: 1, pageSize: WORKSPACE_PAGE_SIZE, offset: 0, limit: WORKSPACE_PAGE_SIZE });
}

router.get("/workspace", async (req, res, next) => {
  try {
    const access = req.access;
    const financial = can(access, "view_financial");
    const admin = req.user?.role === "admin";
    const staffAdmin = can(access, "manage_users") || can(access, "manage_roles");
    const has = (module) => canReadModule(access, module);
    const org = await organizationId();
    const empty = { rows: [], pagination: { page: 1, page_size: WORKSPACE_PAGE_SIZE, total: 0, total_pages: 0, has_next: false, has_previous: false } };
    // A module the caller does not hold is reported as an EMPTY PAGE with total
    // 0, exactly as before - the module gate has not moved, only the shape of
    // what an empty module looks like.
    const gated = async (allowed, build) => (allowed ? firstPage(build) : empty);
    // Everything the dashboard needs is fetched concurrently in one round trip.
    // The heavy administration extras (organization counters and collections) are
    // deliberately left out: they are only used on the Administration screen and
    // would otherwise dominate the time-to-first-paint.
    const [projects, contractsPage, clientsPage, propertiesPage, appointmentsPage, documentsPage, debtsPage, paymentsPage, reminders, summary, projectReports, reportTypes, reportHistory, me, leadsPage, followUpsPage, counts, departments, roles, users, permissions, audit, approvals] = await Promise.all([
      has("projects") ? Project.all() : [],
      gated(has("contracts"), () => Contract.paged()),
      gated(has("clients"), () => Client.paged()),
      gated(has("properties"), () => Property.paged()),
      gated(has("appointments"), () => Appointment.paged()),
      gated(has("documents"), () => Document.paged()),
      gated(has("debts") && financial, () => Debt.paged()),
      gated(has("payments") && financial, () => Payment.paged()),
      has("reminders") && financial ? Reminder.due() : [],
      has("reports") ? Report.summary() : null,
      has("reports") ? Report.byProject() : [],
      has("reports") ? { types: REPORT_TYPES.filter((type) => financial || !reportTypeIsFinancial(type.id)), payment_methods: PAYMENT_METHODS, financial } : { types: [], payment_methods: [] },
      has("reports") ? Report.history({}) : [],
      buildMe(req),
      gated(has("leads"), () => scopedListPaged("leads", "l", "lead", "l.created_at DESC")),
      gated(has("follow_ups"), () => scopedListPaged("follow_ups", "f", "follow_up", "f.due_at")),
      scopedCounts({ financial, has }),
      // Staff administration data goes to whoever holds the duty for it (the
      // administrator account, or the ICT Officer), not only to the admin account.
      staffAdmin ? rows(`${DEPARTMENT_SELECT} WHERE d.organization_id=$1 ORDER BY d.name`, [org]).then((list) => list.map(withCore)) : [],
      staffAdmin ? rows("SELECT r.*, COALESCE((SELECT json_agg(p.permission_key ORDER BY p.permission_key) FROM role_permissions rpx JOIN permissions p ON p.id=rpx.permission_id WHERE rpx.role_id=r.id),'[]'::json) AS permissions FROM roles r WHERE r.organization_id=$1 ORDER BY r.rank DESC, r.name", [org]) : [],
      can(access, "manage_users") ? rows(`SELECT u.id,u.email,u.display_name,u.role,u.active,${USER_ROLES_JSON} AS roles,${USER_DEPARTMENTS_JSON} AS departments FROM users u WHERE u.organization_id=$1 ORDER BY u.display_name`, [org]) : [],
      can(access, "manage_permissions") ? rows("SELECT permission_key, label FROM permissions ORDER BY permission_key") : [],
      // The full audit trail is administrator-only. A `view_audit` holder such as
      // the ICTO receives only system/security events, never business activity.
      admin
        ? rows("SELECT a.*,u.display_name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.organization_id=$1 ORDER BY a.created_at DESC LIMIT 100", [org])
        : can(access, "view_audit")
          ? rows("SELECT a.id,a.action,a.module,a.record_id,a.created_at,u.display_name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.organization_id=$1 AND a.module=ANY($2::text[]) ORDER BY a.created_at DESC LIMIT 100", [org, [...AUDIT_SYSTEM_MODULES]])
          : [],
      can(access, "approve") ? rows("SELECT * FROM approvals WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100", [org]) : [],
    ]);
    // Payment-plan presence per contract, for callers who may see money only, so
    // the register can flag contracts Finance still has to plan. One grouped
    // query over the contracts already on this page.
    let planCounts = null;
    if (can(req.access, "view_financial") && contractsPage.rows.length) {
      const ids = contractsPage.rows.map((contract) => contract.id);
      const counted = await query("SELECT contract_id, COUNT(*)::int AS n FROM debts WHERE contract_id = ANY($1::int[]) GROUP BY contract_id", [ids]);
      planCounts = new Map(counted.rows.map((row) => [row.contract_id, row.n]));
    }
    res.set("Cache-Control", "private, no-store");
    res.json({
      me,
      projects, reminders,
      // One bounded first page per list. The keys are unchanged, so the
      // frontend's `payload.X || []` contract still holds; what changed is that
      // an array is now a PAGE, not the whole table.
      //
      // Contracts carry their own available_actions, computed per caller, so the
      // Legal desk shows review buttons a Sales officer will never see. Applied
      // to the page rather than to a separate key, so the contract register keeps
      // working exactly as it did when the array was complete.
      contracts: contractsPage.rows.map((contract) => ({ ...contract, available_actions: contractActionsFor(contract, req), ...(planCounts ? { installments_recorded: planCounts.get(contract.id) || 0 } : {}) })),
      clients: clientsPage.rows,
      properties: propertiesPage.rows,
      appointments: appointmentsPage.rows,
      documents: documentsPage.rows,
      debts: debtsPage.rows,
      payments: paymentsPage.rows,
      leads: leadsPage.rows,
      followUps: followUpsPage.rows,
      pages: {
        contracts: contractsPage.pagination,
        clients: clientsPage.pagination,
        properties: propertiesPage.pagination,
        appointments: appointmentsPage.pagination,
        documents: documentsPage.pagination,
        debts: debtsPage.pagination,
        payments: paymentsPage.pagination,
        leads: leadsPage.pagination,
        followUps: followUpsPage.pagination,
      },
      // Scoped totals. The dashboard reads these rather than `array.length`,
      // which would now be a page size rather than a record count.
      counts,
      summary, projectReports, reportTypes, reportHistory,
      admin: { departments, roles, users, permissions, audit, approvals, dashboard: null, collections: null },
    });
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// Profile photo (every member) and signature (Legal only).
//
// Each person manages only their OWN photo and signature: the routes act on
// the session user and take no user id, so nobody can replace another
// person's picture. Photos may be viewed by any signed-in colleague; a
// signature image is only ever returned to its owner (for preview) and
// otherwise only leaves the server embedded in a signed contract.
// ---------------------------------------------------------------------------
function profileUploadHandler(kind) {
  const nameColumn = kind === "photo" ? "photo_stored_name" : "signature_stored_name";
  const mimeColumn = kind === "photo" ? "photo_mime" : "signature_mime";
  return async (req, res, next) => {
    try {
      if (kind === "signature" && !can(req.access, "approve_legal")) {
        cleanupUploadedFile(req.file);
        return res.status(403).json({ error: "only members of Legal who approve contracts can upload a signature" });
      }
      let fileInfo;
      try { fileInfo = validateUploadedFile(req.file, profileImageExtensions); }
      catch (error) { cleanupUploadedFile(req.file); if (!error.status) { console.error("upload failed:", error?.stack || error); return res.status(400).json({ error: "the file could not be saved" }); } return res.status(error.status).json({ error: error.message }); }
      const previous = await queryOne(`SELECT ${nameColumn} AS stored FROM users WHERE id=$1`, [req.user.id]);
      const title = kind === "signature" && typeof req.body?.signature_title === "string" ? req.body.signature_title.trim().slice(0, 120) || null : undefined;
      await query(
        `UPDATE users SET ${nameColumn}=$1, ${mimeColumn}=$2${title !== undefined ? ", signature_title=$4" : ""} WHERE id=$3`,
        title !== undefined ? [fileInfo.storedName, fileInfo.mimeType, req.user.id, title] : [fileInfo.storedName, fileInfo.mimeType, req.user.id],
      );
      if (previous?.stored && previous.stored !== fileInfo.storedName) removeStoredFile(profileUploadsDir, previous.stored);
      await audit(req, `${kind}_uploaded`, "user", req.user.id, {});
      res.status(201).json({ ok: true, [`has_${kind}`]: true });
    } catch (error) { next(error); }
  };
}

function profileDeleteHandler(kind) {
  const nameColumn = kind === "photo" ? "photo_stored_name" : "signature_stored_name";
  const mimeColumn = kind === "photo" ? "photo_mime" : "signature_mime";
  return async (req, res, next) => {
    try {
      const previous = await queryOne(`SELECT ${nameColumn} AS stored FROM users WHERE id=$1`, [req.user.id]);
      await query(`UPDATE users SET ${nameColumn}=NULL, ${mimeColumn}=NULL WHERE id=$1`, [req.user.id]);
      // A signature already embedded in signed contracts stays in those
      // documents; only the stored image used for future signing is removed.
      if (previous?.stored) removeStoredFile(profileUploadsDir, previous.stored);
      await audit(req, `${kind}_removed`, "user", req.user.id, {});
      res.json({ ok: true, [`has_${kind}`]: false });
    } catch (error) { next(error); }
  };
}

function sendProfileImage(res, storedName, mime) {
  const file = resolveStoredFile(profileUploadsDir, storedName);
  if (!file) return res.status(404).json({ error: "no image" });
  res.setHeader("Content-Type", mime || "image/png");
  res.setHeader("Cache-Control", "private, max-age=300");
  return res.sendFile(file);
}

router.post("/me/photo", uploadProfileImageFile, profileUploadHandler("photo"));
router.delete("/me/photo", profileDeleteHandler("photo"));
router.post("/me/signature", uploadProfileImageFile, profileUploadHandler("signature"));
router.delete("/me/signature", profileDeleteHandler("signature"));
router.put("/me/signature-title", async (req, res, next) => {
  try {
    if (!can(req.access, "approve_legal")) return res.status(403).json({ error: "only members of Legal can set a signature title" });
    const title = typeof req.body?.signature_title === "string" ? req.body.signature_title.trim().slice(0, 120) || null : null;
    await query("UPDATE users SET signature_title=$1 WHERE id=$2", [title, req.user.id]);
    res.json({ ok: true, signature_title: title });
  } catch (error) { next(error); }
});
router.get("/me/signature", async (req, res, next) => {
  try {
    const row = await queryOne("SELECT signature_stored_name, signature_mime FROM users WHERE id=$1", [req.user.id]);
    return sendProfileImage(res, row?.signature_stored_name, row?.signature_mime);
  } catch (error) { next(error); }
});
router.get("/users/:id/photo", async (req, res, next) => {
  try {
    const row = await queryOne("SELECT photo_stored_name, photo_mime FROM users WHERE id=$1 AND organization_id=$2", [id(req.params.id, "user_id"), await organizationId()]);
    return sendProfileImage(res, row?.photo_stored_name, row?.photo_mime);
  } catch (error) { next(error); }
});

router.get("/me", async (req, res, next) => {
  try { res.json(await buildMe(req)); } catch (error) { next(error); }
});
// Departments: full CRUD for staff administration (MD, ICT, administrator).
//
// Core departments are named in the role design (ROLE_HOME_DEPARTMENT) and the
// hand-off rules (TASK_HANDOFF), so they cannot be renamed, deactivated or
// deleted - that would silently break who belongs where. A department that
// still has active staff cannot be deactivated or deleted either: its people
// would vanish from every department list. Names are unique (any case).
const CORE_DEPARTMENTS = new Set([...Object.values(ROLE_HOME_DEPARTMENT), ...Object.keys(TASK_HANDOFF), ...Object.values(TASK_HANDOFF).flat()]);
const departmentName = (value) => text(value, "name", 80).replace(/\s+/g, " ").trim().toUpperCase();
const httpError = (status, message) => { const e = new Error(message); e.status = status; return e; };
async function assertUniqueDepartment(org, name, exceptId = null) {
  const clash = await queryOne("SELECT id FROM departments WHERE organization_id=$1 AND UPPER(name)=$2 AND ($3::int IS NULL OR id<>$3)", [org, name, exceptId]);
  if (clash) throw httpError(409, `a department called "${name}" already exists`);
}
const DEPARTMENT_SELECT = `SELECT d.*,
  (SELECT COUNT(*) FROM user_departments ud JOIN users u ON u.id=ud.user_id WHERE ud.department_id=d.id AND u.active)::int AS active_members,
  (SELECT COUNT(*) FROM user_departments ud WHERE ud.department_id=d.id)::int AS all_members,
  (SELECT COUNT(*) FROM clients c WHERE c.department_id=d.id)::int AS client_count
  FROM departments d`;
const withCore = (row) => row && ({ ...row, core: CORE_DEPARTMENTS.has(row.name) });

router.get("/departments", requireAnyPermission("manage_users", "manage_roles"), async (req,res,next)=>{try{res.json((await rows(`${DEPARTMENT_SELECT} WHERE d.organization_id=$1 ORDER BY d.name`,[await organizationId()])).map(withCore));}catch(e){next(e);}});
router.post("/departments", requirePermission("manage_roles"), async (req,res,next)=>{try{
  const org=await organizationId();const name=departmentName(req.body?.name);await assertUniqueDepartment(org,name);
  const r=await queryOne("INSERT INTO departments (organization_id,name,description) VALUES ($1,$2,$3) RETURNING *",[org,name,req.body?.description||null]);
  clearAccessCache();await audit(req,"created","department",r.id,{name});res.status(201).json(withCore({...r,active_members:0,all_members:0}));
}catch(e){next(e);}});
router.put("/departments/:id", requirePermission("manage_roles"), async (req,res,next)=>{try{
  const org=await organizationId();const deptId=id(req.params.id,"department_id");
  const current=await queryOne(`${DEPARTMENT_SELECT} WHERE d.id=$1 AND d.organization_id=$2`,[deptId,org]);
  if(!current)return res.status(404).json({error:"department not found"});
  const name=req.body?.name!==undefined&&req.body?.name!==null&&req.body?.name!==""?departmentName(req.body.name):null;
  const active=req.body?.active===undefined?null:Boolean(req.body.active);
  const core=CORE_DEPARTMENTS.has(current.name);
  if(name&&name!==current.name){if(core)return res.status(409).json({error:`"${current.name}" is a core department and cannot be renamed`});await assertUniqueDepartment(org,name,deptId);}
  if(active===false&&current.active){
    if(core)return res.status(409).json({error:`"${current.name}" is a core department and cannot be deactivated`});
    if(current.active_members)return res.status(409).json({error:`move its ${current.active_members} active staff to another department first`});
  }
  const r=await queryOne("UPDATE departments SET name=COALESCE($1,name),description=COALESCE($2,description),active=COALESCE($3,active) WHERE id=$4 AND organization_id=$5 RETURNING *",[name,req.body?.description||null,active,deptId,org]);
  clearAccessCache();await audit(req,"updated","department",r.id,{name:r.name,active:r.active});res.json(withCore({...current,...r}));
}catch(e){next(e);}});
// Delete: only an empty, non-core department that no record points at. Any
// department that has been used is deactivated instead, to keep history whole.
router.delete("/departments/:id", requirePermission("manage_roles"), async (req,res,next)=>{try{
  const org=await organizationId();const deptId=id(req.params.id,"department_id");
  const current=await queryOne(`${DEPARTMENT_SELECT} WHERE d.id=$1 AND d.organization_id=$2`,[deptId,org]);
  if(!current)return res.status(404).json({error:"department not found"});
  if(CORE_DEPARTMENTS.has(current.name))return res.status(409).json({error:`"${current.name}" is a core department and cannot be deleted`});
  if(current.all_members)return res.status(409).json({error:`it still has ${current.all_members} staff member(s); move them first`});
  const tables=(await rows("SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='department_id' AND table_name<>'user_departments'")).map((row)=>row.table_name);
  for(const table of tables){const used=await queryOne(`SELECT 1 FROM "${table.replace(/"/g,"")}" WHERE department_id=$1 LIMIT 1`,[deptId]);if(used)return res.status(409).json({error:"records already belong to this department; deactivate it instead"});}
  await query("DELETE FROM departments WHERE id=$1 AND organization_id=$2",[deptId,org]);
  clearAccessCache();await audit(req,"deleted","department",deptId,{name:current.name});res.json({ok:true});
}catch(e){next(e);}});
router.get("/roles", requireAnyPermission("manage_users", "manage_roles"), async (req,res,next)=>{try{res.json(await rows("SELECT r.*,COUNT(rp.permission_id)::int AS permission_count,COALESCE((SELECT json_agg(p.permission_key ORDER BY p.permission_key) FROM role_permissions rpx JOIN permissions p ON p.id=rpx.permission_id WHERE rpx.role_id=r.id),'[]'::json) AS permissions FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id WHERE r.organization_id=$1 GROUP BY r.id ORDER BY r.rank DESC, r.name",[await organizationId()]));}catch(e){next(e);}});
router.post("/roles", requirePermission("manage_roles"), async (req,res,next)=>{try{const r=await queryOne("INSERT INTO roles (organization_id,name,description,rank,scope) VALUES ($1,$2,$3,$4,$5) RETURNING *",[await organizationId(),text(req.body?.name,"name"),req.body?.description||null,guardRank(req,rank(req.body?.rank)),scope(req.body?.scope)]);await audit(req,"created","role",r.id);res.status(201).json(r);}catch(e){next(e);}});
router.put("/roles/:id", requirePermission("manage_roles"), async (req,res,next)=>{try{await guardRoleChange(req,id(req.params.id,"role_id"),await organizationId());if(req.body?.rank!==undefined)guardRank(req,rank(req.body.rank));const r=await queryOne("UPDATE roles SET name=COALESCE($1,name),description=COALESCE($2,description),rank=COALESCE($3,rank),scope=COALESCE($4,scope),active=COALESCE($5,active) WHERE id=$6 AND organization_id=$7 RETURNING *",[req.body?.name||null,req.body?.description||null,req.body?.rank===undefined?null:rank(req.body.rank),req.body?.scope===undefined?null:scope(req.body.scope),req.body?.active===undefined?null:Boolean(req.body.active),id(req.params.id,"role_id"),await organizationId()]);if(!r)return res.status(404).json({error:"role not found"});clearAccessCache();await audit(req,"updated","role",r.id);res.json(r);}catch(e){next(e);}});
router.get("/permissions", requirePermission("manage_permissions"), async (req,res,next)=>{try{res.json(await rows("SELECT * FROM permissions ORDER BY permission_key"));}catch(e){next(e);}});

/**
 * The access matrix: Department -> Role -> Duty -> Permission -> Scope.
 * Administrator only, because it describes who can do what across the office.
 * The `audit` block runs the same bidirectional checks the test suite uses, so a
 * misconfigured role is visible in the API rather than only in a terminal.
 */
/**
 * The approval workflow and every duty on every department.
 *
 * Read-only reference data, open to any signed-in member: it describes the shape
 * of the organization and who owns which decision, and contains no business
 * record, no other person's data and no way to act. That is deliberately a
 * different posture from GET /org/access-matrix above, which stays
 * administrator-only because it reports which permissions each role really holds
 * and runs the misconfiguration audit.
 *
 * The caller's own permissions are echoed back so the UI can mark which stages
 * they personally decide - a highlight, never a grant. Authority still comes from
 * CONTRACT_ACTIONS on POST /contracts/:id/transition.
 */
router.get("/duties", async (req, res, next) => {
  try {
    const org = await organizationId();
    const permissionLabels = new Map(
      (await rows("SELECT permission_key, label FROM permissions ORDER BY permission_key")).map((row) => [row.permission_key, row.label]),
    );
    const held = req.access?.isAdmin ? null : new Set(await permissionKeys(req.user.id));
    const stagePermissions = workflowStagePermissions();
    const stages = WORKFLOW_STAGES.map((stage) => ({
      ...stage,
      // `yours` marks the step this caller can actually decide. It is derived
      // from the caller's own permission list and grants nothing.
      yours: held === null || (held.has(stage.permission) && (stagePermissions[stage.status] || []).every((key) => held.has(key))),
    }));
    res.set("Cache-Control", "private, no-store");
    res.json({
      departments: departmentDutyTree(permissionLabels).map((department) => ({
        ...department,
        roles: department.roles.map((entry) => ({
          ...entry,
          duties: entry.duties.map((duty) => ({ ...duty, yours: held === null || duty.permissions.every((key) => held.has(key)) })),
        })),
      })),
      workflow: { stages, exceptions: WORKFLOW_EXCEPTIONS, graph: workflowGraph(), ownership: CONTRACT_OWNERSHIP },
      totals: {
        departments: Object.keys(ROLE_HOME_DEPARTMENT).length ? new Set(Object.values(ROLE_HOME_DEPARTMENT)).size : 0,
        roles: Object.keys(ROLE_HOME_DEPARTMENT).length,
        duties: Object.values(ROLE_DUTIES).reduce((sum, duties) => sum + duties.length, 0),
      },
      // Which lifecycle permissions the caller personally holds. Read from their
      // own access profile; it is not derived from the duty catalogue.
      yourApprovals: [...(held || new Set())].filter((permission) => permission in CONTRACT_OWNERSHIP).sort(),
      organization_id: org,
    });
  } catch (error) { next(error); }
});

router.get("/access-matrix", requireAdmin(), async (req, res, next) => {
  try {
    const org = await organizationId();
    const roleRows = await rows(
      `SELECT r.id,r.name,r.description,r.rank,r.scope,
              COALESCE((SELECT json_agg(p.permission_key ORDER BY p.permission_key)
                          FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
                         WHERE rp.role_id=r.id),'[]'::json) AS permissions,
              COALESCE((SELECT json_agg(json_build_object('key',d.duty_key,'label',d.label,'description',d.description,
                        'permissions',COALESCE((SELECT json_agg(p.permission_key ORDER BY p.permission_key)
                                                  FROM duty_permissions dp JOIN permissions p ON p.id=dp.permission_id
                                                 WHERE dp.duty_id=d.id),'[]'::json))
                          ORDER BY d.sort_order)
                          FROM duties d WHERE d.role_id=r.id),'[]'::json) AS duties,
              COALESCE((SELECT json_agg(dep.name ORDER BY dep.name)
                          FROM (SELECT DISTINCT ud.department_id FROM user_roles ur JOIN user_departments ud ON ud.user_id=ur.user_id
                                 WHERE ur.role_id=r.id) x
                          JOIN departments dep ON dep.id=x.department_id),'[]'::json) AS staff_departments
         FROM roles r WHERE r.organization_id=$1 ORDER BY r.rank DESC, r.name`,
      [org],
    );
    // Ownership is policed against each role's designed home department, not
    // against whoever happens to hold the role today.
    const rolesByName = {};
    for (const role of roleRows) {
      rolesByName[role.name] = {
        name: role.name,
        department: ROLE_HOME_DEPARTMENT[role.name] || null,
        permissions: role.permissions || [],
      };
    }
    const unmapped = Object.values(rolesByName).filter((role) => !role.department).map((role) => role.name);
    const dutyProblems = [];
    for (const role of roleRows) {
      const result = checkRoleDuties(role.name, role.permissions || [], ROLE_DUTIES[role.name] || []);
      if (result.missingPermission.length || result.unjustifiedPermission.length) {
        dutyProblems.push({ role: role.name, ...result });
      }
    }
    res.json({
      departments: await rows("SELECT id,name,description,active FROM departments WHERE organization_id=$1 ORDER BY name", [org]),
      roles: roleRows,
      audit: {
        dutyProblems,
        contractOwnershipViolations: checkContractOwnership(rolesByName),
        systemAdminLeaks: checkNoSystemAdminLeak(rolesByName),
        deadPermissions: checkDeadPermissions(rolesByName),
        unmappedRoles: unmapped,
        contractOwnership: CONTRACT_OWNERSHIP,
      },
    });
  } catch (error) { next(error); }
});
router.put("/roles/:id/permissions", requirePermission("manage_permissions"), async (req,res,next)=>{try{const roleId=id(req.params.id,"role_id");await guardRoleChange(req,roleId,await organizationId());const keys=(Array.isArray(req.body?.permissions)?req.body.permissions:[]).map(String);if(!isAdminAccount(req)){const reserved=keys.filter((key)=>RESERVED_ROLE_PERMISSIONS.has(key));if(reserved.length)return res.status(403).json({error:`only the System Administrator can grant ${reserved.join(", ")}`});}await withTransaction(async(client)=>{await client.query("DELETE FROM role_permissions WHERE role_id=$1",[roleId]);for(const key of keys)await client.query("INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE permission_key=$2 ON CONFLICT DO NOTHING",[roleId,String(key)]);});clearAccessCache();await audit(req,"updated","role_permissions",roleId);res.json({ok:true});}catch(e){next(e);}});
router.get("/users", requirePermission("manage_users"), async (req,res,next)=>{try{const result=await rows(`SELECT u.id,u.email,u.display_name,u.role,u.active,u.created_at,${USER_ROLES_JSON} AS roles,${USER_DEPARTMENTS_JSON} AS departments FROM users u WHERE u.organization_id=$1 ORDER BY u.display_name`,[await organizationId()]);res.json(result);}catch(e){next(e);}});
router.post("/users", requirePermission("manage_users"), async (req,res,next)=>{try{const password=String(req.body?.password||"");if(password.length<8)return res.status(400).json({error:"password must be at least 8 characters"});if(isProduction()&&password===demoPasswordFor(String(req.body?.email||"").toLowerCase()))return res.status(400).json({error:"that password follows the published demo scheme; choose another"});const roleIds=[...new Set((Array.isArray(req.body?.role_ids)?req.body.role_ids:[]).map(Number))];let departmentIds=[...new Set((Array.isArray(req.body?.department_ids)?req.body.department_ids:[]).map(Number))].filter(Boolean);if(!roleIds.length)return res.status(400).json({error:"select at least one role for the staff member"});if(roleIds.some((roleId)=>!Number.isInteger(roleId)||roleId<1))return res.status(400).json({error:"one or more selected roles are invalid"});const org=await organizationId();await assignableRoles(req,roleIds,org);
    // Every staff member belongs to a department, or no department list would
    // ever show them. Without a choice, the role's home department is used.
    if(!departmentIds.length){const roleNames=await rows("SELECT name FROM roles WHERE id=ANY($1::int[]) AND organization_id=$2",[roleIds,org]);const homes=roleNames.map((row)=>ROLE_HOME_DEPARTMENT[row.name]).filter(Boolean);if(homes.length)departmentIds=(await rows("SELECT id FROM departments WHERE organization_id=$1 AND active AND name=ANY($2::text[])",[org,homes])).map((row)=>Number(row.id));}
    if(!departmentIds.length)return res.status(400).json({error:"choose a department for the staff member"});
    const liveDepartments=await rows("SELECT id FROM departments WHERE organization_id=$1 AND active AND id=ANY($2::int[])",[org,departmentIds]);
    if(liveDepartments.length!==departmentIds.length)return res.status(400).json({error:"one or more selected departments do not exist or are inactive"});const newEmail=text(req.body?.email,"email").toLowerCase();if(await queryOne("SELECT 1 FROM users WHERE LOWER(email)=$1",[newEmail]))return res.status(409).json({error:"a staff account with this email already exists"});const r=await queryOne("INSERT INTO users(organization_id,email,password_hash,display_name,role) VALUES($1,$2,$3,$4,'staff') RETURNING id,email,display_name,role,active,created_at",[org,text(req.body?.email,"email").toLowerCase(),hashPassword(password),text(req.body?.display_name,"display_name",80)]);for(const roleId of roleIds)await query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE id=$2 AND organization_id=$3",[r.id,id(roleId,"role_id"),org]);for(const departmentId of departmentIds)await query("INSERT INTO user_departments(user_id,department_id) SELECT $1,id FROM departments WHERE id=$2 AND organization_id=$3",[r.id,id(departmentId,"department_id"),org]);clearAccessCache();await audit(req,"created","user",r.id,{role_ids:roleIds});res.status(201).json(r);}catch(e){next(e);}});
router.put("/users/:id", requirePermission("manage_users"), async (req,res,next)=>{try{const userId=id(req.params.id,"user_id");const org=await organizationId();const target=await guardTargetUser(req,userId,org,{allowSelf:false});const r=await queryOne("UPDATE users SET display_name=COALESCE($1,display_name),active=COALESCE($2,active) WHERE id=$3 AND organization_id=$4 RETURNING id,email,display_name,role,active,created_at",[req.body?.display_name||null,req.body?.active===undefined?null:Boolean(req.body.active),userId,org]);
    // A password reset changes the credential and nothing else: the user id, role,
    // department, permissions and every owned record are untouched. Live sessions
    // are dropped so a token minted against the old password cannot outlive it.
    if(req.body?.password){if(String(req.body.password).length<8)return res.status(400).json({error:"password must be at least 8 characters"});if(isProduction()&&String(req.body.password)===demoPasswordFor(target.email))return res.status(400).json({error:"that password follows the published demo scheme; choose another"});await query("UPDATE users SET password_hash=$1 WHERE id=$2",[hashPassword(req.body.password),userId]);await query("DELETE FROM sessions WHERE user_id=$1",[userId]);clearAccessCache();await audit(req,"password_reset","user",userId,{email:target.email,sessions_invalidated:true});}
    if(!r)return res.status(404).json({error:"user not found"});clearAccessCache();if(req.body?.active===false||req.body?.active===0||req.body?.active==="false")await revokeUserSessions(userId);await audit(req,"updated","user",userId);res.json(r);}catch(e){next(e);}});
router.put("/users/:id/roles", requirePermission("manage_users"), async (req,res,next)=>{try{const userId=id(req.params.id,"user_id");const org=await organizationId();await guardTargetUser(req,userId,org,{allowSelf:true});const roleIds=[...new Set((Array.isArray(req.body?.role_ids)?req.body.role_ids:[]).map((roleId)=>id(roleId,"role_id")))];if(roleIds.length)await assignableRoles(req,roleIds,org);
    // An administrator may move THEMSELVES only between system-administration
    // roles (no business permission), so nobody can hand themselves Finance,
    // Legal or Sales powers; another administrator must do that.
    if(userId===req.user.id){if(!roleIds.length)return res.status(400).json({error:"you must keep a role"});const business=await rows("SELECT DISTINCT r.name FROM roles r JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id WHERE r.id=ANY($1::int[]) AND p.permission_key=ANY($2::text[])",[roleIds,[...BUSINESS_PERMISSIONS]]);if(business.length)return res.status(403).json({error:`you can move yourself only between system-administration roles; "${business[0].name}" carries business access, so another administrator must assign it`});}await withTransaction(async(c)=>{await c.query("DELETE FROM user_roles WHERE user_id=$1",[userId]);for(const roleId of roleIds)await c.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE id=$2 AND organization_id=$3 ON CONFLICT DO NOTHING",[userId,roleId,org]);});clearAccessCache();
    // MK-13: someone whose role changed signs in again, so no browser keeps an
    // old picture of their access. (Your own change keeps your current session.)
    if(userId!==req.user.id)await revokeUserSessions(userId);await audit(req,"changed_role","user",userId);res.json({ok:true});}catch(e){next(e);}});
router.put("/users/:id/departments", requirePermission("manage_users"), async (req,res,next)=>{try{const userId=id(req.params.id,"user_id");await guardTargetUser(req,userId,await organizationId());
    const wanted=[...new Set((Array.isArray(req.body?.department_ids)?req.body.department_ids:[]).map((value)=>id(value,"department_id")))];
    if(!wanted.length)return res.status(400).json({error:"a staff member must belong to at least one department"});
    const live=await rows("SELECT id FROM departments WHERE organization_id=$1 AND active AND id=ANY($2::int[])",[await organizationId(),wanted]);
    if(live.length!==wanted.length)return res.status(400).json({error:"one or more selected departments do not exist or are inactive"});
    req.body.department_ids=wanted;
    if(userId!==req.user.id)await revokeUserSessions(userId);await withTransaction(async(c)=>{await c.query("DELETE FROM user_departments WHERE user_id=$1",[userId]);for(const departmentId of(req.body?.department_ids||[]))await c.query("INSERT INTO user_departments(user_id,department_id) SELECT $1,id FROM departments WHERE id=$2 AND organization_id=$3 ON CONFLICT DO NOTHING",[userId,id(departmentId,"department_id"),await organizationId()]);});clearAccessCache();await audit(req,"changed_department","user",userId);res.json({ok:true});}catch(e){next(e);}});
/**
 * Audit log.
 *
 * Two levels, both read-only:
 *   - the full trail (every module, every user) for administrators;
 *   - a system-security slice for `view_audit` holders such as the ICTO, which
 *     excludes business modules entirely so owning an incident trail never
 *     turns into reading contracts, clients or money.
 *
 * Nothing here writes, so a reader can never alter what they are reviewing.
 */
router.get("/audit", requireAnyPermission("view_audit", "manage_settings"), async (req, res, next) => {
  try {
    const org = await organizationId();
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    // Only a true administrator sees the complete trail. `manage_settings` is NOT
    // enough: the ICTO holds it, and owning the system does not mean owning every
    // business action ever recorded. This mirrors requireAdmin() elsewhere.
    const full = req.access?.isAdmin === true;
    if (full) {
      return res.json(await rows(
        "SELECT a.*,u.display_name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.organization_id=$1 ORDER BY a.created_at DESC,a.id DESC LIMIT $2",
        [org, limit],
      ));
    }
    const systemModules = [...AUDIT_SYSTEM_MODULES];
    return res.json({
      scope: "system",
      note: "System and security events only. Business-module activity is withheld.",
      entries: await rows(
        `SELECT a.id,a.action,a.module,a.record_id,a.details_json,a.created_at,u.display_name AS user_name
           FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
          WHERE a.organization_id=$1 AND a.module=ANY($2::text[])
          ORDER BY a.created_at DESC,a.id DESC LIMIT $3`,
        [org, systemModules, limit],
      ),
    });
  } catch (error) { next(error); }
});
router.get("/approvals", requireAnyPermission("approve", "view_reports"), async (req, res, next) => { try { const o = await organizationId(); const status = req.query.status || null; if (status && !["pending", "approved", "rejected"].includes(status)) return res.status(400).json({ error: "status is invalid" }); res.json(await rows(`SELECT a.*,r.display_name AS requested_by_name,d.display_name AS decided_by_name FROM approvals a LEFT JOIN users r ON r.id=a.requested_by LEFT JOIN users d ON d.id=a.approved_by WHERE a.organization_id=$1 ${status ? "AND a.status=$2" : ""} ORDER BY a.created_at DESC,a.id DESC LIMIT 250`, status ? [o, status] : [o])); } catch (e) { next(e); } });
router.post("/approvals", requirePermission("approve"), async (req, res, next) => { try { const o = await organizationId(); const r = await queryOne("INSERT INTO approvals(organization_id,module,record_id,requested_by,status,notes) VALUES($1,$2,$3,$4,'pending',$5) RETURNING *", [o, text(req.body?.module, "module", 80), id(req.body?.record_id, "record_id"), req.user.id, req.body?.notes || null]); await audit(req, "created", "approval", r.id); res.status(201).json(r); } catch (e) { next(e); } });
router.put("/approvals/:id", requirePermission("approve"), async (req, res, next) => { try { const approvalId = id(req.params.id, "approval_id"); const status = String(req.body?.status || ""); if (!["approved", "rejected", "pending"].includes(status)) return res.status(400).json({ error: "status must be approved, rejected, or pending" }); const o = await organizationId(); const r = await queryOne("UPDATE approvals SET status=$1,approved_by=CASE WHEN $1='pending' THEN NULL ELSE $2 END,decided_at=CASE WHEN $1='pending' THEN NULL ELSE NOW() END,notes=COALESCE($3,notes) WHERE id=$4 AND organization_id=$5 RETURNING *", [status, req.user.id, req.body?.notes || null, approvalId, o]); if (!r) return res.status(404).json({ error: "approval not found" }); await audit(req, status === "pending" ? "reopened" : "decided", "approval", r.id, { status }); res.json(r); } catch (e) { next(e); } });

// Leads. Paginated twin is opt-in: without `page`/`page_size` the response is
// still the bare array this route has always returned, which the workspace
// aggregate and the existing tests both rely on.
router.get("/leads", requireModuleAccess("leads"), async(req,res,next)=>{try{
  if(!paginationRequested(req.query)){const values=[await organizationId()];const visible=scopeCondition("l","lead",req.access,values);return res.json(await rows(`SELECT l.* FROM leads l WHERE l.organization_id=$1 AND ${visible} ORDER BY l.created_at DESC LIMIT ${UNPAGED_LIMIT}`,values));}
  const paged=await paginatedList({build:()=>scopedListPaged("leads","l","lead","l.created_at DESC",searchTerm(req.query.search),["l.name","l.email","l.notes"]),...parsePagination(req.query)});
  res.json({data:paged.rows,pagination:paged.pagination});
}catch(e){next(e);}});
router.post("/leads", requireModuleAccess("leads"), requirePermission("create"), async(req,res,next)=>{try{const own=ownershipFields(req.access);const r=await queryOne("INSERT INTO leads(organization_id,name,email,phone,source,status,notes,assigned_to,owner_id,created_by,department_id,visibility) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",[await organizationId(),text(req.body?.name,"name"),req.body?.email||null,req.body?.phone||null,req.body?.source||null,req.body?.status||"new",req.body?.notes||null,req.body?.assigned_to||req.user.id,own.owner_id,own.created_by,own.department_id,own.visibility]);await audit(req,"created","lead",r.id);res.status(201).json(r);}catch(e){next(e);}});
// Requests: the website's Buy/Rent requests (leads with source 'website'),
// each with the Customer Service task it was handed to, so Sales can follow it
// from arrival to client. Same module and record scope as Leads.
router.get("/requests", requireModuleAccess("leads"), async(req,res,next)=>{try{
  const values=[await organizationId()];const visible=scopeCondition("l","lead",req.access,values);
  res.json(await rows(`SELECT l.*, p.name AS property_name, t.status AS task_status, t.assigned_to AS task_assignee_id, u.display_name AS task_assignee, t.submitted_at AS task_submitted_at, t.approved_at AS task_approved_at,
      tb.display_name AS task_assigned_by, rv.display_name AS task_reviewer, ap.display_name AS task_approved_by, t.updated_at AS task_updated_at,
      ap_row.starts_at AS appointment_starts_at,
      cl.name AS client_name, cv.display_name AS converted_by_name,
      ec.id AS existing_client_id, ec.name AS existing_client_name,
      rp.body AS task_report, rp.created_at AS task_report_at
    FROM leads l LEFT JOIN properties p ON p.id=l.property_id LEFT JOIN tasks t ON t.id=l.task_id LEFT JOIN users u ON u.id=t.assigned_to
    LEFT JOIN users tb ON tb.id=t.assigned_by LEFT JOIN users rv ON rv.id=t.reviewer_id LEFT JOIN users ap ON ap.id=t.approved_by
    LEFT JOIN appointments ap_row ON ap_row.id=l.appointment_id
    LEFT JOIN clients cl ON cl.id=l.client_id LEFT JOIN users cv ON cv.id=l.converted_by
    LEFT JOIN LATERAL (SELECT c.body, c.created_at FROM task_comments c WHERE c.task_id=t.id AND c.author_id=t.assigned_to ORDER BY c.created_at DESC, c.id DESC LIMIT 1) rp ON TRUE
    LEFT JOIN clients ec ON l.client_id IS NULL AND ec.id = ${EXISTING_CLIENT_SQL}
    WHERE l.organization_id=$1 AND l.source IN ('website','website-contact') AND ${visible} ORDER BY l.created_at DESC LIMIT 500`,values));
}catch(e){next(e);}});
// Sales arranges the agreed appointment for a request once Customer Service
// has reported back (or moves it). It goes straight into Appointments.
/** Whether a user works in Sales (who own website requests end to end). */
async function inSalesDepartment(userId){
  return Boolean(await queryOne("SELECT 1 FROM user_departments ud JOIN departments d ON d.id=ud.department_id WHERE ud.user_id=$1 AND d.active=TRUE AND d.name='SALES, MARKETING & OPERATIONS'",[userId]));
}
router.post("/requests/:id/appointment", requireModuleAccess("leads"), requireModuleAccess("appointments"), requirePermission("assign_tasks"), async(req,res,next)=>{try{
  if(!await inSalesDepartment(req.user.id))return res.status(403).json({error:"Sales arranges the appointment; the MD can see it under Appointments"});
  const leadId=id(req.params.id,"lead_id");const org=await organizationId();
  const values=[leadId,org];const lead=await queryOne(`SELECT l.* FROM leads l WHERE l.id=$1 AND l.organization_id=$2 AND l.source IN ('website','website-contact') AND ${scopeCondition("l","lead",req.access,values)}`,values);
  if(!lead)return res.status(404).json({error:"request not found"});
  // A report must have come back and been accepted first (unless one is already booked).
  if(!lead.appointment_id){
    const task=lead.task_id?await queryOne("SELECT status FROM tasks WHERE id=$1",[lead.task_id]):null;
    if(!task||!["approved","completed"].includes(task.status))return res.status(409).json({error:"approve Customer Service's report first, then arrange the appointment"});
  }
  const when=new Date(String(req.body?.starts_at||""));
  if(Number.isNaN(when.getTime()))return res.status(400).json({error:"give the appointment date and time"});
  if(when.getTime()<Date.now()-60*60*1000)return res.status(400).json({error:"the appointment must be in the future"});
  const type=String(req.body?.appointment_type||"viewing");
  if(!APPOINTMENT_TYPES.includes(type))return res.status(400).json({error:"appointment type must be viewing, meeting or call"});
  const note=typeof req.body?.note==="string"?req.body.note.trim().slice(0,2000):"";
  const result=await arrangeRequestAppointment(lead,{when,type,note},ownershipFields(req.access));
  await audit(req,result.created?"created":"updated","appointment",result.appointmentId,{from_request:leadId});
  res.status(result.created?201:200).json({appointment_id:result.appointmentId,client_id:result.clientId,created:result.created});
}catch(e){next(e);}});
// A Contact-page message is Customer Service's to answer. The officer who
// replied to the visitor records it here, with what was said.
router.post("/requests/:id/answer", requireModuleAccess("leads"), requirePermission("edit"), async(req,res,next)=>{try{
  const leadId=id(req.params.id,"lead_id");const org=await organizationId();
  const inCs=await queryOne("SELECT 1 FROM user_departments ud JOIN departments d ON d.id=ud.department_id WHERE ud.user_id=$1 AND d.active=TRUE AND d.name='CUSTOMER SERVICE'",[req.user.id]);
  if(!inCs)return res.status(403).json({error:"Customer Service answers website messages"});
  const values=[leadId,org];const lead=await queryOne(`SELECT l.* FROM leads l WHERE l.id=$1 AND l.organization_id=$2 AND l.source='website-contact' AND ${scopeCondition("l","lead",req.access,values)}`,values);
  if(!lead)return res.status(404).json({error:"message not found"});
  const note=typeof req.body?.note==="string"?req.body.note.trim().slice(0,2000):"";
  if(!note)return res.status(400).json({error:"say how the visitor was answered"});
  const r=await queryOne("UPDATE leads SET outcome='answered',outcome_note=$1,outcome_at=NOW(),outcome_by=$2,status='contacted' WHERE id=$3 RETURNING *",[note,req.user.id,leadId]);
  await audit(req,"answered","lead",leadId,{});res.json(r);
}catch(e){next(e);}});
// Records which Customer Service task a request was handed to. The task must
// already exist and have been assigned by the caller (POST /tasks decided
// whether they may assign it); this only ties the two together.
router.post("/requests/:id/handed-off", requireModuleAccess("leads"), requirePermission("assign_tasks"), async(req,res,next)=>{try{
  // Requests are Sales's work: only Sales hands them to Customer Service. The
  // MD follows them (sees every step) but does not hand them over.
  if(!await inSalesDepartment(req.user.id))return res.status(403).json({error:"Sales hands requests to Customer Service; the MD can follow them under Requests"});
  const leadId=id(req.params.id,"lead_id");const taskId=id(req.body?.task_id,"task_id");const org=await organizationId();
  // Contact-page messages may be handed to Customer Service the same way.
  const values=[leadId,org];const lead=await queryOne(`SELECT l.* FROM leads l WHERE l.id=$1 AND l.organization_id=$2 AND l.source IN ('website','website-contact') AND ${scopeCondition("l","lead",req.access,values)}`,values);
  if(!lead)return res.status(404).json({error:"request not found"});
  if(lead.client_id)return res.status(409).json({error:"this request is already a client"});
  const task=await queryOne("SELECT id,assigned_to FROM tasks WHERE id=$1 AND organization_id=$2 AND assigned_by=$3",[taskId,org,req.user.id]);
  if(!task)return res.status(400).json({error:"task not found"});
  // A request goes to Customer Service, nobody else.
  const inCs=await queryOne("SELECT 1 FROM user_departments ud JOIN departments d ON d.id=ud.department_id WHERE ud.user_id=$1 AND d.active=TRUE AND d.name='CUSTOMER SERVICE'",[task.assigned_to]);
  if(!inCs)return res.status(400).json({error:"a request can only be handed to a Customer Service officer"});
  const r=await queryOne("UPDATE leads SET task_id=$1,handed_off_at=NOW(),status='handed_off',outcome=NULL,outcome_note=NULL,outcome_at=NULL,outcome_by=NULL,appointment_at=NULL,appointment_type=NULL WHERE id=$2 RETURNING *",[taskId,leadId]);
  await audit(req,"handed_off","lead",leadId,{task_id:taskId});res.json(r);
}catch(e){next(e);}});
// Conversion registers a person as a client record; it is NOT a signature. The
// record is therefore created as a PROSPECT ('lead'), so the completed-client rule
// (a client must have a contract) is never violated by converting a lead. Sales
// attaches the contract and completes the client afterwards.
// "Become a client". Only two may approve it: Sales (who own the customer)
// and the MD. The approver is recorded, so everyone - and the contract made
// later - knows exactly which client the customer is and who accepted them.
// When the customer matches an existing client (same phone or email), the
// approver chooses: the same person (link to that client) or a new client.
router.post("/leads/:id/convert", requireModuleAccess("leads"), async(req,res,next)=>{try{
    if(!(await inSalesDepartment(req.user.id)||can(req.access,"approve_management")))return res.status(403).json({error:"only Sales or the MD can approve a customer becoming a client"});
    const leadId=id(req.params.id,"lead_id");const values=[leadId,await organizationId()];const lead=await queryOne(`SELECT l.* FROM leads l WHERE l.id=$1 AND l.organization_id=$2 AND ${scopeCondition("l","lead",req.access,values)}`,values);if(!lead)return res.status(404).json({error:"lead not found"});if(lead.client_id)return res.status(409).json({error:"already a client"});
    const mode=req.body?.mode==="new"?"new":req.body?.mode==="existing"?"existing":"auto";
    const existing=mode==="new"?null:await findExistingClient(values[1],{email:lead.email,phone:lead.phone});
    if(mode==="existing"&&!existing)return res.status(409).json({error:"no existing client matches this customer; choose 'new client'"});
    if(existing){await query("UPDATE leads SET client_id=$1,status='converted',converted_at=NOW(),converted_by=$3 WHERE id=$2",[existing.id,lead.id,req.user.id]);await audit(req,"converted","lead",lead.id,{client_id:existing.id,existing:true});return res.json(await queryOne("SELECT * FROM clients WHERE id=$1",[existing.id]));}
    const clientType=lead.service==="sell"?"seller":lead.service==="rent"?"tenant":"buyer";const client=await queryOne("INSERT INTO clients(organization_id,name,email,phone,client_type,status,notes,owner_id,created_by,department_id,visibility) VALUES($1,$2,$3,$4,$10,'lead',$5,$6,$7,$8,$9) RETURNING *",[values[1],lead.name,lead.email,lead.phone,lead.notes,lead.owner_id,lead.created_by,lead.department_id,lead.visibility,clientType]);await query("UPDATE leads SET client_id=$1,status='converted',converted_at=NOW(),converted_by=$3 WHERE id=$2",[client.id,lead.id,req.user.id]);await audit(req,"converted","lead",lead.id,{client_id:client.id});res.status(201).json(client);}catch(e){next(e);}});
// Follow-ups. Opt-in pagination; the default response is the bare array the
// workspace aggregate and the existing tests depend on.
router.get("/follow-ups", requireModuleAccess("follow_ups"), async(req,res,next)=>{try{
  if(!paginationRequested(req.query)){const values=[await organizationId()];const visible=scopeCondition("f","follow_up",req.access,values);return res.json(await rows(`SELECT f.* FROM follow_ups f WHERE f.organization_id=$1 AND ${visible} ORDER BY f.due_at`,values));}
  const paged=await paginatedList({build:()=>scopedListPaged("follow_ups","f","follow_up","f.due_at",searchTerm(req.query.search),["f.notes","f.follow_up_type"]),...parsePagination(req.query)});
  res.json({data:paged.rows,pagination:paged.pagination});
}catch(e){next(e);}});
router.post("/follow-ups", requireModuleAccess("follow_ups"), requirePermission("create"), async(req,res,next)=>{try{const own=ownershipFields(req.access);const r=await queryOne("INSERT INTO follow_ups(organization_id,lead_id,client_id,assigned_to,due_at,next_due_at,follow_up_type,status,outcome,notes,owner_id,created_by,department_id,visibility) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *",[await organizationId(),req.body?.lead_id||null,req.body?.client_id||null,req.body?.assigned_to||req.user.id,req.body?.due_at,req.body?.next_due_at||null,req.body?.follow_up_type||"call",req.body?.status||"open",req.body?.outcome||null,req.body?.notes||null,own.owner_id,own.created_by,own.department_id,own.visibility]);await audit(req,"created","follow_up",r.id);res.status(201).json(r);}catch(e){next(e);}});
// Dashboard counters honour the caller's record scope, and monetary counters are
// only produced for callers holding `view_financial`.
router.get("/dashboard", requireAnyPermission("manage_permissions", "manage_users", "view_reports"), requireScope("organization", "department"), async(req,res,next)=>{try{res.json(await dashboardMetrics(req));}catch(e){next(e);}});
router.get("/collections",requireAnyPermission("manage_users", "view_financial"),async(req,res,next)=>{try{res.json(await collections(req));}catch(e){next(e);}});
router.get("/settings",requireAdmin(),async(req,res,next)=>{try{res.json(await rows("SELECT setting_key,setting_value FROM settings WHERE organization_id=$1 ORDER BY setting_key",[await organizationId()]));}catch(e){next(e);}});
router.put("/settings/:key",requireAdmin(),async(req,res,next)=>{try{const o=await organizationId();const key=text(req.params.key,"setting_key",80);const value=String(req.body?.value??"");await query("INSERT INTO settings(organization_id,setting_key,setting_value) VALUES($1,$2,$3) ON CONFLICT(organization_id,setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value",[o,key,value]);await audit(req,"updated","setting",key);res.json({setting_key:key,setting_value:value});}catch(e){next(e);}});
router.get("/public-listings",async(req,res,next)=>{try{res.json(await rows("SELECT id,name,property_type,status,price,location,area,bedrooms,bathrooms,description FROM properties WHERE organization_id=$1 AND public_listing=TRUE AND public_listing_status='approved' ORDER BY created_at DESC",[await organizationId()]));}catch(e){next(e);}});
// Sector workspaces. Each workspace lists the modules it covers; the response is
// filtered by what the caller actually holds, so a sector never advertises a
// module the caller cannot open.
const workspaces = {
  management: { label: "Managing Director", modules: ["projects", "properties", "clients", "leads", "contracts", "documents", "appointments", "debts", "payments", "reports"] },
  sales: { label: "Sales", modules: ["leads", "follow_ups", "clients", "properties", "appointments", "contracts", "documents", "reports"] },
  marketing: { label: "Marketing", modules: ["leads", "follow_ups", "properties", "documents", "clients", "reports"] },
  finance: { label: "Finance", modules: ["contracts", "debts", "payments", "reminders", "clients", "reports"] },
  property: { label: "Property", modules: ["projects", "properties", "clients", "appointments", "documents"] },
  legal: { label: "Contracts & Legal", modules: ["contracts", "documents", "clients", "projects"] },
  administration: { label: "Administration", modules: [] },
};
router.get("/workspaces/:workspace",async(req,res,next)=>{try{const key=String(req.params.workspace).toLowerCase();const workspace=workspaces[key];if(!workspace)return res.status(404).json({error:"workspace not found"});const isAdmin=req.access?.isAdmin;const modules=isAdmin?[...workspace.modules,"administration"]:workspace.modules.filter((module)=>canAccessModule(req.access,module));res.json({workspace:key,label:workspace.label,modules,permissions:req.access?.permissions||[],scope:req.access?.scope||"own",financial:can(req.access,"view_financial")});}catch(e){next(e);}});
router.get("/workspaces",async(req,res,next)=>{try{res.json(Object.entries(workspaces).map(([key,value])=>({workspace:key,label:value.label,modules:value.modules})));}catch(e){next(e);}});

/**
 * Record allocation overview. Administrators use this to find records that are
 * still in the office-wide pool (created before ownership existed) and to move
 * them to an owner, a department and a visibility.
 */
router.get("/records/allocation", requireAdmin(), async (req, res, next) => {
  try {
    const org = await organizationId();
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const onlyUnassigned = req.query.unassigned !== "0";
    const entities = [];
    for (const [entity, entry] of Object.entries(recordTables)) {
      // Records with no ownership columns of their own (reminders inherit the
      // scope of their installment) cannot be allocated, so they are reported
      // as skipped rather than queried against columns that do not exist.
      if (entry.ownable === false) { entities.push({ entity, table: entry.table, ownable: false, total: 0, unassigned: 0, records: [] }); continue; }
      const alias = entry.table.charAt(0);
      const where = `${alias}.organization_id = $1${onlyUnassigned ? ` AND ${alias}.owner_id IS NULL AND ${alias}.created_by IS NULL` : ""}`;
      const totals = await queryOne(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE ${alias}.owner_id IS NULL AND ${alias}.created_by IS NULL)::int AS unassigned FROM ${entry.table} ${alias} WHERE ${alias}.organization_id = $1`,
        [org],
      );
      const labelColumn = { projects: "name", clients: "name", contracts: "client_name", properties: "name", appointments: "title", documents: "title", debts: "client_name", payments: "client_name", reports: "title", leads: "name", follow_ups: "follow_up_type" }[entry.table] || "id";
      const records = await rows(
        `SELECT ${alias}.id, ${alias}.${labelColumn} AS label, ${alias}.owner_id, ${alias}.department_id, ${alias}.visibility, (SELECT COUNT(*)::int FROM record_shares rs WHERE rs.entity = $2 AND rs.record_id = ${alias}.id) AS share_count
           FROM ${entry.table} ${alias} WHERE ${where} ORDER BY ${alias}.created_at DESC LIMIT $3`,
        [org, entity, limit],
      );
      entities.push({ entity, table: entry.table, label_field: labelColumn, total: totals.total, unassigned: totals.unassigned, records });
    }
    res.json({ entities, limit });
  } catch (error) { next(error); }
});

// Administrators allocate legacy records: this is how an unassigned record
// leaves the office-wide pool and starts following owner/department rules.
router.put("/records/:entity/:id/access", requireAdmin(), async (req, res, next) => {
  try {
    const { table, alias } = recordTable(String(req.params.entity || ""));
    const recordId = id(req.params.id, "record_id");
    const ownerId = req.body?.owner_id === undefined || req.body.owner_id === null || req.body.owner_id === "" ? null : id(req.body.owner_id, "owner_id");
    const departmentId = req.body?.department_id === undefined || req.body.department_id === null || req.body.department_id === "" ? null : id(req.body.department_id, "department_id");
    const visibility = req.body?.visibility === undefined || req.body.visibility === null || req.body.visibility === "" ? null : String(req.body.visibility);
    if (visibility && !isVisibility(visibility)) return res.status(400).json({ error: "visibility must be own, department or organization" });
    const org = await organizationId();
    if (ownerId && !await queryOne("SELECT 1 AS ok FROM users WHERE id=$1 AND organization_id=$2", [ownerId, org])) return res.status(400).json({ error: "owner_id is not a member of this organization" });
    if (departmentId && !await queryOne("SELECT 1 AS ok FROM departments WHERE id=$1 AND organization_id=$2", [departmentId, org])) return res.status(400).json({ error: "department_id is not a department of this organization" });
    const record = await queryOne(`UPDATE ${table} ${alias} SET owner_id=COALESCE($1,owner_id),created_by=COALESCE($1,created_by),department_id=$2,visibility=COALESCE($3,visibility) WHERE ${alias}.id=$4 AND ${alias}.organization_id=$5 RETURNING *`, [ownerId, departmentId, visibility, recordId, org]);
    if (!record) return res.status(404).json({ error: "record not found" });
    await audit(req, "reassigned", String(req.params.entity), recordId, { owner_id: ownerId, department_id: departmentId, visibility });
    res.json(record);
  } catch (e) { next(e); }
});

// Sharing is available to the record owner, department managers, and admins.
async function requireShareable(req, entity, recordId) {
  const { table, alias } = recordTable(entity);
  const access = req.access;
  const values = [recordId, await organizationId()];
  const visible = scopeCondition(alias, entity, access, values);
  const record = await queryOne(`SELECT ${alias}.* FROM ${table} ${alias} WHERE ${alias}.id=$1 AND ${alias}.organization_id=$2 AND ${visible}`, values);
  if (!record) { const e = new Error("record not found"); e.status = 404; throw e; }
  if (access.isAdmin || access.scope === "organization" || record.owner_id === access.userId || (access.scope === "department" && record.department_id && access.departmentIds.includes(record.department_id))) return record;
  const e = new Error("only the owner, a department manager or an administrator can share this record");
  e.status = 403;
  throw e;
}

router.get("/records/:entity/:id/shares", async (req, res, next) => {
  try {
    const entity = String(req.params.entity || "");
    const record = await requireShareable(req, entity, id(req.params.id, "record_id"));
    res.json(await listRecordShares(entity, record.id));
  } catch (e) { next(e); }
});
router.post("/records/:entity/:id/shares", requirePermission("edit"), async (req, res, next) => {
  try {
    const entity = String(req.params.entity || "");
    const record = await requireShareable(req, entity, id(req.params.id, "record_id"));
    const userId = req.body?.user_id ? id(req.body.user_id, "user_id") : null;
    const departmentId = req.body?.department_id ? id(req.body.department_id, "department_id") : null;
    if (!userId && !departmentId) return res.status(400).json({ error: "share with a user_id or a department_id" });
    const org = await organizationId();
    if (userId && !await queryOne("SELECT 1 AS ok FROM users WHERE id=$1 AND organization_id=$2", [userId, org])) return res.status(400).json({ error: "user_id is not a member of this organization" });
    if (departmentId && !await queryOne("SELECT 1 AS ok FROM departments WHERE id=$1 AND organization_id=$2", [departmentId, org])) return res.status(400).json({ error: "department_id is not a department of this organization" });
    const share = await addRecordShare({ entity, recordId: record.id, userId, departmentId, createdBy: req.user.id });
    await audit(req, "shared", entity, record.id, { user_id: userId, department_id: departmentId });
    res.status(201).json(share);
  } catch (e) { next(e); }
});
router.delete("/records/:entity/:id/shares/:shareId", requirePermission("edit"), async (req, res, next) => {
  try {
    const entity = String(req.params.entity || "");
    const record = await requireShareable(req, entity, id(req.params.id, "record_id"));
    const shareId = id(req.params.shareId, "share_id");
    const removed = await removeRecordShare(shareId);
    if (!removed || Number(removed.record_id) !== Number(record.id) || removed.entity !== entity) return res.status(404).json({ error: "share not found" });
    await audit(req, "unshared", entity, record.id, { share_id: shareId });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
