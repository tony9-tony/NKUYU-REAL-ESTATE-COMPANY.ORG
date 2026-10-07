// Optional e-mailed sign-in code (two-step sign-in) and the chaser for hand-offs without a report.
//   node --import ./test_support/guard.mjs diaspora_security_test.mjs
// (based on the Diaspora Desk test) self sign-up (abroad -> desk, Tanzania -> Sales), password
// login and reset, identity verification (Desk checks, Legal verifies), the
// desk's own client list, and the admin's per-desk activity log.
//   node --import ./test_support/guard.mjs diaspora_desk_test.mjs
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { query, queryOne, closeDatabase } from "./backend/src/db.js";
import { assertTestDatabase, prepareTestDatabase, startIsolatedServer, reapOrphanServers } from "./test_support/harness.mjs";
import { chaseOverdueHandoffs } from "./backend/src/notify/handoffWatch.js";
import { demoPasswordFor, legacyPasswordFor } from "./backend/src/org/demoCredentials.js";

await assertTestDatabase("diaspora-security");
reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ port: Number(process.env.SEC_PORT || 3197), label: "diaspora-security" });
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
  const tag = `DS${Date.now()}`;
  const mail = (who) => `${who}.${tag.toLowerCase()}@example.com`;
  const desk = await signIn("diaspora@demo.mkuyu.local");
  const cs = await signIn("cs@demo.mkuyu.local");
  const r0 = await signUp({ name: "Neema Joseph", email: mail("neema"), phone: "+44 7700 900789", residence: "GB", nationality: "TZ" });
  assert.equal(r0.status, 200, JSON.stringify(r0.payload));
  const cookie = r0.cookie;
  const email = mail("neema");
  const account = await queryOne("SELECT id, client_id FROM customer_accounts WHERE lower(email)=$1", [email]);
  const codeHash = (code) => sha(`${account.id}:${code}`);
  const login = () => customer("/auth/login", { method: "POST", body: { identifier: email, password: "Diaspora2026" } });
  const verify = (code) => customer("/auth/login-verify", { method: "POST", body: { identifier: email, code } });
  const plant = async (code, purpose) => query("UPDATE customer_login_codes SET code_hash=$1 WHERE id=(SELECT MAX(id) FROM customer_login_codes WHERE account_id=$2 AND purpose=$3)", [codeHash(code), account.id, purpose]);

  await test("by default sign-in is password only", async () => {
    const r = await login();
    assert.equal(r.status, 200); assert.match(r.cookie, /^mkuyu_customer=/); assert.equal(r.payload.needs_code, undefined);
    const prefs = (await customer("/portal", { cookie })).payload.prefs;
    assert.equal(prefs.two_factor, false);
    assert.equal(typeof prefs.two_factor_available, "boolean");
  });

  await test("the code can only be switched on while e-mail can be sent, and notices stay on", async () => {
    const available = (await customer("/portal", { cookie })).payload.prefs.two_factor_available;
    const r = await customer("/preferences", { cookie, method: "POST", body: { two_factor: true } });
    // No SMTP on the server: refuse, so nobody can lock themselves out. SMTP set up: allowed.
    assert.equal(r.status, available ? 200 : 400, JSON.stringify(r.payload));
    assert.equal((await queryOne("SELECT two_factor FROM customer_accounts WHERE id=$1", [account.id])).two_factor, available);
    if (available) assert.equal((await customer("/preferences", { cookie, method: "POST", body: { two_factor: false } })).status, 200);
    await query("UPDATE customer_accounts SET two_factor=FALSE WHERE id=$1", [account.id]);
    assert.equal((await queryOne("SELECT notify_email FROM clients WHERE id=$1", [account.client_id])).notify_email !== false, true);
  });

  await test("turning a notice off does not touch the sign-in code setting", async () => {
    await query("UPDATE customer_accounts SET two_factor=TRUE WHERE id=$1", [account.id]);
    const r = await customer("/preferences", { cookie, method: "POST", body: { notify_email: false } });
    assert.equal(r.status, 200);
    assert.equal((await queryOne("SELECT two_factor FROM customer_accounts WHERE id=$1", [account.id])).two_factor, true);
    await customer("/preferences", { cookie, method: "POST", body: { notify_email: true } });
  });

  await test("with the code on: the password alone gives no session, the right code does", async () => {
    const r = await login();
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.needs_code, true);
    assert.equal(r.cookie, "", "no session yet");
    assert.equal((await verify("000000")).status, 401, "a wrong code is refused");
    await plant("246810", "login");
    const ok = await verify("246810");
    assert.equal(ok.status, 200, JSON.stringify(ok.payload));
    assert.match(ok.cookie, /^mkuyu_customer=/);
    assert.equal((await verify("246810")).status, 401, "a code works once");
  });

  await test("a password-reset code cannot be used as a sign-in code, and a wrong password still fails", async () => {
    await query("INSERT INTO customer_login_codes (account_id, code_hash, expires_at) VALUES ($1,$2,NOW() + INTERVAL '10 minutes')", [account.id, codeHash("135791")]);
    assert.equal((await verify("135791")).status, 401);
    assert.equal((await customer("/auth/login", { method: "POST", body: { identifier: email, password: "Wrong2026x" } })).status, 401);
  });

  await test("a customer without the code switched on cannot use /auth/login-verify at all", async () => {
    await query("UPDATE customer_accounts SET two_factor=FALSE WHERE id=$1", [account.id]);
    await query("INSERT INTO customer_login_codes (account_id, code_hash, expires_at, purpose) VALUES ($1,$2,NOW() + INTERVAL '10 minutes','login')", [account.id, codeHash("112233")]);
    assert.equal((await verify("112233")).status, 401);
  });

  // ---- the chaser ----
  await query("UPDATE clients SET verification_status='verified' WHERE id=$1", [account.client_id]);
  const md = await signIn("md@demo.mkuyu.local");
  const sales = await signIn("sales@demo.mkuyu.local");
  const project = (await staff("/projects", { token: md, method: "POST", body: { name: `DS ${tag}` } })).payload;
  const prop = (await staff("/properties", { token: sales, method: "POST", body: { project_id: project.id, name: `DS House ${tag}`, property_type: "house", price: 80000000, location: "Mwanza", area: 120, offer_buy: 1, public_listing: 1 } })).payload;
  const req = await customer("/requests", { cookie, method: "POST", body: { property_id: prop.id, service: "buy", preferred_contact: "whatsapp" } });
  assert.equal(req.status, 201, JSON.stringify(req.payload));
  const leadId = Number(String(req.payload.reference).slice(2));
  const assignees = (await staff("/org/tasks/assignees?department=CUSTOMER%20SERVICE", { token: desk })).payload;
  const me = (await staff("/org/me", { token: desk })).payload.user;
  const t = await staff("/org/tasks", { token: desk, method: "POST", body: { title: "Contact Neema (diaspora)", assigned_to: assignees[0].id, reviewer_id: me.id, priority: "medium" } });
  assert.equal(t.status, 201, JSON.stringify(t.payload));
  const taskId = t.payload.id;
  assert.equal((await staff(`/org/requests/${leadId}/handed-off`, { token: desk, method: "POST", body: { task_id: taskId } })).status, 200);
  const notes = async () => Number((await queryOne("SELECT COUNT(*) AS n FROM task_comments WHERE task_id=$1 AND author_id IS NULL", [taskId])).n);
  const level = async () => Number((await queryOne("SELECT overdue_level AS n FROM leads WHERE id=$1", [leadId])).n);

  await test("a fresh hand-off is left alone", async () => {
    await chaseOverdueHandoffs();
    assert.equal(await notes(), 0); assert.equal(await level(), 0);
    assert.equal((await queryOne("SELECT priority FROM tasks WHERE id=$1", [taskId])).priority, "medium");
  });

  await test("after a day without a report the task becomes urgent and gets one reminder", async () => {
    await query("UPDATE leads SET handed_off_at=NOW() - INTERVAL '25 hours' WHERE id=$1", [leadId]);
    await chaseOverdueHandoffs();
    assert.equal((await queryOne("SELECT priority FROM tasks WHERE id=$1", [taskId])).priority, "urgent");
    assert.equal(await notes(), 1); assert.equal(await level(), 1);
    await chaseOverdueHandoffs();
    assert.equal(await notes(), 1, "no second note on the same day");
  });

  await test("after two days a second reminder, then no more", async () => {
    await query("UPDATE leads SET handed_off_at=NOW() - INTERVAL '49 hours' WHERE id=$1", [leadId]);
    await chaseOverdueHandoffs();
    assert.equal(await notes(), 2); assert.equal(await level(), 2);
    await chaseOverdueHandoffs();
    assert.equal(await notes(), 2);
  });

  await test("once Customer Service has reported, nothing more is sent; a new hand-off starts again", async () => {
    await query("UPDATE leads SET overdue_level=0 WHERE id=$1", [leadId]);
    const o = await staff(`/org/tasks/${taskId}/outcome`, { token: cs, method: "POST", body: { outcome: "interested", note: "Called, wants a viewing." } });
    assert.equal(o.status, 200, JSON.stringify(o.payload));
    await chaseOverdueHandoffs();
    assert.equal(await notes(), 2, "reported: no reminder");
    const again = await staff(`/org/requests/${leadId}/handed-off`, { token: desk, method: "POST", body: { task_id: taskId } });
    assert.equal(again.status, 200, JSON.stringify(again.payload));
    assert.equal(await level(), 0, "a new hand-off resets the count");
  });
} finally {
  await server.stop();
  await closeDatabase();
}
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
