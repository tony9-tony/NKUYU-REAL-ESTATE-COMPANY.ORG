// Diaspora messages: ticks, edit, delete (for me / for everyone).
//   node --import ./test_support/guard.mjs diaspora_messages_test.mjs
// (based on the Diaspora Desk test) self sign-up (abroad -> desk, Tanzania -> Sales), password
// login and reset, identity verification (Desk checks, Legal verifies), the
// desk's own client list, and the admin's per-desk activity log.
//   node --import ./test_support/guard.mjs diaspora_desk_test.mjs
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { query, queryOne, closeDatabase } from "./backend/src/db.js";
import { assertTestDatabase, prepareTestDatabase, startIsolatedServer, reapOrphanServers } from "./test_support/harness.mjs";
import { demoPasswordFor, legacyPasswordFor } from "./backend/src/org/demoCredentials.js";

await assertTestDatabase("diaspora-messages");
reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ port: Number(process.env.MSG_PORT || 3194), label: "diaspora-messages" });
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
  const tag = `DM${Date.now()}`;
  const mail = (who) => `${who}.${tag.toLowerCase()}@example.com`;
  const desk = await signIn("diaspora@demo.mkuyu.local");
  const sales = await signIn("sales@demo.mkuyu.local");
  const deskB = await signIn("diaspora.manager@demo.mkuyu.local");
  const r0 = await signUp({ name: "Neema Joseph", email: mail("neema"), phone: "+44 7700 900123", residence: "GB", nationality: "TZ" });
  assert.equal(r0.status, 200, JSON.stringify(r0.payload));
  const cookie = r0.cookie;
  const client = await queryOne("SELECT id FROM clients WHERE lower(email)=$1", [mail("neema")]);
  const cid = client.id;
  const conv = () => staff(`/diaspora/messages/${cid}`, { token: desk });
  let c1, s1;

  await test("customer writes, desk sees it and the customer's message becomes read", async () => {
    const r = await customer("/messages", { cookie, method: "POST", body: { body: "Hello desk" } });
    assert.equal(r.status, 201, JSON.stringify(r.payload));
    c1 = r.payload.message.id;
    const v = await conv();
    assert.equal(v.payload.messages.at(-1).body, "Hello desk");
  });
  await test("desk reply: customer poll marks it delivered then read, and the desk sees the blue tick", async () => {
    const r = await staff(`/diaspora/messages/${cid}`, { token: desk, method: "POST", body: { body: "Karibu" } });
    assert.equal(r.status, 201, JSON.stringify(r.payload));
    s1 = r.payload.id;
    assert.equal((await conv()).payload.messages.find((m) => m.id === s1).read, false);
    await customer(`/messages/poll?after=${c1}&peek=1`, { cookie });
    let m = (await conv()).payload.messages.find((x) => x.id === s1);
    assert.equal(m.delivered, true); assert.equal(m.read, false);
    await customer(`/messages/poll?after=${c1}`, { cookie });
    m = (await conv()).payload.messages.find((x) => x.id === s1);
    assert.equal(m.read, true, "blue tick");
  });
  await test("customer edits own message; desk sees the new text marked edited", async () => {
    const r = await customer(`/messages/${c1}/edit`, { cookie, method: "POST", body: { body: "Hello desk, edited" } });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    const m = (await conv()).payload.messages.find((x) => x.id === c1);
    assert.equal(m.body, "Hello desk, edited"); assert.equal(m.edited, true);
    assert.equal((await customer(`/messages/${s1}/edit`, { cookie, method: "POST", body: { body: "x" } })).status, 404, "not the desk's message");
    assert.equal((await customer(`/messages/${c1}/edit`, { cookie, method: "POST", body: { body: "  " } })).status, 400);
  });
  await test("edit window: an old message cannot be edited", async () => {
    await query("UPDATE customer_messages SET created_at = NOW() - INTERVAL '20 minutes' WHERE id=$1", [c1]);
    assert.equal((await customer(`/messages/${c1}/edit`, { cookie, method: "POST", body: { body: "late" } })).status, 409);
  });
  await test("desk edits only its own message; another desk member cannot", async () => {
    assert.equal((await staff(`/diaspora/messages/${cid}/edit`, { token: deskB, method: "POST", body: { message_id: s1, body: "hijack" } })).status, 404);
    const r = await staff(`/diaspora/messages/${cid}/edit`, { token: desk, method: "POST", body: { message_id: s1, body: "Karibu sana" } });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    const p = await customer(`/messages/poll?after=${s1}&peek=1`, { cookie });
    const st = p.payload.state.find((x) => x.id === s1);
    assert.equal(st.body, "Karibu sana"); assert.equal(st.edited, true);
  });
  let c2;
  await test("delete for me hides only for that side", async () => {
    const r = await customer("/messages", { cookie, method: "POST", body: { body: "private note", reply_to: s1 } });
    c2 = r.payload.message.id;
    assert.equal((await customer(`/messages/${s1}/delete`, { cookie, method: "POST", body: { scope: "me" } })).status, 200);
    const mine = (await customer("/messages", { cookie })).payload.messages;
    assert.ok(!mine.find((m) => m.id === s1), "gone for the customer");
    assert.ok((await conv()).payload.messages.find((m) => m.id === s1 && !m.deleted), "still there for the desk");
    assert.equal((await staff(`/diaspora/messages/${cid}/delete`, { token: desk, method: "POST", body: { message_id: c2, scope: "me" } })).status, 200);
    assert.ok(!(await conv()).payload.messages.find((m) => m.id === c2), "gone for this desk member");
    assert.ok((await staff(`/diaspora/messages/${cid}`, { token: deskB })).payload.messages.find((m) => m.id === c2), "other desk member still sees it");
  });
  await test("delete for everyone leaves a tombstone on both sides; only the sender may", async () => {
    assert.equal((await staff(`/diaspora/messages/${cid}/delete`, { token: desk, method: "POST", body: { message_id: c1, scope: "all" } })).status, 403, "desk cannot withdraw the customer's message");
    assert.equal((await customer(`/messages/${s1}/delete`, { cookie, method: "POST", body: { scope: "all" } })).status, 403, "not hers");
    assert.equal((await customer(`/messages/${c1}/delete`, { cookie, method: "POST", body: { scope: "all" } })).status, 200);
    const m = (await conv()).payload.messages.find((x) => x.id === c1);
    assert.equal(m.deleted, true); assert.equal(m.body, "");
    const mine = (await customer("/messages", { cookie })).payload.messages.find((x) => x.id === c1);
    assert.equal(mine.deleted, true); assert.equal(mine.body, "");
    const s = await staff(`/diaspora/messages/${cid}/delete`, { token: desk, method: "POST", body: { message_id: s1, scope: "all" } });
    assert.equal(s.status, 200, JSON.stringify(s.payload));
    assert.equal((await customer("/messages", { cookie })).payload.messages.find((x) => x.id === c2)?.reply?.deleted, true, "quote shows deleted");
    assert.equal((await staff("/diaspora/messages", { token: desk })).payload.rows.find((r) => r.id === cid).last_body.length > 0, true);
  });
  await test("delete for everyone window is 48 hours", async () => {
    const r = await customer("/messages", { cookie, method: "POST", body: { body: "old one" } });
    await query("UPDATE customer_messages SET created_at = NOW() - INTERVAL '3 days' WHERE id=$1", [r.payload.message.id]);
    assert.equal((await customer(`/messages/${r.payload.message.id}/delete`, { cookie, method: "POST", body: { scope: "all" } })).status, 409);
  });
  await test("video call: the desk rings, the customer answers and ends; the customer can ring too", async () => {
    const start = await staff(`/diaspora/calls/${cid}`, { token: desk, method: "POST", body: {} });
    assert.equal(start.status, 201, JSON.stringify(start.payload));
    assert.equal(start.payload.call.status, "ringing"); assert.match(start.payload.call.url, /^https:\/\/meet\.jit\.si\/MKUYU-[0-9a-f]{24}#/);
    const seen = (await customer(`/messages/poll?after=0&peek=1`, { cookie })).payload.call;
    assert.equal(seen.status, "ringing"); assert.equal(seen.mine, false);
    assert.equal(seen.url.split("#")[0], start.payload.call.url.split("#")[0], "the same room");
    assert.equal((await customer(`/calls/${seen.id}/answer`, { cookie, method: "POST", body: {} })).status, 200);
    assert.equal((await conv()).payload.call.status, "active");
    assert.equal((await customer(`/calls/${seen.id}/end`, { cookie, method: "POST", body: {} })).status, 200);
    assert.equal((await conv()).payload.call, null);
    const up = await customer("/calls", { cookie, method: "POST", body: {} });
    assert.equal(up.status, 201, JSON.stringify(up.payload)); assert.equal(up.payload.call.mine, true);
    assert.equal((await staff("/diaspora/messages", { token: desk })).payload.rows.find((r) => r.id === cid).calling, true);
    const c = (await conv()).payload.call;
    assert.equal((await staff(`/diaspora/calls/${c.id}/answer`, { token: desk, method: "POST", body: {} })).status, 200);
    assert.equal((await staff(`/diaspora/calls/${c.id}/end`, { token: desk, method: "POST", body: {} })).status, 200);
    assert.equal((await staff(`/diaspora/calls/${cid}`, { token: sales, method: "POST", body: {} })).status, 403);
  });
} finally {
  await server.stop();
  await closeDatabase();
}
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
