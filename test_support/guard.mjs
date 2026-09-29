// ---------------------------------------------------------------------------
// TEST DATABASE ISOLATION - hard safety guard.
//
// Loaded with `node --import ./test_support/guard.mjs <script>`, so it runs
// BEFORE any application module. That ordering matters: `./backend/src/db.js`
// calls `dotenv.config()` and builds its connection pool at import time, so a
// guard that ran inside a test file would arrive too late - ES module imports
// are hoisted above any statement in the importing file.
//
// This guard:
//   1. resolves the LIVE database from .env (never to be written to),
//   2. derives a throwaway TEST database from it,
//   3. refuses to run if the test target is the live database,
//   4. creates the test database if it does not exist,
//   5. repoints process.env.DATABASE_URL at the test database.
//
// It performs no write of any kind against the live database.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Reads a KEY=VALUE line from .env without loading it into the environment. */
function readEnvFile(key, fallback) {
  try {
    const text = fs.readFileSync(path.join(projectRoot, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`));
      if (match) return match[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env: fall back */ }
  return fallback;
}

const liveUrl = readEnvFile("DATABASE_URL", process.env.DATABASE_URL || "postgresql://postgres@localhost:5432/mkuyu_org");
const liveName = new URL(liveUrl).pathname.replace(/^\//, "") || "mkuyu_org";

// The test database is derived from the live one so the credentials always match
// and no manual .env edit is ever needed. `MKUYU_TEST_DB` may override the name.
const testName = process.env.MKUYU_TEST_DB || `${liveName}_test`;
const testUrl = liveUrl.replace(new RegExp(`/${liveName}(\\?|$)`), `/${testName}$1`);

/**
 * Refuse to continue if the destructive target IS the live database.
 * Every destructive script calls this before touching anything.
 */
export function assertNotLiveDatabase(label = "this script") {
  if (testName === liveName || testUrl === liveUrl) {
    console.error(
      `\nREFUSING TO RUN: ${label}\n` +
      `  the test target resolves to the LIVE database "${liveName}".\n` +
      `  set MKUYU_TEST_DB to a different name, or unset it to use "${testName}".\n`,
    );
    process.exit(1);
  }
  return { liveName, testName, testUrl };
}

/** Creates the test database if missing. Connects to `postgres` to issue CREATE. */
async function ensureTestDatabase() {
  const adminUrl = liveUrl.replace(new RegExp(`/${liveName}(\\?|$)`), "/postgres$1");
  const client = new pg.Client({ connectionString: adminUrl });
  try {
    await client.connect();
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [testName]);
    if (!exists.rowCount) {
      await client.query(`CREATE DATABASE "${testName}"`);
      console.log(`[guard] created test database "${testName}"`);
    } else {
      console.log(`[guard] using existing test database "${testName}"`);
    }
  } finally {
    await client.end().catch(() => {});
  }
}

if (testName === liveName) {
  console.error(`\nREFUSING TO RUN: the test target is the LIVE database "${liveName}".\n`);
  process.exit(1);
}

await ensureTestDatabase();

// Repoint the environment BEFORE db.js is imported, so its pool is built against
// the throwaway database. dotenv.config() does not override an existing value.
process.env.DATABASE_URL = testUrl;
process.env.MKUYU_IS_TEST_DATABASE = "1";
process.env.MKUYU_LIVE_DATABASE = liveName;
process.env.DATA_DIR = path.join(projectRoot, "data", "test-runtime");

console.log(`[guard] live database    : ${liveName}  (never written to)`);
console.log(`[guard] test database    : ${testName}`);
process.env.MKUYU_LIVE_DATABASE_URL = liveUrl;
