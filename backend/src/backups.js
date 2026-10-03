// Database backups: made by hand from the System & backups page, and
// automatically once a day while the server runs.
//
// Preferred format is a PostgreSQL custom dump. When `pg_dump` is not installed
// (common on Windows without the PostgreSQL tools, and on shared hosting) the
// backup falls back to a self-contained JSON snapshot of every table, so a
// backup is always made.
//
// Automatic backups (AUTO_BACKUP, on unless set to "0"):
//   * one per calendar day, named system-auto-YYYY-MM-DD....dump|json
//   * the newest AUTO_BACKUP_KEEP (default 14) are kept; older automatic ones
//     are removed. Backups made by hand are never removed automatically.
//   * when BACKUP_COPY_DIR is set (an external drive, or a folder Google Drive
//     or OneDrive syncs), every new backup is copied there and the uploaded
//     files (receipts, contracts, photos) are mirrored there too, so a copy
//     survives if this computer is lost.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DATABASE_URL, query } from "./db.js";
import { backupsDir, uploadsRoot } from "./uploads.js";

const execFileAsync = promisify(execFile);
const BACKUP_EXTENSIONS = [".dump", ".json"];
export const backupNamePattern = /^system-[\w-]+\.(dump|json)$/;
// Never copied into a snapshot: live sign-in tokens are secrets and worthless
// after a restore.
const SNAPSHOT_SKIP = new Set(["sessions"]);

export function autoBackupSettings() {
  const keep = Number(process.env.AUTO_BACKUP_KEEP || 14);
  return {
    enabled: process.env.AUTO_BACKUP !== "0",
    keep: Number.isInteger(keep) && keep > 0 ? keep : 14,
    copy_dir: process.env.BACKUP_COPY_DIR ? path.resolve(process.env.BACKUP_COPY_DIR) : null,
  };
}

export function listBackups() {
  if (!fs.existsSync(backupsDir)) return [];
  return fs.readdirSync(backupsDir)
    .filter((name) => BACKUP_EXTENSIONS.some((extension) => name.endsWith(extension)) && backupNamePattern.test(name))
    .map((name) => {
      const stats = fs.statSync(path.join(backupsDir, name));
      return { name, size: stats.size, format: name.endsWith(".json") ? "json" : "pgdump", automatic: name.startsWith("system-auto-"), created_at: stats.mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Every table in the database, so a table added later is never left out. */
async function writeJsonSnapshot(name) {
  const tables = (await query(`SELECT t.table_name,
        EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=t.table_name AND c.column_name='organization_id') AS scoped
      FROM information_schema.tables t WHERE t.table_schema='public' AND t.table_type='BASE TABLE' ORDER BY t.table_name`)).rows;
  const data = {};
  for (const { table_name: table } of tables) {
    if (SNAPSHOT_SKIP.has(table)) continue;
    data[table] = (await query(`SELECT * FROM "${table.replace(/"/g, "")}"`)).rows;
  }
  const payload = { format: "mkuyu-json-snapshot", version: 2, created_at: new Date().toISOString(), tables: Object.keys(data).length, data };
  fs.writeFileSync(path.join(backupsDir, name), JSON.stringify(payload), "utf8");
  return name;
}

/** Makes one backup and returns its listing entry. */
export async function createBackup({ automatic = false } = {}) {
  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = `system-${automatic ? "auto-" : ""}${stamp}`;
  const dumpName = `${base}.dump`;
  let created;
  try {
    await execFileAsync(process.env.PG_DUMP_PATH || "pg_dump", ["--format=custom", `--file=${path.join(backupsDir, dumpName)}`, DATABASE_URL]);
    created = dumpName;
  } catch (error) {
    console.warn(`pg_dump unavailable (${error.code || error.message}); writing JSON snapshot instead`);
    try { fs.unlinkSync(path.join(backupsDir, dumpName)); } catch { /* nothing written */ }
    created = await writeJsonSnapshot(`${base}.json`);
  }
  copyOffsite(created);
  return listBackups().find((entry) => entry.name === created);
}

/** Copies a backup, and mirrors the uploaded files, to BACKUP_COPY_DIR. */
function copyOffsite(name) {
  const { copy_dir: dir } = autoBackupSettings();
  if (!dir) return;
  try {
    fs.mkdirSync(path.join(dir, "database"), { recursive: true });
    fs.copyFileSync(path.join(backupsDir, name), path.join(dir, "database", name));
    if (fs.existsSync(uploadsRoot)) fs.cpSync(uploadsRoot, path.join(dir, "uploads"), { recursive: true, force: false, errorOnExist: false });
  } catch (error) {
    console.warn(`backup copy to BACKUP_COPY_DIR failed: ${error.message}`);
  }
}

/** Keeps the newest `keep` automatic backups (here and in the copy folder). */
function pruneAutomatic(keep) {
  const old = listBackups().filter((entry) => entry.automatic).slice(keep);
  for (const entry of old) {
    try { fs.unlinkSync(path.join(backupsDir, entry.name)); } catch { /* already gone */ }
  }
  const { copy_dir: dir } = autoBackupSettings();
  if (dir && fs.existsSync(path.join(dir, "database"))) {
    const copies = fs.readdirSync(path.join(dir, "database")).filter((name) => name.startsWith("system-auto-")).sort().reverse();
    for (const name of copies.slice(keep)) {
      try { fs.unlinkSync(path.join(dir, "database", name)); } catch { /* already gone */ }
    }
  }
}

let lastRun = null;
let lastError = null;
export function autoBackupStatus() {
  const settings = autoBackupSettings();
  const latest = listBackups().find((entry) => entry.automatic) || null;
  return { enabled: settings.enabled, keep: settings.keep, copy_dir_set: Boolean(settings.copy_dir), last_automatic: latest, last_checked_at: lastRun, last_error: lastError };
}

/** Makes today's automatic backup if there is none yet. */
export async function runAutoBackupIfDue() {
  const settings = autoBackupSettings();
  lastRun = new Date().toISOString();
  if (!settings.enabled) return null;
  const today = new Date().toISOString().slice(0, 10);
  const done = listBackups().some((entry) => entry.automatic && entry.name.startsWith(`system-auto-${today}`));
  if (done) return null;
  try {
    const entry = await createBackup({ automatic: true });
    pruneAutomatic(settings.keep);
    lastError = null;
    console.log(`automatic backup made: ${entry?.name}`);
    return entry;
  } catch (error) {
    lastError = error.message;
    console.warn(`automatic backup failed: ${error.message}`);
    return null;
  }
}

/** Checks a few minutes after start, then every hour. */
export function startAutoBackups() {
  if (!autoBackupSettings().enabled) return;
  const first = setTimeout(() => runAutoBackupIfDue(), 5 * 60 * 1000);
  first.unref();
  const hourly = setInterval(() => runAutoBackupIfDue(), 60 * 60 * 1000);
  hourly.unref();
}
