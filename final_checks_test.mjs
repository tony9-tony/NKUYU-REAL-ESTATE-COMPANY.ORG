// ---------------------------------------------------------------------------
// Final checks: the public Sell flow, the Buy/Rent/Sell contract type, and
// Finance payment approval.
//
//   Visitor (no login) -> POST /public/sell -> Sell request for Sales
//   -> handed to Customer Service -> outcome -> Sales accepts -> Seller Client
//   -> Sell contract (deal_type "sell")
//   Payment recorded -> "pending" -> approved by another Finance user only.
// ---------------------------------------------------------------------------
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { closeDatabase, query } from "./backend/src/db.js";
import { demoPasswordFor, legacyPasswordFor } from "./backend/src/org/demoCredentials.js";

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ label: "final-checks", port: 3232 });
const base = server.base;
const tag = Date.now().toString(36);

async function call(path, { method = "GET", body, token, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const signIn = async (email, password) => (await call("/auth/login", { method: "POST", body: { email, password } })).body.token;

try {
  const admin = await signIn("admin@mkuyu.local", legacyPasswordFor("admin@mkuyu.local"));
  const md = await signIn("md@mkuyu.local", legacyPasswordFor("md@mkuyu.local"));
  const roles = (await call("/org/roles", { token: admin })).body;
  const roleId = (name) => roles.find((r) => r.name === name).id;
  const make = async (name, email, role) => {
    await call("/org/users", { method: "POST", token: admin, body: { display_name: name, email, password: "TempPass#2026", role_ids: [roleId(role)] } });
    return signIn(email, "TempPass#2026");
  };
  const sales = await make(`Sales FC ${tag}`, `sales.fc.${tag}@test.mkuyu.local`, "Sales & Marketing Officer");
  const cs = await make(`CS FC ${tag}`, `cs.fc.${tag}@test.mkuyu.local`, "Customer Service Officer");
  const financeA = await make(`Finance A FC ${tag}`, `fin.a.${tag}@test.mkuyu.local`, "Finance Officer");
  const financeB = await make(`Finance B FC ${tag}`, `fin.b.${tag}@test.mkuyu.local`, "Finance Officer");
  check(Boolean(sales && cs && financeA && financeB), "created Sales, Customer Service and two Finance officers");

  console.log("\n=== CHECK 01: Sell from the public website (no login) ===");
  const phone = `+255 75${String(Date.now()).slice(-7)}`;
  const good = { name: "Owner FC", phone, email: `owner.${tag}@example.com`, preferred_contact: "whatsapp", property_type: "house", location: "Mbezi Beach, Dar es Salaam", area: 450, bedrooms: 4, asking_price: 350000000, title_deed: "yes", message: "Family house with garden." };
  check((await call("/public/sell", { method: "POST", body: { ...good, property_type: "castle" } })).status === 400, "an unknown property type is refused");
  check((await call("/public/sell", { method: "POST", body: { ...good, location: "" } })).status === 400, "a submission without a location is refused");
  check((await call("/public/sell", { method: "POST", body: { ...good, asking_price: -5 } })).status === 400, "a negative asking price is refused");
  const before = Number((await query("SELECT COUNT(*) FROM leads")).rows[0].count);
  const bot = await call("/public/sell", { method: "POST", body: { ...good, website: "spam" } });
  check(bot.status === 201 && Number((await query("SELECT COUNT(*) FROM leads")).rows[0].count) === before, "a bot filling the hidden field gets a quiet 'ok' and no lead");
  const sent = await call("/public/sell", { method: "POST", body: good, headers: { Origin: "http://localhost:5500" } });
  check(sent.status === 201 && /^W-\d+$/.test(sent.body.reference), `the public site submits a property without logging in (${sent.body.reference})`);
  const leadId = Number(sent.body.reference.slice(2));
  const lead = (await query("SELECT * FROM leads WHERE id=$1", [leadId])).rows[0];
  check(lead?.service === "sell" && lead?.source === "website" && Number(lead?.budget) === 350000000 && lead?.sell_details?.location === good.location && lead?.sell_details?.property_type === "house", "it is stored as a Sell request with the property details and asking price");
  check(Number((await query("SELECT COUNT(*) FROM clients WHERE LOWER(email)=LOWER($1)", [good.email])).rows[0].count) === 0, "no client or account is created by submitting");
  const requests = (await call("/org/requests", { token: sales })).body;
  const row = requests.find((r) => r.id === leadId);
  check(row && row.service === "sell" && row.sell_details?.bedrooms === 4, "Sales sees it under Requests, as Sell, with the details");

  const csUser = (await call("/org/tasks/assignees?department=CUSTOMER%20SERVICE", { token: sales })).body.find((u) => u.display_name === `CS FC ${tag}`);
  const salesMe = (await call("/org/me", { token: sales })).body.user;
  const task = await call("/org/tasks", { method: "POST", token: sales, body: { title: "Contact Owner FC (sell request)", assigned_to: csUser.id, reviewer_id: salesMe.id, priority: "high" } });
  check((await call(`/org/requests/${leadId}/handed-off`, { method: "POST", token: sales, body: { task_id: task.body.id } })).status === 200, "Sales hands the Sell request to Customer Service");
  const when = new Date(Date.now() + 3 * 86400000); when.setUTCHours(8, 0, 0, 0);
  check((await call(`/org/tasks/${task.body.id}/outcome`, { method: "POST", token: cs, body: { outcome: "appointment", appointment_at: when.toISOString(), appointment_type: "viewing", note: "Site visit agreed" } })).status === 200, "Customer Service contacts the owner and reports a site visit");
  await call(`/org/tasks/${task.body.id}/actions`, { method: "POST", token: sales, body: { action: "begin_review" } });
  check((await call(`/org/tasks/${task.body.id}/actions`, { method: "POST", token: sales, body: { action: "approve" } })).status === 200, "Sales accepts");
  const accepted = (await call("/org/requests", { token: sales })).body.find((r) => r.id === leadId);
  const client = (await query("SELECT client_type FROM clients WHERE id=$1", [accepted?.client_id])).rows[0];
  check(client?.client_type === "seller", `the owner becomes a Seller Client (${client?.client_type})`);

  console.log("\n=== CHECK 02: contract type Buy / Rent / Sell ===");
  const project = (await call("/projects", { method: "POST", token: md, body: { name: `FC ${tag}` } })).body;
  const noType = await call("/contracts", { method: "POST", token: md, body: { project_id: project.id, client_name: "No Type", contract_type: "new", value: 1000 } });
  check(noType.status === 400 && /Buy, Rent or Sell/.test(noType.body.error || ""), "a contract without a type is refused");
  check((await call("/contracts", { method: "POST", token: md, body: { project_id: project.id, client_name: "Bad Type", contract_type: "new", deal_type: "lease", value: 1000 } })).status === 400, "an unknown type is refused");
  const created = {};
  for (const type of ["buy", "rent", "sell"]) {
    const r = await call("/contracts", { method: "POST", token: md, body: { project_id: project.id, client_name: `FC ${type}`, client_id: type === "sell" ? accepted.client_id : undefined, contract_type: "new", deal_type: type, value: 5000000 } });
    created[type] = r.body;
    check(r.status === 201 && r.body.deal_type === type, `a ${type.toUpperCase()} contract is created and keeps its type`);
  }
  check((await call(`/contracts/${created.sell.id}`, { token: md })).body.deal_type === "sell", "the type is read back later");
  const edited = await call(`/contracts/${created.rent.id}`, { method: "PUT", token: md, body: { notes: "edited" } });
  check(edited.status === 200 && edited.body.deal_type === "rent", "editing a contract keeps its type");

  console.log("\n=== CHECK 05: Finance approves payments ===");
  const draftPay = await call("/payments", { method: "POST", token: financeA, body: { contract_id: created.buy.id, amount: 250000, paid_at: "2026-09-30", method: "bank", reference: `FC-${tag}`, evidence_text: "bank slip" } });
  check(draftPay.status === 409, "a contract that is not yet approved takes no payment");
  // The approval lifecycle is covered by access_matrix_test; set it directly here.
  await query("UPDATE contracts SET status='active' WHERE id=$1", [created.buy.id]);
  check((await call("/payments", { method: "POST", token: financeA, body: { contract_id: created.buy.id, amount: 250000, paid_at: "2026-09-30", method: "bank", evidence_text: "bank slip" } })).status === 400, "the transaction reference is required");
  check((await call("/payments", { method: "POST", token: financeA, body: { contract_id: created.buy.id, amount: 250000, paid_at: "2026-09-30", method: "bank", reference: `FC-${tag}` } })).status === 400, "proof (receipt or pasted message) is required");
  const pay = await call("/payments", { method: "POST", token: financeA, body: { contract_id: created.buy.id, amount: 250000, paid_at: "2026-09-30", method: "bank", reference: `FC-${tag}`, evidence_text: `CRDB: TZS 250,000 received. Ref FC-${tag}` } });
  check(pay.status === 201 && pay.body.status === "pending", "a recorded payment starts as pending");
  const dup = await call("/payments", { method: "POST", token: financeB, body: { contract_id: created.buy.id, amount: 250000, paid_at: "2026-09-30", method: "bank", reference: ` fc-${tag} `, evidence_text: "same slip again" } });
  check(dup.status === 409 && /already used/.test(dup.body.error || ""), "the same transaction reference cannot be recorded twice");
  check((await call(`/payments/${pay.body.id}/approve`, { method: "POST", token: financeA, body: {} })).status === 403, "the person who recorded it cannot approve it");
  check((await call(`/payments/${pay.body.id}/approve`, { method: "POST", token: sales, body: {} })).status === 403, "Sales cannot approve payments");
  check((await call(`/payments/${pay.body.id}/approve`, { method: "POST", token: md, body: {} })).status === 403, "the MD (not Finance) cannot approve payments");
  check((await call(`/payments/${pay.body.id}/approve`, { method: "POST", token: admin, body: {} })).status === 403, "the System Administrator cannot approve payments");
  const approved = await call(`/payments/${pay.body.id}/approve`, { method: "POST", token: financeB, body: {} });
  check(approved.status === 200 && approved.body.status === "approved" && approved.body.approved_by_name === `Finance B FC ${tag}`, "another Finance officer approves it");
  check((await call(`/payments/${pay.body.id}/approve`, { method: "POST", token: financeB, body: {} })).status === 409, "an approved payment cannot be approved again");
  check((await call(`/payments/${pay.body.id}`, { method: "PUT", token: financeA, body: { amount: 300000 } })).status === 409, "an approved payment cannot be edited");
  check((await call(`/payments/${pay.body.id}`, { method: "DELETE", token: md })).status === 409, "an approved payment cannot be deleted");
  check(Number((await query("SELECT COUNT(*) FROM audit_logs WHERE action='payment_approved' AND record_id=$1", [String(pay.body.id)])).rows[0].count) === 1, "the approval is in the audit log");

  console.log("\n=== CHECK 06: Payments settle installments only once approved; reversal keeps the record ===");
  const debt = await call("/debts", { method: "POST", token: financeA, body: { contract_id: created.buy.id, client_name: "FC buy", amount: 400000, due_date: "2099-01-01", status: "paid" } });
  check(debt.status === 201 && debt.body.status === "pending", "a new installment starts unpaid (a status in the request is ignored)");
  check((await call(`/debts/${debt.body.id}`, { method: "PUT", token: financeA, body: { status: "paid" } })).body.status === "pending", "an installment cannot be set to paid by editing it");
  check((await call(`/debts/${debt.body.id}/pay`, { method: "POST", token: financeA, body: {} })).status === 410, "there is no 'mark paid' without money");
  const instal = await call("/payments", { method: "POST", token: financeA, body: { contract_id: created.buy.id, debt_id: debt.body.id, amount: 400000, paid_at: "2026-10-01", method: "mobile", reference: `MP-${tag}`, evidence_text: `M-Pesa ${tag} Confirmed. Tsh400,000.00` } });
  check(instal.status === 201, "the installment payment is recorded");
  check((await call(`/debts/${debt.body.id}`, { token: financeA })).body.status === "pending", "a pending payment does not settle the installment");
  check((await call(`/payments/${instal.body.id}/approve`, { method: "POST", token: financeB, body: {} })).status === 200, "a second Finance officer approves it");
  check((await call(`/debts/${debt.body.id}`, { token: financeA })).body.status === "paid", "the approved payment settles the installment");
  check((await call(`/payments/${instal.body.id}/reverse`, { method: "POST", token: financeB, body: {} })).status === 400, "a reversal needs a reason");
  check((await call(`/payments/${instal.body.id}/reverse`, { method: "POST", token: sales, body: { reason: "x" } })).status === 403, "Sales cannot reverse payments");
  const reversed = await call(`/payments/${instal.body.id}/reverse`, { method: "POST", token: financeB, body: { reason: "Bounced at the bank" } });
  check(reversed.status === 200 && reversed.body.status === "reversed" && reversed.body.reversal_reason === "Bounced at the bank", "an approved payment is reversed with its reason");
  check((await call(`/debts/${debt.body.id}`, { token: financeA })).body.status === "pending", "after the reversal the installment is unpaid again");
  check((await call(`/payments/${instal.body.id}`, { token: financeA })).status === 200, "the reversed payment stays in the ledger");
  check((await call(`/payments/${instal.body.id}/reverse`, { method: "POST", token: financeB, body: { reason: "again" } })).status === 409, "a payment is reversed only once");
  check((await call(`/payments/${instal.body.id}`, { method: "DELETE", token: md })).status === 409, "a reversed payment cannot be deleted");
  const redo = await call("/payments", { method: "POST", token: financeA, body: { contract_id: created.buy.id, debt_id: debt.body.id, amount: 400000, paid_at: "2026-10-02", method: "mobile", reference: `MP-${tag}`, evidence_text: "re-sent after the bounce" } });
  check(redo.status === 201, "the reference of a reversed payment may be used again");
  check((await call(`/payments/${redo.body.id}`, { method: "DELETE", token: md })).status === 200, "a pending payment may still be deleted");
  check((await call(`/debts/${debt.body.id}`, { method: "DELETE", token: md })).status === 409, "an installment with payments on record cannot be deleted");
  check((await call(`/contracts/${created.buy.id}`, { method: "DELETE", token: md })).status === 409, "a contract with payments on record cannot be deleted");
  check(Number((await query("SELECT COUNT(*) FROM audit_logs WHERE action='payment_reversed' AND record_id=$1", [String(instal.body.id)])).rows[0].count) === 1, "the reversal is in the audit log");

  console.log("\n=== CHECK 07: single-Finance mode ===");
  const meBefore = await call("/org/me", { token: financeA });
  check(meBefore.body.sole_finance_approver === false, "with several Finance people, nobody is the sole approver");
  const solo = await call("/payments", { method: "POST", token: financeA, body: { contract_id: created.buy.id, amount: 1000, paid_at: "2026-10-02", method: "cash", reference: `SOLO-${tag}`, evidence_text: "cash book 77" } });
  check((await call(`/payments/${solo.body.id}/approve`, { method: "POST", token: financeA, body: {} })).status === 403, "self-approval is refused while another Finance person exists");
  // Leave financeA as the only active Finance person (test database only), then restore.
  const others = (await query(`SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN role_permissions rp ON rp.role_id=ur.role_id
      JOIN permissions p ON p.id=rp.permission_id WHERE p.permission_key='validate_finance' AND u.active=TRUE AND u.role<>'admin' AND u.email<>$1`, [`fin.a.${tag}@test.mkuyu.local`])).rows.map((row) => row.id);
  await query("UPDATE users SET active=FALSE WHERE id = ANY($1::int[])", [others]);
  try {
    check((await call("/org/me", { token: financeA })).body.sole_finance_approver === true, "the only Finance person is told they are the sole approver");
    const own = await call(`/payments/${solo.body.id}/approve`, { method: "POST", token: financeA, body: {} });
    check(own.status === 200 && own.body.status === "approved" && own.body.self_approved === true, "the only Finance person approves their own entry, marked self-approved");
  } finally {
    await query("UPDATE users SET active=TRUE WHERE id = ANY($1::int[])", [others]);
  }

  console.log("\n=== CHECK 08: one property, one live deal; the client is always in the register ===");
  const legal = await make(`Legal FC ${tag}`, `legal.fc.${tag}@test.mkuyu.local`, "Legal Manager");
  const house = (await call("/properties", { method: "POST", token: sales, body: { project_id: project.id, name: `FC House ${tag}`, property_type: "villa", price: 10000000, location: "Mbezi", area: 500 } })).body;
  const house2 = (await call("/properties", { method: "POST", token: sales, body: { project_id: project.id, name: `FC House B ${tag}`, property_type: "villa", price: 6000000, location: "Mbezi", area: 400 } })).body;
  check(Boolean(house?.id && house2?.id), "two properties are listed");
  const buyerPhone = `+255 71${String(Date.now()).slice(-7)}`;
  const deal = await call("/contracts", { method: "POST", token: sales, body: { project_id: project.id, property_id: house.id, client_name: `Buyer FC ${tag}`, client_phone: buyerPhone, contract_type: "new", deal_type: "buy", value: 10000000, start_date: "2026-10-05" } });
  check(deal.status === 201 && Number(deal.body.client_id) > 0, "a contract typed with a new name registers the client automatically");
  const autoClient = (await query("SELECT * FROM clients WHERE id=$1", [deal.body.client_id])).rows[0];
  check(autoClient?.phone === buyerPhone && autoClient?.client_type === "buyer", "the new client carries the phone and is a Buyer");
  const twice = await call("/contracts", { method: "POST", token: sales, body: { project_id: project.id, property_id: house.id, client_name: "Someone Else", contract_type: "new", deal_type: "buy", value: 10000000 } });
  check(twice.status === 409, "a second sale contract on the same property is refused while the first is live");
  const again = await call("/contracts", { method: "POST", token: sales, body: { project_id: project.id, property_id: house2.id, client_name: `Buyer FC ${tag}`, client_phone: buyerPhone, contract_type: "new", deal_type: "buy", value: 6000000 } });
  check(again.status === 201 && Number(again.body.client_id) === Number(deal.body.client_id), "the same customer (same phone) is linked, not registered twice");

  console.log("\n=== CHECK 09: Finance validation creates the plan from the contract terms ===");
  await query("UPDATE contracts SET deposit_amount=2000000, installment_count=4, first_due_date='2026-11-01', payment_frequency='monthly' WHERE id=$1", [deal.body.id]);
  await query("UPDATE contracts SET payment_mode='cash', deposit_amount=0, installment_count=1, first_due_date='2026-10-10' WHERE id=$1", [again.body.id]);
  // The real hand-over: Sales submits, Legal reviews and approves; Finance then sees it.
  for (const id of [deal.body.id, again.body.id]) {
    const steps = [[sales, "submit"], [legal, "start_review"], [legal, "legal_approve"]];
    for (const [who, action] of steps) {
      const step = await call(`/contracts/${id}/transition`, { method: "POST", token: who, body: { action } });
      if (step.status !== 200) console.log(`   ${action} on #${id}: ${step.status} ${step.body.error || ""}`);
    }
  }
  const validated = await call(`/contracts/${deal.body.id}/transition`, { method: "POST", token: financeA, body: { action: "finance_validate" } });
  check(validated.status === 200, `Finance validates the contract (${validated.status} ${validated.body.error || ""})`);
  const plan = (await query("SELECT * FROM debts WHERE contract_id=$1 ORDER BY due_date, id", [deal.body.id])).rows;
  check(plan.length === 5 && Number(plan[0].amount) === 2000000 && plan.slice(1).every((row) => Number(row.amount) === 2000000), `deposit + 4 installments are created (${plan.map((row) => Number(row.amount)).join(", ")})`);
  const financeDebts = (await call(`/debts?contract_id=${deal.body.id}`, { token: financeB })).body;
  const seen = (Array.isArray(financeDebts) ? financeDebts : financeDebts.rows || financeDebts.data || []).filter((row) => Number(row.contract_id) === Number(deal.body.id));
  check(seen.length === 5, `another Finance officer sees the installments of a Sales contract (${seen.length})`);
  await call(`/contracts/${again.body.id}/transition`, { method: "POST", token: financeA, body: { action: "finance_validate" } });
  const cashPlan = (await query("SELECT amount FROM debts WHERE contract_id=$1", [again.body.id])).rows;
  check(cashPlan.length === 1 && Number(cashPlan[0].amount) === 6000000, "a cash contract gets one payment of the full price");

  console.log("\n=== CHECK 10: the property follows the contract; the deposit comes before the signature ===");
  for (const [who, action] of [[legal, "submit_management"], [md, "management_approve"]]) {
    const step = await call(`/contracts/${deal.body.id}/transition`, { method: "POST", token: who, body: { action } });
    check(step.status === 200, `${action} (${step.status} ${step.body.error || ""})`);
  }
  check((await call(`/contracts/${deal.body.id}/transition`, { method: "POST", token: legal, body: { action: "send_to_customer" } })).status === 200, "Legal sends the approved contract to the customer");
  check((await query("SELECT sale_status FROM properties WHERE id=$1", [house.id])).rows[0].sale_status === "reserved", "the property is Reserved while the customer has the contract");
  const early = await call(`/contracts/${deal.body.id}/transition`, { method: "POST", token: legal, body: { action: "record_signature", signed_by: "Buyer FC" } });
  check(early.status === 409, `the signature cannot be recorded before the deposit is paid (${early.status} ${early.body.error || ""})`);
  const deposit = await call("/payments", { method: "POST", token: financeA, body: { contract_id: deal.body.id, debt_id: plan[0].id, amount: 3000000, paid_at: "2026-10-06", method: "bank", reference: `DEP-${tag}`, evidence_text: `NMB: TZS 3,000,000 received ref DEP-${tag}` } });
  const depositOk = await call(`/payments/${deposit.body.id}/approve`, { method: "POST", token: financeB, body: {} });
  check(depositOk.status === 200 && /^RCT-\d{4}-\d{6}$/.test(depositOk.body.receipt_number || ""), `the approved payment gets an MKUYU receipt number (${depositOk.body.receipt_number})`);
  const afterPay = (await query("SELECT id, status, (SELECT COALESCE(SUM(amount),0) FROM payment_allocations WHERE debt_id=d.id) AS paid FROM debts d WHERE contract_id=$1 ORDER BY due_date, id", [deal.body.id])).rows;
  check(afterPay[0].status === "paid" && Number(afterPay[1].paid) === 1000000 && Number(afterPay[2].paid) === 0, "an overpayment settles the deposit and the rest goes to the next installment");
  check((await call(`/contracts/${deal.body.id}/transition`, { method: "POST", token: legal, body: { action: "record_signature", signed_by: "Buyer FC" } })).status === 200, "with the deposit paid the signature is recorded");
  check((await query("SELECT sale_status FROM properties WHERE id=$1", [house.id])).rows[0].sale_status === "sold", "the property is Sold once the contract is active");
  check((await query("SELECT status FROM clients WHERE id=$1", [deal.body.client_id])).rows[0].status === "active", "the customer becomes an active client");
  const pdf = await fetch(`${base}/payments/${deposit.body.id}/mkuyu-receipt`, { headers: { Authorization: `Bearer ${financeA}` } });
  const pdfBytes = Buffer.from(await pdf.arrayBuffer());
  check(pdf.status === 200 && /pdf/.test(pdf.headers.get("content-type") || "") && pdfBytes.subarray(0, 4).toString() === "%PDF", "the MKUYU receipt downloads as a PDF");
  check((await fetch(`${base}/payments/${solo.body.id}/mkuyu-receipt`, { headers: { Authorization: `Bearer ${sales}` } })).status >= 400, "Sales cannot download receipts");

  console.log("\n=== CHECK 11: the contract account ===");
  const account = await call(`/contracts/${deal.body.id}/account`, { token: md });
  const totals = account.body.totals || {};
  check(account.status === 200 && totals.price === 10000000 && totals.received === 3000000 && totals.balance === 7000000, `the MD sees price, received and balance (${totals.price} / ${totals.received} / ${totals.balance})`);
  check(account.body.next_due && account.body.next_due.amount === 1000000, "the next amount due is what is left of the next installment");
  check(account.body.payments?.[0]?.receipt_number === depositOk.body.receipt_number, "payments are listed with their receipt numbers");
  check((await call(`/contracts/${deal.body.id}/account`, { token: sales })).status === 403, "Sales cannot read the contract account");

  console.log("\n=== CHECK 12: refunds ===");
  check((await call("/payments/refunds", { method: "POST", token: financeA, body: { contract_id: deal.body.id, amount: 9000000, reference: `RF-${tag}`, reason: "test", evidence_text: "slip" } })).status === 409, "a refund cannot exceed the money received");
  check((await call("/payments/refunds", { method: "POST", token: financeA, body: { contract_id: deal.body.id, amount: 100, reference: `RF-${tag}`, reason: "test" } })).status === 400, "a refund needs proof");
  check((await call("/payments/refunds", { method: "POST", token: sales, body: { contract_id: deal.body.id, amount: 100, reference: `RF-${tag}`, reason: "test", evidence_text: "slip" } })).status === 403, "Sales cannot record refunds");
  const refund = await call("/payments/refunds", { method: "POST", token: financeA, body: { contract_id: deal.body.id, amount: 500000, method: "bank", reference: `RF-${tag}`, reason: "Agreed discount returned", evidence_text: "NMB transfer RF" } });
  check(refund.status === 201 && refund.body.status === "pending", "Finance records a refund; it waits for approval");
  check((await call(`/payments/refunds/${refund.body.id}/approve`, { method: "POST", token: financeA, body: {} })).status === 403, "the person who recorded a refund cannot approve it");
  check((await call(`/payments/refunds/${refund.body.id}/approve`, { method: "POST", token: financeB, body: {} })).status === 200, "a second Finance officer approves the refund");
  const afterRefund = (await call(`/contracts/${deal.body.id}/account`, { token: financeA })).body.totals || {};
  check(afterRefund.refunded === 500000 && afterRefund.balance === 7500000, `the refund shows in the account (balance ${afterRefund.balance})`);

  console.log("\n=== CHECK 13: forgotten password: the administrator resets, the person chooses a new one ===");
  const forgetful = `cs.fc.${tag}@test.mkuyu.local`;
  const csId = (await query("SELECT id FROM users WHERE email=$1", [forgetful])).rows[0].id;
  const notYet = await call("/auth/forgot-password", { method: "POST", body: { email: forgetful } });
  check(notYet.status === 200 && notYet.body.reset_ready === false && /administrator/i.test(notYet.body.message), "without a reset, Forgot password says: contact your administrator");
  check((await call("/auth/reset-password", { method: "POST", body: { email: forgetful, new_password: "NewPass#2026", confirm_password: "NewPass#2026" } })).status === 403, "nobody can set a password unless the administrator reset it");
  check((await call(`/org/users/${csId}/reset-password`, { method: "POST", token: sales, body: {} })).status === 403, "Sales cannot reset passwords");
  const opened = await call(`/org/users/${csId}/reset-password`, { method: "POST", token: admin, body: {} });
  check(opened.status === 200 && opened.body.hours === 24, "the administrator resets the password");
  check((await call("/org/me", { token: cs })).status === 401, "the person's open sessions end");
  const oldLogin = await call("/auth/login", { method: "POST", body: { email: forgetful, password: "TempPass#2026" } });
  check(oldLogin.status === 401 && /Forgot password/.test(oldLogin.body.error || ""), "the old password stops working and the sign-in screen points to Forgot password");
  const users = (await call("/org/users", { token: admin })).body;
  check(users.find((u) => u.id === csId)?.password_reset_pending === true, "the staff list shows the reset is waiting");
  const ready = await call("/auth/forgot-password", { method: "POST", body: { email: forgetful.toUpperCase() } });
  check(ready.body.reset_ready === true, "after the reset, Forgot password opens the new-password form");
  check((await call("/auth/reset-password", { method: "POST", body: { email: forgetful, new_password: "NewPass#2026", confirm_password: "Other#2026x" } })).status === 400, "the two passwords must match");
  check((await call("/auth/reset-password", { method: "POST", body: { email: forgetful, new_password: "short", confirm_password: "short" } })).status === 400, "a short password is refused");
  const saved = await call("/auth/reset-password", { method: "POST", body: { email: forgetful, new_password: "NewPass#2026", confirm_password: "NewPass#2026" } });
  check(saved.status === 200 && saved.body.ok === true, "the person saves the new password");
  check((await call("/auth/reset-password", { method: "POST", body: { email: forgetful, new_password: "Again#20266", confirm_password: "Again#20266" } })).status === 403, "the reset works only once");
  check((await call("/auth/forgot-password", { method: "POST", body: { email: forgetful } })).body.reset_ready === false, "afterwards Forgot password is back to: contact your administrator");
  check(Boolean(await signIn(forgetful, "NewPass#2026")), "the person signs in with the new password");
  check(Number((await query("SELECT COUNT(*) FROM audit_logs WHERE action IN ('password_reset_opened','password_set_after_reset') AND record_id=$1", [String(csId)])).rows[0].count) === 2, "both steps are in the audit log");
  await query("UPDATE users SET password_reset_expires_at=NOW() - INTERVAL '1 minute' WHERE id=$1", [csId]);
  check((await call("/auth/forgot-password", { method: "POST", body: { email: forgetful } })).body.reset_ready === false, "an expired reset no longer opens the form");
  void demoPasswordFor;
} catch (error) {
  failures += 1;
  console.error(error);
}

console.log(`\n${failures ? `${failures} FINAL CHECK(S) FAILED` : "FINAL_CHECKS_ALL_PASSED"}`);
if (failures) process.exitCode = 1;
await closeDatabase();
await server.stop();
