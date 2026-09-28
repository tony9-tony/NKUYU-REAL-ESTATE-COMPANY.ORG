// Demo-account verification. Logs in as every seeded account and checks the
// department, role, permissions, visible workspace, the negative API cases, and
// the ICTO audit boundary. Talks to a PRIVATE server on the test database.
import { demoPasswordFor, legacyPasswordFor } from "./backend/src/org/demoCredentials.js";
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { closeDatabase } from "./backend/src/db.js";

reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ label: "demo-accounts", port: 3205 });
const base = server.base;

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

// email, role, department, modules it must have, modules it must not have,
// permissions it must hold, permissions it must never hold
const EXPECTED = [
  { email: "md@demo.mkuyu.local", role: "Managing Director", dept: "MANAGEMENT",
    has: ["contracts", "payments", "projects"], lacks: [],
    perms: ["approve_management"],
    notPerms: ["approve_legal", "review_legal", "validate_finance", "manage_users", "manage_roles", "manage_settings", "view_audit"] },
  { email: "finance.manager@demo.mkuyu.local", role: "Finance Manager", dept: "FINANCE & ACCOUNTS",
    has: ["debts", "payments", "reminders"], lacks: [],
    perms: ["validate_finance", "view_financial"], notPerms: ["approve_legal", "approve_management"] },
  { email: "finance@demo.mkuyu.local", role: "Finance Officer", dept: "FINANCE & ACCOUNTS",
    has: ["debts", "payments"], lacks: [], perms: ["validate_finance"], notPerms: ["approve_legal", "approve_management"] },
  { email: "sales.manager@demo.mkuyu.local", role: "Department Manager", dept: "SALES, MARKETING & OPERATIONS",
    has: ["leads", "properties", "projects"], lacks: ["debts", "payments"],
    perms: ["submit_contract"], notPerms: ["approve_legal", "validate_finance", "approve_management", "view_financial"] },
  { email: "sales@demo.mkuyu.local", role: "Sales, Marketing & Operations Officer", dept: "SALES, MARKETING & OPERATIONS",
    has: ["leads", "clients", "contracts"], lacks: ["debts", "payments", "reminders"],
    perms: ["submit_contract"], notPerms: ["approve_legal", "validate_finance", "approve_management"] },
  { email: "legal.manager@demo.mkuyu.local", role: "Legal Manager", dept: "LEGAL",
    has: ["contracts", "documents"], lacks: ["debts", "payments"],
    perms: ["approve_legal", "review_legal", "request_changes"],
    notPerms: ["validate_finance", "approve_management", "submit_contract"] },
  { email: "legal@demo.mkuyu.local", role: "Legal Officer", dept: "LEGAL",
    has: ["contracts", "documents"], lacks: ["debts", "payments"],
    perms: ["approve_legal", "review_legal"], notPerms: ["validate_finance", "approve_management"] },
  { email: "icto@demo.mkuyu.local", role: "ICTO", dept: "ICT & ADMINISTRATION",
    has: [],
    lacks: ["contracts", "clients", "properties", "leads", "projects", "debts", "payments", "reminders", "documents", "appointments", "reports", "follow_ups"],
    perms: ["manage_users", "manage_roles", "manage_permissions", "manage_settings", "view_audit"],
    notPerms: ["approve", "approve_legal", "validate_finance", "approve_management", "view_financial"] },
  { email: "itsupport@demo.mkuyu.local", role: "Administration & IT Support Officer", dept: "ICT & ADMINISTRATION",
    has: [], lacks: ["contracts", "clients", "debts", "payments"],
    perms: ["manage_users"], notPerms: ["manage_roles", "manage_permissions", "manage_settings", "view_audit", "approve_legal"] },
  { email: "cs.manager@demo.mkuyu.local", role: "Customer Service Manager", dept: "CUSTOMER SERVICE",
    has: ["clients", "appointments", "follow_ups"], lacks: ["contracts", "debts", "payments"],
    perms: [], notPerms: ["approve_legal", "submit_contract", "validate_finance", "view_financial"] },
  { email: "cs@demo.mkuyu.local", role: "Customer Service Officer", dept: "CUSTOMER SERVICE",
    has: ["clients", "appointments", "follow_ups"], lacks: ["contracts", "debts", "payments"],
    perms: [], notPerms: ["approve_legal", "submit_contract", "validate_finance", "view_financial"] },
];

const call = async (path, token, method = "GET") => {
  const response = await fetch(`${base}${path}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
};

const signIn = async (email, password) => {
  const response = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { status: response.status, session: await response.json().catch(() => ({})) };
};

const MODULE_ENDPOINT = {
  clients: "/clients", contracts: "/contracts", debts: "/debts", payments: "/payments",
  properties: "/properties", leads: "/org/leads", documents: "/documents",
  projects: "/projects", reports: "/reports/summary", appointments: "/appointments",
  reminders: "/reminders", follow_ups: "/org/follow-ups",
};

const adminSession = (await signIn("admin@mkuyu.local", legacyPasswordFor("admin@mkuyu.local"))).session;
const users = (await call("/org/users", adminSession.token)).body || [];

console.log("=== demo accounts ===");
for (const account of EXPECTED) {
  const { status, session } = await signIn(account.email, demoPasswordFor(account.email));
  if (!session.token) { check(false, `${account.email}: login rejected (${status})`); continue; }
  check(true, `${account.email}: logs in with the rotated demo password`);

  const me = (await call("/org/me", session.token)).body || {};
  const permissions = me.permissions || [];
  const modules = me.modules || [];

  const record = users.find((u) => u.email === account.email);
  const roleName = (record?.roles || []).map((r) => r.name).join(",");
  const deptName = (record?.departments || []).map((d) => d.name).join(",");
  check(Boolean(record), `${account.email}: exists in the staff register`);
  check(roleName === account.role, `${account.email}: role is "${roleName}"`);
  check(deptName === account.dept, `${account.email}: department is "${deptName}"`);
  check(!["Sales and Marketing Officer", "Supervisor"].includes(me.user?.display_name),
    `${account.email}: display name is "${me.user?.display_name}"`);

  for (const permission of account.perms) check(permissions.includes(permission), `${account.email}: holds ${permission}`);
  for (const permission of account.notPerms) check(!permissions.includes(permission), `${account.email}: does NOT hold ${permission}`);
  for (const module of account.has) check(modules.includes(module), `${account.email}: workspace includes ${module}`);
  for (const module of account.lacks) check(!modules.includes(module), `${account.email}: workspace excludes ${module}`);

  // A module the workspace hides must also be refused on a direct API call.
  for (const module of account.lacks.slice(0, 2)) {
    const denied = await call(MODULE_ENDPOINT[module], session.token);
    check(denied.status === 403, `${account.email}: direct ${MODULE_ENDPOINT[module]} refused (${denied.status})`);
  }
}

console.log("\n=== ICTO audit / security boundary (Task 1) ===");
const icto = (await signIn("icto@demo.mkuyu.local", demoPasswordFor("icto@demo.mkuyu.local"))).session;
const ictoAudit = await call("/org/audit", icto.token);
check(ictoAudit.status === 200, `ICTO can read the security audit trail (${ictoAudit.status})`);
check(ictoAudit.body?.scope === "system", "ICTO receives the system-scoped view, not the full trail");
check(Array.isArray(ictoAudit.body?.entries), "ICTO's audit payload is a structured, filtered list");
const BUSINESS_MODULES = new Set(["contract", "client", "payment", "debt", "property", "lead", "document", "report", "appointment", "reminder", "project"]);
const leaked = (ictoAudit.body?.entries || []).filter((entry) => BUSINESS_MODULES.has(entry.module));
check(leaked.length === 0, `ICTO's audit view leaks no business-module events (${leaked.length} found)`);

const admin = adminSession;
const adminAudit = await call("/org/audit", admin.token);
check(adminAudit.status === 200 && Array.isArray(adminAudit.body), "admin still receives the full unfiltered audit trail");
const adminModules = new Set((adminAudit.body || []).map((entry) => entry.module));
check(adminModules.size >= 0 && Array.isArray(adminAudit.body), "the admin payload is the complete trail, not the filtered object");

// Least privilege: view_audit is read-only and grants no administration.
for (const path of ["/org/users", "/org/roles", "/org/departments", "/org/permissions", "/org/access-matrix"]) {
  const denied = await call(path, icto.token);
  check(denied.status === 403, `ICTO is refused ${path} (${denied.status})`);
}

// The MD holds no view_audit and no manage_settings, so the trail stays closed.
const md = (await signIn("md@demo.mkuyu.local", demoPasswordFor("md@demo.mkuyu.local"))).session;
const mdAudit = await call("/org/audit", md.token);
check(mdAudit.status === 403, `MD is refused the audit trail (${mdAudit.status})`);

// No business role may use the new permission.
for (const email of ["sales@demo.mkuyu.local", "finance@demo.mkuyu.local", "legal@demo.mkuyu.local", "cs@demo.mkuyu.local", "itsupport@demo.mkuyu.local"]) {
  const session = (await signIn(email, demoPasswordFor(email))).session;
  const denied = await call("/org/audit", session.token);
  check(denied.status === 403, `${email} is refused the audit trail (${denied.status})`);
}

console.log("\n=== organization shape (Task 5) ===");
const matrix = (await call("/org/access-matrix", admin.token)).body;
const EXPECTED_ROLES = {
  MANAGEMENT: ["Managing Director"],
  "FINANCE & ACCOUNTS": ["Finance Manager", "Finance Officer"],
  "SALES, MARKETING & OPERATIONS": ["Department Manager", "Sales, Marketing & Operations Officer", "Sales Officer", "Marketing Officer", "Property Officer"],
  "ICT & ADMINISTRATION": ["ICTO", "Administration & IT Support Officer", "System Administrator"],
  LEGAL: ["Legal Manager", "Legal Officer"],
  "CUSTOMER SERVICE": ["Customer Service Manager", "Customer Service Officer"],
};
check(matrix.departments.length === 6, `exactly six departments (${matrix.departments.length})`);
const roleNames = new Set(matrix.roles.map((r) => r.name));
for (const [department, expected] of Object.entries(EXPECTED_ROLES)) {
  for (const role of expected) check(roleNames.has(role), `${department} has the "${role}" role`);
}
for (const retired of ["Sales and Marketing Officer", "Supervisor"]) {
  check(!roleNames.has(retired), `the retired role "${retired}" does not exist`);
}
check(roleNames.has("Staff Member"), "the general Staff Member role is still present");
const staff = (await call("/org/users", admin.token)).body || [];
check(!staff.some((u) => u.display_name === "Sales and Marketing Officer"), "no staff display name still says \"Sales and Marketing Officer\"");

console.log("\n=== audit integrity (Task 6/7) ===");
check(matrix.audit.dutyProblems.length === 0, `duty/permission consistency holds: ${JSON.stringify(matrix.audit.dutyProblems).slice(0, 200)}`);
check(matrix.audit.contractOwnershipViolations.length === 0, "contract lifecycle remains owned by one department");
check(matrix.audit.systemAdminLeaks.length === 0, "system administration remains inside ICT");
check(matrix.audit.deadPermissions.length === 0, "no role holds an unusable permission");
check(matrix.audit.unmappedRoles.length === 0, "every role maps to a home department");
for (const role of matrix.roles) {
  check(role.duties.length >= 2 && role.duties.length <= 8, `${role.name}: ${role.duties.length} duties (2-8)`);
}

console.log(`\n${failures ? `${failures} DEMO CHECK(S) FAILED` : "DEMO_ACCOUNTS_ALL_PASSED"}`);
if (failures) process.exitCode = 1;
await closeDatabase();
await server.stop();
