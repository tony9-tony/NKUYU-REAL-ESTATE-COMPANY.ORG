// Inspects every account: current role, department, permission set, owned records
// and audit history, so the rotation is based on what the database says rather
// than on assumptions.
import { query, closeDatabase } from "./backend/src/db.js";

const roles = (await query("SELECT id,name FROM roles WHERE organization_id=1 ORDER BY rank DESC,name")).rows;
const departments = (await query("SELECT id,name FROM departments WHERE organization_id=1 ORDER BY name")).rows;
const roleIds = new Set(roles.map((r) => r.id));
const deptIds = new Set(departments.map((d) => d.id));

const users = (await query(
  "SELECT id,email,display_name,role,active,LEFT(password_hash,7) AS hash_scheme,LENGTH(password_hash) AS hash_len FROM users WHERE organization_id=1 ORDER BY id",
)).rows;

console.log(`=== ${users.length} accounts ===\n`);
for (const user of users) {
  const userRoles = (await query(
    "SELECT r.id,r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1 ORDER BY r.rank DESC", [user.id],
  )).rows;
  const userDepts = (await query(
    "SELECT d.id,d.name FROM user_departments ud JOIN departments d ON d.id=ud.department_id WHERE ud.user_id=$1", [user.id],
  )).rows;
  const perms = (await query(
    `SELECT p.permission_key FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id
       JOIN permissions p ON p.id=rp.permission_id WHERE ur.user_id=$1 ORDER BY p.permission_key`, [user.id],
  )).rows.map((r) => r.permission_key);
  const owned = {};
  for (const [label, sql] of Object.entries({
    contracts: "SELECT COUNT(*)::int n FROM contracts WHERE owner_id=$1 OR created_by=$1",
    clients: "SELECT COUNT(*)::int n FROM clients WHERE owner_id=$1 OR created_by=$1",
    properties: "SELECT COUNT(*)::int n FROM properties WHERE owner_id=$1 OR created_by=$1",
    projects: "SELECT COUNT(*)::int n FROM projects WHERE owner_id=$1 OR created_by=$1",
    payments: "SELECT COUNT(*)::int n FROM payments WHERE owner_id=$1 OR created_by=$1",
    documents: "SELECT COUNT(*)::int n FROM documents WHERE owner_id=$1 OR created_by=$1",
    reports: "SELECT COUNT(*)::int n FROM reports WHERE owner_id=$1 OR created_by=$1",
    audit_events: "SELECT COUNT(*)::int n FROM audit_logs WHERE user_id=$1",
    sessions: "SELECT COUNT(*)::int n FROM sessions WHERE user_id=$1",
  })) {
    owned[label] = (await query(sql, [user.id])).rows[0].n;
  }

  const invalidRole = userRoles.filter((r) => !roleIds.has(r.id)).length;
  const invalidDept = userDepts.filter((d) => !deptIds.has(d.id)).length;

  console.log(`id=${user.id}  ${user.email}`);
  console.log(`  display_name : ${user.display_name}`);
  console.log(`  user.role    : ${user.role}${user.role === "admin" ? "  (administrator)" : "  (staff)"}`);
  console.log(`  active       : ${user.active}   hash=${user.hash_scheme}... len=${user.hash_len}`);
  console.log(`  roles        : ${userRoles.map((r) => `${r.name}#${r.id}`).join(", ") || "NONE"}${invalidRole ? "  !! INVALID ROLE REF" : ""}`);
  console.log(`  departments  : ${userDepts.map((d) => `${d.name}#${d.id}`).join(", ") || "NONE"}${invalidDept ? "  !! INVALID DEPT REF" : ""}`);
  console.log(`  permissions  : ${perms.length}`);
  console.log(`     ${perms.join(", ") || "none"}`);
  console.log(`  owned/history: ${JSON.stringify(owned)}`);
  console.log("");
}
await closeDatabase();
