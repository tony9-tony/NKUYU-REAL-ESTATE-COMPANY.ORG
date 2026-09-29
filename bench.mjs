// Backend latency benchmark. Runs against the live server and reports the mean
// and p95 of each endpoint over N iterations, so performance work can be
// measured instead of guessed.
import { closeDatabase } from "./backend/src/db.js";
import { legacyPasswordFor } from "./backend/src/org/demoCredentials.js";

const BASE = "http://localhost:3003/api/v1";
const ROUNDS = Number(process.env.BENCH_ROUNDS || 25);

async function call(path, { token, method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const started = process.hrtime.bigint();
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { status: response.status, ms, payload };
}

async function token(email, password) {
  const login = await call("/auth/login", { method: "POST", body: { email, password } });
  if (login.status !== 200) throw new Error(`login failed for ${email}`);
  return login.payload.token;
}

async function bench(label, run) {
  await run(); // warm-up
  const samples = [];
  for (let i = 0; i < ROUNDS; i += 1) samples.push((await run()).ms);
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
  console.log(`${label.padEnd(34)} mean ${mean.toFixed(1).padStart(7)} ms   p95 ${p95.toFixed(1).padStart(7)} ms`);
  return { mean, p95 };
}

const admin = await token("admin@mkuyu.local", legacyPasswordFor("admin@mkuyu.local"));
const md = await token("md@mkuyu.local", legacyPasswordFor("md@mkuyu.local"));
const sales = await token("sales.officer@mkuyu.local", legacyPasswordFor("sales.officer@mkuyu.local"));

console.log(`\nBENCHMARK  (${ROUNDS} rounds per endpoint)\n`);
const results = {};
results["POST /auth/login"] = await bench("POST /auth/login", () => call("/auth/login", { method: "POST", body: { email: "admin@mkuyu.local", password: legacyPasswordFor("admin@mkuyu.local") } }));
results["GET /org/me (md)"] = await bench("GET /org/me (md)", () => call("/org/me", { token: md }));
results["GET /org/me (sales)"] = await bench("GET /org/me (sales)", () => call("/org/me", { token: sales }));
results["GET /contracts (md)"] = await bench("GET /contracts (md)", () => call("/contracts", { token: md }));
results["GET /projects (md)"] = await bench("GET /projects (md)", () => call("/projects", { token: md }));
results["GET /clients (sales)"] = await bench("GET /clients (sales)", () => call("/clients", { token: sales }));
results["GET /debts (md)"] = await bench("GET /debts (md)", () => call("/debts", { token: md }));
results["GET /documents (md)"] = await bench("GET /documents (md)", () => call("/documents", { token: md }));
results["GET /properties (md)"] = await bench("GET /properties (md)", () => call("/properties", { token: md }));
results["GET /reports/summary (md)"] = await bench("GET /reports/summary (md)", () => call("/reports/summary", { token: md }));
results["GET /reports/by-project (md)"] = await bench("GET /reports/by-project (md)", () => call("/reports/by-project", { token: md }));
results["GET /org/leads (admin)"] = await bench("GET /org/leads (admin)", () => call("/org/leads", { token: admin }));
results["GET /org/users (admin)"] = await bench("GET /org/users (admin)", () => call("/org/users", { token: admin }));

// A cold-ish combined read, mirroring what the dashboard fires on load.
const dashboardCalls = ["/projects", "/contracts", "/clients", "/properties", "/appointments", "/documents", "/reports/summary", "/reports/by-project", "/org/me"];
results["DASHBOARD (9 parallel)"] = await bench(`DASHBOARD (${dashboardCalls.length} parallel)`, async () => {
  const started = process.hrtime.bigint();
  await Promise.all(dashboardCalls.map((path) => call(path, { token: md })));
  return { status: 200, ms: Number(process.hrtime.bigint() - started) / 1e6, payload: null };
});
results["GET /org/workspace (md)"] = await bench("GET /org/workspace (md)", () => call("/org/workspace", { token: md }));

const total = Object.values(results).reduce((sum, entry) => sum + entry.mean, 0);
console.log(`\nTOTAL mean across endpoints: ${total.toFixed(1)} ms`);
console.log(`RESULT ${JSON.stringify(results)}`);
await closeDatabase();
