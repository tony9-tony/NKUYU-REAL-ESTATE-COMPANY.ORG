// Customer invoices test (temporary payment method, no bank link).
// Anthony's flow: an accepted buy/rent request -> the Finance Manager raises an
// invoice before the contract -> it appears under Invoices in the customer
// portal -> "Pay now" shows MKUYU's payment details -> the customer pays outside
// and uploads proof -> the Finance Manager accepts (final) or rejects with a
// reason -> only then can the contract for that request go ahead.
// Covers every duplicate rule, the statuses, a Tanzanian customer's portal and
// the "paid before contract" rule.
// Run: npm run test:customer-payments
import crypto from "node:crypto";
import { query, queryOne, closeDatabase } from "./backend/src/db.js";
import { assertTestDatabase, startIsolatedServer } from "./test_support/harness.mjs";
import { runMigrations } from "./backend/src/migrate.js";
import { hashPassword } from "./backend/src/auth.js";
import { invoiceStatus, normalizeTransactionId, proofActionsFor, proofRefusal } from "./backend/src/payments/customerPayments.js";

await assertTestDatabase("customer_payment_test");

const PASSWORD = "CustomerPay123!";
const stamp = Date.now();
let failures = 0;
const check = (condition, label) => {
  if (condition) console.log(`ok    ${label}`);
  else { failures += 1; console.log(`FAIL  ${label}`); }
};
const section = (title) => console.log(`\n=== ${title} ===`);
const ymd = (offsetDays = 0) => { const d = new Date(Date.now() + offsetDays * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// ---- 1. Rules on their own ----------------------------------------------------------
section("1. the rules on their own");
check(normalizeTransactionId(" qj81 xk-2a ") === "QJ81XK-2A", "transaction IDs ignore spaces and case");
const inv = { amount_required: 1000, due_date: ymd(5) };
check(invoiceStatus(inv, []).status === "not_paid", "no proof: Not paid");
check(invoiceStatus({ ...inv, due_date: ymd(-1) }, []).status === "overdue", "past the due date with nothing paid: Overdue");
check(invoiceStatus(inv, [{ status: "pending" }]).status === "proof_uploaded", "proof waiting: Proof uploaded");
const partly = invoiceStatus(inv, [{ status: "accepted", amount_received: 400 }]);
check(partly.status === "partly_paid" && partly.balance === 600, "less than the amount accepted: Partly paid with the balance");
check(invoiceStatus(inv, [{ status: "accepted", amount_received: 400 }, { status: "accepted", amount_received: 600 }]).status === "paid", "accepted money covers it: Paid");
const rejected = invoiceStatus(inv, [{ id: 1, status: "rejected", reject_reason: "Not on our statement", created_at: "2026-01-01" }]);
check(rejected.status === "rejected" && rejected.reject_reason === "Not on our statement", "last proof rejected: Rejected with the reason");
check(Boolean(proofRefusal(inv, [{ status: "pending" }])) && !proofRefusal(inv, [{ status: "rejected" }]), "one proof waiting at a time; after a rejection the customer may send again");
check(proofActionsFor({ status: "pending" }, { canAccept: true }).join() === "accept,reject" && !proofActionsFor({ status: "accepted" }, { canAccept: true }).length, "Finance accepts or rejects proof that is waiting; acceptance is final");

// ---- 2. Fixtures ---------------------------------------------------------------
await runMigrations({ seedDemo: false });
const org = (await queryOne("SELECT id FROM organizations ORDER BY id LIMIT 1")).id;
const PEOPLE = [
  { key: "fm", role: "Finance Manager", department: "FINANCE & ACCOUNTS" },
  { key: "md", role: "Managing Director", department: "MANAGEMENT" },
  { key: "sales", role: "Sales Officer", department: "SALES, MARKETING & OPERATIONS" },
  { key: "cs", role: "Customer Service Officer", department: "CUSTOMER SERVICE" },
];
const users = {};
for (const person of PEOPLE) {
  const email = `cp.${person.key}.${stamp}@mkuyu.local`;
  const user = await queryOne("INSERT INTO users (organization_id,email,password_hash,display_name,role) VALUES ($1,$2,$3,$4,'staff') RETURNING id", [org, email, hashPassword(PASSWORD), `CP Test ${person.key} ${stamp}`]);
  const role = await queryOne("SELECT id FROM roles WHERE organization_id=$1 AND name=$2", [org, person.role]);
  const department = await queryOne("SELECT id FROM departments WHERE organization_id=$1 AND name=$2", [org, person.department]);
  await query("INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)", [user.id, role.id]);
  await query("INSERT INTO user_departments (user_id, department_id) VALUES ($1,$2)", [user.id, department.id]);
  users[person.key] = { id: user.id, email };
}
const project = await queryOne("INSERT INTO projects (organization_id, name, visibility) VALUES ($1,$2,'organization') RETURNING id", [org, `CP Test Project ${stamp}`]);
const customerEmail = `cp.customer.${stamp}@example.com`;
const tzClient = await queryOne("INSERT INTO clients (organization_id, name, email, phone, client_type, status, visibility) VALUES ($1,$2,$3,'+255700100200','buyer','active','organization') RETURNING id", [org, `CP Test Customer ${stamp}`, customerEmail]);
const clientB = await queryOne("INSERT INTO clients (organization_id, name, client_type, status, visibility) VALUES ($1,$2,'buyer','active','organization') RETURNING id", [org, `CP Test Second ${stamp}`]);
const lead = (clientId, accepted = true) => queryOne(
  `INSERT INTO leads (organization_id, name, phone, source, status, service, client_id, converted_at, visibility)
   VALUES ($1,$2,'+255700100200','website',$3,'buy',$4,$5,'organization') RETURNING id`,
  [org, `CP Test Lead ${stamp}`, accepted ? "converted" : "new", clientId, accepted ? new Date().toISOString() : null]);
const leadNew = await lead(tzClient.id, false);
// A contract on another customer carries a hand-recorded transaction reference.
const otherContract = await queryOne("INSERT INTO contracts (organization_id, project_id, client_name, contract_type, status, value, visibility) VALUES ($1,$2,$3,'new','active',100,'organization') RETURNING id", [org, project.id, `CP Test Other ${stamp}`]);
const manualRef = `MANUAL${stamp}`;
await query("INSERT INTO payments (organization_id, contract_id, client_name, amount, paid_at, method, reference, status, visibility) VALUES ($1,$2,$3,50,$4,'bank',$5,'pending','organization')", [org, otherContract.id, `CP Test Other ${stamp}`, ymd(), manualRef]);

const server = await startIsolatedServer({ port: Number(process.env.CP_TEST_PORT || 3197), label: "customer_payment_test" });
const tokens = {};
async function call(path, { as, method = "GET", body, form, cookie } = {}) {
  const headers = {};
  if (as) headers.Authorization = `Bearer ${tokens[as]}`;
  if (cookie) { headers.Cookie = cookie; headers["x-mkuyu-customer"] = "1"; }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${server.base}${path}`, { method, headers, body: form || (body === undefined ? undefined : JSON.stringify(body)) });
  const type = response.headers.get("content-type") || "";
  const payload = type.includes("json") ? await response.json().catch(() => ({})) : { _type: type };
  if (response.status >= 500) console.log(`  HTTP ${response.status} ${method} ${path}`, JSON.stringify(payload));
  return { status: response.status, body: payload, headers: response.headers };
}
const pngBytes = (seed) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(`proof-${seed}-${stamp}`)]);
const proofForm = (fields, file) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  if (file) form.append("file", new Blob([file], { type: "image/png" }), "receipt.png");
  return form;
};

try {
  for (const [key, user] of Object.entries(users)) {
    const res = await fetch(`${server.base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: user.email, password: PASSWORD }) });
    tokens[key] = (await res.json()).token;
  }
  const C = "/org/customer-payments";

  section("2. who takes part (no Customer Service step)");
  check((await call(`${C}/invoices`, { as: "cs" })).status === 403, "Customer Service has no part in it");
  check((await call(`${C}/invoices`, { as: "sales" })).status === 403, "a Sales Officer has no part in it");
  check((await call(`${C}/invoices`, { as: "fm" })).status === 200 && (await call(`${C}/invoices`, { as: "md" })).status === 200, "the Finance Manager and the MD see who has paid");

  section("3. Settings: MKUYU's payment details (Finance Manager)");
  const leadA = await lead(tzClient.id);
  if (!(await queryOne("SELECT 1 FROM payment_details WHERE active"))) {
    check((await call(`${C}/invoices`, { as: "fm", method: "POST", body: { lead_id: leadA.id, purpose: "Deposit", amount_required: 1000, due_date: ymd(5) } })).status === 409, "no invoice before MKUYU's payment details exist");
  }
  check((await call(`${C}/details`, { as: "md", method: "POST", body: { kind: "bank", bank_name: "CRDB", account_name: "MKUYU", account_number: "1" } })).status === 403, "the MD does not edit payment details");
  let res = await call(`${C}/details`, { as: "fm", method: "POST", body: { kind: "bank", bank_name: "CRDB Bank", branch: "Mlimani City", swift_code: "CORUTZTZ", account_name: "MKUYU AFRICA LTD", account_number: `0150${stamp}` } });
  check(res.status === 201 && res.body.active === true, "the Finance Manager adds the bank details (no approval step)");
  const bank = res.body;
  check((await call(`${C}/details`, { as: "fm", method: "POST", body: { kind: "mobile", network: "M-Pesa", account_name: "MKUYU AFRICA LTD", account_number: `0754${String(stamp).slice(-6)}` } })).status === 400, "payment settings take a bank account only (no mobile money)");

  section("4. an invoice on an accepted request, before the contract");
  check((await call(`${C}/invoices`, { as: "fm", method: "POST", body: { lead_id: leadNew.id, purpose: "Deposit", amount_required: 1000, due_date: ymd(5) } })).status === 409, "a request not yet accepted cannot be invoiced");
  check((await call(`${C}/invoices`, { as: "md", method: "POST", body: { lead_id: leadA.id, purpose: "Deposit", amount_required: 1000, due_date: ymd(5) } })).status === 403, "only the Finance Manager raises invoices");
  check((await call(`${C}/accepted-requests`, { as: "fm" })).body.some((r) => r.id === leadA.id) && !(await call(`${C}/accepted-requests`, { as: "fm" })).body.some((r) => r.id === leadNew.id), "Finance picks from accepted requests only");
  res = await call(`${C}/invoices`, { as: "fm", method: "POST", body: { lead_id: leadA.id, purpose: "Deposit", amount_required: 1000000, due_date: ymd(10), note: "Deposit before the sale agreement" } });
  check(res.status === 201 && /^INV-\d{4}-[A-Z0-9]{6}$/.test(res.body.reference) && res.body.status === "not_paid", `the invoice has a unique reference (${res.body.reference}) and is Not paid`);
  const one = res.body;
  res = await call("/contracts", { as: "sales", method: "POST", body: { project_id: project.id, client_id: tzClient.id, client_name: `CP Test Customer ${stamp}`, contract_type: "new", deal_type: "buy", value: 5000000, notes: `cp-${stamp}` } });
  check(res.status === 409 && /must|waits/.test(res.body.error || ""), "the contract for this request cannot be prepared while the invoice is unpaid");

  section("5. a Tanzanian customer gets the portal (no diaspora parts)");
  check((await call(`/clients/${clientB.id}/portal-invite`, { as: "sales", method: "POST" })).status === 400, "a Tanzanian client without an accepted request is not invited");
  res = await call(`/clients/${tzClient.id}/portal-invite`, { as: "sales", method: "POST" });
  check(res.status === 200, "a Tanzanian client with an accepted request is invited");
  await call("/customer/auth/request-code", { cookie: "x=1", method: "POST", body: { email: customerEmail } });
  const account = await queryOne("SELECT id FROM customer_accounts WHERE lower(email)=$1", [customerEmail]);
  await query("UPDATE customer_login_codes SET code_hash=$1 WHERE id=(SELECT MAX(id) FROM customer_login_codes WHERE account_id=$2)", [crypto.createHash("sha256").update(`${account.id}:246810`).digest("hex"), account.id]);
  res = await call("/customer/auth/reset-password", { cookie: "x=1", method: "POST", body: { email: customerEmail, code: "246810", password: "Portal2026x" } });
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  check(res.status === 200 && cookie.startsWith("mkuyu_customer="), "the customer sets a password and signs in");
  res = await call("/customer/portal", { cookie });
  check(res.status === 200 && res.body.diaspora === false && res.body.invoices_open === 1 && res.body.journey === null, "the portal knows a Tanzanian customer and counts one invoice to pay");
  check((await call("/customer/messages", { cookie })).status === 403 && (await call("/customer/verification", { cookie })).status === 403 && (await call("/customer/requests", { cookie })).status === 403, "Diaspora Desk messages, verification and portal requests stay diaspora-only");

  section("6. Invoices -> Pay now -> upload proof");
  res = await call("/customer/invoices", { cookie });
  check(res.status === 200 && res.body.length === 1 && res.body[0].reference === one.reference && res.body[0].can_pay && res.body[0].status === "not_paid", "the invoice is under Invoices with Pay now");
  res = await call("/customer/payment-details", { cookie });
  check(res.body.some((d) => d.id === bank.id && d.swift_code === "CORUTZTZ") && res.body.every((d) => d.kind === "bank"), "Pay now shows MKUYU's bank accounts only");
  const sms = `QJ81XK2A Confirmed. TZS 400,000 sent to MKUYU AFRICA LTD on ${ymd()} ${stamp}`;
  const send = (body, file) => call(`/customer/invoices/${one.id}/proof`, { cookie, method: "POST", ...(file ? { form: proofForm(body, file) } : { body }) });
  check((await call(`/customer/invoices/${one.id}/proof`, { cookie: undefined, method: "POST", body: {} })).status === 401, "proof needs the customer to be signed in");
  check((await send({ method: "mobile", detail_id: bank.id, transaction_id: "AB1234", amount: 1, paid_on: ymd(), sms_text: sms })).status === 400, "customers pay by bank only");
  check((await send({ method: "bank", detail_id: bank.id, transaction_id: "QJ81 XK2A", amount: 400000, paid_on: ymd(1), sms_text: sms })).status === 400, "a payment date in the future is refused");
  res = await send({ method: "bank", detail_id: bank.id, transaction_id: "QJ81 XK2A", amount: 400000, paid_on: ymd(), sms_text: sms });
  check(res.status === 201, "the customer sends the transaction ID, amount, date and the pasted message");
  check((await call("/customer/invoices", { cookie })).body[0].status === "proof_uploaded", "status: Proof uploaded");
  check((await send({ method: "bank", detail_id: bank.id, transaction_id: `OTHER${stamp}`, amount: 600000, paid_on: ymd(), sms_text: `another message ${stamp}` })).status === 409, "rule 4: one proof waiting for Finance per invoice");

  section("7. the Finance Manager accepts (final) or rejects");
  let detail = await call(`${C}/invoices/${one.id}`, { as: "fm" });
  const proofA = detail.body.proofs[0];
  check(proofA.available_actions.join() === "accept,reject", "Finance is offered Accept or Reject");
  check((await call(`${C}/proofs/${proofA.id}/accept`, { as: "md", method: "POST", body: { amount_received: 400000 } })).status === 403, "the MD does not accept payments (Finance does)");
  res = await call(`${C}/proofs/${proofA.id}/accept`, { as: "fm", method: "POST", body: { amount_received: 400000, note: "On the M-Pesa statement" } });
  check(res.status === 200 && res.body.status === "partly_paid" && res.body.balance === 600000, "accepted: Partly paid, balance TZS 600,000");
  check((await call(`${C}/proofs/${proofA.id}/accept`, { as: "fm", method: "POST", body: { amount_received: 1 } })).status === 409, "an accepted payment cannot be accepted again");
  let mine = (await call("/customer/invoices", { cookie })).body[0];
  check(mine.status === "partly_paid" && mine.balance === 600000 && mine.can_pay && /^RCT-/.test(mine.proofs[0].receipt_number || ""), "the customer sees Partly paid, the balance, may pay more, and has an MKUYU receipt");
  const receipt = await call(mine.proofs[0].receipt_url, { cookie });
  check(receipt.status === 200 && receipt.body._type.includes("pdf"), "the receipt opens as a PDF in the portal");

  section("8. duplicate rules");
  check((await send({ method: "bank", detail_id: bank.id, transaction_id: "qj81xk2a", amount: 600000, paid_on: ymd(), sms_text: `different text ${stamp}` })).status === 409, "rule 1: a transaction ID is used once (spaces and case ignored)");
  check((await send({ method: "bank", detail_id: bank.id, transaction_id: manualRef.toLowerCase(), amount: 600000, paid_on: ymd(), sms_text: `third text ${stamp}` })).status === 409, "rule 1: including references already in the payment ledger");
  check((await send({ method: "bank", detail_id: bank.id, transaction_id: `NEW${stamp}`, amount: 600000, paid_on: ymd(), sms_text: `  ${sms.toUpperCase()}  ` })).status === 409, "rule 2: the same message cannot back two payments (re-pasted, any case)");
  res = await send({ method: "bank", detail_id: bank.id, transaction_id: `FT${stamp}`, amount: 600000, paid_on: ymd() }, pngBytes("A"));
  check(res.status === 201, "the customer uploads a receipt photo for the balance");
  detail = await call(`${C}/invoices/${one.id}`, { as: "fm" });
  const proofB = detail.body.proofs.find((p) => p.transaction_id === `FT${stamp}`);
  check(proofB.has_file && (await fetch(`${server.base}${C}/proofs/${proofB.id}/file`, { headers: { Authorization: `Bearer ${tokens.fm}` } })).ok, "Finance opens the receipt photo");
  res = await call(`${C}/proofs/${proofB.id}/reject`, { as: "fm", method: "POST", body: { reason: "This amount is not on our statement yet." } });
  check(res.status === 200 && res.body.status === "rejected", "Finance rejects it with a reason");
  mine = (await call("/customer/invoices", { cookie })).body[0];
  check(mine.status === "rejected" && mine.reject_reason === "This amount is not on our statement yet." && mine.balance === 600000 && mine.can_pay, "the customer sees Rejected, the reason, the balance, and may send again");
  check((await send({ method: "bank", detail_id: bank.id, transaction_id: `FT${stamp}`, amount: 600000, paid_on: ymd() }, pngBytes("A"))).status === 201, "after a rejection the same transaction and file may be sent again");

  const leadB = await lead(tzClient.id);
  res = await call(`${C}/invoices`, { as: "fm", method: "POST", body: { lead_id: leadB.id, purpose: "Booking fee", amount_required: 600000, due_date: ymd(20) } });
  const two = res.body;
  const sendTwo = (body, file) => call(`/customer/invoices/${two.id}/proof`, { cookie, method: "POST", ...(file ? { form: proofForm(body, file) } : { body }) });
  check((await sendTwo({ method: "bank", detail_id: bank.id, transaction_id: `DUPFILE${stamp}`, amount: 600000, paid_on: ymd() }, pngBytes("A"))).status === 409, "rule 2: the same receipt file cannot back two payments");
  check((await sendTwo({ method: "bank", detail_id: bank.id, transaction_id: `TWIN${stamp}`, amount: 600000, paid_on: ymd() }, pngBytes("B"))).status === 201, "rule 3: another payment with the same customer, amount, date and method is accepted...");
  detail = await call(`${C}/invoices/${two.id}`, { as: "fm" });
  check(detail.body.proofs[0].duplicate_flag === true && /within 24 hours/.test(detail.body.proofs[0].duplicate_note || ""), "...but flagged for Finance to check");

  section("9. paid: the contract can follow, and the money counts on it");
  detail = await call(`${C}/invoices/${one.id}`, { as: "fm" });
  await call(`${C}/proofs/${detail.body.proofs.find((p) => p.status === "pending").id}/accept`, { as: "fm", method: "POST", body: { amount_received: 600000 } });
  check((await call(`${C}/invoices/${one.id}`, { as: "fm" })).body.status === "paid", "the balance accepted: Paid");
  mine = (await call("/customer/invoices", { cookie })).body.find((row) => row.id === one.id);
  check(mine.status === "paid" && !mine.can_pay, "the customer sees Paid and Pay now is gone");
  check((await send({ method: "bank", detail_id: bank.id, transaction_id: `AFTER${stamp}`, amount: 1, paid_on: ymd(), sms_text: `after paid ${stamp}` })).status === 409, "a paid invoice takes no more proof");
  res = await call("/contracts", { as: "sales", method: "POST", body: { project_id: project.id, client_id: tzClient.id, client_name: `CP Test Customer ${stamp}`, contract_type: "new", deal_type: "buy", value: 5000000, notes: `cp-${stamp}` } });
  check(res.status === 409, "still blocked while the customer's other invoice is not paid");
  await call(`${C}/proofs/${detail.body.proofs.length ? (await call(`${C}/invoices/${two.id}`, { as: "fm" })).body.proofs[0].id : 0}/accept`, { as: "fm", method: "POST", body: { amount_received: 600000 } });
  res = await call("/contracts", { as: "sales", method: "POST", body: { project_id: project.id, client_id: tzClient.id, client_name: `CP Test Customer ${stamp}`, contract_type: "new", deal_type: "buy", value: 5000000, notes: `cp-${stamp}` } });
  check(res.status === 201, "every invoice paid: Sales prepares the contract");
  const ledger = (await query("SELECT amount, status, reference, receipt_number, approved_by FROM payments WHERE contract_id=$1", [res.body.id])).rows;
  check(ledger.length === 3 && ledger.every((p) => p.status === "approved" && /^RCT-/.test(p.receipt_number) && Number(p.approved_by) === users.fm.id)
    && ledger.reduce((sum, p) => sum + Number(p.amount), 0) === 1600000, "the TZS 1,600,000 paid on the invoices is in the contract's payments, with the same receipts");
  const plan = await call(`/contracts/${res.body.id}/schedule`, { as: "md", method: "POST", body: { deposit: 1600000, installments: 2, first_due_date: ymd(30), frequency: "monthly" } });
  const debts = (await query("SELECT amount, status FROM debts WHERE contract_id=$1 ORDER BY due_date, id", [res.body.id])).rows;
  check(plan.status === 201 && debts.length === 3 && Number(debts[0].amount) === 1600000 && debts[0].status === "paid" && debts.slice(1).every((d) => d.status !== "paid"),
    "a payment plan made later counts the invoice money: the deposit shows as paid");

  section("10. a drafted contract cannot be submitted while unpaid; overdue; the list");
  const leadC = await lead(clientB.id);
  const draft = await call("/contracts", { as: "sales", method: "POST", body: { project_id: project.id, client_id: clientB.id, client_name: `CP Test Second ${stamp}`, contract_type: "new", deal_type: "buy", value: 900000, notes: `cp-${stamp}` } });
  check(draft.status === 201, "a contract drafted before any invoice exists");
  res = await call(`${C}/invoices`, { as: "fm", method: "POST", body: { lead_id: leadC.id, purpose: "Deposit", amount_required: 90000, due_date: ymd(1) } });
  const three = res.body;
  check((await call(`/contracts/${draft.body.id}/transition`, { as: "sales", method: "POST", body: { action: "submit" } })).status === 409, "it cannot be submitted to Legal while its invoice is unpaid");
  await query("UPDATE invoices SET due_date=$2 WHERE id=$1", [three.id, ymd(-3)]);
  const list = (await call(`${C}/invoices`, { as: "md" })).body;
  check(list.find((r) => r.id === three.id)?.status === "overdue", "past the due date with nothing paid: Overdue");
  check(list.find((r) => r.id === one.id)?.status === "paid" && list.find((r) => r.id === two.id)?.status === "paid", "the MD's list shows who has paid and who has not");
  const summary = (await call(`${C}/summary`, { as: "fm" })).body;
  check(summary.overdue_total >= 1 && summary.paid >= 2, "the summary counts paid and overdue invoices");
  res = await call(`${C}/invoices/${three.id}/cancel`, { as: "fm", method: "POST", body: { reason: "Raised on the wrong request." } });
  check(res.status === 200 && res.body.status === "cancelled", "an invoice with no proof can be cancelled with a reason");
  check((await call(`/contracts/${draft.body.id}/transition`, { as: "sales", method: "POST", body: { action: "submit" } })).status === 200, "with the invoice cancelled, the contract goes to Legal");

  section("11. audit trail");
  const actions = (await query("SELECT action FROM audit_logs WHERE module IN ('invoice','payment_details')")).rows.map((r) => r.action);
  for (const action of ["payment_details_added", "invoice_created", "invoice_proof_uploaded", "invoice_payment_accepted", "invoice_payment_rejected", "invoice_cancelled"]) {
    check(actions.includes(action), `audit log has ${action}`);
  }
} finally {
  await server.stop();
  const ids = Object.values(users).map((user) => user.id);
  const clientIds = [tzClient.id, clientB.id];
  const invoiceIds = (await query("SELECT id FROM invoices WHERE client_id = ANY($1::int[])", [clientIds])).rows.map((r) => String(r.id));
  await query("DELETE FROM audit_logs WHERE module='invoice' AND record_id = ANY($1::text[])", [invoiceIds]).catch(() => {});
  await query("DELETE FROM invoices WHERE client_id = ANY($1::int[])", [clientIds]).catch(() => {});
  await query("DELETE FROM payment_allocations WHERE payment_id IN (SELECT p.id FROM payments p JOIN contracts c ON c.id=p.contract_id WHERE c.project_id=$1)", [project.id]).catch(() => {});
  await query("DELETE FROM payments WHERE contract_id IN (SELECT id FROM contracts WHERE project_id=$1)", [project.id]).catch(() => {});
  await query("DELETE FROM contracts WHERE project_id=$1", [project.id]).catch(() => {});
  await query("DELETE FROM customer_sessions WHERE account_id IN (SELECT id FROM customer_accounts WHERE client_id = ANY($1::int[]))", [clientIds]).catch(() => {});
  await query("DELETE FROM customer_login_codes WHERE account_id IN (SELECT id FROM customer_accounts WHERE client_id = ANY($1::int[]))", [clientIds]).catch(() => {});
  await query("DELETE FROM customer_accounts WHERE client_id = ANY($1::int[])", [clientIds]).catch(() => {});
  await query("DELETE FROM leads WHERE name=$1", [`CP Test Lead ${stamp}`]).catch(() => {});
  await query("DELETE FROM clients WHERE id = ANY($1::int[])", [clientIds]).catch(() => {});
  await query("DELETE FROM projects WHERE id=$1", [project.id]).catch(() => {});
  await query("DELETE FROM payment_details WHERE account_number LIKE $1", [`%${String(stamp).slice(-6)}%`]).catch(() => {});
  await query("DELETE FROM audit_logs WHERE user_id = ANY($1::int[])", [ids]).catch(() => {});
  await query("DELETE FROM users WHERE id = ANY($1::int[])", [ids]).catch(() => {});
  await closeDatabase().catch(() => {});
}

console.log(failures ? `\nCUSTOMER_PAYMENT_FAILURES: ${failures}` : "\nCUSTOMER_PAYMENTS_ALL_PASSED");
process.exit(failures ? 1 : 0);
