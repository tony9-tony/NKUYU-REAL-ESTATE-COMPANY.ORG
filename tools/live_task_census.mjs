// Read-only census of the LIVE database business tables.
//
// Used before and after the task-assignment work to prove no existing business
// row moved. It opens its own connection to the database named in .env and
// never writes: every statement is a SELECT.
//
//   node tools/live_task_census.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readEnvFile(key, fallback) {
  try {
    const text = fs.readFileSync(path.join(projectRoot, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`));
      if (match) return match[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env */ }
  return fallback;
}

const url = readEnvFile("DATABASE_URL", "postgresql://postgres@localhost:5432/mkuyu_org");
const TABLES = [
  "users", "departments", "roles", "permissions", "role_permissions", "user_roles", "user_departments",
  "projects", "clients", "properties", "property_images", "contracts", "contract_revisions",
  "debts", "payments", "reminders", "documents", "appointments", "leads", "follow_ups",
  "approvals", "record_shares", "tasks", "task_comments",
];
const client = new pg.Client({ connectionString: url });
await client.connect();
const { rows: nameRows } = await client.query("SELECT current_database() AS db");
console.log(`database: ${nameRows[0].db}`);
const counts = {};
for (const table of TABLES) {
  // A table that does not exist yet is reported as absent rather than failing the
  // census, so the same script works before and after the additive migration.
  const { rows } = await client.query("SELECT to_regclass($1) AS reg", [table]);
  if (!rows[0].reg) { counts[table] = null; continue; }
  const result = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
  counts[table] = result.rows[0].n;
}
console.log(JSON.stringify(counts, null, 2));

// The most recent audit entries. This is a read-only trace of who last touched
// the live data, so a count that moved between two runs can be attributed rather
// than guessed at.
const { rows: recent } = await client.query(
  "SELECT a.created_at, a.action, a.module, a.record_id, u.display_name AS actor FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC, a.id DESC LIMIT 12",
);
console.log("--- most recent live audit entries ---");
for (const row of recent) console.log(`${row.created_at}  ${String(row.action).padEnd(18)} ${String(row.module).padEnd(10)} #${row.record_id}  by ${row.actor || "system"}`);

await client.end();
