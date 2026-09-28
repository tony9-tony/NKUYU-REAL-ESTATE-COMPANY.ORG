// READ-ONLY inspection + a safety copy of the CURRENT database state.
//
// Performs SELECT queries only, and writes exactly one new file: a JSON copy of
// the current state, so the database can always be returned to "as it is right
// now" before any restore decision. No DELETE, UPDATE, INSERT, DROP or migration.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, closeDatabase, DATABASE_URL } from "./backend/src/db.js";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const backupsDir = path.join(projectRoot, "data", "backups");

// --- 1. Which database is the running application actually using? -------------
console.log("=== 1. live database connection ===");
const conn = (await query(`
  SELECT current_database() AS db, current_user AS usr,
         inet_server_addr()::text AS host, inet_server_port() AS port,
         pg_size_pretty(pg_database_size(current_database())) AS size,
         (SELECT count(*)::int FROM organizations) AS organizations
`)).rows[0];
console.log(`  DATABASE_URL (config) : ${DATABASE_URL}`);
console.log(`  connected database   : ${conn.db}`);
console.log(`  connected user       : ${conn.usr}`);
console.log(`  server               : ${conn.host}:${conn.port}`);
console.log(`  database size        : ${conn.size}`);
console.log(`  organizations        : ${conn.organizations}`);

// --- 2. Safety copy of the CURRENT state -------------------------------------
const TABLES = [
  "organizations", "users", "departments", "roles", "permissions", "role_permissions",
  "user_roles", "user_departments", "duties", "duty_permissions",
  "projects", "clients", "properties", "property_images", "contracts", "contract_revisions",
  "debts", "payments", "reminders", "documents", "appointments", "leads", "follow_ups",
  "approvals", "audit_logs", "record_shares", "settings", "sessions",
];
const current = {};
const counts = {};
for (const table of TABLES) {
  try {
    const rows = (await query(`SELECT * FROM ${table}`)).rows;
    current[table] = rows;
    counts[table] = rows.length;
  } catch (error) {
    current[table] = { unavailable: error.message };
    counts[table] = null;
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const copyPath = path.join(backupsDir, `SAFETY-COPY-current-state-${stamp}.json`);
fs.writeFileSync(copyPath, JSON.stringify({
  format: "mkuyu-json-snapshot",
  version: 1,
  safety_copy: true,
  note: "Read-only capture of the CURRENT database state, taken before any restore decision. Not a restore source.",
  created_at: new Date().toISOString(),
  source_database: conn.db,
  table_counts: counts,
  data: current,
}));
console.log(`\n=== 2. safety copy of the CURRENT state ===`);
console.log(`  written : ${path.basename(copyPath)}`);
console.log(`  size    : ${(fs.statSync(copyPath).size / 1024).toFixed(1)} KB`);
console.log(`  contents: ${TABLES.length} tables, ${Object.values(counts).reduce((a, b) => a + (b || 0), 0)} rows`);
console.log("\n  current row counts:");
for (const table of ["users", "projects", "clients", "properties", "property_images", "contracts", "debts", "payments", "documents", "audit_logs", "sessions"]) {
  console.log(`    ${table.padEnd(20)} ${counts[table]}`);
}

// --- 3. What backups already exist? -------------------------------------------
console.log(`\n=== 3. files in data/backups/ ===`);
const files = fs.readdirSync(backupsDir)
  .map((name) => {
    const stat = fs.statSync(path.join(backupsDir, name));
    return { name, bytes: stat.size, mtime: stat.mtime.toISOString() };
  })
  .sort((a, b) => b.mtime.localeCompare(a.mtime));
for (const f of files) {
  console.log(`  ${f.mtime}  ${String(f.bytes).padStart(10)} B  ${f.name}`);
}

// --- 4/5/6. Inspect the newest PRE-EXISTING backup, read-only ----------------
const existing = files.filter((f) => !f.name.startsWith("SAFETY-COPY-"));
const newest = existing[0];
console.log(`\n=== 4. newest pre-existing backup: ${newest?.name} ===`);
if (!newest) {
  console.log("  none found");
} else {
  console.log(`  size  : ${(newest.bytes / 1024).toFixed(1)} KB`);
  console.log(`  taken : ${newest.mtime}`);
  const snapshot = JSON.parse(fs.readFileSync(path.join(backupsDir, newest.name), "utf8"));
  console.log(`  created_at (inside): ${snapshot.created_at}`);
  console.log(`  format            : ${snapshot.format} v${snapshot.version}`);
  const data = snapshot.data || {};
  console.log(`  tables in snapshot: ${Object.keys(data).length}`);

  const WANTED = ["contracts", "clients", "projects", "payments", "debts", "documents", "properties", "property_images"];
  console.log(`\n=== 5. does the backup contain the missing records? ===`);
  const backupCounts = {};
  for (const table of WANTED) {
    const n = Array.isArray(data[table]) ? data[table].length : null;
    backupCounts[table] = n;
    console.log(`  ${table.padEnd(18)} ${n === null ? "TABLE ABSENT" : `${n} records`}`);
  }

  console.log(`\n=== 6. backup counts vs. counts before the accidental deletion ===`);
  // "before" = figures observed live earlier in this session, before the loss.
  const BEFORE = { contracts: 34, clients: 70, projects: 34, properties: 66, payments: 30, debts: 157, documents: 28 };
  console.log("  table          backup   before-loss     now   verdict");
  for (const table of Object.keys(BEFORE)) {
    const b = backupCounts[table];
    const before = BEFORE[table];
    const now = counts[table];
    const verdict = b === null ? "backup lacks this table"
      : b >= before ? "backup covers it"
      : `backup is short by ${before - b}`;
    console.log(`  ${table.padEnd(14)} ${String(b).padStart(6)} ${String(before).padStart(13)} ${String(now).padStart(6)}   ${verdict}`);
  }
}

await closeDatabase();
console.log("\n(no DELETE, UPDATE, INSERT, DROP or migration was performed)");
