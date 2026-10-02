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
import { hashPassword } from "./backend/src/auth.js";

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
let ictoToken = await tokenFor("icto@demo.mkuyu.local");
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
check((await call("/org/users", ictoToken, "POST", { display_name: "Again", email: staffEmail.toUpperCase(), password: "TempPass#2026", role_ids: [roleId("Accountant")] })).status === 409, "a second account with the same email is refused clearly (409, not a crash)");
const staffId = created.body.id;

console.log("\n=== the system knows every department and every officer (CRUD) ===");
const deptId = department.body.id;
const deptRow = async () => (await call("/org/departments", adminToken)).body.find((d) => d.id === deptId);
check((await call("/org/departments", ictoToken, "POST", { name: `construction ${tag}` })).status === 409, "a duplicate department name (any case) is refused");
check((await deptRow())?.active_members === 1, "the department list counts its staff");
check((await call("/org/departments", adminToken)).body.find((d) => d.name === "CUSTOMER SERVICE")?.core === true, "core departments are marked");
const register = (await call("/org/workspace", ictoToken)).body.admin.users.find((u) => u.id === staffId);
check(register?.departments?.some((d) => d.id === deptId), "the new staff member appears under the new department in the staff register");
check((await call("/org/tasks/departments", adminToken)).body.some((d) => d.id === deptId && d.active_members === 1), "the Assignments department picker knows the new department");
check((await call("/org/tasks/assignees", adminToken)).body.some((u) => u.id === staffId && u.departments.some((d) => d.id === deptId)), "the Assignments officer list knows the new staff member and their department");
const emptyDept = await call("/org/departments", ictoToken, "POST", { name: `Surveying ${tag}` });
check(emptyDept.status === 201 && emptyDept.body.name === `SURVEYING ${tag}`.toUpperCase(), "a new department is stored in the house style (capitals)");
check((await call("/org/tasks/departments", adminToken)).body.some((d) => d.id === emptyDept.body.id && d.active_members === 0), "an empty department is still offered in Assignments (as 'no staff yet')");
const auto = await call("/org/users", ictoToken, "POST", { display_name: "Auto Dept", email: `auto.${tag}@test.mkuyu.local`, password: "TempPass#2026", role_ids: [roleId("Accountant")] });
const autoDepts = (await query("SELECT d.name FROM user_departments ud JOIN departments d ON d.id=ud.department_id WHERE ud.user_id=$1", [auto.body.id])).rows.map((r) => r.name);
check(auto.status === 201 && autoDepts.includes("FINANCE & ACCOUNTS"), `staff added without a department get their role's department (${autoDepts})`);
check((await call(`/org/users/${staffId}/departments`, ictoToken, "PUT", { department_ids: [] })).status === 400, "a staff member cannot be left without a department");
check((await call(`/org/departments/${deptId}`, ictoToken, "PUT", { active: false })).status === 409, "a department with active staff cannot be deactivated");
check((await call(`/org/departments/${deptId}`, ictoToken, "DELETE")).status === 409, "a department with staff cannot be deleted");
const csDept = (await call("/org/departments", adminToken)).body.find((d) => d.name === "CUSTOMER SERVICE");
check((await call(`/org/departments/${csDept.id}`, adminToken, "PUT", { name: "HELP DESK" })).status === 409, "a core department cannot be renamed");
check((await call(`/org/departments/${csDept.id}`, adminToken, "DELETE")).status === 409, "a core department cannot be deleted");
check((await call(`/org/departments/${deptId}`, ictoToken, "PUT", { name: `Site Works ${tag}` })).status === 200 && (await deptRow())?.name === `SITE WORKS ${tag}`.toUpperCase(), "a department is renamed and its staff stay in it");
check((await deptRow())?.active_members === 1, "(still one person in it after the rename)");
const finance = (await call("/org/departments", adminToken)).body.find((d) => d.name === "FINANCE & ACCOUNTS");
check((await call(`/org/users/${staffId}/departments`, ictoToken, "PUT", { department_ids: [finance.id] })).status === 200, "a staff member is moved to another department");
check((await call("/org/tasks/assignees", adminToken)).body.find((u) => u.id === staffId)?.departments.every((d) => d.id === finance.id), "Assignments follows the move at once");
check((await call(`/org/departments/${deptId}`, ictoToken, "PUT", { active: false })).status === 200, "the emptied department can now be deactivated");
check(!(await call("/org/tasks/departments", adminToken)).body.some((d) => d.id === deptId), "an inactive department is no longer offered in Assignments");
check((await call("/org/users", ictoToken, "POST", { display_name: "x", email: `inactive.${tag}@test.mkuyu.local`, password: "TempPass#2026", role_ids: [roleId("Accountant")], department_ids: [deptId] })).status === 400, "nobody can be added to an inactive department");
check((await call(`/org/departments/${deptId}`, ictoToken, "PUT", { active: true })).status === 200, "a department is re-activated");
check((await call(`/org/departments/${emptyDept.body.id}`, mdToken, "DELETE")).status === 403, "the MD cannot delete a department");
check((await call(`/org/departments/${emptyDept.body.id}`, ictoToken, "DELETE")).status === 200 && !(await call("/org/departments", adminToken)).body.some((d) => d.id === emptyDept.body.id), "an unused empty department is deleted");

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
check((await call(`/org/users/${ictoId}/roles`, ictoToken, "PUT", { role_ids: [roleId("ICTO"), roleId("Accountant")] })).status === 403, "ICTO cannot give themselves a business role (Accountant)");

console.log("\n=== administrators administer; they do no business ===");
for (const path of ["/clients", "/contracts", "/properties", "/org/requests", "/payments"]) {
  check((await call(path, adminToken)).status === 403, `the System Administrator is refused ${path}`);
}
const adminMeNow = (await call("/org/me", adminToken)).body;
check((adminMeNow.modules || []).length === 0 && !(adminMeNow.permissions || []).includes("submit_contract"), "the System Administrator carries no business module or contract power");
check((await call("/org/users", adminToken)).status === 200 && (await call("/org/departments", adminToken)).status === 200, "the System Administrator still runs staff and departments");
check((await call("/org/departments", adminToken)).body.every((d) => typeof d.client_count === "number"), "each department reports its client count");
const ictoRoleId = roleId("ICTO");
check((await call(`/org/users/${ictoId}/roles`, ictoToken, "PUT", { role_ids: [roleId("ICT Officer")] })).status === 200, "ICTO can move themselves to another system-administration role");
check((await call(`/org/users/${ictoId}/roles`, adminToken, "PUT", { role_ids: [ictoRoleId] })).status === 200, "(restored the ICTO role)");
check((await call("/org/me", ictoToken)).status === 401, "MK-13: after another administrator changed their role, the old session no longer works");
ictoToken = await tokenFor("icto@demo.mkuyu.local");
const ictDept = (await call("/org/departments", adminToken)).body.find((d) => d.name === "ICT & ADMINISTRATION");
check((await call(`/org/users/${ictoId}/departments`, ictoToken, "PUT", { department_ids: [ictDept.id] })).status === 200, "ICTO can move themselves between departments");
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

console.log("\n=== Add staff straight from a department ===");
const departments = (await call("/org/departments", adminToken)).body;
const deptByName = (name) => departments.find((d) => d.name === name);
const sales = deptByName("SALES, MARKETING & OPERATIONS");
check(sales?.default_role === "Sales, Marketing & Operations Officer", `Sales lists its default role (${sales?.default_role})`);
check(deptByName("MANAGEMENT")?.default_role === null, "Management has no default role");
const quickEmail = `quick.${tag}@test.mkuyu.local`;
const quick = await call(`/org/departments/${sales.id}/staff`, adminToken, "POST", { email: quickEmail, password: "TempPass#2026" });
check(quick.status === 201 && quick.body.role === "Sales, Marketing & Operations Officer", `email + password alone creates the account (${quick.status} ${quick.body.error || quick.body.role})`);
check(quick.body.display_name === `quick.${tag}`, "a blank name falls back to the email's first part");
const quickLogin = await signIn(quickEmail, "TempPass#2026");
check(quickLogin.status === 200, "the new member signs in with that password");
const quickUser = (await call("/org/users", adminToken)).body.find((u) => u.email === quickEmail) || {};
const quickMe = (await call("/org/me", quickLogin.body.token)).body;
check((quickMe.modules || []).includes("leads"), `they open straight into Sales work (modules: ${(quickMe.modules || []).join(",")})`);
check((quickUser.departments || []).map((d) => d.name).join() === "SALES, MARKETING & OPERATIONS", `they belong to Sales only (${(quickUser.departments || []).map((d) => d.name).join()})`);
check((quickUser.roles || []).map((r) => r.name ?? r).join() === "Sales, Marketing & Operations Officer", "they hold Sales' default role");
check((await call(`/org/departments/${sales.id}/staff`, adminToken, "POST", { email: quickEmail, password: "TempPass#2026" })).status === 409, "the same email cannot be added twice");
check((await call(`/org/departments/${sales.id}/staff`, adminToken, "POST", { email: `short.${tag}@test.mkuyu.local`, password: "short" })).status === 400, "a password under 8 characters is refused");
check((await call(`/org/departments/${sales.id}/staff`, adminToken, "POST", { email: `demo.${tag}@test.mkuyu.local`, password: `MkuDemo#demo${tag}2026` })).status === 400, "a password on the published MkuDemo# scheme is refused");
const quickId = (await call("/org/users", adminToken)).body.find((u) => u.email === quickEmail)?.id;
check((await call(`/org/users/${quickId}`, adminToken, "PUT", { password: `MkuDemo#quick${tag}2026` })).status === 400, "Reset password refuses the MkuDemo# scheme too");
check((await call(`/org/departments/${deptByName("MANAGEMENT").id}/staff`, adminToken, "POST", { email: `mgmt.${tag}@test.mkuyu.local`, password: "TempPass#2026" })).status === 400, "nobody is added to Management by default (no Managing Director by accident)");
check((await call(`/org/departments/${sales.id}/staff`, quickLogin.body.token, "POST", { email: `self.${tag}@test.mkuyu.local`, password: "TempPass#2026" })).status === 403, "a sales officer cannot add staff");
const extraDept = await call("/org/departments", adminToken, "POST", { name: `Field Team ${tag}` });
const extraStaff = await call(`/org/departments/${extraDept.body.id}/staff`, adminToken, "POST", { display_name: "Field Hand", email: `field.${tag}@test.mkuyu.local`, password: "TempPass#2026" });
check(extraStaff.status === 201 && extraStaff.body.role === "Staff Member", `a new department's member gets the basic Staff Member role (${extraStaff.body.error || extraStaff.body.role})`);

console.log("\n=== Change my password: the administrator only ===");
const adminPassword = legacyPasswordFor("admin@mkuyu.local");
const newAdminPassword = `Fresh#${tag}2026`;
const staffSelf = await call("/org/me/password", quickLogin.body.token, "PUT", { current_password: "TempPass#2026", new_password: "Another#2026x" });
check(staffSelf.status === 403, `a staff member cannot change their own password (${staffSelf.status})`);
check((await signIn(quickEmail, "TempPass#2026")).status === 200, "...and their password is unchanged");
const otherAdminSession = (await signIn("admin@mkuyu.local", adminPassword)).body.token;
check((await call("/org/me/password", adminToken, "PUT", { current_password: "wrong-password", new_password: newAdminPassword })).status === 400, "a wrong current password is refused");
check((await call("/org/me/password", adminToken, "PUT", { current_password: adminPassword, new_password: "short" })).status === 400, "a new password under 8 characters is refused");
check((await call("/org/me/password", adminToken, "PUT", { current_password: adminPassword, new_password: adminPassword })).status === 400, "the same password again is refused");
const changed = await call("/org/me/password", adminToken, "PUT", { current_password: adminPassword, new_password: newAdminPassword });
check(changed.status === 200, `the administrator changes their own password (${changed.status} ${changed.body.error || ""})`);
check((await call("/org/users", adminToken)).status === 200, "this browser stays signed in");
check((await call("/org/users", otherAdminSession)).status === 401, "every other admin session is signed out");
check((await signIn("admin@mkuyu.local", adminPassword)).status !== 200, "the old password no longer works");
check((await signIn("admin@mkuyu.local", newAdminPassword)).status === 200, "the new password works");
// Put the seeded password back so the next run (and other suites) can sign in.
await query("UPDATE users SET password_hash=$1 WHERE email='admin@mkuyu.local'", [hashPassword(adminPassword)]);

// Tidy the throwaway database. Every name carries a unique tag, so a leftover
// row (say, one an audit entry still references) never breaks a rerun.
for (const [sql, value] of [
  ["DELETE FROM users WHERE email LIKE $1", `%.${tag}@test.mkuyu.local`],
  ["DELETE FROM roles WHERE id=$1", custom.body.id],
  ["DELETE FROM departments WHERE id=$1", department.body.id],
  ["DELETE FROM departments WHERE id=$1", extraDept.body.id],
]) {
  try { await query(sql, [value]); } catch { /* left for the next database reset */ }
}

console.log(`\n${failures ? `${failures} STAFF ADMIN CHECK(S) FAILED` : "STAFF_ADMIN_ALL_PASSED"}`);
if (failures) process.exitCode = 1;
await closeDatabase();
await server.stop();
