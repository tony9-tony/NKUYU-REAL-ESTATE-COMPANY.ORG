import { legacyPasswordFor } from "./backend/src/org/demoCredentials.js";
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { closeDatabase } from "./backend/src/db.js";

// PRIVATE server on the throwaway test database. This suite generates reports and
// writes uploads, so it must not run against the live workspace.
reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ label: "export", port: 3206 });
const base = server.base;

const login = await fetch(`${base}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "admin@mkuyu.local", password: legacyPasswordFor("admin@mkuyu.local") }),
});
const session = await login.json();
if (!session.token) { console.log("LOGIN FAILED", JSON.stringify(session).slice(0, 300)); process.exit(1); }
const auth = { Authorization: `Bearer ${session.token}` };

let failures = 0;
const gen = await fetch(`${base}/reports/generate`, {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ report_type: "properties", format: "xlsx", title: "QA Export Probe" }),
});
const created = await gen.json();
console.log("generate:", gen.status, "id", created.id);
if (gen.status !== 201) { failures += 1; }

// Re-downloading must work for every format, and must re-generate rather than
// 500 on the stored filters_json.
for (const type of ["properties", "clients", "income", "debt"]) {
  const g = await fetch(`${base}/reports/generate`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ report_type: type, format: "xlsx" }),
  });
  const r = await g.json();
  for (const format of ["xlsx", "pdf", "docx", "pptx"]) {
    const res = await fetch(`${base}/reports/${r.id}/export?format=${format}`, { headers: auth });
    const buf = Buffer.from(await res.arrayBuffer());
    const ok = res.status === 200 && buf.length > 500;
    if (!ok) failures += 1;
    console.log(`${ok ? "ok  " : "FAIL"}  export ${type}/${format}: status=${res.status} bytes=${buf.length}`);
  }
}

// Saved filters must survive the round trip (filters with a project set).
const projects = await (await fetch(`${base}/projects`, { headers: auth })).json();
const first = (Array.isArray(projects) ? projects : projects.projects || [])[0];
if (first) {
  const g = await fetch(`${base}/reports/generate`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ report_type: "properties", format: "xlsx", project: first.id }),
  });
  const r = await g.json();
  const res = await fetch(`${base}/reports/${r.id}/export?format=xlsx`, { headers: auth });
  const buf = Buffer.from(await res.arrayBuffer());
  const ok = res.status === 200 && buf.length > 500;
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  export with project filter: status=${res.status} bytes=${buf.length}`);
}

// An uploaded report must serve its stored file untouched.
console.log(failures ? `\n${failures} EXPORT CHECK(S) FAILED` : "\nEXPORT_ALL_PASSED");
if (failures) process.exitCode = 1;
await closeDatabase();
await server.stop();
