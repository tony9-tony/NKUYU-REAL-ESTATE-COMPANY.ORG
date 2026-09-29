// One-off removal of test accounts and fixtures left behind by interrupted
// access-matrix runs. Strictly scoped to the `matrix.` email prefix and the
// `Matrix ...` / `matrix-...` fixture names, verified beforehand to contain no
// real business records.
import { query, closeDatabase } from "./backend/src/db.js";

const users = (await query("SELECT id,email FROM users WHERE email LIKE 'matrix.%@mkuyu.local' ORDER BY id")).rows;
const ids = users.map((u) => u.id);
console.log(`matrix accounts to remove: ${ids.length}`);

const before = {};
for (const [label, sql] of Object.entries({
  users: "SELECT COUNT(*)::int n FROM users",
  contracts: "SELECT COUNT(*)::int n FROM contracts",
  clients: "SELECT COUNT(*)::int n FROM clients",
  projects: "SELECT COUNT(*)::int n FROM projects",
  leads: "SELECT COUNT(*)::int n FROM leads",
  debts: "SELECT COUNT(*)::int n FROM debts",
  payments: "SELECT COUNT(*)::int n FROM payments",
  documents: "SELECT COUNT(*)::int n FROM documents",
  reports: "SELECT COUNT(*)::int n FROM reports",
})) before[label] = (await query(sql)).rows[0].n;
console.log("before:", JSON.stringify(before));

// Fixtures first: contracts cascade to their debts and payments.
const removed = {};
removed.contracts = (await query("DELETE FROM contracts WHERE notes LIKE 'matrix-%' RETURNING id")).rowCount;
removed.leads = (await query("DELETE FROM leads WHERE name LIKE 'Matrix Lead %' RETURNING id")).rowCount;
removed.clients = (await query("DELETE FROM clients WHERE name LIKE 'Matrix Client %' RETURNING id")).rowCount;
removed.projects = (await query("DELETE FROM projects WHERE name LIKE 'Matrix Project %' RETURNING id")).rowCount;
// record_shares has no FK to users, so clear it explicitly.
await query("DELETE FROM record_shares WHERE user_id = ANY($1::int[]) OR created_by = ANY($1::int[])", [ids]);
removed.audit = (await query("DELETE FROM audit_logs WHERE user_id = ANY($1::int[]) RETURNING id", [ids])).rowCount;
removed.users = (await query("DELETE FROM users WHERE id = ANY($1::int[]) RETURNING id", [ids])).rowCount;
console.log("removed:", JSON.stringify(removed));

const after = {};
for (const [label, sql] of Object.entries({
  users: "SELECT COUNT(*)::int n FROM users",
  contracts: "SELECT COUNT(*)::int n FROM contracts",
  clients: "SELECT COUNT(*)::int n FROM clients",
  projects: "SELECT COUNT(*)::int n FROM projects",
  leads: "SELECT COUNT(*)::int n FROM leads",
  debts: "SELECT COUNT(*)::int n FROM debts",
  payments: "SELECT COUNT(*)::int n FROM payments",
  documents: "SELECT COUNT(*)::int n FROM documents",
  reports: "SELECT COUNT(*)::int n FROM reports",
})) after[label] = (await query(sql)).rows[0].n;
console.log("after: ", JSON.stringify(after));

// Real data must be untouched: only counts that belonged to fixtures may drop.
const MUST_NOT_DROP = ["documents", "reports", "payments"];
const violations = MUST_NOT_DROP.filter((key) => after[key] < before[key]);
console.log(`\n${violations.length ? "UNEXPECTED LOSS: " + violations.join(", ") : "CLEANUP_SCOPED_CORRECTLY"}`);
const leftovers = (await query("SELECT COUNT(*)::int n FROM users WHERE email LIKE 'matrix.%@mkuyu.local'")).rows[0].n;
console.log(`matrix accounts remaining: ${leftovers}`);
await closeDatabase();
