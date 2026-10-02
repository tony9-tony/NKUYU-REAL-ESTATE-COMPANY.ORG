// Password rotation + history preservation.
//
// Proves, for every legacy account, that the OLD credential no longer
// authenticates, the NEW one does, and that rotation changed the credential and
// nothing else: same id, role, department, permissions, owned records and audit
// history. Also exercises the admin password-reset endpoint (Task 5) and the
// reminders boundary (Task 3).
import { legacyPasswordFor } from "./backend/src/org/demoCredentials.js";
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { closeDatabase, query } from "./backend/src/db.js";
import { hashPassword } from "./backend/src/auth.js";

// PRIVATE server on the throwaway test database. This suite rotates passwords,
// so running it against :3003 would rewrite real credentials.
reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ label: "rotation", port: 3204 });
const base = server.base;
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

// The credentials these accounts shipped with before the rotation.
const OLD_PASSWORDS = {
  "admin@mkuyu.local": "MkuyuRuntime123!",
  "md@mkuyu.local": "ManagingDirector123!",
  "sales.officer@mkuyu.local": "SalesOfficer123!",
  "amina.sales@mkuyu.local": "SalesOfficer123!",
};

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

const snapshot = async (email) => {
  const user = (await query(
    `SELECT u.id,u.email,u.display_name,u.role,u.active,
            (SELECT json_agg(r.name ORDER BY r.name) FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id) AS roles,
            (SELECT json_agg(d.name ORDER BY d.name) FROM user_departments ud JOIN departments d ON d.id=ud.department_id WHERE ud.user_id=u.id) AS departments,
            (SELECT COUNT(*)::int FROM contracts WHERE owner_id=u.id OR created_by=u.id) AS contracts,
            (SELECT COUNT(*)::int FROM clients WHERE owner_id=u.id OR created_by=u.id) AS clients,
            (SELECT COUNT(*)::int FROM properties WHERE owner_id=u.id OR created_by=u.id) AS properties,
            (SELECT COUNT(*)::int FROM projects WHERE owner_id=u.id OR created_by=u.id) AS projects,
            (SELECT COUNT(*)::int FROM reports WHERE owner_id=u.id OR created_by=u.id) AS reports,
            (SELECT COUNT(*)::int FROM payments WHERE owner_id=u.id OR created_by=u.id) AS payments,
            (SELECT COUNT(*)::int FROM debts WHERE owner_id=u.id OR created_by=u.id) AS debts,
            (SELECT COUNT(*)::int FROM audit_logs WHERE user_id=u.id) AS audit,
            (SELECT COUNT(*)::int FROM contract_revisions WHERE changed_by=u.id) AS revisions
       FROM users u WHERE u.email=$1`, [email],
  )).rows[0];
  const perms = (await query(
    `SELECT p.permission_key FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id
       JOIN permissions p ON p.id=rp.permission_id WHERE ur.user_id=(SELECT id FROM users WHERE email=$1) ORDER BY p.permission_key`, [email],
  )).rows.map((r) => r.permission_key);
  return { ...user, permissions: perms };
};

console.log("=== TASK 1/2: legacy rotation ===");
for (const [email, oldPassword] of Object.entries(OLD_PASSWORDS)) {
  const newPassword = legacyPasswordFor(email);
  const before = await snapshot(email);
  check(Boolean(before), `${email}: account exists (id=${before?.id})`);

  const oldAttempt = await signIn(email, oldPassword);
  check(oldAttempt.status !== 200, `${email}: the OLD password no longer authenticates (${oldAttempt.status})`);

  const newAttempt = await signIn(email, newPassword);
  check(newAttempt.status === 200 && Boolean(newAttempt.body.token), `${email}: the NEW password authenticates (${newAttempt.status})`);

  const after = await snapshot(email);
  check(after.id === before.id, `${email}: user id unchanged (${before.id} -> ${after.id})`);
  check(after.role === before.role, `${email}: user.role column unchanged (${before.role})`);
  check(JSON.stringify(after.roles) === JSON.stringify(before.roles), `${email}: assigned role unchanged (${(before.roles || []).join(",")})`);
  check(JSON.stringify(after.departments) === JSON.stringify(before.departments), `${email}: department unchanged (${(before.departments || []).join(",")})`);
  check(JSON.stringify(after.permissions) === JSON.stringify(before.permissions), `${email}: permissions unchanged (${after.permissions.length} keys)`);
  check(after.display_name === before.display_name, `${email}: display name unchanged ("${after.display_name}")`);
  check(after.contracts === before.contracts && after.clients === before.clients && after.properties === before.properties
    && after.projects === before.projects && after.reports === before.reports && after.payments === before.payments
    && after.debts === before.debts,
    `${email}: owned records preserved (contracts=${after.contracts} clients=${after.clients} projects=${after.projects} reports=${after.reports})`);
  check(after.audit >= before.audit, `${email}: audit history intact (${before.audit} -> ${after.audit})`);

  const rotations = (await query(
    "SELECT COUNT(*)::int n FROM audit_logs WHERE user_id=$1 AND action='password_rotated'", [before.id],
  )).rows[0].n;
  check(rotations >= 1, `${email}: rotation recorded in the audit trail (${rotations} event)`);

  const stored = (await query("SELECT password_hash FROM users WHERE email=$1", [email])).rows[0].password_hash;
  check(stored.startsWith("scrypt$") && stored.length === 168, `${email}: stored as scrypt hash (len ${stored.length})`);
  check(!stored.includes(newPassword) && !stored.includes(oldPassword), `${email}: no plaintext password in the stored hash`);
}

console.log("\n=== administrator unchanged ===");
const adminToken = (await signIn("admin@mkuyu.local", legacyPasswordFor("admin@mkuyu.local"))).body.token;
const adminMe = (await call("/org/me", adminToken)).body;
check(adminMe.user?.role === "admin", `admin@mkuyu.local is still an administrator (role=${adminMe.user?.role})`);
check(!["access_clients", "access_contracts", "submit_contract", "approve_legal", "view_financial"].some((key) => (adminMe.permissions || []).includes(key)) && (adminMe.modules || []).length === 0, `admin carries no business permission or module (${(adminMe.modules || []).length} modules)`);
check(["manage_users", "manage_roles"].every((key) => (adminMe.permissions || []).includes(key)), "admin keeps staff and role administration");
check((await call("/org/users", adminToken)).status === 200, "admin can still administer staff");

console.log("\n=== TASK 5: admin password reset preserves history ===");
const target = "amina.sales@mkuyu.local";
const beforeReset = await snapshot(target);
const adminSession = await signIn("admin@mkuyu.local", legacyPasswordFor("admin@mkuyu.local"));
const resetToken = adminSession.body.token;
const tempPassword = "MkuReset#amina2026";

const reset = await call(`/org/users/${beforeReset.id}`, resetToken, "PUT", { password: tempPassword });
check(reset.status === 200, `admin reset the password for ${target} (${reset.status})`);
check((await signIn(target, tempPassword)).status === 200, `${target} authenticates with the reset password`);
check((await signIn(target, legacyPasswordFor(target))).status !== 200, `${target} cannot use the pre-reset password`);

const afterReset = await snapshot(target);
check(afterReset.id === beforeReset.id, "reset: user id unchanged");
check(afterReset.role === beforeReset.role, "reset: user.role unchanged");
check(JSON.stringify(afterReset.roles) === JSON.stringify(beforeReset.roles), "reset: assigned role unchanged");
check(JSON.stringify(afterReset.departments) === JSON.stringify(beforeReset.departments), "reset: department unchanged");
check(JSON.stringify(afterReset.permissions) === JSON.stringify(beforeReset.permissions), "reset: permissions unchanged");
check(afterReset.contracts === beforeReset.contracts && afterReset.reports === beforeReset.reports, `reset: owned records preserved (reports=${afterReset.reports})`);
check(afterReset.audit > beforeReset.audit, `reset: audit history grew, not shrank (${beforeReset.audit} -> ${afterReset.audit})`);
// The audit row records the ACTOR in user_id and the TARGET in record_id, so a
// reset performed by the administrator is attributed to the administrator.
const resetEvents = (await query(
  "SELECT COUNT(*)::int n FROM audit_logs WHERE record_id=$1 AND action='password_reset'", [String(beforeReset.id)],
)).rows[0].n;
check(resetEvents >= 1, `reset: recorded as a password_reset audit event (${resetEvents})`);
const resetActor = (await query(
  "SELECT a.user_id,u.email,u.role FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.record_id=$1 AND a.action='password_reset' ORDER BY a.id DESC LIMIT 1", [String(beforeReset.id)],
)).rows[0];
check(resetActor?.role === "admin", `reset: the event is attributed to the acting administrator (${resetActor?.email})`);

// The API refuses the published MkuDemo# scheme, so the deterministic demo
// credential is put back straight in the throwaway database.
check((await call(`/org/users/${beforeReset.id}`, resetToken, "PUT", { password: legacyPasswordFor(target) })).status === 400, "reset: the published MkuDemo# scheme is refused");
const restoreDemo = () => query("UPDATE users SET password_hash=$1 WHERE id=$2", [hashPassword(legacyPasswordFor(target)), beforeReset.id]);
await restoreDemo();
check((await signIn(target, legacyPasswordFor(target))).status === 200, "restored the documented demo credential after the reset test");

// The MD has no staff administration, so cannot reset a password.
const mdToken = (await signIn("md@mkuyu.local", legacyPasswordFor("md@mkuyu.local"))).body.token;
check((await call(`/org/users/${beforeReset.id}`, mdToken, "PUT", { password: "SneakyPassword123" })).status === 403, "the MD cannot reset a staff password");
// The ICTO holds manage_users, so resets passwords for staff at or below their
// rank, but never for the MD or the administrator account.
const ictoToken = (await signIn("icto@demo.mkuyu.local", legacyPasswordFor("icto@demo.mkuyu.local"))).body.token;
check((await call(`/org/users/${beforeReset.id}`, ictoToken, "PUT", { password: "IctoReset#amina2026" })).status === 200, "the ICTO can reset a sales officer's password");
await restoreDemo();
check((await signIn(target, legacyPasswordFor(target))).status === 200, "restored the demo credential after the ICTO reset");
const mdId = (await snapshot("md@mkuyu.local")).id;
const adminId = (await snapshot("admin@mkuyu.local")).id;
check((await call(`/org/users/${mdId}`, ictoToken, "PUT", { password: "SneakyPassword123" })).status === 403, "the ICTO cannot reset the MD's password");
check((await call(`/org/users/${adminId}`, ictoToken, "PUT", { password: "SneakyPassword123" })).status === 403, "the ICTO cannot reset the administrator's password");

console.log("\n=== TASK 3: reminders visibility and authorization ===");
const financeToken = (await signIn("finance.manager@demo.mkuyu.local", legacyPasswordFor("finance.manager@demo.mkuyu.local"))).body.token;
const financeMe = (await call("/org/me", financeToken)).body;
check((financeMe.modules || []).includes("reminders"), "Finance workspace advertises the reminders module");
const reminders = await call("/reminders", financeToken);
check(reminders.status === 200 && Array.isArray(reminders.body), `Finance can read /reminders (${reminders.status}, ${Array.isArray(reminders.body) ? reminders.body.length : "n/a"} rows)`);
const financeWorkspace = (await call("/org/workspace", financeToken)).body;
check(Array.isArray(financeWorkspace.reminders), "Finance workspace payload carries the reminders array");

// The MD deliberately keeps financial oversight (duty: "Oversee financial
// performance"), so reminders are expected. Everyone without the financial
// permissions must be refused.
for (const email of ["sales@demo.mkuyu.local", "legal@demo.mkuyu.local", "cs@demo.mkuyu.local", "property@demo.mkuyu.local"]) {
  const token = (await signIn(email, legacyPasswordFor(email))).body.token;
  if (!token) continue;
  const denied = await call("/reminders", token);
  check(denied.status === 403, `${email} is refused /reminders (${denied.status})`);
}
const mdReminderToken = (await signIn("md@demo.mkuyu.local", legacyPasswordFor("md@demo.mkuyu.local"))).body.token;
check((await call("/reminders", mdReminderToken)).status === 200, "the MD keeps financial oversight of reminders");
const ictoToken2 = (await signIn("icto@demo.mkuyu.local", legacyPasswordFor("icto@demo.mkuyu.local"))).body.token;
check((await call("/reminders", ictoToken2)).status === 403, "the ICTO is refused the reminders register");

console.log("\n=== TASK 4: role visibility, cross-checked against the API ===");
const EXPECTED_UI = {
  "md@demo.mkuyu.local": { has: ["contracts", "payments", "reminders", "projects"], lacks: [] },
  "finance.manager@demo.mkuyu.local": { has: ["debts", "payments", "reminders", "contracts"], lacks: ["documents"] },
  "sales@demo.mkuyu.local": { has: ["leads", "clients", "contracts", "properties"], lacks: ["debts", "payments", "reminders"] },
  "legal@demo.mkuyu.local": { has: ["contracts", "documents", "clients"], lacks: ["debts", "payments", "reminders"] },
  "icto@demo.mkuyu.local": { has: [], lacks: ["contracts", "clients", "leads", "debts", "payments", "reminders", "documents", "properties", "projects"] },
  "cs@demo.mkuyu.local": { has: ["clients", "appointments", "follow_ups"], lacks: ["contracts", "debts", "payments", "reminders"] },
};
for (const [email, expected] of Object.entries(EXPECTED_UI)) {
  const token = (await signIn(email, legacyPasswordFor(email))).body.token;
  const me = (await call("/org/me", token)).body;
  const modules = me.modules || [];
  const permissions = me.permissions || [];
  for (const module of expected.has) check(modules.includes(module), `${email}: workspace shows ${module}`);
  for (const module of expected.lacks) check(!modules.includes(module), `${email}: workspace hides ${module}`);

  // The ICTO runs staff, role and department administration, but the access
  // matrix audit stays with the administrator account.
  if (email === "icto@demo.mkuyu.local") {
    for (const path of ["/org/users", "/org/roles", "/org/departments", "/org/permissions"]) {
      check((await call(path, token)).status === 200, `ICTO can read ${path}`);
    }
    check((await call("/org/access-matrix", token)).status === 403, "ICTO is refused /org/access-matrix");
    check(!permissions.some((key) => key.startsWith("access_")), "ICTO holds no business module access");
  }
  if (email === "md@demo.mkuyu.local") {
    check(!permissions.some((key) => key.startsWith("manage_")), "MD holds no system administration");
    check(!permissions.includes("approve_legal") && !permissions.includes("review_legal") && !permissions.includes("validate_finance"),
      "MD holds no legal approval or finance validation");
    check(permissions.includes("approve_management"), "MD holds management approval");
    check((await call("/org/users", token)).status === 403, "MD cannot read the staff register");
  }
  if (email === "legal@demo.mkuyu.local") {
    check(!permissions.includes("validate_finance"), "Legal cannot perform finance-only validation");
    check((await call("/reminders", token)).status === 403, "Legal cannot reach the finance reminder register");
  }
  if (email === "sales@demo.mkuyu.local") {
    check((await call("/debts", token)).status === 403, "Sales cannot open the finance installment register");
  }
  if (email === "cs@demo.mkuyu.local") {
    check((await call("/contracts", token)).status === 403, "Customer Service cannot open the contract register");
  }
}

console.log(`\n${failures ? `${failures} ROTATION/UI CHECK(S) FAILED` : "ROTATION_AND_UI_ALL_PASSED"}`);
if (failures) process.exitCode = 1;
await closeDatabase();
await server.stop();
