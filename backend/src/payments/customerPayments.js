// ---------------------------------------------------------------------------
// Customer invoices (temporary payment method, no bank link yet).
//
// A buy or rent request is accepted first. When payment is due, BEFORE the
// contract, the Finance Manager raises an invoice on that request. It appears
// under Invoices in the customer portal; "Pay now" shows MKUYU's payment
// details (Finance's Settings). The customer pays outside the system, then
// uploads proof. The Finance Manager accepts it (final: "this customer paid
// this", with the amount actually received) or rejects it with a reason the
// customer reads. The contract for that request waits until the invoice is
// Paid. No Customer Service step.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";

/**
 * Who does what. One permission per step, so a step can move to another role
 * by changing the role table only (for example invoices to the Sales Manager).
 */
export const CUSTOMER_PAYMENT_PERMISSIONS = {
  invoice: "set_payment_requests",        // Finance Manager: raise and cancel invoices
  details: "edit_payment_accounts",       // Finance Manager: MKUYU payment details
  accept: "confirm_customer_payments",    // Finance Manager: accept or reject proof
  view: "view_customer_payments",         // Managing Director: who has paid
};

export const INVOICE_STATUS_LABELS = {
  not_paid: "Not paid",
  proof_uploaded: "Proof uploaded",
  partly_paid: "Partly paid",
  paid: "Paid",
  overdue: "Overdue",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export const PROOF_METHODS = ["bank", "mobile"];

/** Same customer + amount + date + method within this window is flagged for Finance. */
export const DUPLICATE_WINDOW_HOURS = 24;

/** "QJ 81 xk-2" and "qj81XK-2" are the same transaction. */
export function normalizeTransactionId(value) {
  return String(value ?? "").replace(/\s+/g, "").toUpperCase();
}

/** A pasted message is compared without spacing or case, so a re-paste is caught. */
export function normalizeSmsText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Invoice reference the customer quotes when paying, e.g. INV-2026-7F3K9Q. */
export function newInvoiceReference(year = new Date().getFullYear()) {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code = "";
  for (const byte of crypto.randomBytes(6)) code += alphabet[byte % alphabet.length];
  return `INV-${year}-${code}`;
}

const cents = (value) => Math.round(Number(value || 0) * 100);

/**
 * The invoice's status, derived from its proofs (never stored, so it cannot
 * drift). `today` is YYYY-MM-DD.
 *   paid           - accepted money covers the amount
 *   proof_uploaded - proof waiting for Finance
 *   rejected       - the last proof did not check out (reason and balance shown)
 *   partly_paid    - some accepted money, a balance left
 *   overdue        - past the due date, nothing accepted (a flag on partly paid too)
 *   not_paid       - no proof yet
 */
export function invoiceStatus(invoice, proofs = [], today = new Date().toISOString().slice(0, 10)) {
  const required = cents(invoice?.amount_required);
  const received = proofs.filter((p) => p.status === "accepted").reduce((sum, p) => sum + cents(p.amount_received), 0);
  const base = { amount_received: received / 100, balance: Math.max(0, required - received) / 100, overdue: false, reject_reason: null };
  if (invoice?.cancelled_at) return { ...base, status: "cancelled" };
  if (required > 0 && received >= required) return { ...base, status: "paid", balance: 0 };
  const overdue = Boolean(invoice?.due_date) && String(invoice.due_date).slice(0, 10) < today;
  if (proofs.some((p) => p.status === "pending")) return { ...base, overdue, status: "proof_uploaded" };
  const latest = [...proofs].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id)[0];
  if (latest?.status === "rejected") return { ...base, overdue, status: "rejected", reject_reason: latest.reject_reason || null };
  if (received > 0) return { ...base, overdue, status: "partly_paid" };
  if (overdue) return { ...base, overdue, status: "overdue" };
  return { ...base, status: "not_paid" };
}

/** May the customer send proof right now? (null = yes) */
export function proofRefusal(invoice, proofs = []) {
  if (invoice?.cancelled_at) return "This invoice was cancelled.";
  if (invoiceStatus(invoice, proofs).status === "paid") return "This invoice is already paid in full.";
  if (proofs.some((p) => p.status === "pending")) return "Your proof is already waiting for MKUYU Finance. Please wait for it to be checked before sending more.";
  return null;
}

/** Finance accepts or rejects proof that is waiting. Acceptance is final. */
export function proofActionsFor(proof, { canAccept = false } = {}) {
  return proof?.status === "pending" && canAccept ? ["accept", "reject"] : [];
}
