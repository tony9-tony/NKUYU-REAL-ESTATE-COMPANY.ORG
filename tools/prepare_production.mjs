// Prepares MKUYU for production: removes every staff account and every
// business record (clients, leads, projects, properties, contracts, payments,
// documents, tasks, reports, audit history, uploaded files) so the system
// starts empty. The organization, its departments, roles, permissions, duties,
// settings and the contract templates are kept.
//
// A full backup is made first (database + uploaded files) in data/backups.
// After this, open the system: the setup screen creates the first
// administrator account.
//
//   node tools/prepare_production.mjs           (asks you to type FUTA)
//   node tools/prepare_production.mjs --yes     (no question; for scripts)
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
const PORT = Number(process.env.PORT || 3003);

// Business records, children before parents. Every table not listed here
// (organizations, departments, roles, permissions, role_permissions, duties,
// duty_permissions, settings) is configuration and is kept.
const CONTENT_TABLES = [
  "payment_allocations", "refunds", "payments", "reminders", "debts",
  "appointment_reminder_days", "appointments", "follow_ups", "approvals",
  "task_comments", "tasks", "record_shares", "contract_revisions", "contracts",
  "property_history", "property_images", "properties", "projects",
  "leads", "clients", "reports", "email_log", "audit_logs", "sessions",
];
const ACCOUNT_TABLES = ["user_departments", "user_roles", "users"];

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1500, () => { socket.destroy(); resolve(false); });
  });
}

const { query, withTransaction, closeDatabase } = await import("../backend/src/db.js");
const { createBackup } = await import("../backend/src/backups.js");
const { uploadsRoot, backupsDir } = await import("../backend/src/uploads.js");

const existingTables = new Set((await query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map((r) => r.tablename));
const has = (t) => existingTables.has(t);
const count = async (sql) => Number((await query(sql)).rows[0].n);

const users = has("users") ? await count("SELECT COUNT(*) AS n FROM users") : 0;
const templates = await count("SELECT COUNT(*) AS n FROM documents WHERE category='template'");
const otherDocs = await count("SELECT COUNT(*) AS n FROM documents WHERE category IS DISTINCT FROM 'template'");
const summary = [];
for (const t of ["clients", "leads", "projects", "properties", "contracts", "payments", "debts", "tasks", "appointments", "audit_logs"]) {
  if (has(t)) summary.push(`${t} ${await count(`SELECT COUNT(*) AS n FROM ${t}`)}`);
}

console.log("");
console.log("MKUYU: prepare for production");
console.log("==============================");
console.log(`Database: ${(process.env.DATABASE_URL || "postgresql://postgres@localhost:5432/mkuyu_org").replace(/\/\/[^@]*@/, "//***@")}`);
console.log(`Will DELETE: ${users} staff accounts, ${otherDocs} documents, ${summary.join(", ")}, and all uploaded photos/files.`);
console.log(`Will KEEP: the organization, departments, roles, permissions, duties, settings, and ${templates} contract template(s).`);
console.log("");

if (await portInUse(PORT)) {
  console.log(`The MKUYU system is still running (port ${PORT}). Close its window first, then run this again.`);
  await closeDatabase?.(); process.exit(1);
}

if (!process.argv.includes("--yes")) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('This cannot be undone (except from the backup). Type FUTA to continue: ')).trim();
  rl.close();
  if (answer !== "FUTA") { console.log("Cancelled. Nothing was changed."); await closeDatabase?.(); process.exit(0); }
}

// 1. Full backup first: the database, and a copy of every uploaded file.
console.log("\n1/3  Making a full backup...");
const backup = await createBackup();
if (!backup) { console.log("The backup could not be made. Nothing was deleted."); await closeDatabase?.(); process.exit(1); }
const filesCopy = path.join(backupsDir, backup.name.replace(/\.(dump|json)$/, "") + "-uploads");
if (fs.existsSync(uploadsRoot)) fs.cpSync(uploadsRoot, filesCopy, { recursive: true });
console.log(`     Database: data/backups/${backup.name}`);
console.log(`     Files:    data/backups/${path.basename(filesCopy)}`);

// 2. Empty the database (one transaction: all or nothing).
console.log("2/3  Removing accounts and business records...");
const keptFiles = await withTransaction(async (client) => {
  for (const t of CONTENT_TABLES) if (has(t)) await client.query(`DELETE FROM ${t}`);
  await client.query("DELETE FROM documents WHERE category IS DISTINCT FROM 'template'");
  // Templates stay, but no longer point at people who are being removed.
  await client.query("UPDATE documents SET created_by=NULL, owner_id=NULL");
  for (const t of ACCOUNT_TABLES) if (has(t)) await client.query(`DELETE FROM ${t}`);
  // Numbering starts again from 1 (record ids, contract and receipt numbers).
  for (const t of [...CONTENT_TABLES, ...ACCOUNT_TABLES]) {
    if (!has(t)) continue;
    const hasId = (await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='id'", [t])).rowCount > 0;
    if (!hasId) continue;
    const seq = (await client.query("SELECT pg_get_serial_sequence($1, 'id') AS s", [t])).rows[0]?.s;
    if (seq) await client.query("SELECT setval($1, 1, false)", [seq]);
  }
  await client.query("ALTER SEQUENCE IF EXISTS payment_receipt_seq RESTART WITH 1");
  return new Set((await client.query("SELECT stored_name FROM documents WHERE stored_name IS NOT NULL")).rows.map((r) => r.stored_name));
});

// 3. Remove uploaded files that no longer belong to anything (template files stay).
console.log("3/3  Removing uploaded photos and files...");
let removed = 0;
function sweep(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { sweep(full); continue; }
    if (keptFiles.has(entry.name)) continue;
    fs.unlinkSync(full); removed += 1;
  }
}
sweep(uploadsRoot);

const left = await count("SELECT COUNT(*) AS n FROM users");
console.log("");
console.log(`Done. ${removed} files removed. Staff accounts left: ${left}.`);
console.log("Next: start the system (start-mkuyu.bat) and open it. The setup screen creates the first administrator.");
console.log("For the live server, set NODE_ENV=production and a SETUP_TOKEN in .env before first setup (see README).");
await closeDatabase?.();
process.exit(0);
