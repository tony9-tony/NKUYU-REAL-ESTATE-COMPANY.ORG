// Automatic daily backup: one a day, old automatic ones pruned, a copy kept in
// BACKUP_COPY_DIR, and the JSON snapshot covers every table except sessions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mkuyu-backup-test-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.BACKUP_COPY_DIR = path.join(root, "offsite");
process.env.AUTO_BACKUP_KEEP = "2";
process.env.PG_DUMP_PATH = path.join(root, "no-pg-dump-here"); // force the JSON snapshot

const { runAutoBackupIfDue, listBackups, autoBackupStatus, createBackup } = await import("./backend/src/backups.js");
const { backupsDir, uploadsRoot } = await import("./backend/src/uploads.js");
const { closeDatabase } = await import("./backend/src/db.js");

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };
try {
  fs.mkdirSync(path.join(uploadsRoot, "documents"), { recursive: true });
  fs.writeFileSync(path.join(uploadsRoot, "documents", "receipt-1.pdf"), "%PDF test");
  fs.mkdirSync(backupsDir, { recursive: true });
  for (const day of ["2026-01-01", "2026-01-02", "2026-01-03"]) {
    const file = path.join(backupsDir, `system-auto-${day}T01-00-00.json`);
    fs.writeFileSync(file, "{}");
    const when = new Date(`${day}T01:00:00Z`); fs.utimesSync(file, when, when);
  }
  fs.writeFileSync(path.join(backupsDir, "system-2025-12-31T09-00-00.json"), "{}");

  const first = await runAutoBackupIfDue();
  check(Boolean(first?.name?.startsWith(`system-auto-${new Date().toISOString().slice(0, 10)}`)), `today's automatic backup is made (${first?.name})`);
  check((await runAutoBackupIfDue()) === null, "only one automatic backup a day");
  const autos = listBackups().filter((entry) => entry.automatic);
  check(autos.length === 2, `only the newest 2 automatic backups are kept (${autos.length})`);
  check(fs.existsSync(path.join(backupsDir, "system-2025-12-31T09-00-00.json")), "a backup made by hand is never removed automatically");
  const snapshot = JSON.parse(fs.readFileSync(path.join(backupsDir, first.name), "utf8"));
  check(snapshot.format === "mkuyu-json-snapshot" && snapshot.version === 2, "the snapshot is a versioned JSON backup");
  for (const table of ["users", "contracts", "payments", "payment_allocations", "refunds", "debts", "tasks"]) check(Array.isArray(snapshot.data[table]), `the snapshot contains ${table}`);
  check(!("sessions" in snapshot.data), "sign-in sessions are never copied into a backup");
  check(fs.existsSync(path.join(process.env.BACKUP_COPY_DIR, "database", first.name)), "the backup is copied to BACKUP_COPY_DIR");
  check(fs.existsSync(path.join(process.env.BACKUP_COPY_DIR, "uploads", "documents", "receipt-1.pdf")), "uploaded files are mirrored to BACKUP_COPY_DIR");
  const manual = await createBackup();
  check(manual && !manual.automatic, "a backup made by hand is not marked automatic");
  const status = autoBackupStatus();
  check(status.enabled && status.keep === 2 && status.copy_dir_set && status.last_automatic?.name === first.name, "the status reports on, keep, copy folder and the last automatic backup");
} catch (error) {
  failures += 1; console.error(error);
} finally {
  await closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(failures ? `${failures} BACKUP CHECK(S) FAILED` : "BACKUP_CHECKS_ALL_PASSED");
if (failures) process.exitCode = 1;
