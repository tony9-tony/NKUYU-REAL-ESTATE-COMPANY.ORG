// Compact account census: classifies every row as real staff, demo seed, or
// leftover test artifact, with the record counts needed to decide safe handling.
import { query, closeDatabase } from "./backend/src/db.js";

const users = (await query(
  "SELECT id,email,display_name,role FROM users WHERE organization_id=1 ORDER BY id",
)).rows;

const bucket = (email) => {
  if (email.startsWith("matrix.")) return "test-artifact";
  if (email.endsWith("@demo.mkuyu.local")) return "demo-seed";
  return "REAL-STAFF";
};

const groups = { "REAL-STAFF": [], "demo-seed": [], "test-artifact": [] };
for (const user of users) groups[bucket(user.email)].push(user);

for (const [name, list] of Object.entries(groups)) {
  console.log(`\n=== ${name} (${list.length}) ===`);
  for (const user of list) {
    const owned = (await query(
      `SELECT
         (SELECT COUNT(*)::int FROM contracts WHERE owner_id=$1 OR created_by=$1) AS contracts,
         (SELECT COUNT(*)::int FROM clients WHERE owner_id=$1 OR created_by=$1) AS clients,
         (SELECT COUNT(*)::int FROM properties WHERE owner_id=$1 OR created_by=$1) AS properties,
         (SELECT COUNT(*)::int FROM projects WHERE owner_id=$1 OR created_by=$1) AS projects,
         (SELECT COUNT(*)::int FROM payments WHERE owner_id=$1 OR created_by=$1) AS payments,
         (SELECT COUNT(*)::int FROM debts WHERE owner_id=$1 OR created_by=$1) AS debts,
         (SELECT COUNT(*)::int FROM documents WHERE owner_id=$1 OR created_by=$1) AS documents,
         (SELECT COUNT(*)::int FROM reports WHERE owner_id=$1 OR created_by=$1) AS reports,
         (SELECT COUNT(*)::int FROM leads WHERE assigned_to=$1) AS leads,
         (SELECT COUNT(*)::int FROM follow_ups WHERE assigned_to=$1) AS follow_ups,
         (SELECT COUNT(*)::int FROM audit_logs WHERE user_id=$1) AS audit,
         (SELECT COUNT(*)::int FROM record_shares WHERE created_by=$1) AS shares`,
      [user.id],
    )).rows[0];
    const business = ["contracts", "clients", "properties", "projects", "payments", "debts", "documents", "reports", "leads", "follow_ups"];
    const held = business.filter((key) => owned[key] > 0).map((key) => `${key}=${owned[key]}`).join(" ");
    console.log(`  id=${String(user.id).padStart(4)} ${user.email.padEnd(46)} ${held ? "OWNS: " + held : "owns nothing"}`);
  }
}

const totals = {};
for (const [name, list] of Object.entries(groups)) totals[name] = list.length;
console.log(`\ntotals: ${JSON.stringify(totals)}`);
await closeDatabase();
