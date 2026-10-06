// Diaspora trust features: legal status, ownership transfer, project stages, verification history, journey, notices.
//   node --import ./test_support/guard.mjs diaspora_trust_test.mjs
// (based on the Diaspora Desk test) self sign-up (abroad -> desk, Tanzania -> Sales), password
// login and reset, identity verification (Desk checks, Legal verifies), the
// desk's own client list, and the admin's per-desk activity log.
//   node --import ./test_support/guard.mjs diaspora_desk_test.mjs
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { query, queryOne, closeDatabase } from "./backend/src/db.js";
import { assertTestDatabase, prepareTestDatabase, startIsolatedServer, reapOrphanServers } from "./test_support/harness.mjs";
import { demoPasswordFor, legacyPasswordFor } from "./backend/src/org/demoCredentials.js";

await assertTestDatabase("diaspora-trust");
reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ port: Number(process.env.TRUST_PORT || 3195), label: "diaspora-trust" });
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
  const tag = `DT${Date.now()}`;
  const mail = (who) => `${who}.${tag.toLowerCase()}@example.com`;
  const desk = await signIn("diaspora@demo.mkuyu.local");
  const legal = await signIn("legal@demo.mkuyu.local");
  const sales = await signIn("sales@demo.mkuyu.local");
  const r0 = await signUp({ name: "Salma Hassan", email: mail("salma"), phone: "+44 7700 900456", residence: "GB", nationality: "TZ" });
  assert.equal(r0.status, 200, JSON.stringify(r0.payload));
  const cookie = r0.cookie;
  const cid = (await queryOne("SELECT id FROM clients WHERE lower(email)=$1", [mail("salma")])).id;
  const org = (await queryOne("SELECT organization_id FROM clients WHERE id=$1", [cid])).organization_id;
  const project = (await queryOne("INSERT INTO projects (organization_id, name) VALUES ($1,$2) RETURNING id", [org, `Test Heights ${tag}`])).id;
  const property = (await queryOne("INSERT INTO properties (organization_id, project_id, name, location) VALUES ($1,$2,$3,'Masaki') RETURNING id", [org, project, `Flat ${tag}`])).id;
  const portal = async () => (await customer("/portal", { cookie })).payload;

  await test("a new customer sees the journey at step one and e-mail notices on", async () => {
    const p = await portal();
    assert.equal(p.journey.steps.length, 7);
    assert.equal(p.journey.steps[0].state, "current");
    assert.equal(p.prefs.notify_email, true);
    assert.equal((await customer("/preferences", { cookie, method: "POST", body: { notify_email: false } })).status, 200);
    assert.equal((await portal()).prefs.notify_email, false);
  });
  await test("documents sent and the Desk's decisions are written to the history, shown to the customer", async () => {
    const png = new Blob([Buffer.from("%PDF-1.4\n%test\n")], { type: "application/pdf" });
    const form = new FormData(); form.append("kind", "selfie"); form.append("file", png, "me.pdf");
    const up = await customer("/verification/documents", { cookie, method: "POST", form });
    assert.equal(up.status, 201, JSON.stringify(up.payload));
    const r = await staff(`/diaspora/verifications/${cid}`, { token: desk, method: "POST", body: { action: "reject", note: "Photo page is blurry" } });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    const h = await staff(`/diaspora/verifications/${cid}/history`, { token: desk });
    assert.deepEqual(h.payload.map((e) => e.action), ["reject", "documents_submitted"]);
    const mine = (await customer("/verification", { cookie })).payload.history;
    assert.equal(mine[0].note, "Photo page is blurry");
  });
  await test("Legal records a property's status; others cannot; verified needs a deed number", async () => {
    const url = `/diaspora/legal/properties/${property}`;
    assert.equal((await staff(url, { token: desk, method: "POST", body: { legal_status: "verified", title_deed_no: "X1" } })).status, 403);
    assert.equal((await staff(url, { token: legal, method: "POST", body: { legal_status: "verified" } })).status, 400);
    assert.equal((await staff(url, { token: legal, method: "POST", body: { legal_status: "issues" } })).status, 400);
    const ok = await staff(url, { token: legal, method: "POST", body: { legal_status: "verified", title_deed_no: "TD-123", title_deed_kind: "Granted Right of Occupancy", legal_note: "Clean title" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.payload));
    const list = await staff("/diaspora/legal", { token: desk });
    assert.equal(list.payload.can_edit, false);
    assert.equal(list.payload.properties.find((p) => p.id === property).title_deed_no, "TD-123");
    assert.equal((await staff("/diaspora/legal", { token: sales })).status, 403);
  });
  let contract;
  await test("the portal shows legal status, transfer steps and project stages for a signed purchase", async () => {
    await query("UPDATE clients SET verification_status='verified', verified_at=NOW() WHERE id=$1", [cid]);
    contract = (await queryOne(`INSERT INTO contracts (organization_id, project_id, property_id, client_id, client_name, contract_type, status, deal_type, value, customer_signed_at, contract_number)
      VALUES ($1,$2,$3,$4,'Salma Hassan','new','active','buy',100000000,NOW(),$5) RETURNING id`, [org, project, property, cid, `C-${tag}`])).id;
    const stages = await staff(`/projects/${project}/stages`, { token: sales, method: "PUT", body: { progress_pct: 40, expected_completion: "2027-06-30",
      stages: [{ title: "Foundation", status: "done" }, { title: "Walls", status: "current" }, { title: "Roof", status: "upcoming", planned_date: "2027-01-15" }] } });
    assert.equal(stages.status, 200, JSON.stringify(stages.payload));
    const t = await staff(`/diaspora/legal/contracts/${contract}/transfer`, { token: legal, method: "POST", body: { stage: "tax_clearance", note: "TRA stamp duty paid" } });
    assert.equal(t.status, 200, JSON.stringify(t.payload));
    const item = (await portal()).services.buy[0];
    assert.equal(item.legal.status, "verified"); assert.equal(item.legal.deed_no, "TD-123");
    assert.equal(item.transfer.stage, "tax_clearance");
    assert.deepEqual(item.transfer.steps.map((s) => s.state), ["done", "current", "upcoming", "upcoming"]);
    assert.equal(item.project.progress_pct, 40);
    assert.deepEqual(item.project.stages.map((x) => x.state), ["done", "current", "upcoming"]);
    const j = (await portal()).journey;
    assert.equal(j.steps[3].state, "done", "agreement signed");
  });
  await test("transfer stage is validated and a lease has no transfer", async () => {
    assert.equal((await staff(`/diaspora/legal/contracts/${contract}/transfer`, { token: legal, method: "POST", body: { stage: "nonsense" } })).status, 400);
    assert.equal((await staff(`/diaspora/legal/contracts/${contract}/transfer`, { token: desk, method: "POST", body: { stage: "registry" } })).status, 403);
    await query("UPDATE contracts SET deal_type='rent' WHERE id=$1", [contract]);
    assert.equal((await staff(`/diaspora/legal/contracts/${contract}/transfer`, { token: legal, method: "POST", body: { stage: "registry" } })).status, 409);
  });
  await test("a customer's request reaches the Diaspora Desk, which can answer and close it", async () => {
    const lp = (await queryOne("INSERT INTO properties (organization_id, project_id, name, location, public_listing, public_listing_status, offer_buy, sale_status) VALUES ($1,$2,$3,'Kigamboni',TRUE,'approved',TRUE,'available') RETURNING id", [org, project, `House ${tag}`])).id;
    await query("UPDATE contracts SET deal_type='buy' WHERE id=$1", [contract]);
    const r = await customer("/requests", { cookie, method: "POST", body: { service: "buy", property_id: lp, message: "Is it still free?" } });
    assert.equal(r.status, 201, JSON.stringify(r.payload));
    const list = await staff("/diaspora/requests", { token: desk });
    assert.equal(list.status, 200, JSON.stringify(list.payload));
    const row = list.payload.rows.find((x) => x.property_id === lp);
    assert.ok(row, "the desk sees it"); assert.equal(row.status, "new"); assert.equal(row.client_name, "Salma Hassan");
    assert.equal((await staff(`/diaspora/requests/${row.id}`, { token: sales, method: "POST", body: { status: "contacted" } })).status, 403);
    assert.equal((await staff(`/diaspora/requests/${row.id}`, { token: desk, method: "POST", body: { status: "contacted" } })).status, 200);
    assert.equal((await customer("/requests", { cookie })).payload.find((x) => x.property_id === lp).status, "Contacted");
  });
  await test("a passport about to expire is reminded once and recorded", async () => {
    const { sendExpiryReminders } = await import("./backend/src/notify/diasporaNotices.js");
    await query("INSERT INTO documents (organization_id, client_id, title, category, status, expires_on) VALUES ($1,$2,'Passport','kyc_passport','pending', CURRENT_DATE + 10)", [org, cid]);
    assert.ok(await sendExpiryReminders() >= 1);
    assert.equal(await sendExpiryReminders(), 0, "only once");
    const h = await staff(`/diaspora/verifications/${cid}/history`, { token: desk });
    assert.ok(h.payload.some((e) => e.action === "expiry_reminder"));
  });
} finally {
  await server.stop();
  await closeDatabase();
}
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
