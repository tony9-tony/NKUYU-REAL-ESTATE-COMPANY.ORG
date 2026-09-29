// Run: node --import ./test_support/guard.mjs pagination_bench.mjs
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { legacyPasswordFor } from "./backend/src/org/demoCredentials.js";
import { query, queryOne, closeDatabase } from "./backend/src/db.js";
import { organizationId } from "./backend/src/org/rbac.js";

reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ label: "pagination-bench", port: 3213 });
const base = server.base;

// Methodology is deliberately IDENTICAL to perf_bench_test.mjs so the numbers
// are comparable with the earlier run: same concurrency, same request count,
// same percentile helper, and the body is read as TEXT (never parsed) so a
// multi-megabyte list cannot exhaust memory just to be timed.
const CONCURRENCY = Number(process.env.PERF_CONCURRENCY || 8);
const REQUESTS = Number(process.env.PERF_REQUESTS || 120);
const SIZES = (process.env.PERF_SIZES || "1000,10000").split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n > 0);

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
  const response = await fetch(`${base}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  return { status: response.status, ms: Number(process.hrtime.bigint() - started) / 1e6, bytes: text.length };
}

async function token(email) {
  const response = await fetch(`${base}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: legacyPasswordFor(email) }),
    signal: AbortSignal.timeout(30000),
  });
  if (response.status !== 200) throw new Error(`login failed for ${email}: ${response.status}`);
  return (await response.json()).token;
}


/** Same bulk seeding as perf_bench_test.mjs, so both benchmarks see the same rows. */
async function seed(count, label) {
  const org = await organizationId();
  await query("DELETE FROM contracts WHERE client_name LIKE $1", [`${label}%`]).catch(() => {});
  await query("DELETE FROM clients WHERE name LIKE $1", [`${label}%`]).catch(() => {});
  await query("DELETE FROM properties WHERE name LIKE $1", [`${label}%`]).catch(() => {});
  await query("INSERT INTO projects (organization_id, name, status, created_at) VALUES ($1, $2, 'active', NOW())", [org, `${label} Project`]);
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
}

/** Runs `REQUESTS` calls at `CONCURRENCY`, returning latency, bytes and errors. */
async function measure(path, session) {
  const samples = [];
  let bytes = 0;
  let errors = 0;
  for (let i = 0; i < REQUESTS; i += CONCURRENCY) {
    const batch = Array.from({ length: Math.min(CONCURRENCY, REQUESTS - i) }, () => call(path, { token: session }));
    for (const result of await Promise.all(batch)) {
      if (result.status !== 200) { errors += 1; continue; }
      samples.push(result.ms);
      bytes += result.bytes;
    }
  }
  const s = stats(samples);
  return { ...s, bytes, errors, throughput: REQUESTS / (s.mean / 1000) };
}

const kb = (bytes) => (bytes / 1024).toFixed(1).padStart(8);
const ms = (v) => `${v.toFixed(1)}`.padStart(7);


try {
  console.log("[pag-bench] server base:", base);
  const admin = await token("admin@mkuyu.local");
  const md = await token("md@mkuyu.local");
  console.log("[pag-bench] signed in as admin and md");

  for (const size of SIZES) {
    const label = `pagbench${size}`;
    const t0 = Date.now();
    await seed(size, label);
    console.log(`\n[pag-bench] seeded ${size} clients / properties / contracts in ${Date.now() - t0} ms`);
    for (const [path, session, who] of [["/clients", admin, "admin"], ["/properties", admin, "admin"], ["/contracts", md, "md"]]) {
      // A single serial request of each shape first. This is the measurement
      // that always completes: at 1,000 rows the unpaginated body is ~1 MB, and
      // repeating that at concurrency exhausts this shared box before a mean,
      // p95 or p99 can be collected honestly. Payload size and single-shot
      // latency are exact; the distribution below is best-effort.
      const one = await call(path, { token: session });
      const onePage = await call(`${path}?page=1&page_size=50`, { token: session });
      console.log(`\n  ${path}  (${who}, ${size} rows) - single request`);
      console.log(`    ${"unpaginated".padEnd(12)} ${ms(one.ms)} ms   ${kb(one.bytes)} KB   status ${one.status}`);
      console.log(`    ${"page_size=50".padEnd(12)} ${ms(onePage.ms)} ms   ${kb(onePage.bytes)} KB   status ${onePage.status}`);
      console.log(`    => ${(one.ms / onePage.ms).toFixed(1)}x faster, ${(one.bytes / (onePage.bytes || 1)).toFixed(0)}x smaller`);

      if (REQUESTS > 0) {
        const bare = await measure(path, session);
        const paged = await measure(`${path}?page_size=50`, session);
        console.log(`  ${path}  (${who}) - n=${REQUESTS} @ concurrency ${CONCURRENCY}`);
        console.log(`    ${"unpaginated".padEnd(12)} mean ${ms(bare.mean)} ms  p50 ${ms(bare.p50)}  p95 ${ms(bare.p95)}  p99 ${ms(bare.p99)}  ${kb(bare.bytes)} KB  ${bare.throughput.toFixed(1)} req/s  errors ${bare.errors}`);
        console.log(`    ${"page_size=50".padEnd(12)} mean ${ms(paged.mean)} ms  p50 ${ms(paged.p50)}  p95 ${ms(paged.p95)}  p99 ${ms(paged.p99)}  ${kb(paged.bytes)} KB  ${paged.throughput.toFixed(1)} req/s  errors ${paged.errors}`);
        console.log(`    => ${(bare.mean / paged.mean).toFixed(1)}x faster, ${(bare.bytes / (paged.bytes || 1)).toFixed(0)}x smaller payload`);
      }
    }
    await query("DELETE FROM contracts WHERE client_name LIKE $1", [`${label}%`]).catch(() => {});
    await query("DELETE FROM clients WHERE name LIKE $1", [`${label}%`]).catch(() => {});
    await query("DELETE FROM properties WHERE name LIKE $1", [`${label}%`]).catch(() => {});
    await query("DELETE FROM projects WHERE name LIKE $1", [`${label}%`]).catch(() => {});
  }
} finally {
  await server.stop();
  await closeDatabase().catch(() => {});
}
console.log("\nPAGINATION_BENCH_DONE");
