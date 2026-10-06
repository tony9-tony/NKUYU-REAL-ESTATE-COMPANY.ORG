// Customer SMS notices against a real database (the isolated TEST database,
// never mkuyu_org): payment received / fully paid, installment reminders,
// overdue notices, new-property announcements, "sent once" and "a failed one
// is retried". SMS stays in log (test) mode except where a fake gateway is used.
//
//   npm run test:notices:db
import assert from "node:assert/strict";
import { query, queryOne, pool } from "./backend/src/db.js";
import { runMigrations } from "./backend/src/migrate.js";

delete process.env.SMS_PROVIDER;
process.env.NOTIFY_EMAIL = "0";
process.env.MKUYU_CONTACT_PHONE = "0712 000 000";
const notices = await import("./backend/src/notify/customerNotices.js");

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed += 1; console.log(`ok  ${name}`); } catch (error) { console.error(`FAIL ${name}\n     ${error.stack}`); process.exitCode = 1; } };

await runMigrations({ seedDemo: false });
const tag = `NT${Date.now()}`;
const org = (await queryOne("SELECT id FROM organizations ORDER BY id LIMIT 1"))?.id
  ?? (await queryOne("INSERT INTO organizations (name, slug) VALUES ('MKUYU', $1) RETURNING id", [`mkuyu-${tag}`])).id;
const project = (await queryOne("INSERT INTO projects (organization_id, name) VALUES ($1,$2) RETURNING id", [org, `${tag} Estate`])).id;
const property = (await queryOne("INSERT INTO properties (organization_id, project_id, name, location, price) VALUES ($1,$2,$3,'Kigamboni',85000000) RETURNING id", [org, project, `${tag} Villa 4`])).id;
const client = (await queryOne("INSERT INTO clients (organization_id, project_id, name, phone, email, status, marketing_opt_in) VALUES ($1,$2,'Asha Juma','0712 345 678','asha@example.com','active',TRUE) RETURNING id", [org, project])).id;
const quiet = (await queryOne("INSERT INTO clients (organization_id, project_id, name, phone, status) VALUES ($1,$2,'No Offers','0754 111 222','active') RETURNING id", [org, project])).id;
const lead = (await queryOne("INSERT INTO leads (organization_id, name, phone, marketing_opt_in) VALUES ($1,'Website Visitor','+255 683 999 000',TRUE) RETURNING id", [org])).id;
const contract = (await queryOne(
  `INSERT INTO contracts (organization_id, project_id, client_id, client_name, client_phone, contract_type, status, value, original_price, property_id, contract_number)
   VALUES ($1,$2,$3,'Asha Juma','0712345678','new','active',1000000,1000000,$4,$5) RETURNING id`, [org, project, client, property, `MK-C-${tag}`])).id;
const debt = async (amount, days) => (await queryOne(
  "INSERT INTO debts (organization_id, contract_id, client_name, amount, due_date, status, notes) VALUES ($1,$2,'Asha Juma',$3,CURRENT_DATE + $4::int,'pending',$5) RETURNING id",
  [org, contract, amount, days, `Installment due ${days}`])).id;
const late = await debt(300000, -10);
const soon = await debt(300000, 3);
const later = await debt(400000, 40);
let paymentSeq = 0;
const approvedPayment = async (amount, debtId) => {
  paymentSeq += 1;
  const p = await queryOne(
    `INSERT INTO payments (organization_id, contract_id, debt_id, client_name, amount, paid_at, method, reference, status, approved_at, receipt_number)
     VALUES ($1,$2,$3,'Asha Juma',$4,NOW(),'bank',$5,'approved',NOW(),$6) RETURNING id`, [org, contract, debtId, amount, `${tag}-${paymentSeq}`, `RCT-${tag}-${paymentSeq}`]);
  await query("INSERT INTO payment_allocations (payment_id, debt_id, amount) VALUES ($1,$2,$3)", [p.id, debtId, amount]);
  return p.id;
};
const logFor = (where, values) => query(`SELECT * FROM notification_log WHERE ${where} ORDER BY id`, values).then((r) => r.rows);

await test("migrations created the log, the once-only index and the consent columns", async () => {
  assert.ok(await queryOne("SELECT 1 FROM pg_indexes WHERE indexname='notification_log_once'"));
  assert.ok(await queryOne("SELECT 1 FROM information_schema.columns WHERE table_name='leads' AND column_name='marketing_opt_in'"));
  await runMigrations({ seedDemo: false }); // and they run twice without error
});

await test("payment received: one SMS with balance and the next installment", async () => {
  const id = await approvedPayment(300000, late);
  const first = await notices.noticeAfterPayment(id);
  assert.equal(first.sms, "test");
  const again = await notices.noticeAfterPayment(id);
  assert.equal(again.sms, "already", "the same payment never texts twice");
  const rows = await logFor("payment_id=$1", [id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recipient, "255712345678");
  assert.equal(rows[0].status, "test");
  assert.match(rows[0].message, /Tumepokea malipo yako ya TZS 300,000/);
  assert.match(rows[0].message, /Salio: TZS 700,000\./);
  assert.match(rows[0].message, /Awamu ijayo: TZS 300,000/);
});

await test("scheduled pass: reminder at the 3-day stage, nothing overdue once paid", async () => {
  const result = await notices.runScheduledNotices({ force: true });
  assert.ok(result.due_soon.sent >= 1);
  const rows = await logFor("debt_id=$1 AND kind='due_soon'", [soon]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].dedupe_key, /:s3$/);
  assert.match(rows[0].message, /siku 3 zijazo/);
  assert.equal((await logFor("contract_id=$1 AND kind='overdue'", [contract])).length, 0, "the late installment was paid");
  await notices.runScheduledNotices({ force: true });
  assert.equal((await logFor("debt_id=$1 AND kind='due_soon'", [soon])).length, 1, "a second pass sends nothing new");
  assert.equal((await logFor("debt_id=$1", [later])).length, 0, "40 days away is too early");
});

await test("overdue: one notice per contract with the total late", async () => {
  await query("UPDATE debts SET due_date = CURRENT_DATE - 8 WHERE id=$1", [soon]);
  await notices.runScheduledNotices({ force: true });
  const rows = await logFor("contract_id=$1 AND kind='overdue'", [contract]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].dedupe_key, new RegExp(`debt:${soon}:d7$`));
  assert.match(rows[0].message, /deni la TZS 300,000 .* limechelewa siku 8\. .*piga 0712 000 000/);
});

await test("a failed SMS frees its key and is retried on the next pass", async () => {
  await query("UPDATE debts SET due_date = CURRENT_DATE - 15 WHERE id=$1", [soon]);
  Object.assign(process.env, { SMS_PROVIDER: "beem", BEEM_API_KEY: "k", BEEM_SECRET_KEY: "s" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("gateway down"); };
  try { await notices.runScheduledNotices({ force: true }); } finally { globalThis.fetch = realFetch; }
  let rows = await logFor("contract_id=$1 AND kind='overdue' AND dedupe_key LIKE '%:d14'", [contract]);
  assert.deepEqual(rows.map((r) => r.status), ["failed"]);
  assert.match(rows[0].error, /gateway down/);
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ successful: true, request_id: 42 }) });
  try { await notices.runScheduledNotices({ force: true }); } finally { globalThis.fetch = realFetch; delete process.env.SMS_PROVIDER; }
  rows = await logFor("contract_id=$1 AND kind='overdue' AND dedupe_key LIKE '%:d14'", [contract]);
  assert.deepEqual(rows.map((r) => r.status), ["failed", "sent"]);
  assert.equal(rows[1].provider, "beem");
  assert.equal(rows[1].provider_ref, "42");
});

await test("the payment that clears the contract says 'fully paid', once", async () => {
  await approvedPayment(300000, soon);
  const last = await approvedPayment(400000, later);
  const result = await notices.noticeAfterPayment(last);
  assert.equal(result.sms, "test");
  const rows = await logFor("contract_id=$1 AND kind='fully_paid'", [contract]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].message, /Hongera Asha! Umekamilisha malipo yote ya mkataba MK-C-NT\d+ \(NT\d+ Villa 4\)\. Jumla uliyolipa: TZS 1,000,000\./);
  assert.equal((await logFor("payment_id=$1 AND kind='payment_received'", [last])).length, 0, "no second 'received' SMS");
  const before = (await logFor("contract_id=$1 AND kind IN ('overdue','due_soon')", [contract])).length;
  await notices.runScheduledNotices({ force: true });
  assert.equal((await logFor("contract_id=$1 AND kind IN ('overdue','due_soon')", [contract])).length, before, "nothing is owed any more");
});

await test("new property: only people who agreed, each once", async () => {
  await query("UPDATE properties SET public_listing=TRUE, public_listing_status='approved', offer_buy=TRUE, sale_status='available' WHERE id=$1", [property]);
  const result = await notices.announceListing(property, "buy");
  assert.equal(result.sent, 2, JSON.stringify(result));
  const rows = await logFor("property_id=$1 AND kind='new_listing'", [property]);
  assert.deepEqual(rows.map((r) => r.recipient).sort(), ["255683999000", "255712345678"]);
  assert.ok(rows.every((r) => r.client_id !== quiet));
  assert.match(rows[0].message, /Inauzwa sasa! NT\d+ Villa 4, Kigamboni\. Bei: TZS 85,000,000\./);
  assert.equal((await notices.announceListing(property, "buy")).sent, 0, "announcing again tells nobody twice");
  assert.equal(lead > 0, true);
});

await test("a lead who became a client is not texted twice", async () => {
  await query("UPDATE leads SET client_id=$1 WHERE id=$2", [client, lead]);
  const other = (await queryOne("INSERT INTO properties (organization_id, project_id, name, location, price, public_listing, public_listing_status, offer_rent, rent_status, rent_price, rent_period) VALUES ($1,$2,$3,'Masaki',0,TRUE,'approved',TRUE,'available',900000,'month') RETURNING id", [org, project, `${tag} Flat 2`])).id;
  const result = await notices.announceListing(other, "rent");
  assert.equal(result.sent, 1);
  const rows = await logFor("property_id=$1", [other]);
  assert.match(rows[0].message, /Inapangishwa sasa!.*Bei: TZS 900,000 kwa mwezi\./);
});

await test("status for the System page", async () => {
  const status = await notices.noticeStatus();
  assert.equal(status.provider, "log");
  assert.equal(status.live, false);
  assert.ok(status.recent.length > 0);
  assert.ok(status.today.test > 0);
});

// Clean up this run's records.
await query("DELETE FROM notification_log WHERE contract_id=$1 OR property_id IN (SELECT id FROM properties WHERE project_id=$2) OR lead_id=$3", [contract, project, lead]);
await query("DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM payments WHERE contract_id=$1)", [contract]);
await query("DELETE FROM payments WHERE contract_id=$1", [contract]);
await query("DELETE FROM contracts WHERE id=$1", [contract]);
await query("DELETE FROM leads WHERE id=$1", [lead]);
await query("DELETE FROM clients WHERE project_id=$1", [project]);
await query("DELETE FROM properties WHERE project_id=$1", [project]);
await query("DELETE FROM projects WHERE id=$1", [project]);
await pool.end();
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
