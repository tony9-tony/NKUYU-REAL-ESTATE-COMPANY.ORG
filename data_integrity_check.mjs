// Data integrity: loads every backend module, re-checks the row-count baseline
// captured before this phase's migration, and proves no relationship was orphaned.
//
// DELIBERATELY EXEMPT FROM THE TEST ISOLATION GUARD, and run WITHOUT
// `node --import ./test_support/guard.mjs`.
//
// Every other suite is repointed at the throwaway `mkuyu_org_test` database. This
// one must NOT be: its whole purpose is to assert that the REAL workspace still
// holds its business records, so pointing it at an empty throwaway database would
// make it report "DATA LOST" for every resource and prove nothing.
//
// It is read-only. It signs in (which writes one session row) and then only
// SELECTs, so it cannot damage the data it is checking. Do not add writes here.
const targets = [
  "./backend/src/org/duties.js",
  "./backend/src/contracts/workflow.js",
  "./backend/src/models/contract.js",
  "./backend/src/migrate.js",
  "./backend/src/routes/api.js",
  "./backend/src/routes/org.js",
];
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

for (const target of targets) {
  try {
    await import(target);
    check(true, `loads ${target}`);
  } catch (error) {
    check(false, `loads ${target}: ${error.message}`);
  }
}
if (failures) { console.log(`\n${failures} MODULE(S) FAILED TO LOAD`); process.exit(1); }

const base = "http://localhost:3003/api/v1";
import { legacyPasswordFor } from "./backend/src/org/demoCredentials.js";

const login = await fetch(`${base}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "admin@mkuyu.local", password: legacyPasswordFor("admin@mkuyu.local") }),
});
const session = await login.json();
if (!session.token) { console.log("FAIL  admin login"); process.exit(1); }
const auth = { Authorization: `Bearer ${session.token}` };

// Baseline recorded before the duties migration and demo seeding.
const BASELINE = { contracts: 27, clients: 52, projects: 29, properties: 47, payments: 26, debts: 122, documents: 19 };
console.log("\nresource      baseline   now   status");
for (const [resource, before] of Object.entries(BASELINE)) {
  const rows = await (await fetch(`${base}/${resource}`, { headers: auth })).json();
  const now = Array.isArray(rows) ? rows.length : -1;
  const ok = now >= before;
  if (!ok) failures += 1;
  console.log(`${resource.padEnd(13)} ${String(before).padStart(9)} ${String(now).padStart(5)}   ${ok ? "ok" : "DATA LOST"}`);
}

const { query, closeDatabase } = await import("./backend/src/db.js");
const ORPHANS = {
  "user_roles -> users": "SELECT COUNT(*)::int AS n FROM user_roles ur LEFT JOIN users u ON u.id=ur.user_id WHERE u.id IS NULL",
  "user_roles -> roles": "SELECT COUNT(*)::int AS n FROM user_roles ur LEFT JOIN roles r ON r.id=ur.role_id WHERE r.id IS NULL",
  "user_departments -> users": "SELECT COUNT(*)::int AS n FROM user_departments ud LEFT JOIN users u ON u.id=ud.user_id WHERE u.id IS NULL",
  "user_departments -> departments": "SELECT COUNT(*)::int AS n FROM user_departments ud LEFT JOIN departments d ON d.id=ud.department_id WHERE d.id IS NULL",
  "role_permissions -> roles": "SELECT COUNT(*)::int AS n FROM role_permissions rp LEFT JOIN roles r ON r.id=rp.role_id WHERE r.id IS NULL",
  "role_permissions -> permissions": "SELECT COUNT(*)::int AS n FROM role_permissions rp LEFT JOIN permissions p ON p.id=rp.permission_id WHERE p.id IS NULL",
  "duties -> roles": "SELECT COUNT(*)::int AS n FROM duties d LEFT JOIN roles r ON r.id=d.role_id WHERE r.id IS NULL",
  "duty_permissions -> duties": "SELECT COUNT(*)::int AS n FROM duty_permissions dp LEFT JOIN duties d ON d.id=dp.duty_id WHERE d.id IS NULL",
  "duty_permissions -> permissions": "SELECT COUNT(*)::int AS n FROM duty_permissions dp LEFT JOIN permissions p ON p.id=dp.permission_id WHERE p.id IS NULL",
  "contracts -> projects": "SELECT COUNT(*)::int AS n FROM contracts c LEFT JOIN projects p ON p.id=c.project_id WHERE p.id IS NULL",
  "contracts -> clients": "SELECT COUNT(*)::int AS n FROM contracts c LEFT JOIN clients cl ON cl.id=c.client_id WHERE c.client_id IS NOT NULL AND cl.id IS NULL",
  "contracts -> properties": "SELECT COUNT(*)::int AS n FROM contracts c LEFT JOIN properties pr ON pr.id=c.property_id WHERE c.property_id IS NOT NULL AND pr.id IS NULL",
  "debts -> contracts": "SELECT COUNT(*)::int AS n FROM debts d LEFT JOIN contracts c ON c.id=d.contract_id WHERE c.id IS NULL",
  "payments -> contracts": "SELECT COUNT(*)::int AS n FROM payments p LEFT JOIN contracts c ON c.id=p.contract_id WHERE c.id IS NULL",
  "documents -> contracts": "SELECT COUNT(*)::int AS n FROM documents d LEFT JOIN contracts c ON c.id=d.contract_id WHERE d.contract_id IS NOT NULL AND c.id IS NULL",
  "contract_revisions -> contracts": "SELECT COUNT(*)::int AS n FROM contract_revisions r LEFT JOIN contracts c ON c.id=r.contract_id WHERE c.id IS NULL",
  "record_shares -> users": "SELECT COUNT(*)::int AS n FROM record_shares rs LEFT JOIN users u ON u.id=rs.user_id WHERE rs.user_id IS NOT NULL AND u.id IS NULL",
  "user_roles -> no user at all": "SELECT COUNT(*)::int AS n FROM users u WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id) AND u.organization_id=1 AND u.role='staff'",
};
console.log("");
for (const [label, sql] of Object.entries(ORPHANS)) {
  const result = (await query(sql)).rows[0].n;
  check(result === 0, `no orphans: ${label} (${result})`);
}

console.log(`\n${failures ? `${failures} INTEGRITY CHECK(S) FAILED` : "DATA_INTEGRITY_OK"}`);
if (failures) process.exitCode = 1;
await closeDatabase();
