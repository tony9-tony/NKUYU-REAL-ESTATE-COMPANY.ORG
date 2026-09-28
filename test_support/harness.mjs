// ---------------------------------------------------------------------------
// Shared harness for tests that talk to the API over HTTP.
//
// Those tests are the most dangerous shape: they can only be safe if the server
// they reach is itself pointed at the throwaway database. Previously they all
// dialled http://localhost:3003 - the developer's live application, wired to
// mkuyu_org - and every fixture, payment and password rotation landed in the
// real database.
//
// `startIsolatedServer()` spawns a private server on its own port with
// DATABASE_URL already repointed by ./guard.mjs, and asserts the child is not
// talking to the live database before it is used.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { query, queryOne, withTransaction, closeDatabase } from "../backend/src/db.js";
import { runMigrations } from "../backend/src/migrate.js";
import { hashPassword } from "../backend/src/auth.js";
import { organizationId } from "../backend/src/org/rbac.js";
import { LEGACY_ACCOUNTS, legacyPasswordFor, demoPasswordFor } from "../backend/src/org/demoCredentials.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Name of the database this process is actually connected to right now. */
export async function connectedDatabase() {
  const row = (await query("SELECT current_database() AS db")).rows[0];
  return row.db;
}

/**
 * Fail loudly and immediately if this process is pointed at the live database.
 * Call this before ANY write in a test body.
 */
export async function assertTestDatabase(label = "test") {
  const live = process.env.MKUYU_LIVE_DATABASE;
  const db = await connectedDatabase();
  if (!process.env.MKUYU_IS_TEST_DATABASE || db === live) {
    console.error(
      `\nREFUSING TO RUN ${label}\n` +
      `  connected to "${db}", which is the LIVE database.\n` +
      `  tests must be started with: node --import ./test_support/guard.mjs <script>\n`,
    );
    await closeDatabase().catch(() => {});
    process.exit(1);
  }
  return db;
}

/** Creates the isolated runtime directory so uploads/backups never touch data/. */
function ensureRuntimeDir() {
  const dir = process.env.DATA_DIR || path.join(projectRoot, "data", "test-runtime");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A test that calls process.exit() would otherwise orphan the server it spawned -
 * a stray listener still bound to the test database, accumulating rows nobody
 * cleans up. The pid is recorded so the next run can reap it.
 */
const PID_FILE = () => path.join(ensureRuntimeDir(), "test-server.pid");

/** Kills any test server left behind by a previous run. */
export function reapOrphanServers() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE(), "utf8").trim());
    if (pid > 0) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    fs.rmSync(PID_FILE(), { force: true });
  } catch { /* no pid file: nothing to reap */ }
}

/**
 * Starts a private API server bound to the test database and returns its base

/**
 * Prepares a usable test database: schema, roles, departments, duties, demo
 * accounts, plus the four LEGACY accounts.
 *
 * `runMigrations()` seeds the demo set and ROTATES the legacy accounts, but it
 * only rotates accounts that already exist. A throwaway database starts empty,
 * so the legacy accounts have to be created here before the rotation, demo and
 * admin suites - which all sign in as `admin@mkuyu.local` - can run at all.
 *
 * The `users.role` column is set explicitly because it is what routes use to
 * decide admin authority, independently of the System Administrator role row.
 */
export async function prepareTestDatabase() {
  const db = await assertTestDatabase("prepareTestDatabase");
  await runMigrations();
  const org = await organizationId();

  for (const account of LEGACY_ACCOUNTS) {
    const existing = await queryOne("SELECT id FROM users WHERE email=$1", [account.email]);
    let userId;
    if (existing) {
      userId = existing.id;
    } else {
      const created = await queryOne(
        "INSERT INTO users (organization_id, email, password_hash, display_name, role) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [org, account.email, hashPassword(legacyPasswordFor(account.email)), account.role, account.administrator ? "admin" : "staff"],
      );
      userId = created.id;
    }
    // Keep the credential deterministic across repeated runs of the suite.
    await query("UPDATE users SET password_hash=$1, active=TRUE WHERE id=$2", [hashPassword(legacyPasswordFor(account.email)), userId]);
    await withTransaction(async (client) => {
      const role = (await client.query("SELECT id FROM roles WHERE organization_id=$1 AND name=$2", [org, account.role])).rows[0];
      if (role) {
        await client.query("DELETE FROM user_roles WHERE user_id=$1", [userId]);
        await client.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)", [userId, role.id]);
      }
      const department = (await client.query("SELECT id FROM departments WHERE organization_id=$1 AND name=$2", [org, account.department])).rows[0];
      if (department) {
        await client.query("DELETE FROM user_departments WHERE user_id=$1", [userId]);
        await client.query("INSERT INTO user_departments (user_id, department_id) VALUES ($1,$2)", [userId, department.id]);
      }
    });
  }
  console.log(`[harness] test database "${db}" prepared (schema, roles, departments, demo + legacy accounts)`);
  return db;
}

/**
 * Starts a private API server bound to the test database and returns its base
 * URL. Always pair with `stop()` (a `try/finally`).
 */
export async function startIsolatedServer({ port, label = "test" } = {}) {
  const testDb = await assertTestDatabase(label);
  const dir = ensureRuntimeDir();
  const chosen = port || Number(process.env.TEST_API_PORT) || 3199;

  if (chosen === 3003) {
    console.error("\nREFUSING TO RUN: a test server may not bind the live application port 3003.\n");
    process.exit(1);
  }

  const logs = [];
  const child = spawn(process.execPath, [path.join(projectRoot, "backend", "src", "server.js")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(chosen),
      DATABASE_URL: process.env.DATABASE_URL,
      DATA_DIR: dir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk) => logs.push(chunk.toString());
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  if (child.pid) {
    fs.writeFileSync(PID_FILE(), String(child.pid));
    // Best-effort cleanup if the test exits without calling stop().
    process.on("exit", () => { try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ } });
  }

  const base = `http://localhost:${chosen}/api/v1`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`test server exited early (code ${child.exitCode})\n${logs.join("")}`);
    }
    try {
      if ((await fetch(`${base}/health`)).ok) {
        console.log(`[harness] ${label}: server ready on :${chosen} (database: ${testDb})`);
        break;
      }
    } catch { /* not listening yet */ }
    await sleep(250);
  }
  if (Date.now() >= deadline) {
    child.kill();
    throw new Error(`test server on :${chosen} never became ready\n${logs.join("")}`);
  }

  return {
    base,
    database: testDb,
    logs,
    async stop() {
      if (child.exitCode === null) child.kill();
      const until = Date.now() + 5000;
      while (child.exitCode === null && Date.now() < until) await sleep(100);
      if (child.exitCode === null && child.pid) {
        try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ }
      }
      fs.rmSync(PID_FILE(), { force: true });
    },
  };
}
