// ---------------------------------------------------------------------------
// Performance benchmark — ISOLATED TEST DATABASE ONLY.
//
// Seeds a synthetic dataset into the throwaway `mkuyu_org_test` database, then
// measures API latency at each dataset size and under controlled concurrency.
// Reports mean / p50 / p95 / p99 and the real error rate.
//
// The older ./bench.mjs dials the live server on :3003, so it cannot be scaled
// and must never be used for a stress run. This one is the safe one.
//
// Run: node --import ./test_support/guard.mjs perf_bench_test.mjs
//       PERF_SIZES=1000,10000 node --import ./test_support/guard.mjs perf_bench_test.mjs
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { legacyPasswordFor } from "./backend/src/org/demoCredentials.js";
import { query, queryOne, closeDatabase } from "./backend/src/db.js";
import { organizationId } from "./backend/src/org/rbac.js";

reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ label: "perf-bench", port: 3211 });
const base = server.base;

// The machine is shared with the developer's other work, so the load is capped
// and every request has a timeout. This reports honest numbers for a modest
// load rather than degrading everything else on the box.
const CONCURRENCY = Number(process.env.PERF_CONCURRENCY || 8);
const REQUESTS = Number(process.env.PERF_REQUESTS || 120);
const SIZES = (process.env.PERF_SIZES || "1000,10000")
  .split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n > 0);

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

const stats = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    mean: sorted.reduce((s, v) => s + v, 0) / (sorted.length || 1),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] || 0,
  };
};

async function call(path, { token, method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const started = process.hrtime.bigint();
  // A hard timeout so a stalled request surfaces as a failure with a reason
  // instead of hanging the whole run with no output.
  const response = await fetch(`${base}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  // Read the body as TEXT, not parsed JSON. A 10,000-row list is several MB;
  // parsing it just to time the request is what exhausts memory on a large
  // dataset and made this benchmark die without a message. Byte count is enough.
  const text = await response.text();
  return {
    status: response.status,
    ms: Number(process.hrtime.bigint() - started) / 1e6,
    bytes: text.length,
  };
}

async function token(email) {
  // Login is the one call that must read the body, because the session token
  // is the point of it. It is a single small object, so parsing costs nothing.
  const response = await fetch(`${base}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: legacyPasswordFor(email) }),
    signal: AbortSignal.timeout(30000),
  });
  if (response.status !== 200) throw new Error(`login failed for ${email}: ${response.status}`);
  return (await response.json()).token;
}

/** Seeds `count` clients + properties + contracts in bulk (no per-row round trip). */
async function seed(count) {
  const org = await organizationId();
  const label = `perf${count}`;
  const t0 = Date.now();
  // Seed rows are owned by the organization (organization scope) so the seeded
  // set is visible to every benchmark caller, whatever their own scope is.
  await query("DELETE FROM contracts WHERE client_name LIKE $1", [`${label}%`]).catch(() => {});
  await query("DELETE FROM clients WHERE name LIKE $1", [`${label}%`]).catch(() => {});
  await query("DELETE FROM properties WHERE name LIKE $1", [`${label}%`]).catch(() => {});

  // contracts.project_id is NOT NULL, so a project has to exist first.
  await query(
    `INSERT INTO projects (organization_id, name, status, created_at)
     VALUES ($1, $2, 'active', NOW()) RETURNING id`,
    [org, `${label} Project`],
  );
  const projectId = (await queryOne("SELECT id FROM projects WHERE organization_id=$1 AND name=$2", [org, `${label} Project`])).id;

  await query(
    `INSERT INTO clients (organization_id, name, client_type, status, created_at)
     SELECT $1, $2 || ' Client ' || g, 'buyer', 'active', NOW() FROM generate_series(1,$3) g`,
    [org, label, count],
  );
  await query(
    `INSERT INTO properties (organization_id, name, property_type, status, price, location, area, bedrooms, bathrooms, created_at)
     SELECT $1, $2 || ' Plot ' || g, 'villa', 'available', 500000 + g, 'Dar es Salaam', 200, 3, 2, NOW() FROM generate_series(1,$3) g`,
    [org, label, count],
  );
  await query(
    `INSERT INTO contracts (organization_id, project_id, client_name, contract_type, status, value, created_at)
     SELECT $1, $2, $3 || ' Client ' || g, 'new', 'active', 500000 + g, NOW() FROM generate_series(1,$4) g`,
    [org, projectId, label, count],
  );
  return Date.now() - t0;
}

try {
  console.log("[perf] server base:", base);
  const admin = await token("admin@mkuyu.local");
  const md = await token("md@mkuyu.local");
  console.log("[perf] signed in as admin and md");

  const line = (label, s, extra = "") => {
    console.log(
      `${label.padEnd(30)} n=${String(s.n).padStart(4)}  mean ${s.mean.toFixed(1).padStart(7)} ms` +
      `  p50 ${s.p50.toFixed(1).padStart(6)}  p95 ${s.p95.toFixed(1).padStart(6)}` +
      `  p99 ${s.p99.toFixed(1).padStart(6)}  max ${s.max.toFixed(1).padStart(7)}  ${extra}`,
    );
  };

  for (const size of SIZES) {
    const seeded = await seed(size);
    const counts = (await query(
      `SELECT (SELECT COUNT(*)::int FROM clients WHERE name LIKE 'perf${size}%') AS clients,
              (SELECT COUNT(*)::int FROM properties WHERE name LIKE 'perf${size}%') AS properties,
              (SELECT COUNT(*)::int FROM contracts WHERE client_name LIKE 'perf${size}%') AS contracts`,
    )).rows[0];
    console.log(`\n================ DATASET ${size.toLocaleString()} per table ================`);
    console.log(`seeded in ${seeded} ms · clients=${counts.clients} properties=${counts.properties} contracts=${counts.contracts}`);

    // --- serial latency -----------------------------------------------------
    console.log("\n-- serial (single caller) --");
    const serial = {};
    for (const [label, path, tk] of [
      ["GET /clients", "/clients", md],
      ["GET /properties", "/properties", md],
      ["GET /contracts", "/contracts", md],
      ["GET /reports/summary", "/reports/summary", md],
      ["GET /reports/by-project", "/reports/by-project", md],
      ["GET /org/workspace", "/org/workspace", md],
    ]) {
      const samples = [];
      let errors = 0;
      let bytes = 0;
      for (let i = 0; i < 12; i += 1) {
        const r = await call(path, { token: tk });
        samples.push(r.ms);
        if (i > 0) bytes = r.bytes;
      }
      serial[label] = { ...stats(samples), bytes };
      line(label, serial[label], `${(bytes / 1024 / 1024).toFixed(2)} MB payload`);
    }

    // --- controlled concurrency --------------------------------------------
    // Driven with a simple bounded pool. A hand-rolled scheduler that re-launches
    // from a .finally() callback can spin if a request resolves immediately, and
    // the whole run then dies without output.
    console.log(`\n-- concurrent (${CONCURRENCY} in flight, ${REQUESTS} requests) --`);
    const conc = {};
    for (const [label, path, tk] of [
      ["GET /clients", "/clients", md],
      ["GET /contracts", "/contracts", md],
      ["GET /properties", "/properties", md],
    ]) {
      const samples = [];
      let errors = 0;
      const wallStart = process.hrtime.bigint();
      for (let done = 0; done < REQUESTS; done += CONCURRENCY) {
        const batch = await Promise.allSettled(
          Array.from({ length: Math.min(CONCURRENCY, REQUESTS - done) }, () => call(path, { token: tk })),
        );
        for (const outcome of batch) {
          if (outcome.status === "fulfilled") { samples.push(outcome.value.ms); if (outcome.value.status >= 400) errors += 1; }
          else errors += 1;
        }
        if (done > 0 && done % (CONCURRENCY * 10) === 0) {
          process.stdout.write(`    ${label}: ${samples.length}/${REQUESTS} ...\n`);
        }
      }
      const wallSeconds = Number(process.hrtime.bigint() - wallStart) / 1e9;
      const s = stats(samples);
      const rps = samples.length / wallSeconds;
      conc[label] = { ...s, errors, rps };
      line(label, s, `err ${errors}  ${rps.toFixed(0)} req/s`);
    }

    // --- database behaviour -------------------------------------------------
    const db = (await query(
      `SELECT
         (SELECT reltuples::bigint FROM pg_class WHERE relname='contracts') AS est_contracts,
         (SELECT count(*)::int FROM pg_stat_user_tables WHERE seq_scan > 50) AS tables_with_seq_scans,
         (SELECT count(*)::int FROM pg_stat_user_tables WHERE idx_scan > 0) AS tables_using_indexes`,
    )).rows[0];
    console.log(`\ndatabase: contracts est. rows ${db.est_contracts} · ${db.tables_with_seq_scans} tables doing heavy seq scans · ${db.tables_using_indexes} using indexes`);
    console.log(`RESULT ${JSON.stringify({ size, serial, conc })}`);
  }
} finally {
  await server.stop();
  await closeDatabase().catch(() => {});
}
console.log("\nPERF_BENCH_DONE");
