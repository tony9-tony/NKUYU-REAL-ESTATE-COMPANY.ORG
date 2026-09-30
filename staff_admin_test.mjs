// Staff administration by duty.
//
// The ICT roles (ICTO today, ICT Officer in the small-office structure) hold
// manage_users / manage_roles / manage_permissions, so they run staff,
// departments and roles without the break-glass administrator account. This
// suite proves both halves: what they CAN do, and every line they can never
// cross - nobody, themselves included, is lifted above their own rank, and the
// contract decision points and system administration are never handed out.
import { legacyPasswordFor } from "./backend/src/org/demoCredentials.js";
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { closeDatabase, query } from "./backend/src/db.js";

reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ label: "staff-admin", port: 3216 });
const base = server.base;
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

const signIn = async (email, password) => {
  const response = await fetch(`${base}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const call = async (path, token, method = "GET", body) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const tokenFor = async (email) => (await signIn(email, legacyPasswordFor(email))).body.token;

const tag = Date.now().toString(36);
const adminToken = await tokenFor("admin@mkuyu.local");
const ictoToken = await tokenFor("icto@demo.mkuyu.local");
const mdToken = await tokenFor("md@demo.mkuyu.local");
check(Boolean(adminToken && ictoToken && mdToken), "administrator, ICTO and MD sign in");

const roles = (await call("/org/roles", adminToken)).body;
const roleId = (name) => roles.find((role) => role.name === name)?.id;
const userId = async (email) => (await query("SELECT id FROM users WHERE email=$1", [email])).rows[0]?.id;
const ictoId = await userId("icto@demo.mkuyu.local");
const mdId = await userId("md@demo.mkuyu.local");

console.log("\n=== the ICTO reaches staff administration ===");
const workspace = (await call("/org/workspace", ictoToken)).body;
check(Array.isArray(workspace.admin?.users) && workspace.admin.users.length > 0, `workspace carries the staff register (${workspace.admin?.users?.length})`);
check(workspace.admin.users.every((user) => Array.isArray(user.roles) && Array.isArray(user.departments)), "each staff row carries its roles and departments");
check((workspace.admin.permissions || []).some((permission) => permission.permission_key === "view"), "workspace carries the permission catalogue");

console.log("\n=== departments ===");
const department = await call("/org/departments", ictoToken, "POST", { name: `CONSTRUCTION ${tag}` });
check(department.status === 201, `ICTO adds a department (${department.status})`);
check((await call(`/org/departments/${department.body.id}`, ictoToken, "PUT", { description: "Site work" })).status === 200, "ICTO edits the department");
check((await call("/org/departments", mdToken, "POST", { name: `MD DEPT ${tag}` })).status === 403, "the MD cannot add a department");

console.log("\n=== staff accounts ===");
const staffEmail = `site.${tag}@test.mkuyu.local`;
const created = await call("/org/users", ictoToken, "POST", {
  display_name: "Site Clerk", email: staffEmail, password: "TempPass#2026",
  role_ids: [roleId("Accountant")], department_ids: [department.body.id],
});
check(created.status === 201, `ICTO creates a staff account in the new department (${created.status})`);
check((await signIn(staffEmail, "TempPass#2026")).status === 200, "the new staff member can sign in");
const staffId = created.body.id;

for (const role of ["Managing Director", "System Administrator"]) {
  const refused = await call("/org/users", ictoToken, "POST", {
    display_name: "Escalation", email: `esc.${tag}.${roleId(role)}@test.mkuyu.local`, password: "TempPass#2026", role_ids: [roleId(role)],
  });
  check(refused.status === 403, `ICTO cannot create an account with the "${role}" role (${refused.status})`);
}
check((await call("/org/users", mdToken, "POST", { display_name: "x", email: `md.${tag}@test.mkuyu.local`, password: "TempPass#2026", role_ids: [roleId("Accountant")] })).status === 403,
  "the MD cannot create staff");

console.log("\n=== custom roles ===");
const custom = await call("/org/roles", ictoToken, "POST", { name: `Site Supervisor ${tag}`, rank: 20, scope: "department" });
check(custom.status === 201, `ICTO creates a role at or below their rank (${custom.status})`);
check((await call("/org/roles", ictoToken, "POST", { name: `Director ${tag}`, rank: 90 })).status === 403, "ICTO cannot create a role ranked above their own");
check((await call(`/org/roles/${custom.body.id}`, ictoToken, "PUT", { rank: 90 })).status === 403, "ICTO cannot raise a role above their own rank");
check((await call(`/org/roles/${custom.body.id}/permissions`, ictoToken, "PUT", { permissions: ["view", "access_projects"] })).status === 200, "ICTO sets permissions on the custom role");
for (const key of ["approve_management", "approve_legal", "validate_finance", "manage_users", "view_audit"]) {
  const refused = await call(`/org/roles/${custom.body.id}/permissions`, ictoToken, "PUT", { permissions: ["view", key] });
  check(refused.status === 403, `ICTO cannot grant ${key} (${refused.status})`);
}
check((await call(`/org/roles/${roleId("Accountant")}/permissions`, ictoToken, "PUT", { permissions: ["view"] })).status === 403, "ICTO cannot rewrite a built-in role's permissions");
check((await call(`/org/roles/${roleId("ICTO")}`, ictoToken, "PUT", { rank: 30 })).status === 403, "ICTO cannot edit the built-in role they hold");

console.log("\n=== changing someone's access ===");
check((await call(`/org/users/${staffId}/roles`, ictoToken, "PUT", { role_ids: [custom.body.id] })).status === 200, "ICTO moves the staff member to the custom role");
check((await call(`/org/users/${staffId}/roles`, ictoToken, "PUT", { role_ids: [roleId("Managing Director")] })).status === 403, "ICTO cannot promote anyone to Managing Director");
check((await call(`/org/users/${staffId}`, ictoToken, "PUT", { active: false })).status === 200, "ICTO deactivates the staff member");
check((await call(`/org/users/${mdId}`, ictoToken, "PUT", { active: false })).status === 403, "ICTO cannot deactivate the MD");
check((await call(`/org/users/${mdId}/departments`, ictoToken, "PUT", { department_ids: [department.body.id] })).status === 403, "ICTO cannot move the MD between departments");

console.log("\n=== the ICTO's own account ===");
check((await call(`/org/users/${ictoId}/roles`, ictoToken, "PUT", { role_ids: [roleId("ICTO"), roleId("Accountant")] })).status === 403, "ICTO cannot change their own roles");
check((await call(`/org/users/${ictoId}`, ictoToken, "PUT", { active: false })).status === 403, "ICTO cannot deactivate themselves");
const ictoRoles = (await query("SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1", [ictoId])).rows.map((row) => row.name);
check(ictoRoles.length === 1 && ictoRoles[0] === "ICTO", `the ICTO's roles are unchanged (${ictoRoles.join(",")})`);

console.log("\n=== the new ICT Officer role works the same way ===");
const officerEmail = `ict.officer.${tag}@test.mkuyu.local`;
const officer = await call("/org/users", adminToken, "POST", { display_name: "ICT Officer", email: officerEmail, password: "TempPass#2026", role_ids: [roleId("ICT Officer")] });
check(officer.status === 201, "the administrator creates an ICT Officer account");
const officerToken = (await signIn(officerEmail, "TempPass#2026")).body.token;
check((await call("/org/users", officerToken, "POST", { display_name: "CS", email: `cs.${tag}@test.mkuyu.local`, password: "TempPass#2026", role_ids: [roleId("Customer Service Officer")] })).status === 201,
  "the ICT Officer creates a Customer Service Officer");
check((await call("/org/users", officerToken, "POST", { display_name: "MD", email: `md2.${tag}@test.mkuyu.local`, password: "TempPass#2026", role_ids: [roleId("Managing Director")] })).status === 403,
  "the ICT Officer cannot create a Managing Director");

console.log("\n=== the administrator keeps full authority ===");
const mdAccount = await call("/org/users", adminToken, "POST", { display_name: "Deputy MD", email: `deputy.${tag}@test.mkuyu.local`, password: "TempPass#2026", role_ids: [roleId("Managing Director")] });
check(mdAccount.status === 201, "the administrator can still create a Managing Director account");

// Tidy the throwaway database. Every name carries a unique tag, so a leftover
// row (say, one an audit entry still references) never breaks a rerun.
for (const [sql, value] of [
  ["DELETE FROM users WHERE email LIKE $1", `%.${tag}@test.mkuyu.local`],
  ["DELETE FROM roles WHERE id=$1", custom.body.id],
  ["DELETE FROM departments WHERE id=$1", department.body.id],
]) {
  try { await query(sql, [value]); } catch { /* left for the next database reset */ }
}

console.log(`\n${failures ? `${failures} STAFF ADMIN CHECK(S) FAILED` : "STAFF_ADMIN_ALL_PASSED"}`);
if (failures) process.exitCode = 1;
await closeDatabase();
await server.stop();
