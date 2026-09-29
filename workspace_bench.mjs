// ---------------------------------------------------------------------------
// Workspace benchmark - ISOLATED TEST DATABASE ONLY.
//
// Measures GET /org/workspace with the SAME methodology as perf_bench_test.mjs
// (identical percentile helper, identical "read the body as text" rule, the
// same seeding) so the before/after numbers are directly comparable with the
// earlier 1.95 MB / 137.9 ms measurement.
//
// Run: node --import ./test_support/guard.mjs workspace_bench.mjs
//       WS_SIZES=1000,10000 WS_REQUESTS=12 node ... workspace_bench.mjs
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { legacyPasswordFor } from "./backend/src/org/demoCredentials.js";
import { query, queryOne, closeDatabase } from "./backend/src/db.js";
import { organizationId } from "./backend/src/org/rbac.js";

// Progress is appended synchronously rather than through console.log. Redirected
// stdout is block-buffered on Windows, so a long run can die (or be killed)
// before anything reaches the log and the failure looks like a hang with no
// output at all. appendFileSync writes through on every call.
import { appendFileSync } from "node:fs";
const LOG = process.env.WS_LOG || "ws_bench.log";
const say = (line) => { appendFileSync(LOG, `${line}\n`); };


reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ label: "workspace-bench", port: 3214 });
const base = server.base;

const REQUESTS = Number(process.env.WS_REQUESTS || 12);
const SIZES = (process.env.WS_SIZES || "1000").split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n > 0);

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

async function call(path, { token } = {}) {
  const started = process.hrtime.bigint();
  const response = await fetch(`${base}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(30000),
  });
  // Text, not parsed JSON: the point is to measure a multi-megabyte response,
  // and parsing it would measure the harness rather than the server.
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

/**
 * Seeds every table the workspace returns, so the baseline reflects the real
 * payload mix (contracts, properties, clients, documents, debts, payments,
 * appointments, leads and follow-ups all scale with the dataset).
 */
async function seed(count, label) {
  const org = await organizationId();
  const like = `${label}%`;
  for (const [table, column] of [["contracts", "client_name"], ["clients", "name"], ["properties", "name"], ["debts", "client_name"], ["payments", "client_name"], ["documents", "title"], ["appointments", "title"], ["leads", "name"], ["follow_ups", "notes"], ["projects", "name"]]) {
    await query(`DELETE FROM ${table} WHERE ${column} LIKE $1`, [like]).catch(() => {});
  }
  await query("INSERT INTO projects (organization_id, name, status, created_at) VALUES ($1, $2, 'active', NOW())", [org, `${label} Project`]);
  const projectId = (await queryOne("SELECT id FROM projects WHERE organization_id=$1 AND name=$2", [org, `${label} Project`])).id;
  await query(
    `INSERT INTO clients (organization_id, project_id, name, client_type, status, created_at)
     SELECT $1,$2,$3 || ' Client ' || g, 'buyer', 'active', NOW() FROM generate_series(1,$4) g`,
    [org, projectId, label, count],
  );
  await query(
    `INSERT INTO properties (organization_id, project_id, name, property_type, status, price, location, area, bedrooms, bathrooms, created_at)
     SELECT $1,$2,$3 || ' Plot ' || g, 'villa', 'available', 500000 + g, 'Dar es Salaam', 200, 3, 2, NOW() FROM generate_series(1,$4) g`,
    [org, projectId, label, count],
  );
  await query(
    `INSERT INTO contracts (organization_id, project_id, client_name, contract_type, status, value, start_date, end_date, created_at)
     SELECT $1,$2,$3 || ' Client ' || g, 'new', 'active', 500000 + g, DATE '2026-01-01', DATE '2026-12-31', NOW() FROM generate_series(1,$4) g`,
    [org, projectId, label, count],
  );
  // Debts, payments, appointments, documents, leads and follow-ups hang off the
  // contracts/project created above.
  const numbered = `(SELECT id, row_number() OVER (ORDER BY id) AS g FROM contracts WHERE client_name LIKE $2)`;
  await query(
    `INSERT INTO debts (organization_id, contract_id, client_name, amount, due_date, status, created_at)
     SELECT $1, c.id, $3 || ' Client ' || c.g, 100000, DATE '2026-06-01' + c.g, 'pending', NOW() FROM ${numbered} c`,
    [org, like, label],
  );
  await query(
    `INSERT INTO payments (organization_id, contract_id, client_name, amount, paid_at, method, created_at)
     SELECT $1, c.id, $3 || ' Client ' || c.g, 50000, TIMESTAMP '2026-05-01' + c.g, 'cash', NOW() FROM ${numbered} c`,
    [org, like, label],
  );
  await query(
    `INSERT INTO documents (organization_id, project_id, title, category, status, created_at)
     SELECT $1,$2,$3 || ' Doc ' || g, 'contract', 'draft', NOW() FROM generate_series(1,$4) g`,
    [org, projectId, label, count],
  );
  await query(
    `INSERT INTO appointments (organization_id, project_id, title, appointment_type, starts_at, ends_at, status, created_at)
     SELECT $1,$2,$3 || ' Viewing ' || g, 'viewing', TIMESTAMP '2026-07-01' + g, TIMESTAMP '2026-07-01' + g + interval '1 hour', 'scheduled', NOW() FROM generate_series(1,$4) g`,
    [org, projectId, label, count],
  );
  await query(
    `INSERT INTO leads (organization_id, name, email, source, status, created_at)
     SELECT $1,$2 || ' Lead ' || g, 'l' || g || '@example.com', 'Website', 'new', NOW() FROM generate_series(1,$3) g`,
    [org, label, count],
  );
  await query(
    `INSERT INTO follow_ups (organization_id, follow_up_type, status, due_at, notes, created_at)
     SELECT $1, 'call', 'open', TIMESTAMP '2026-08-01' + g, $2 || ' Note ' || g, NOW() FROM generate_series(1,$3) g`,
    [org, label, count],
  );
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(3)} MB`;

try {
  say(`[ws-bench] server base: ${base}`);
  const admin = await token("admin@mkuyu.local");
  const md = await token("md@mkuyu.local");
  say("[ws-bench] signed in as admin and md");

  for (const size of SIZES) {
    const label = `wsbench${size}`;
    await seed(size, label);
    const counts = (await query(
      `SELECT (SELECT COUNT(*)::int FROM clients WHERE name LIKE $1) AS clients,
              (SELECT COUNT(*)::int FROM contracts WHERE client_name LIKE $1) AS contracts,
              (SELECT COUNT(*)::int FROM properties WHERE name LIKE $1) AS properties`,
      [`${label}%`],
    )).rows[0];
    say(`\n=========== DATASET ${size.toLocaleString()} per table ===========`);
    say(`seeded: clients=${counts.clients} properties=${counts.properties} contracts=${counts.contracts}`);
    for (const [who, tk] of [["md", md], ["admin", admin]]) {
      const samples = [];
      let bytes = 0;
      let errors = 0;
      for (let i = 0; i < REQUESTS; i += 1) {
        const r = await call("/org/workspace", { token: tk });
        if (r.status !== 200) { errors += 1; continue; }
        samples.push(r.ms);
        // The first call is a cold-cache outlier, so the reported payload is
        // taken from a warmed one - matching perf_bench_test.mjs.
        if (i > 0) bytes = r.bytes;
      }
      const s = stats(samples);
      say(`  GET /org/workspace (${who})  n=${s.n}  mean ${s.mean.toFixed(1)} ms  p50 ${s.p50.toFixed(1)}  p95 ${s.p95.toFixed(1)}  p99 ${s.p99.toFixed(1)}  max ${s.max.toFixed(1)}  ${mb(bytes)}  errors ${errors}`);
    }
  }
} finally {
  await server.stop();
  await closeDatabase().catch(() => {});
}
say("WORKSPACE_BENCH_DONE");

  return (await response.json()).token;
}
