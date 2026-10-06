// Diaspora Desk: self sign-up (abroad -> desk, Tanzania -> Sales), password
// login and reset, identity verification (Desk checks, Legal verifies), the
// desk's own client list, and the admin's per-desk activity log.
//   node --import ./test_support/guard.mjs diaspora_desk_test.mjs
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { query, queryOne, closeDatabase } from "./backend/src/db.js";
import { assertTestDatabase, prepareTestDatabase, startIsolatedServer, reapOrphanServers } from "./test_support/harness.mjs";
import { demoPasswordFor, legacyPasswordFor } from "./backend/src/org/demoCredentials.js";

await assertTestDatabase("diaspora-desk");
reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ port: Number(process.env.DESK_PORT || 3193), label: "diaspora-desk" });
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
  const tag = `DD${Date.now()}`;
  const mail = (who) => `${who}.${tag.toLowerCase()}@example.com`;
  const desk = await signIn("diaspora@demo.mkuyu.local");
  const deskManager = await signIn("diaspora.manager@demo.mkuyu.local");
  const sales = await signIn("sales@demo.mkuyu.local");
  const legal = await signIn("legal@demo.mkuyu.local");
  const admin = await signIn("admin@mkuyu.local", legacyPasswordFor("admin@mkuyu.local"));
  const deskIds = (await query("SELECT u.id FROM users u JOIN user_departments ud ON ud.user_id=u.id JOIN departments d ON d.id=ud.department_id WHERE d.name='DIASPORA DESK'")).rows.map((r) => r.id);

  await test("the Diaspora Desk department and its two roles exist", async () => {
    assert.ok(await queryOne("SELECT 1 FROM departments WHERE name='DIASPORA DESK'"));
    assert.equal((await query("SELECT name FROM roles WHERE name LIKE 'Diaspora Desk%'")).rows.length, 2);
    assert.ok(deskIds.length >= 2);
  });

  let asha;
  await test("signing up from abroad creates a diaspora customer on the desk, signed in", async () => {
    const r = await signUp({ name: "Asha Mohamed", email: mail("asha"), phone: "+971 50 123 4567", residence: "AE", nationality: "TZ" });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.route, "portal");
    assert.match(r.cookie, /^mkuyu_customer=/);
    asha = { cookie: r.cookie, client: await queryOne("SELECT c.*, d.name AS dept FROM clients c JOIN departments d ON d.id=c.department_id WHERE lower(c.email)=$1", [mail("asha")]) };
    assert.equal(asha.client.is_diaspora, true);
    assert.equal(asha.client.dept, "DIASPORA DESK");
    assert.equal(asha.client.visibility, "department");
    assert.equal(asha.client.verification_status, "unverified");
    assert.equal(asha.client.residence_check, "ok");
    assert.equal(asha.client.country, "United Arab Emirates");
    assert.ok(deskIds.includes(asha.client.diaspora_officer_id), "a desk member is the contact person");
  });

  await test("a phone that does not match the country is flagged for the desk", async () => {
    const r = await signUp({ name: "John Kimaro", email: mail("john"), phone: "0754 111 222", residence: "GB", nationality: "TZ" });
    assert.equal(r.payload.route, "portal");
    assert.equal((await queryOne("SELECT residence_check FROM clients WHERE lower(email)=$1", [mail("john")])).residence_check, "check");
  });

  await test("signing up from Tanzania goes to Sales as a lead, no account", async () => {
    const r = await signUp({ name: "Halima Said", email: mail("halima"), phone: "0712 000 111", residence: "TZ", nationality: "TZ" });
    assert.equal(r.payload.route, "sales");
    const lead = await queryOne("SELECT l.*, d.name AS dept FROM leads l JOIN departments d ON d.id=l.department_id WHERE lower(l.email)=$1", [mail("halima")]);
    assert.equal(lead.dept, "SALES, MARKETING & OPERATIONS");
    assert.equal(lead.source, "website-signup");
    assert.ok(!(await queryOne("SELECT 1 FROM customer_accounts WHERE lower(email)=$1", [mail("halima")])), "no account");
  });

  await test("sign-up checks: weak password, missing consent, existing account", async () => {
    assert.equal((await customer("/auth/signup", { method: "POST", body: { name: "A B", email: mail("x"), phone: "+44 7700 900123", residence: "GB", nationality: "TZ", password: "short", accept: true } })).status, 400);
    assert.equal((await customer("/auth/signup", { method: "POST", body: { name: "A B", email: mail("x"), phone: "+44 7700 900123", residence: "GB", nationality: "TZ", password: "Diaspora2026" } })).status, 400);
    const before = Number((await queryOne("SELECT COUNT(*) AS n FROM customer_signups WHERE lower(email)=$1", [mail("asha")])).n);
    const again = await customer("/auth/signup", { method: "POST", body: { name: "Asha Mohamed", email: mail("asha"), username: `again${Date.now()}`, phone: "+971501234567", residence: "AE", nationality: "TZ", password: "Diaspora2026", accept: true } });
    assert.equal(again.status, 200, "same answer, so the form does not reveal accounts");
    assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM customer_signups WHERE lower(email)=$1", [mail("asha")])).n), before, "no second sign-up for an existing account");
  });

  await test("password login: right password in, wrong one out", async () => {
    assert.equal((await customer("/auth/login", { method: "POST", body: { email: mail("asha"), password: "Diaspora2026" } })).status, 200);
    const username = mail("asha").split("@")[0];
    assert.equal((await customer("/auth/login", { method: "POST", body: { identifier: username, password: "Diaspora2026" } })).status, 200, "username works too");
    assert.equal((await customer("/auth/login", { method: "POST", body: { identifier: username.toUpperCase(), password: "Diaspora2026" } })).status, 200, "username is not case-sensitive");
    assert.equal((await customer("/auth/login", { method: "POST", body: { email: mail("asha"), password: "Wrong2026x" } })).status, 401);
    assert.equal((await customer("/auth/login", { method: "POST", body: { email: "nobody@example.com", password: "Wrong2026x" } })).status, 401);
  });

  await test("before verification: browse and request yes, contracts no", async () => {
    const org = (await queryOne("SELECT id FROM organizations ORDER BY id LIMIT 1")).id;
    const project = (await queryOne("INSERT INTO projects (organization_id, name) VALUES ($1,$2) RETURNING id", [org, `${tag} Estate`])).id;
    await query("INSERT INTO contracts (organization_id, project_id, client_id, client_name, contract_type, status, value, original_price, contract_number, deal_type) VALUES ($1,$2,$3,'Asha','new','active',1000,1000,$4,'buy')", [org, project, asha.client.id, `MK-${tag}`]);
    const r = await customer("/portal", { cookie: asha.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.payload.verification.status, "unverified");
    assert.equal(r.payload.services.buy.length, 0, "the contract stays hidden");
  });

  await test("uploading passport and residence proof moves to 'submitted'", async () => {
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
    for (const kind of ["passport", "residence"]) {
      const form = new FormData();
      form.append("kind", kind);
      form.append("file", new Blob([pdf], { type: "application/pdf" }), `${kind}.pdf`);
      const r = await customer("/verification/documents", { method: "POST", cookie: asha.cookie, form });
      assert.equal(r.status, 201, JSON.stringify(r.payload));
    }
    assert.equal((await customer("/verification", { cookie: asha.cookie })).payload.status, "submitted");
  });

  await test("the desk sees its customers; Sales does not", async () => {
    const deskList = await staff("/clients?segment=diaspora", { token: desk });
    assert.ok(deskList.payload.some((c) => c.id === asha.client.id), "desk officer sees the customer");
    const manager = await staff("/clients?segment=diaspora", { token: deskManager });
    assert.ok(manager.payload.some((c) => c.id === asha.client.id), "the whole desk shares the queue");
    const salesList = await staff("/clients", { token: sales });
    assert.ok(!salesList.payload.some((c) => c.id === asha.client.id), "Sales does not see diaspora customers");
    assert.equal((await staff("/diaspora/verifications", { token: sales })).status, 403);
  });

  await test("verification: the Desk verifies, then Legal confirms nationality", async () => {
    const id = asha.client.id;
    assert.equal((await staff(`/diaspora/verifications/${id}`, { token: desk, method: "POST", body: { action: "reject" } })).status, 400, "a send-back needs a note");
    assert.equal((await customer("/requests", { method: "POST", cookie: asha.cookie, body: { property_id: 1, service: "buy" } })).status, 403, "no property requests before verification");
    assert.equal((await staff(`/diaspora/verifications/${id}`, { token: legal, method: "POST", body: { action: "confirm_citizenship" } })).status, 409, "Legal waits for the desk");
    const list = await staff("/diaspora/verifications", { token: desk });
    const row = list.payload.rows.find((r) => r.id === id);
    assert.equal(row.documents.length, 2);
    const file = await fetch(`${BASE}/diaspora/verifications/${id}/documents/${row.documents[0].id}`, { headers: { Authorization: `Bearer ${legal}` } });
    assert.equal(file.status, 200, "Legal opens the document");
    const done = await staff(`/diaspora/verifications/${id}`, { token: desk, method: "POST", body: { action: "verify", note: "Passport matches" } });
    assert.equal(done.status, 200, JSON.stringify(done.payload));
    assert.equal(done.payload.status, "verified", "the Desk verifies");
    assert.equal(done.payload.citizenship_confirmed, false, "nationality still for Legal");
    assert.equal((await staff(`/diaspora/verifications/${id}`, { token: desk, method: "POST", body: { action: "verify" } })).status, 409, "already verified");
    const me = await customer("/verification", { cookie: asha.cookie });
    assert.equal(me.payload.verified, true, "the portal shows the Verified badge");
    assert.equal(me.payload.nationality_confirmed, false);
    const portal = await customer("/portal", { cookie: asha.cookie });
    assert.deepEqual(portal.payload.services.buy.map((c) => c.id), [`MK-${tag}`], "the contract appears once verified");
    assert.equal((await staff(`/diaspora/verifications/${id}`, { token: desk, method: "POST", body: { action: "confirm_citizenship" } })).status, 403, "only Legal confirms nationality");
    const confirmed = await staff(`/diaspora/verifications/${id}`, { token: legal, method: "POST", body: { action: "confirm_citizenship" } });
    assert.equal(confirmed.payload.citizenship_confirmed, true);
    assert.equal((await customer("/verification", { cookie: asha.cookie })).payload.nationality_confirmed, true);
  });

  await test("forgot password: code plus a new password", async () => {
    await customer("/auth/request-code", { method: "POST", body: { email: mail("asha") } });
    const account = await queryOne("SELECT id FROM customer_accounts WHERE lower(email)=$1", [mail("asha")]);
    await query("UPDATE customer_login_codes SET code_hash=$1 WHERE id=(SELECT MAX(id) FROM customer_login_codes WHERE account_id=$2)", [sha(`${account.id}:112233`), account.id]);
    assert.equal((await customer("/auth/reset-password", { method: "POST", body: { email: mail("asha"), code: "112233", password: "weak" } })).status, 400);
    const reset = await customer("/auth/reset-password", { method: "POST", body: { email: mail("asha"), code: "112233", password: "NewPass2026" } });
    assert.equal(reset.status, 200, JSON.stringify(reset.payload));
    assert.equal((await customer("/portal", { cookie: asha.cookie })).status, 401, "old sessions end");
    assert.equal((await customer("/auth/login", { method: "POST", body: { email: mail("asha"), password: "Diaspora2026" } })).status, 401);
    assert.equal((await customer("/auth/login", { method: "POST", body: { email: mail("asha"), password: "NewPass2026" } })).status, 200);
  });

  await test("a portal request lands on the desk, assigned to the contact person", async () => {
    const login = await customer("/auth/login", { method: "POST", body: { email: mail("asha"), password: "NewPass2026" } });
    const org = (await queryOne("SELECT id FROM organizations ORDER BY id LIMIT 1")).id;
    const prop = (await queryOne("INSERT INTO properties (organization_id, name, location, price, public_listing, public_listing_status, offer_buy, sale_status) VALUES ($1,$2,'Masaki',5000000,TRUE,'approved',TRUE,'available') RETURNING id", [org, `${tag} Flat`])).id;
    const r = await customer("/requests", { method: "POST", cookie: login.cookie, body: { property_id: prop, service: "buy" } });
    assert.equal(r.status, 201, JSON.stringify(r.payload));
    const lead = await queryOne("SELECT l.*, d.name AS dept FROM leads l JOIN departments d ON d.id=l.department_id WHERE l.id=$1", [Number(r.payload.reference.slice(2))]);
    assert.equal(lead.dept, "DIASPORA DESK");
    assert.equal(lead.assigned_to, asha.client.diaspora_officer_id);
    const seen = await staff("/org/requests", { token: desk });
    assert.ok(seen.payload.some((x) => x.id === lead.id), "the desk sees it under Requests");
  });

  await test("diaspora contract: own wording, own path, signed by the customer in the portal", async () => {
    const md = await signIn("md@demo.mkuyu.local");
    const finance = await signIn("finance@demo.mkuyu.local");
    const financeManager = await signIn("finance.manager@demo.mkuyu.local");
    const org = (await queryOne("SELECT id FROM organizations ORDER BY id LIMIT 1")).id;
    const project = (await queryOne("INSERT INTO projects (organization_id, name) VALUES ($1,$2) RETURNING id", [org, `${tag} Kigamboni`])).id;
    const villa = (await queryOne("INSERT INTO properties (organization_id, project_id, name, location, price) VALUES ($1,$2,$3,'Kigamboni',9000000) RETURNING id", [org, project, `${tag} Villa`])).id;
    const terms = { project_id: project, property_id: villa, client_id: asha.client.id, client_name: "Asha Mohamed", contract_type: "new", value: 9000000, original_price: 9000000,
      payment_mode: "installments", deposit: 900000, installments: 3, frequency: "monthly", first_due_date: "2026-11-01", start_date: "2026-10-06", agreement_duration: 3, agreement_duration_unit: "months" };
    assert.equal((await staff("/contracts", { token: desk, method: "POST", body: { ...terms, deal_type: "sell" } })).status, 400, "no Sell mandate through the desk");
    assert.equal((await staff("/contracts/generate", { token: desk, method: "POST", body: { ...terms, deal_type: "sell" } })).status, 400, "nor through the wizard");
    const bare = await staff("/contracts", { token: desk, method: "POST", body: { ...terms, client_name: "Asha Mohamed", deal_type: "rent" } });
    assert.equal(bare.status, 201);
    assert.equal((await queryOne("SELECT channel FROM contracts WHERE id=$1", [bare.payload.id])).channel, "diaspora", "even a bare contract record follows the diaspora path");
    await query("DELETE FROM contracts WHERE id=$1", [bare.payload.id]);
    const made = await staff("/contracts/generate", { token: desk, method: "POST", body: { ...terms, deal_type: "buy" } });
    assert.equal(made.status, 201, JSON.stringify(made.payload));
    const id = made.payload.contract.id;
    const row = await queryOne("SELECT channel, requires_management_approval FROM contracts WHERE id=$1", [id]);
    assert.equal(row.channel, "diaspora");
    assert.equal(row.requires_management_approval, true);
    const doc = await staff(`/contracts/${id}/document-content`, { token: desk });
    assert.equal(doc.status, 200, JSON.stringify(doc.payload));
    const text = doc.payload.body_text;
    assert.match(text, /# Diaspora Sale Agreement/);
    assert.match(text, /residing in United Arab Emirates/);
    assert.match(text, /## 26\. Schedules/);
    assert.ok(!/\{\{/.test(text), "every placeholder is filled");
    const step = (who, action, body = {}) => staff(`/contracts/${id}/transition`, { token: who, method: "POST", body: { action, ...body } });
    for (const [who, action] of [[desk, "submit"], [legal, "start_review"], [legal, "legal_approve"], [finance, "finance_validate"], [legal, "submit_management"], [md, "management_approve"], [legal, "send_to_customer"]]) {
      const r = await step(who, action);
      assert.equal(r.status, 200, `${action}: ${JSON.stringify(r.payload)}`);
    }
    const early = await step(legal, "record_signature");
    assert.equal(early.status, 409);
    assert.match(early.payload.error, /signed this agreement in the portal/);
    const login = await customer("/auth/login", { method: "POST", body: { identifier: mail("asha"), password: "NewPass2026" } });
    const portal = await customer("/portal", { cookie: login.cookie });
    const item = portal.payload.services.buy.find((c) => c.contract.number === made.payload.contract.contract_number);
    assert.equal(item.signing.required, true, "the portal asks the customer to sign");
    const agreement = await customer(`/contracts/${id}/agreement`, { cookie: login.cookie });
    assert.equal(agreement.payload.can_sign, true);
    const all = Object.fromEntries(Object.keys(agreement.payload.confirmations).map((k) => [k, true]));
    const sign = (body) => customer(`/contracts/${id}/sign`, { method: "POST", cookie: login.cookie, body: { full_name: "Asha Mohamed", password: "NewPass2026", confirmations: all, fingerprint: agreement.payload.fingerprint, ...body } });
    assert.equal((await sign({ password: "Wrong2026x" })).status, 401, "password required");
    assert.equal((await sign({ confirmations: { ...all, ownership: false } })).status, 400, "every confirmation ticked");
    assert.equal((await sign({ full_name: "Someone Else" })).status, 400, "own full name");
    assert.equal((await sign({ fingerprint: "0".repeat(64) })).status, 409, "the exact text read");
    const signed = await sign({ full_name: "  asha   MOHAMED " });
    assert.equal(signed.status, 200, JSON.stringify(signed.payload));
    assert.equal((await sign({})).status, 409, "signed once");
    const record = await queryOne("SELECT customer_accepted_name, customer_accepted_hash, customer_accepted_text FROM contracts WHERE id=$1", [id]);
    assert.equal(record.customer_accepted_hash, agreement.payload.fingerprint);
    assert.equal(sha(record.customer_accepted_text), record.customer_accepted_hash, "the signed text is kept and matches its fingerprint");
    const plan = (await query("SELECT id, amount FROM debts WHERE contract_id=$1 ORDER BY due_date, id", [id])).rows;
    const pay = await staff("/payments", { token: finance, method: "POST", body: { contract_id: id, debt_id: plan[0].id, amount: Number(plan[0].amount), paid_at: "2026-10-06", method: "bank", reference: `DD-${tag}`, evidence_text: `Bank: TZS ${plan[0].amount} ref DD-${tag}` } });
    assert.equal(pay.status, 201, JSON.stringify(pay.payload));
    assert.equal((await staff(`/payments/${pay.payload.id}/approve`, { token: financeManager, method: "POST", body: {} })).status, 200);
    const done = await step(legal, "record_signature");
    assert.equal(done.status, 200, JSON.stringify(done.payload));
    const final = await queryOne("SELECT status, signed_by_names, customer_signed_by FROM contracts WHERE id=$1", [id]);
    assert.equal(final.status, "active");
    assert.match(String(final.customer_signed_by || final.signed_by_names || ""), /signed electronically in the portal/);
    assert.ok(await queryOne("SELECT 1 FROM audit_logs WHERE action='contract_customer_esigned' AND record_id=$1", [String(id)]));
  });

  await test("the desk sees ONLY diaspora work; properties stay the normal Sales ones", async () => {
    const org = (await queryOne("SELECT id FROM organizations ORDER BY id LIMIT 1")).id;
    const salesUser = (await queryOne("SELECT id FROM users WHERE email='sales@demo.mkuyu.local'")).id;
    const salesDept = (await queryOne("SELECT id FROM departments WHERE name='SALES'"))?.id ?? null;
    const project = (await queryOne("INSERT INTO projects (organization_id, name, owner_id, created_by, department_id, visibility) VALUES ($1,$2,$3,$3,$4,'department') RETURNING id", [org, `${tag} Sales Estate`, salesUser, salesDept])).id;
    const property = (await queryOne("INSERT INTO properties (organization_id, project_id, name, location, price, owner_id, created_by, department_id, visibility) VALUES ($1,$2,$3,'Mbezi',90000000,$4,$4,$5,'department') RETURNING id", [org, project, `${tag} Sales Villa`, salesUser, salesDept])).id;
    // Local work, including records in the old "unallocated" pool that every
    // department used to see.
    const local = (await queryOne("INSERT INTO clients (organization_id, project_id, name, phone, status) VALUES ($1,$2,'Local Buyer','0712 222 333','active') RETURNING id", [org, project])).id;
    const lead = (await queryOne("INSERT INTO leads (organization_id, name, phone, source) VALUES ($1,'Website Visitor','0754 000 111','website') RETURNING id", [org])).id;
    const contract = (await queryOne("INSERT INTO contracts (organization_id, project_id, client_id, client_name, contract_type, status, value, contract_number) VALUES ($1,$2,$3,'Local Buyer','new','active',5000000,$4) RETURNING id", [org, project, local, `MK-L-${tag}`])).id;
    const debt = (await queryOne("INSERT INTO debts (organization_id, contract_id, client_name, amount, due_date, status) VALUES ($1,$2,'Local Buyer',100000,CURRENT_DATE+5,'pending') RETURNING id", [org, contract])).id;

    const me = await staff("/org/me", { token: desk });
    assert.equal(me.payload.diaspora_desk_only, true, "the app knows this is a desk-only member");
    assert.equal((await staff("/org/me", { token: sales })).payload.diaspora_desk_only, false);

    const clients = (await staff("/clients", { token: desk })).payload;
    assert.ok(clients.length > 0 && clients.every((c) => c.is_diaspora), "only diaspora clients");
    assert.ok(!clients.some((c) => c.id === local));
    assert.equal((await staff(`/clients/${local}`, { token: desk })).status, 404, "a local client cannot be opened");
    const leads = (await staff("/org/leads", { token: desk })).payload;
    assert.ok(!leads.some((l) => l.id === lead), "website (local) requests are not the desk's");
    const requests = (await staff("/org/requests", { token: desk })).payload;
    const list = Array.isArray(requests) ? requests : requests.rows || [];
    assert.ok(!list.some((l) => l.id === lead));
    const contracts = (await staff("/contracts", { token: desk })).payload;
    const contractRows = Array.isArray(contracts) ? contracts : contracts.rows || [];
    assert.ok(!contractRows.some((c) => c.id === contract), "local contracts are hidden");
    assert.equal((await staff(`/contracts/${contract}`, { token: desk })).status, 404);
    const debts = await staff("/debts", { token: desk });
    if (debts.status === 200) assert.ok(!(Array.isArray(debts.payload) ? debts.payload : debts.payload.rows || []).some((d) => d.id === debt));

    const properties = (await staff("/properties", { token: desk })).payload;
    const propertyRows = Array.isArray(properties) ? properties : properties.rows || [];
    assert.ok(propertyRows.some((p) => p.id === property), "the desk sees the properties Sales posted");
    assert.equal((await staff(`/properties/${property}`, { token: desk })).status, 200);

    // Sales still sees its local work as before.
    assert.ok((await staff("/clients", { token: sales })).payload.some((c) => c.id === local));

    // A client the desk adds is always a diaspora client, even unticked.
    const made = await staff("/clients", { token: desk, method: "POST", body: { name: `${tag} Desk Added`, project_id: project, is_diaspora: false, status: "lead" } });
    assert.equal(made.status, 201, JSON.stringify(made.payload));
    assert.equal(made.payload.is_diaspora, true);

    await query("DELETE FROM debts WHERE id=$1", [debt]);
    await query("DELETE FROM contracts WHERE id=$1", [contract]);
    await query("DELETE FROM leads WHERE id=$1", [lead]);
    await query("DELETE FROM clients WHERE project_id=$1", [project]);
    await query("DELETE FROM properties WHERE id=$1", [property]);
    await query("DELETE FROM projects WHERE id=$1", [project]);
  });

  await test("client overlay: details, portal account, property taken with project and picture", async () => {
    const org = (await queryOne("SELECT id FROM organizations ORDER BY id LIMIT 1")).id;
    const project = (await queryOne("INSERT INTO projects (organization_id, name, location) VALUES ($1,$2,'Kigamboni') RETURNING id", [org, `${tag} Overlay Estate`])).id;
    const property = (await queryOne("INSERT INTO properties (organization_id, project_id, name, location, price) VALUES ($1,$2,$3,'Kigamboni',120000000) RETURNING id", [org, project, `${tag} Plot 7`])).id;
    const image = (await queryOne("INSERT INTO property_images (organization_id, property_id, original_filename, stored_name, mime_type) VALUES ($1,$2,'front.jpg','missing-front.jpg','image/jpeg') RETURNING id", [org, property])).id;
    const contract = (await queryOne("INSERT INTO contracts (organization_id, project_id, client_id, client_name, contract_type, status, value, contract_number, property_id, channel) VALUES ($1,$2,$3,'Asha','new','active',120000000,$4,$5,'diaspora') RETURNING id", [org, project, asha.client.id, `MK-O-${tag}`, property])).id;
    await query("INSERT INTO payments (organization_id, contract_id, client_name, amount, paid_at, method, reference, status, approved_at) VALUES ($1,$2,'Asha',30000000,NOW(),'bank',$3,'approved',NOW())", [org, contract, `${tag}-ov`]);
    const r = await staff(`/clients/${asha.client.id}/profile`, { token: desk });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.client.id, asha.client.id);
    assert.ok(r.payload.client.nationality, "nationality from sign-up");
    assert.ok(r.payload.account?.username, "portal username shown");
    const k = r.payload.contracts.find((c) => c.id === contract);
    assert.ok(k, "the property the customer took is listed");
    assert.equal(k.property_name, `${tag} Plot 7`);
    assert.equal(k.project_name, `${tag} Overlay Estate`);
    assert.equal(k.paid, 30000000);
    assert.equal(k.balance, 90000000);
    assert.equal(k.photo_url, `/api/v1/properties/${property}/images/${image}/file`);
    assert.equal((await staff(`/clients/${asha.client.id}/profile`, { token: sales })).status, 404, "Sales cannot open a diaspora client");
    await query("DELETE FROM payments WHERE contract_id=$1", [contract]);
    await query("DELETE FROM contracts WHERE id=$1", [contract]);
    await query("DELETE FROM properties WHERE id=$1", [property]);
    await query("DELETE FROM projects WHERE id=$1", [project]);
  });

  await test("admin sees each desk member's activity, sign-ins included", async () => {
    const r = await staff("/org/audit?department=DIASPORA%20DESK&limit=300", { token: admin });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    const actions = new Set(r.payload.map((a) => a.action));
    assert.ok(actions.has("login"));
    assert.ok(actions.has("kyc_verify"));
    assert.ok(r.payload.every((a) => deskIds.includes(a.user_id)), "only desk members' actions");
    const one = await staff(`/org/audit?user_id=${deskIds[0]}`, { token: admin });
    assert.ok(one.payload.every((a) => a.user_id === deskIds[0]));
    assert.equal((await staff("/org/audit?department=DIASPORA%20DESK", { token: desk })).status, 403, "a desk member cannot read the log");
  });
} finally {
  await server.stop();
  await closeDatabase();
}
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
