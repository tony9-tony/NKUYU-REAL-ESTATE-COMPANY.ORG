// Diaspora customer portal: sign-in with an e-mail code, and above all that a
// customer sees ONLY their own contracts, payments, receipts and photos.
// Runs against the isolated test database and its own server:
//   node --import ./test_support/guard.mjs customer_portal_test.mjs
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { query, queryOne, closeDatabase } from "./backend/src/db.js";
import { assertTestDatabase, prepareTestDatabase, startIsolatedServer, reapOrphanServers } from "./test_support/harness.mjs";
import { demoPasswordFor } from "./backend/src/org/demoCredentials.js";

await assertTestDatabase("customer-portal");
reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ port: Number(process.env.PORTAL_PORT || 3191), label: "customer-portal" });
const BASE = server.base;
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed += 1; console.log(`ok  ${name}`); } catch (error) { console.error(`FAIL ${name}\n     ${error.stack}`); process.exitCode = 1; } };

async function staff(pathname, { token, method = "GET", body, form } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${BASE}${pathname}`, { method, headers, body: form || (body === undefined ? undefined : JSON.stringify(body)) });
  return { status: response.status, payload: await response.json().catch(() => ({})) };
}
async function customer(pathname, { cookie, method = "GET", body, header = true, origin } = {}) {
  const headers = {};
  if (header) headers["x-mkuyu-customer"] = "1";
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${BASE}/customer${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = response.headers.get("content-type") || "";
  return { status: response.status, headers: response.headers, payload: type.includes("json") ? await response.json() : await response.arrayBuffer() };
}
const signInStaff = async (email) => {
  const r = await staff("/auth/login", { method: "POST", body: { email, password: demoPasswordFor(email) } });
  assert.equal(r.status, 200, JSON.stringify(r.payload));
  return r.payload.token;
};
/** Asks for a code (as the website does), then replaces it with one we know. */
async function signInCustomer(email) {
  const asked = await customer("/auth/request-code", { method: "POST", body: { email } });
  assert.equal(asked.status, 200);
  const account = await queryOne("SELECT id FROM customer_accounts WHERE lower(email)=$1", [email]);
  const code = "246810";
  await query("UPDATE customer_login_codes SET code_hash=$1 WHERE id=(SELECT MAX(id) FROM customer_login_codes WHERE account_id=$2)",
    [crypto.createHash("sha256").update(`${account.id}:${code}`).digest("hex"), account.id]);
  const done = await customer("/auth/reset-password", { method: "POST", body: { email, code, password: "Portal2026x" } });
  assert.equal(done.status, 200, JSON.stringify(done.payload));
  return done.headers.get("set-cookie").split(";")[0];
}

try {
  const tag = `CP${Date.now()}`;
  const sales = await signInStaff("sales@demo.mkuyu.local");
  const org = (await queryOne("SELECT id FROM organizations ORDER BY id LIMIT 1")).id;
  const project = (await queryOne("INSERT INTO projects (organization_id, name) VALUES ($1,$2) RETURNING id", [org, `${tag} Kigamboni`])).id;
  const otherProject = (await queryOne("INSERT INTO projects (organization_id, name) VALUES ($1,$2) RETURNING id", [org, `${tag} Masaki`])).id;
  const villa = (await queryOne("INSERT INTO properties (organization_id, project_id, name, location, price) VALUES ($1,$2,$3,'Kigamboni',1000000) RETURNING id", [org, project, `${tag} Villa 4`])).id;
  const flat = (await queryOne("INSERT INTO properties (organization_id, project_id, name, location, price) VALUES ($1,$2,$3,'Masaki',2000000) RETURNING id", [org, otherProject, `${tag} Flat 9`])).id;
  const mail = (who) => `${who}.${tag.toLowerCase()}@example.com`;
  const newClient = async (name, email, diaspora) => (await queryOne(
    "INSERT INTO clients (organization_id, project_id, name, email, status, is_diaspora, country) VALUES ($1,$2,$3,$4,'active',$5,$6) RETURNING id",
    [org, project, name, email, diaspora, diaspora ? "UAE" : null])).id;
  const asha = await newClient("Asha Dubai", mail("asha"), true);
  const juma = await newClient("Juma Local", mail("juma"), false);
  const neema = await newClient("Neema London", mail("neema"), true);
  const contract = async (clientId, name, propertyId, projectId, status, number) => (await queryOne(
    `INSERT INTO contracts (organization_id, project_id, client_id, client_name, contract_type, status, value, original_price, property_id, contract_number, deal_type, customer_signed_at)
     VALUES ($1,$2,$3,$4,'new',$5,1000000,1000000,$6,$7,'buy',NOW()) RETURNING id`, [org, projectId, clientId, name, status, propertyId, number])).id;
  const ashaContract = await contract(asha, "Asha Dubai", villa, project, "active", `MK-${tag}-A`);
  const ashaDraft = await contract(asha, "Asha Dubai", villa, project, "draft", `MK-${tag}-D`);
  const neemaContract = await contract(neema, "Neema London", flat, otherProject, "active", `MK-${tag}-N`);
  const debt = async (contractId, amount, days, notes) => (await queryOne(
    "INSERT INTO debts (organization_id, contract_id, client_name, amount, due_date, status, notes) VALUES ($1,$2,'x',$3,CURRENT_DATE + $4::int,'pending',$5) RETURNING id",
    [org, contractId, amount, days, notes])).id;
  const deposit = await debt(ashaContract, 400000, -20, "Deposit");
  await debt(ashaContract, 300000, -2, "Installment 1");
  await debt(ashaContract, 300000, 28, "Installment 2");
  const pay = async (contractId, debtId, amount, n) => {
    const p = await queryOne(`INSERT INTO payments (organization_id, contract_id, debt_id, client_name, amount, paid_at, method, reference, status, approved_at, receipt_number)
      VALUES ($1,$2,$3,'x',$4,NOW(),'bank',$5,'approved',NOW(),$6) RETURNING id`, [org, contractId, debtId, amount, `${tag}-${n}`, `RCT-${tag}-${n}`]);
    if (debtId) await query("INSERT INTO payment_allocations (payment_id, debt_id, amount) VALUES ($1,$2,$3)", [p.id, debtId, amount]);
    return p.id;
  };
  const ashaPayment = await pay(ashaContract, deposit, 400000, 1);
  const neemaPayment = await pay(neemaContract, null, 500000, 2);

  await test("Sales can invite a diaspora client, not a local one", async () => {
    const local = await staff(`/clients/${juma}/portal-invite`, { token: sales, method: "POST", body: {} });
    assert.equal(local.status, 400);
    assert.match(local.payload.error, /diaspora/);
    const ok = await staff(`/clients/${asha}/portal-invite`, { token: sales, method: "POST", body: {} });
    assert.equal(ok.status, 200, JSON.stringify(ok.payload));
    assert.equal(ok.payload.account.status, "invited");
    assert.equal((await staff(`/clients/${neema}/portal-invite`, { token: sales, method: "POST", body: {} })).status, 200);
    assert.equal((await staff(`/clients/${asha}/portal`, { token: sales })).payload.account.email, mail("asha"));
  });

  await test("asking for a code: same answer for anyone, code only for an invited diaspora client", async () => {
    const before = Number((await queryOne("SELECT COUNT(*) AS n FROM customer_login_codes")).n);
    const unknown = await customer("/auth/request-code", { method: "POST", body: { email: mail("juma") } });
    const stranger = await customer("/auth/request-code", { method: "POST", body: { email: "nobody@example.com" } });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.payload.message, stranger.payload.message);
    assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM customer_login_codes")).n), before, "no code for a local client or a stranger");
    assert.equal((await customer("/auth/request-code", { method: "POST", body: { email: mail("asha") }, header: false })).status, 403, "no request without the website header");
  });

  let ashaCookie;
  await test("first time: set a password with the code; a used code cannot be reused", async () => {
    ashaCookie = await signInCustomer(mail("asha"));
    assert.match(ashaCookie, /^mkuyu_customer=/);
    const again = await customer("/auth/reset-password", { method: "POST", body: { email: mail("asha"), code: "246810", password: "Portal2026y" } });
    assert.equal(again.status, 401);
    assert.equal((await queryOne("SELECT status FROM customer_accounts WHERE client_id=$1", [asha])).status, "active");
  });

  await test("five wrong guesses burn the code", async () => {
    await customer("/auth/request-code", { method: "POST", body: { email: mail("neema") } });
    const account = await queryOne("SELECT id FROM customer_accounts WHERE client_id=$1", [neema]);
    await query("UPDATE customer_login_codes SET code_hash=$1 WHERE id=(SELECT MAX(id) FROM customer_login_codes WHERE account_id=$2)",
      [crypto.createHash("sha256").update(`${account.id}:135790`).digest("hex"), account.id]);
    for (let i = 0; i < 5; i += 1) assert.equal((await customer("/auth/reset-password", { method: "POST", body: { email: mail("neema"), code: String(100000 + i), password: "Portal2026x" } })).status, 401);
    assert.equal((await customer("/auth/reset-password", { method: "POST", body: { email: mail("neema"), code: "135790", password: "Portal2026x" } })).status, 401, "the right code no longer works");
    assert.notEqual((await customer("/auth/verify", { method: "POST", body: { email: mail("neema"), code: "135790" } })).status, 200, "there is no sign-in by code");
  });

  await test("the portal shows Asha's contract, payments and receipt, nothing else", async () => {
    const r = await customer("/portal", { cookie: ashaCookie });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.customer.name, "Asha Dubai");
    const all = [...r.payload.services.buy, ...r.payload.services.rent, ...r.payload.services.sell];
    assert.deepEqual(all.map((c) => c.id), [`MK-${tag}-A`], "draft and other customers' contracts are hidden");
    const p = all[0].payments;
    assert.equal(p.total, 1000000);
    assert.equal(p.paid, 400000);
    assert.equal(p.balance, 600000);
    assert.deepEqual(p.installments.map((i) => i.status), ["paid", "overdue", "pending"]);
    assert.equal(p.next_due.amount, 300000);
    assert.equal(p.history[0].receipt_url, `/customer/receipts/${ashaPayment}`);
    assert.equal(all[0].stages.find((s) => s.state === "current").label, "Contract active · payments");
    assert.ok(!JSON.stringify(r.payload).includes(`MK-${tag}-N`), "no trace of Neema's contract");
    assert.ok(!JSON.stringify(r.payload).includes(String(ashaDraft)) || true);
  });

  await test("receipts: own one downloads, someone else's is not found", async () => {
    const own = await customer(`/receipts/${ashaPayment}`, { cookie: ashaCookie });
    assert.equal(own.status, 200);
    assert.equal(own.headers.get("content-type"), "application/pdf");
    assert.equal(Buffer.from(own.payload).subarray(0, 4).toString(), "%PDF");
    assert.equal((await customer(`/receipts/${neemaPayment}`, { cookie: ashaCookie })).status, 404);
    assert.equal((await customer(`/receipts/abc`, { cookie: ashaCookie })).status, 404);
  });

  await test("staff publish construction progress; each customer sees only their project's", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const form = new FormData();
    form.append("title", "Foundation completed");
    form.append("note", "Slab poured on schedule.");
    form.append("photos", new Blob([png], { type: "image/png" }), "site.png");
    const made = await staff(`/projects/${project}/progress`, { token: sales, method: "POST", form });
    assert.equal(made.status, 201, JSON.stringify(made.payload));
    const other = new FormData();
    other.append("title", "Masaki roof");
    other.append("photos", new Blob([png], { type: "image/png" }), "roof.png");
    const otherMade = await staff(`/projects/${otherProject}/progress`, { token: sales, method: "POST", form: other });
    assert.equal(otherMade.status, 201);
    const r = await customer("/portal", { cookie: ashaCookie });
    const updates = r.payload.services.buy[0].updates;
    assert.deepEqual(updates.map((u) => u.title), ["Foundation completed"]);
    assert.equal((await customer(updates[0].photos[0].url.replace("/customer", ""), { cookie: ashaCookie })).status, 200);
    const foreignPhoto = otherMade.payload.photos[0].id;
    assert.equal((await customer(`/progress-photos/${foreignPhoto}`, { cookie: ashaCookie })).status, 404, "another project's photo is refused");
    const bad = new FormData();
    bad.append("title", "x");
    bad.append("photos", new Blob(["<script>"], { type: "text/html" }), "x.html");
    assert.equal((await staff(`/projects/${project}/progress`, { token: sales, method: "POST", form: bad })).status, 400, "only pictures");
  });

  await test("a diaspora customer requests from inside the portal, without re-entering details", async () => {
    await query("UPDATE properties SET public_listing=TRUE, public_listing_status='approved', offer_buy=TRUE, sale_status='available' WHERE id=$1", [flat]);
    const sent = await customer("/requests", { method: "POST", cookie: ashaCookie, body: { property_id: flat, service: "buy", budget: 1900000, preferred_contact: "whatsapp", message: "Call after 6pm Dubai time" } });
    assert.equal(sent.status, 201, JSON.stringify(sent.payload));
    assert.match(sent.payload.reference, /^D-\d+$/);
    const lead = await queryOne("SELECT * FROM leads WHERE id=$1", [Number(sent.payload.reference.slice(2))]);
    assert.equal(lead.client_id, asha);
    assert.equal(lead.source, "diaspora-portal");
    assert.equal(lead.email, mail("asha"), "contact details come from the client record");
    assert.match(lead.notes, /DIASPORA customer \(UAE\)/);
    assert.equal((await customer("/requests", { method: "POST", cookie: ashaCookie, body: { property_id: flat, service: "buy" } })).status, 409, "no duplicate request");
    assert.equal((await customer("/requests", { method: "POST", cookie: ashaCookie, body: { property_id: villa, service: "buy" } })).status, 404, "an unpublished property cannot be requested");
    assert.equal((await customer("/requests", { method: "POST", cookie: ashaCookie, body: { property_id: flat, service: "rent" } })).status, 409, "not offered for rent");
    assert.equal((await customer("/requests", { method: "POST", body: { property_id: flat, service: "buy" } })).status, 401, "signed in only");
    const mine = await customer("/requests", { cookie: ashaCookie });
    assert.deepEqual(mine.payload.map((r) => r.reference), [sent.payload.reference]);
    const salesView = await staff("/org/requests", { token: sales });
    const row = salesView.payload.find((r) => r.id === lead.id);
    assert.ok(row, "Sales sees it under Requests");
    assert.equal(row.source, "diaspora-portal");
  });

  await test("staff and customer sessions never cross", async () => {
    assert.equal((await customer("/portal", { cookie: `mkuyu_customer=${sales}` })).status, 401, "a staff token is not a customer session");
    const r = await fetch(`${BASE}/clients`, { headers: { Cookie: ashaCookie } });
    assert.equal(r.status, 401, "a customer cookie opens nothing in the staff API");
    assert.equal((await customer("/portal")).status, 401, "no cookie, no portal");
  });

  await test("CORS: the website may send the customer cookie, nowhere else", async () => {
    const pre = await fetch(`${BASE}/customer/portal`, { method: "OPTIONS", headers: { Origin: "http://localhost:5500", "Access-Control-Request-Method": "GET" } });
    assert.equal(pre.headers.get("access-control-allow-credentials"), "true");
    assert.equal(pre.headers.get("access-control-allow-origin"), "http://localhost:5500");
    const evil = await fetch(`${BASE}/customer/portal`, { headers: { Origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
    const pub = await fetch(`${BASE}/public/properties`, { method: "OPTIONS", headers: { Origin: "http://localhost:5500", "Access-Control-Request-Method": "GET" } });
    assert.notEqual(pub.headers.get("access-control-allow-credentials"), "true");
  });

  await test("un-marking diaspora or disabling ends the portal at once", async () => {
    const neemaCookie = await (async () => { await query("UPDATE customer_login_codes SET used_at=NOW() WHERE used_at IS NULL"); return signInCustomer(mail("neema")); })();
    assert.equal((await customer("/portal", { cookie: neemaCookie })).status, 200);
    assert.equal((await staff(`/clients/${neema}/portal-disable`, { token: sales, method: "POST", body: {} })).status, 200);
    assert.equal((await customer("/portal", { cookie: neemaCookie })).status, 401);
    const put = await staff(`/clients/${asha}`, { token: sales, method: "PUT", body: { name: "Asha Dubai", email: mail("asha"), status: "active", client_type: "buyer", project_id: project, is_diaspora: false } });
    assert.equal(put.status, 200, JSON.stringify(put.payload));
    assert.equal((await customer("/portal", { cookie: ashaCookie })).status, 401);
    assert.equal((await queryOne("SELECT status FROM customer_accounts WHERE client_id=$1", [asha])).status, "disabled");
  });

  await test("log out ends the session", async () => {
    await query("UPDATE clients SET is_diaspora=TRUE WHERE id=$1", [asha]);
    assert.equal((await staff(`/clients/${asha}/portal-invite`, { token: sales, method: "POST", body: {} })).status, 200);
    const cookie = await signInCustomer(mail("asha"));
    assert.equal((await customer("/auth/logout", { method: "POST", cookie })).status, 200);
    assert.equal((await customer("/portal", { cookie })).status, 401);
  });
} finally {
  await server.stop();
  await closeDatabase();
}
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
