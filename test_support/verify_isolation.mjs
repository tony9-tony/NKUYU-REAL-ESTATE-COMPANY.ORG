// ---------------------------------------------------------------------------
// Proves the isolation guard actually holds, rather than assuming it does.
//
// A test that is "supposed" to use a throwaway database is only safe if the
// refusal path is exercised too. This checks all three layers:
//   1. the guard repoints DATABASE_URL away from the live database,
//   2. a test server never binds the live application port,
//   3. the guard refuses to run at all when pointed at the live database.
// ---------------------------------------------------------------------------
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertTestDatabase, connectedDatabase, reapOrphanServers } from "./harness.mjs";
import { closeDatabase } from "../backend/src/db.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const live = process.env.MKUYU_LIVE_DATABASE;
const expected = process.env.MKUYU_TEST_DB || `${live}_test`;

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

console.log("=== test database isolation ===");

// --- 1. this process is on the throwaway database --------------------------
const db = await connectedDatabase();
check(db !== live, `this process is NOT on the live database ("${db}" != "${live}")`);
check(db === expected, `this process is on the expected test database ("${db}")`);
check(process.env.DATABASE_URL !== process.env.MKUYU_LIVE_DATABASE_URL, "DATABASE_URL has been repointed away from the live value");
check(process.env.MKUYU_IS_TEST_DATABASE === "1", "the guard marked this process as a test run");

// The guard must not have touched the live database in any way.
check(Boolean(live) && live !== db, `the live database name is still resolvable for comparison ("${live}")`);

// --- 2. assertTestDatabase passes here -------------------------------------
let guardPassed = true;
try { await assertTestDatabase("verify_isolation"); } catch { guardPassed = false; }
check(guardPassed, "assertTestDatabase() allows the run when correctly isolated");

// --- 3. the refusal path works ---------------------------------------------
// Runs the guard with the test name forced to equal the live name. It must exit
// non-zero and print a refusal, without ever connecting to or writing anything.
const refusal = spawnSync(
  process.execPath,
  ["--import", "./test_support/guard.mjs", "-e", "console.log('SHOULD NOT REACH')"],
  { cwd: projectRoot, env: { ...process.env, MKUYU_TEST_DB: live }, encoding: "utf8" },
);
const refusalText = `${refusal.stdout || ""}${refusal.stderr || ""}`;
check(refusal.status !== 0, `the guard exits non-zero when pointed at the live database (status ${refusal.status})`);
check(/REFUSING TO RUN/.test(refusalText), "the guard prints an explicit refusal");
check(!/SHOULD NOT REACH/.test(refusalText), "the guard stops before the script body runs");

// --- 4. the live application config is untouched ---------------------------
const envText = (await import("node:fs")).readFileSync(path.join(projectRoot, ".env"), "utf8");
const liveLine = envText.split(/\r?\n/).find((line) => /^\s*DATABASE_URL\s*=/.test(line)) || "";
check(liveLine.includes(live), `.env still points the application at the live database (${live})`);

// --- 5. no test server may bind the live port ------------------------------
const portRefusal = spawnSync(
  process.execPath,
  ["-e", "import('./test_support/harness.mjs').then(m => m.startIsolatedServer({ port: 3003 }))"],
  { cwd: projectRoot, encoding: "utf8", timeout: 20000 },
);
const portText = `${portRefusal.stdout || ""}${portRefusal.stderr || ""}`;
check(portRefusal.status !== 0, "a test server refuses to bind the live application port 3003");
check(/REFUSING TO RUN/.test(portText), "the port refusal is explicit");

reapOrphanServers();
await closeDatabase();

console.log(failures ? `\n${failures} ISOLATION CHECK(S) FAILED` : "\nTEST_ISOLATION_VERIFIED");
if (failures) process.exitCode = 1;
