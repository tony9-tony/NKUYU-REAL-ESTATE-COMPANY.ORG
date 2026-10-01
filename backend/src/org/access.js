// Central data-scope service.
//
// Two independent controls protect the workspace:
//   * permission -> "which actions are allowed?"  (rbac.js)
//   * data scope -> "which records are visible?"  (this file)
//
// Models never build scope conditions themselves; they call `scopeCondition` so
// there is exactly one implementation of the visibility rules.
import { AsyncLocalStorage } from "node:async_hooks";
import { query, queryOne } from "../db.js";
import { can, canAccessModule, canReadModule, isReadOnlyModule, organizationId } from "./rbac.js";

export { can, canAccessModule, canReadModule, isReadOnlyModule };

const SCOPE_RANK = { own: 1, department: 2, organization: 3 };
const VISIBILITIES = new Set(["own", "department", "organization"]);
const storage = new AsyncLocalStorage();
const accessCache = new Map();

// Column order used by `OWNERSHIP_COLUMNS` in INSERT statements.
export const OWNERSHIP_COLUMNS = "owner_id, created_by, department_id, visibility";

export function scopeRank(scope) {
  return SCOPE_RANK[scope] || 0;
}

export function isScope(value) {
  return Boolean(value) && SCOPE_RANK[value] !== undefined;
}

export function isVisibility(value) {
  return VISIBILITIES.has(value);
}

/**
 * Access profile for the current request. `null` means "no request scope", which
 * only happens for migrations, unit tests and background work; those callers are
 * trusted and therefore see everything.
 */
export function currentAccess() {
  return storage.getStore() || null;
}

const ACCESS_CACHE_MS = 60 * 1000;

export function clearAccessCache() {
  accessCache.clear();
}

// Roles, departments and permissions are fetched in a single round trip instead
// of three; the result is memoised per user and invalidated whenever an
// administrator changes roles, permissions, departments or staff.
export async function accessForUser(user) {
  if (!user) return null;
  const key = `${user.id}:${user.role === "admin" ? "admin" : "staff"}`;
  // Changes made through the API clear the cache at once; the short lifetime
  // also catches changes made any other way (another process, direct SQL).
  const cached = accessCache.get(key);
  if (cached && Date.now() - cached.loadedAt < ACCESS_CACHE_MS) return cached.access;
  const row = await queryOne(
    `SELECT
       COALESCE((SELECT json_agg(json_build_object('scope', r.scope, 'rank', r.rank) ORDER BY r.rank DESC)
                   FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                  WHERE ur.user_id = $1 AND r.active = TRUE), '[]'::json) AS roles,
       COALESCE((SELECT json_agg(d.id ORDER BY d.id)
                   FROM user_departments ud JOIN departments d ON d.id = ud.department_id
                  WHERE ud.user_id = $1 AND d.active = TRUE), '[]'::json) AS departments,
       COALESCE((SELECT json_agg(DISTINCT p.permission_key)
                   FROM user_roles ur
                   JOIN roles r ON r.id = ur.role_id AND r.active = TRUE
                   JOIN role_permissions rp ON rp.role_id = ur.role_id
                   JOIN permissions p ON p.id = rp.permission_id
                  WHERE ur.user_id = $1), '[]'::json) AS permissions`,
    [user.id],
  );
  let scope = "own";
  let rank = 0;
  for (const role of row.roles || []) {
    if (scopeRank(role.scope) > scopeRank(scope)) scope = role.scope;
    rank = Math.max(rank, Number(role.rank) || 0);
  }
  const access = {
    userId: user.id,
    isAdmin: user.role === "admin",
    scope: user.role === "admin" ? "organization" : scope,
    rank,
    departmentIds: row.departments || [],
    permissions: row.permissions || [],
    organizationId: await organizationId(),
  };
  accessCache.set(key, { access, loadedAt: Date.now() });
  return access;
}

/** Express middleware: resolves the access profile and binds it to the request chain. */
export function accessMiddleware() {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => accessForUser(req.user))
      .then((access) => {
        req.access = access;
        storage.run(access, next);
      })
      .catch(next);
  };
}

/** Runs `work` with an explicit access profile (used for boot-time warmup). */
export function runWithAccess(access, work) {
  return storage.run(access, work);
}

/** Default ownership written when a record is created. */
export function ownershipFields(access) {
  if (!access) return { owner_id: null, created_by: null, department_id: null, visibility: "organization" };
  const departmentId = access.departmentIds.length ? access.departmentIds[0] : null;
  const visibility = access.isAdmin || access.scope === "organization" ? "organization" : departmentId ? "department" : "own";
  return { owner_id: access.userId, created_by: access.userId, department_id: departmentId, visibility };
}

/** Same as `ownershipFields` but appends the values in OWNERSHIP_COLUMNS order. */
export function ownershipValues(values, access) {
  const fields = ownershipFields(access);
  values.push(fields.owner_id, fields.created_by, fields.department_id, fields.visibility);
  return values;
}


/**
 * Builds the SQL visibility predicate for one record table. `values` is the
 * parameter array already in use; new bind values are appended so callers keep
 * their existing `$1..$n` numbering intact.
 */
// Read-only holders see the WHOLE register for:
//   * projects / properties - Finance (view_financial): the money it records
//     belongs to deals on any project or property, whoever created them;
//   * appointments - Legal: it follows every customer appointment Sales books.
// They cannot write through it (the middleware refuses every write), so this
// widens what they SEE, never what they may change. Other read-only holders
// keep their normal record scope: a department's private project stays private.
const CATALOGUE_READ_GRANT = {
  project: { module: "projects", needs: "view_financial" },
  property: { module: "properties", needs: "view_financial" },
  appointment: { module: "appointments", needs: null },
};

export function scopeCondition(alias, entity, access, values) {
  if (!access || access.isAdmin || access.scope === "organization") return "TRUE";
  const grant = CATALOGUE_READ_GRANT[entity];
  if (grant && isReadOnlyModule(access, grant.module) && (!grant.needs || access.permissions.includes(grant.needs))) return "TRUE";
  const bind = (value) => {
    values.push(value);
    return `$${values.length}`;
  };
  const parts = [
    // Records the caller created or owns.
    `${alias}.owner_id = ${bind(access.userId)}`,
    `${alias}.created_by = ${bind(access.userId)}`,
    // Records that were never allocated stay in an office-wide pool so an upgrade
    // never hides historical data; assigning an owner takes them out of the pool.
    `(${alias}.owner_id IS NULL AND ${alias}.created_by IS NULL)`,
    // Anything an organization-scoped author published for the whole office. This
    // is honoured at every scope: if the MD publishes a project, every sector
    // with module access must be able to work with it.
    `${alias}.visibility = 'organization'`,
  ];
  // Explicitly shared with the caller, or with one of the caller's departments.
  //
  // The department branch is only emitted when the caller actually belongs to a
  // department. `= ANY()` requires a real array on the right-hand side, so binding
  // an empty list raised "op ANY/ALL (array) requires array on right side" and
  // turned every scoped read into a 500.
  const shareMatch = access.departmentIds.length
    ? `rs.user_id = ${bind(access.userId)} OR rs.department_id = ANY(${bind(access.departmentIds)})`
    : `rs.user_id = ${bind(access.userId)}`;
  parts.push(
    `EXISTS (SELECT 1 FROM record_shares rs WHERE rs.organization_id = ${bind(access.organizationId)} AND rs.entity = ${bind(entity)} AND rs.record_id = ${alias}.id AND (${shareMatch}))`,
  );
  if (access.departmentIds.length) {
    parts.push(`(${alias}.visibility = 'department' AND ${alias}.department_id = ANY(${bind(access.departmentIds)}))`);
  }
  return `(${parts.join(" OR ")})`;
}

export async function clearRecordShares(entity, recordId) {
  await query("DELETE FROM record_shares WHERE entity = $1 AND record_id = $2", [entity, recordId]);
}

export async function listRecordShares(entity, recordId) {
  return (await query(
    `SELECT rs.id, rs.entity, rs.record_id, rs.user_id, rs.department_id, rs.created_at, u.display_name AS user_name, d.name AS department_name
       FROM record_shares rs
       LEFT JOIN users u ON u.id = rs.user_id
       LEFT JOIN departments d ON d.id = rs.department_id
      WHERE rs.organization_id = $1 AND rs.entity = $2 AND rs.record_id = $3
      ORDER BY rs.created_at`,
    [await organizationId(), entity, recordId],
  )).rows;
}

export async function addRecordShare({ entity, recordId, userId, departmentId, createdBy }) {
  return queryOne(
    `INSERT INTO record_shares (organization_id, entity, record_id, user_id, department_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (entity, record_id, COALESCE(user_id, 0), COALESCE(department_id, 0))
     DO UPDATE SET created_by = EXCLUDED.created_by
     RETURNING *`,
    [await organizationId(), entity, recordId, userId || null, departmentId || null, createdBy || null],
  );
}

export async function removeRecordShare(shareId, entity, recordId) {
  return queryOne("DELETE FROM record_shares WHERE id = $1 AND organization_id = $2 AND entity = $3 AND record_id = $4 RETURNING *", [shareId, await organizationId(), entity, recordId]);
}
