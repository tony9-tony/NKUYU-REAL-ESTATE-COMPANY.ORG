// Regression test for installment (debt) status derivation.
//
// `Payment.syncInstallment` is the single place an installment's status is
// derived from the payment ledger. Before `partial` existed it could only ever
// write paid/overdue/pending, so an installment that had received some money
// but not all of it was indistinguishable from one that had received nothing.
// Finance could not see who was part-paid.
//
// This asserts the four required cases against the real database, using the
// same fixtures-and-cleanup shape as unit_test.mjs.
import assert from "node:assert/strict";
import { assertTestDatabase } from "./test_support/harness.mjs";
import { query, closeDatabase } from "./backend/src/db.js";
import { runMigrations } from "./backend/src/migrate.js";
import { Project } from "./backend/src/models/project.js";
import { Client } from "./backend/src/models/catalog.js";
import { Contract } from "./backend/src/models/contract.js";
import { Debt } from "./backend/src/models/debt.js";
import { Payment } from "./backend/src/models/payment.js";


// Refuse to touch mkuyu_org before any write happens.
await assertTestDatabase("partial_status_test");

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

const far = "2099-01-01";
const past = "2000-01-01";

try {
  await runMigrations();
  const suffix = Date.now();
  const project = await Project.create(`Partial Project ${suffix}`);
  const client = await Client.create({ project_id: project.id, name: `Partial Client ${suffix}`, client_type: "buyer", status: "active" });
  const contract = await Contract.create({
    project_id: project.id,
    client_id: client.id,
    client_name: `Partial Client ${suffix}`,
    contract_type: "new", deal_type: "buy",
    value: 1000,
  });

  const makeDebt = (amount, due) => Debt.create({
    contract_id: contract.id,
    client_name: `Partial Client ${suffix}`,
    amount,
    due_date: due,
  });
  const pay = (debtId, amount, paidAt = "2026-09-25 10:00:00") => Payment.create({
    contract_id: contract.id, debt_id: debtId, client_name: `Partial Client ${suffix}`, amount, paid_at: paidAt, method: "bank",
  });
  const statusOf = async (debtId) => (await Debt.get(debtId)).status;

  // --- 0 paid, not yet due -> pending (unchanged existing behaviour) --------
  const untouched = await makeDebt(500, far);
  await Payment.syncInstallment(untouched.id);
  check(await statusOf(untouched.id) === "pending", "0 paid and not yet due stays pending");

  // --- 0 paid, past its due date -> overdue (unchanged existing behaviour) --
  const lapsed = await makeDebt(500, past);
  await Payment.syncInstallment(lapsed.id);
  check(await statusOf(lapsed.id) === "overdue", "0 paid and past due is overdue");



  // --- part paid -> partial (the gap this test exists for) ------------------
  const partPaid = await makeDebt(500, far);
  await pay(partPaid.id, 300);
  await Payment.syncInstallment(partPaid.id);
  check(await statusOf(partPaid.id) === "partial", "300 paid against 500 is partial");
  check(await Payment.forDebt(partPaid.id) === 300, "the part payment total is still 300");

  // A part-paid installment that has also passed its due date is still
  // PARTIAL, not overdue: money has arrived, and the balance is what is late.
  const partPaidLapsed = await makeDebt(500, past);
  await pay(partPaidLapsed.id, 200);
  await Payment.syncInstallment(partPaidLapsed.id);
  check(await statusOf(partPaidLapsed.id) === "partial", "part paid and past due is partial, not overdue");

  // --- fully paid -> paid (unchanged existing behaviour) --------------------
  const settled = await makeDebt(500, far);
  await pay(settled.id, 250);
  await Payment.syncInstallment(settled.id);
  check(await statusOf(settled.id) === "partial", "250 paid against 500 is partial before the rest arrives");
  await pay(settled.id, 250, "2026-10-25 10:00:00");
  await Payment.syncInstallment(settled.id);
  check(await statusOf(settled.id) === "paid", "the balance completes it to paid");

  // --- overpayment still counts as paid -------------------------------------
  const overpaid = await makeDebt(500, far);
  await pay(overpaid.id, 600);
  await Payment.syncInstallment(overpaid.id);
  check(await statusOf(overpaid.id) === "paid", "paying more than the amount is paid");

  // --- history is reversible: removing the part payment reopens it ---------
  const reopened = await makeDebt(500, past);
  const firstPayment = await pay(reopened.id, 200);
  await Payment.syncInstallment(reopened.id);
  check(await statusOf(reopened.id) === "partial", "the reopened installment starts partial");
  await Payment.remove(firstPayment.id);
  await Payment.syncInstallment(reopened.id, true);
  check(await statusOf(reopened.id) === "overdue", "removing the part payment returns it to overdue");
  check(await Payment.forDebt(reopened.id) === 0, "the payment total is back to zero");

  // --- the vocabulary is the one the model can actually produce --------------
  const { DEBT_STATUSES, deriveInstallmentStatus } = await import("./backend/src/models/debt.js");
  check(DEBT_STATUSES.includes("partial"), "the status vocabulary includes partial");
  check(["pending", "partial", "paid", "overdue"].every((value) => DEBT_STATUSES.includes(value)), "the vocabulary still carries all four values");

  // The derivation is pure, so the boundary cases are asserted directly rather
  // than only through the database.
  const now = new Date("2026-09-28T00:00:00Z");
  check(deriveInstallmentStatus(500, 500, null, now) === "paid", "exactly the amount is paid");
  check(deriveInstallmentStatus(500, 499.99, null, now) === "partial", "one cent short is partial");
  check(deriveInstallmentStatus(500, 0.01, null, now) === "partial", "one cent in is partial");
  check(deriveInstallmentStatus(0, 0, null, now) === "pending", "a zero-value installment is pending, not paid");
  check(deriveInstallmentStatus(500, 0, "2000-01-01", now) === "overdue", "unpaid and past due is overdue");
  check(deriveInstallmentStatus(500, 0, "2099-01-01", now) === "pending", "unpaid and not yet due is pending");

  // Clean up after ourselves. Deleting the project cascades to contracts,
  // installments and payments, but `clients.project_id` is ON DELETE SET NULL,
  // so the client row has to be removed explicitly or every run leaves litter.
  await query("DELETE FROM projects WHERE id=$1", [project.id]);
  await query("DELETE FROM clients WHERE id=$1", [client.id]);
  console.log(failures ? `\n${failures} PARTIAL STATUS CHECK(S) FAILED` : "\nPARTIAL_STATUS_ALL_PASSED");
  if (failures) process.exitCode = 1;
} catch (error) {
  console.error("PARTIAL_STATUS_FAILURE", error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
