// Diaspora request flow: Desk -> Customer Service -> Desk, like Sales does for Tanzanian requests.
//   node --import ./test_support/guard.mjs diaspora_flow_test.mjs
// (based on the Diaspora Desk test) self sign-up (abroad -> desk, Tanzania -> Sales), password
// login and reset, identity verification (Desk checks, Legal verifies), the
// desk's own client list, and the admin's per-desk activity log.
//   node --import ./test_support/guard.mjs diaspora_desk_test.mjs
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { query, queryOne, closeDatabase } from "./backend/src/db.js";
import { assertTestDatabase, prepareTestDatabase, startIsolatedServer, reapOrphanServers } from "./test_support/harness.mjs";
import { demoPasswordFor, legacyPasswordFor } from "./backend/src/org/demoCredentials.js";

await assertTestDatabase("diaspora-flow");
reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ port: Number(process.env.FLOW_PORT || 3195), label: "diaspora-flow" });
const BASE = server.base;
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed += 1; console.log(`ok  ${name}`); } catch (error) { console.error(`FAIL ${name}\n     ${error.stack}`); process.exitCode = 1; } };
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");

async function staff(pathname, { token, method = "GET", body } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(`${BASE}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, payload: await r.json().catch(() => ({})) };
}
async function customer(pathname, { cookie, method = "GET", body, form } = {}) {
  const headers = { "x-mkuyu-customer": "1" };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(`${BASE}/customer${pathname}`, { method, headers, body: form || (body === undefined ? undefined : JSON.stringify(body)) });
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], payload: await r.json().catch(() => ({})) };
}
const signIn = async (email, password) => {
  const r = await staff("/auth/login", { method: "POST", body: { email, password: password || demoPasswordFor(email) } });
  assert.equal(r.status, 200, `${email}: ${JSON.stringify(r.payload)}`);
  return r.payload.token;
};
/** Full sign-up: details, then the code (replaced with one we know). */
async function signUp(details) {
  const username = details.email.split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 30);
  const start = await customer("/auth/signup", { method: "POST", body: { password: "Diaspora2026", accept: true, username, ...details } });
  assert.equal(start.status, 200, JSON.stringify(start.payload));
  const email = details.email.toLowerCase();
  await query("UPDATE customer_signups SET code_hash=$1 WHERE id=(SELECT MAX(id) FROM customer_signups WHERE lower(email)=$2)", [sha(`signup:${email}:135790`), email]);
  return customer("/auth/signup/verify", { method: "POST", body: { email, code: "135790" } });
}

try {
  const tag = `DF${Date.now()}`;
  const mail = (who) => `${who}.${tag.toLowerCase()}@example.com`;
  const desk = await signIn("diaspora@demo.mkuyu.local");
  const cs = await signIn("cs@demo.mkuyu.local");
  const md = await signIn("md@demo.mkuyu.local");
  const sales = await signIn("sales@demo.mkuyu.local");
  const r0 = await signUp({ name: "Zawadi Peter", email: mail("zawadi"), phone: "+44 7700 900456", residence: "GB", nationality: "TZ" });
  assert.equal(r0.status, 200, JSON.stringify(r0.payload));
  const cookie = r0.cookie;
  const client = await queryOne("SELECT id FROM clients WHERE lower(email)=$1", [mail("zawadi")]);
  await query("UPDATE clients SET verification_status='verified' WHERE id=$1", [client.id]);
  const project = (await staff("/projects", { token: md, method: "POST", body: { name: `DF ${tag}` } })).payload;
  const prop = (await staff("/properties", { token: sales, method: "POST", body: { project_id: project.id, name: `DF House ${tag}`, property_type: "house", price: 90000000, location: "Arusha", area: 120, offer_buy: 1, public_listing: 1 } })).payload;
  const req = await customer("/requests", { cookie, method: "POST", body: { property_id: prop.id, service: "buy", preferred_contact: "email" } });
  assert.equal(req.status, 201, JSON.stringify(req.payload));
  const leadId = Number(String(req.payload.reference).slice(2));
  let taskId;
  await test("the customer sees the request as Pending", async () => {
    const list = (await customer("/requests", { cookie })).payload;
    const row = list.find((r) => r.reference === `D-${leadId}`);
    assert.equal(row.state, "pending"); assert.equal(row.open, true); assert.match(row.status, /^Pending/);
  });
  await test("the Desk hands the request to Customer Service", async () => {
    assert.ok((await staff(`/org/requests/${leadId}/handed-off`, { token: sales, method: "POST", body: { task_id: 1 } })).status >= 400, "Sales cannot touch diaspora requests");
    const assignees = (await staff("/org/tasks/assignees?department=CUSTOMER%20SERVICE", { token: desk })).payload;
    assert.ok(assignees.length, "the Desk may pick Customer Service officers: " + JSON.stringify(assignees));
    const me = (await staff("/org/me", { token: desk })).payload.user;
    const t = await staff("/org/tasks", { token: desk, method: "POST", body: { title: "Contact Zawadi (diaspora)", assigned_to: assignees[0].id, reviewer_id: me.id, priority: "high" } });
    assert.equal(t.status, 201, JSON.stringify(t.payload)); taskId = t.payload.id;
    const h = await staff(`/org/requests/${leadId}/handed-off`, { token: desk, method: "POST", body: { task_id: taskId } });
    assert.equal(h.status, 200, JSON.stringify(h.payload));
    assert.equal((await customer("/requests", { cookie })).payload.find((r) => r.reference === `D-${leadId}`).state, "active");
  });
  await test("Customer Service sees the request, reports, and the Desk accepts it", async () => {
    const seen = (await staff("/org/requests", { token: cs })).payload.find((r) => r.id === leadId);
    assert.ok(seen, "Customer Service sees the diaspora request they were handed");
    const o = await staff(`/org/tasks/${taskId}/outcome`, { token: cs, method: "POST", body: { outcome: "interested", note: "Wants to buy, pays in instalments." } });
    assert.equal(o.status, 200, JSON.stringify(o.payload));
    await staff(`/org/tasks/${taskId}/actions`, { token: desk, method: "POST", body: { action: "begin_review" } });
    const a = await staff(`/org/tasks/${taskId}/actions`, { token: desk, method: "POST", body: { action: "approve" } });
    assert.equal(a.status, 200, JSON.stringify(a.payload));
    const row = (await staff("/org/requests", { token: desk })).payload.find((r) => r.id === leadId);
    assert.equal(row.outcome_note, "Wants to buy, pays in instalments.");
  });
} finally {
  await server.stop();
  await closeDatabase();
}
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
