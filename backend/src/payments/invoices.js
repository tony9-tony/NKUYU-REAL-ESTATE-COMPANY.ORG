// Customer invoices: database work shared by the Finance screens
// (routes/customerPayments.js), the customer portal (routes/customer.js) and
// the contract model (no contract until the request's invoice is Paid).
// The rules themselves live in ./customerPayments.js.
import fs from "node:fs";
import PDFDocument from "pdfkit";
import { query, queryOne } from "../db.js";
import { organizationId } from "../org/rbac.js";
import { Payment } from "../models/payment.js";
import { writeReceiptPdf } from "./notices.js";
import { validateUploadedFile, cleanupUploadedFile } from "../uploads.js";
import { DUPLICATE_WINDOW_HOURS, INVOICE_STATUS_LABELS, invoiceStatus, normalizeSmsText, normalizeTransactionId, proofRefusal, sha256 } from "./customerPayments.js";

/** A buy/rent request MKUYU has accepted (Sales approved the customer as a client or booked the appointment). */
export const ACCEPTED_REQUEST_SQL = "l.client_id IS NOT NULL AND l.converted_at IS NOT NULL AND l.service IN ('buy','rent') AND l.status NOT IN ('lost','closed')";

export const PROOF_FILE_TYPES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".pdf"]);

const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export const INVOICE_SELECT = `SELECT i.*, p.name AS property_name, cu.display_name AS created_by_name
  FROM invoices i LEFT JOIN properties p ON p.id=i.property_id LEFT JOIN users cu ON cu.id=i.created_by`;
export const PROOF_SELECT = `SELECT f.*, d.kind AS detail_kind, d.bank_name, d.network, d.account_number AS paid_into,
    au.display_name AS accepted_by_name, ru.display_name AS rejected_by_name
  FROM invoice_proofs f LEFT JOIN payment_details d ON d.id=f.detail_id
  LEFT JOIN users au ON au.id=f.accepted_by LEFT JOIN users ru ON ru.id=f.rejected_by`;

export async function proofsFor(invoiceIds) {
  const map = new Map();
  if (!invoiceIds.length) return map;
  for (const row of (await query(`${PROOF_SELECT} WHERE f.invoice_id = ANY($1::int[]) ORDER BY f.created_at, f.id`, [invoiceIds])).rows) {
    map.set(row.invoice_id, [...(map.get(row.invoice_id) || []), row]);
  }
  return map;
}

/** Invoices with their derived status (Not paid ... Paid), newest first. */
export async function invoicesWithStatus(where = "TRUE", values = []) {
  const invoices = (await query(`${INVOICE_SELECT} WHERE ${where} ORDER BY i.due_date, i.id DESC LIMIT 1000`, values)).rows;
  const proofs = await proofsFor(invoices.map((row) => row.id));
  return invoices.map((invoice) => {
    const list = proofs.get(invoice.id) || [];
    const state = invoiceStatus(invoice, list, today());
    return { ...invoice, ...state, status_label: INVOICE_STATUS_LABELS[state.status], proofs: list };
  });
}

/** MKUYU's bank accounts customers see (Finance's Payment settings). Customers pay by bank only. */
export async function paymentDetails({ activeOnly = true } = {}) {
  return (await query(
    `SELECT d.*, u.display_name AS edited_by_name FROM payment_details d LEFT JOIN users u ON u.id=d.edited_by
      WHERE d.organization_id=$1 AND d.kind='bank' ${activeOnly ? "AND d.active" : ""} ORDER BY d.active DESC, d.id`, [await organizationId()])).rows;
}

/** A unique-index violation, turned into the duplicate rule it enforces. */
export function duplicateMessage(error) {
  if (error?.code !== "23505") return null;
  const rule = String(error.constraint || "");
  if (rule.includes("txn")) return "This transaction ID has already been used for a payment. Each transaction can be sent only once.";
  if (rule.includes("evidence")) return "This receipt file has already been sent for a payment. The same proof cannot back two payments.";
  if (rule.includes("sms")) return "This payment message has already been sent. The same proof cannot back two payments.";
  if (rule.includes("pending")) return "Your proof is already waiting for MKUYU Finance. Please wait for it to be checked.";
  return "This payment proof was already sent.";
}
const duplicate = (constraint) => fail(duplicateMessage({ code: "23505", constraint }), 409);

/**
 * The one way proof enters the system (the customer, in the portal). All four
 * duplicate rules run here, and again in the unique indexes.
 */
export async function submitProof(invoice, body = {}, file = null) {
  try {
    const proofs = (await proofsFor([invoice.id])).get(invoice.id) || [];
    const refusal = proofRefusal(invoice, proofs);
    if (refusal) fail(refusal, 409);
    const method = String(body.method || "");
    if (method !== "bank") fail("MKUYU takes customer payments by bank only.");
    const detailId = Number(body.detail_id);
    const detail = Number.isInteger(detailId) && detailId > 0
      ? await queryOne("SELECT id, kind FROM payment_details WHERE id=$1 AND organization_id=$2 AND active", [detailId, invoice.organization_id]) : null;
    if (!detail || detail.kind !== method) fail("Choose the MKUYU bank account you paid into.");
    const transactionId = String(body.transaction_id || "").trim();
    const norm = normalizeTransactionId(transactionId);
    if (norm.length < 4 || transactionId.length > 80) fail("Enter the transaction ID from the bank receipt or message.");
    const claimed = Number(body.amount);
    if (!Number.isFinite(claimed) || claimed <= 0 || claimed > 1e13) fail("Enter the amount you paid in TZS.");
    const paidOn = String(body.paid_on || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || Number.isNaN(new Date(`${paidOn}T00:00:00`).getTime())) fail("Enter the date you paid.");
    if (paidOn > today()) fail("The payment date cannot be in the future.");
    const sms = typeof body.sms_text === "string" && body.sms_text.trim() ? body.sms_text.trim().slice(0, 4000) : null;
    if (!file && !(sms && sms.length >= 10)) fail("Upload the receipt (photo, screenshot or PDF), or paste the payment message.");
    const fileInfo = file ? validateUploadedFile(file, PROOF_FILE_TYPES) : null;
    const fileHash = fileInfo ? sha256(fs.readFileSync(file.path)) : null;
    const smsHash = sms ? sha256(normalizeSmsText(sms)) : null;
    // 1. one transaction ID in the whole system: other proofs and the payment ledger
    if (await queryOne("SELECT 1 FROM invoice_proofs WHERE transaction_norm=$1 AND status <> 'rejected'", [norm])) duplicate("txn");
    if (await Payment.findByReference(transactionId)) duplicate("txn");
    // 2. the same file or message cannot back two payments
    if (fileHash && await queryOne("SELECT 1 FROM invoice_proofs WHERE evidence_hash=$1 AND status <> 'rejected'", [fileHash])) duplicate("evidence");
    if (smsHash && await queryOne("SELECT 1 FROM invoice_proofs WHERE sms_hash=$1 AND status <> 'rejected'", [smsHash])) duplicate("sms");
    // 3. same customer + amount + date + method within 24 hours: accepted, flagged for Finance
    const twin = await queryOne(
      `SELECT f.id, i.reference FROM invoice_proofs f JOIN invoices i ON i.id=f.invoice_id
        WHERE i.client_id=$1 AND f.status <> 'rejected' AND f.amount_claimed=$2 AND f.paid_on=$3 AND f.method=$4
          AND f.created_at >= NOW() - ($5 || ' hours')::interval ORDER BY f.id DESC LIMIT 1`,
      [invoice.client_id, claimed, paidOn, method, String(DUPLICATE_WINDOW_HOURS)]);
    // (4. one pending proof per invoice: proofRefusal above, and the index)
    return await queryOne(
      `INSERT INTO invoice_proofs (invoice_id, method, detail_id, transaction_id, transaction_norm, amount_claimed, paid_on, sms_text,
         original_filename, stored_name, mime_type, file_size, evidence_hash, sms_hash, duplicate_flag, duplicate_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id, duplicate_flag`,
      [invoice.id, method, detail.id, transactionId, norm, claimed, paidOn, sms,
        fileInfo?.displayName ?? null, fileInfo?.storedName ?? null, fileInfo?.mimeType ?? null, fileInfo?.size ?? null, fileHash ?? smsHash, smsHash,
        Boolean(twin), twin ? `Same customer, amount, date and method as proof #${twin.id} (${twin.reference}) within ${DUPLICATE_WINDOW_HOURS} hours. Check it is not the same payment.` : null]);
  } catch (error) {
    cleanupUploadedFile(file);
    const message = duplicateMessage(error);
    if (message) fail(message, 409);
    throw error;
  }
}

/** The MKUYU receipt for an accepted proof, as a PDF (same layout as every receipt). */
export function invoiceReceiptPdf(res, invoice, proof, orgName = "MKUYU") {
  const doc = new PDFDocument({ size: "A5", margin: 40 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${proof.receipt_number}.pdf"`);
  doc.pipe(res);
  writeReceiptPdf(doc,
    { receipt_number: proof.receipt_number, client_name: invoice.client_name, amount: proof.amount_received, paid_at: proof.paid_on, method: proof.method === "bank" ? "bank" : "mobile",
      reference: proof.transaction_id, approved_by_name: proof.accepted_by_name || "Finance", approved_at: proof.accepted_at, installment_notes: `${invoice.purpose} (invoice ${invoice.reference})` },
    { contract_number: `Invoice ${invoice.reference}`, property_name: invoice.property_name || null, id: invoice.id },
    orgName);
  doc.end();
}

/**
 * Unpaid invoice that stops the contract for this request. A request with no
 * invoice is not blocked. `propertyId` null matches any invoice of the client.
 */
export async function invoiceBlockingContract(clientId, propertyId = null) {
  if (!clientId) return null;
  const rows = await invoicesWithStatus(
    "i.client_id=$1 AND i.cancelled_at IS NULL AND i.contract_id IS NULL AND ($2::int IS NULL OR i.property_id IS NULL OR i.property_id=$2)",
    [clientId, propertyId]);
  return rows.find((row) => row.status !== "paid") || null;
}

export function contractBlockedMessage(invoice) {
  return `Invoice ${invoice.reference} (${invoice.purpose}) for ${invoice.client_name} is ${INVOICE_STATUS_LABELS[invoice.status].toLowerCase()}. The contract for this request waits until Finance has accepted the full payment.`;
}

/**
 * Money accepted on a request's invoices before the contract existed goes into
 * that contract's payment ledger, approved by the Finance person who accepted
 * it and with the same receipt number, so the contract balance counts it.
 */
export async function carryPaidInvoices(contract) {
  if (!contract?.client_id) return 0;
  const invoices = await invoicesWithStatus(
    "i.client_id=$1 AND i.cancelled_at IS NULL AND i.contract_id IS NULL AND ($2::int IS NULL OR i.property_id IS NULL OR i.property_id=$2)",
    [contract.client_id, contract.property_id || null]);
  let carried = 0;
  for (const invoice of invoices.filter((row) => row.status === "paid")) {
    for (const proof of invoice.proofs.filter((p) => p.status === "accepted" && !p.payment_id)) {
      const payment = await queryOne(
        `INSERT INTO payments (organization_id, contract_id, client_name, amount, paid_at, method, reference, notes, evidence_text, receipt_number, owner_id, created_by, visibility, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,'organization','pending') RETURNING id`,
        [invoice.organization_id, contract.id, invoice.client_name, proof.amount_received, proof.paid_on, proof.method, proof.transaction_id,
          `${invoice.purpose} · invoice ${invoice.reference} (paid before the contract)`, proof.sms_text || `Customer proof file: ${proof.original_filename || "uploaded"}`, proof.receipt_number, proof.accepted_by]);
      await query("UPDATE payments SET status='approved', approved_by=$2, approved_at=$3 WHERE id=$1", [payment.id, proof.accepted_by, proof.accepted_at]);
      await Payment.allocate(payment.id);
      await query("UPDATE invoice_proofs SET payment_id=$2 WHERE id=$1", [proof.id, payment.id]);
      carried += 1;
    }
    await query("UPDATE invoices SET contract_id=$2 WHERE id=$1", [invoice.id, contract.id]);
  }
  return carried;
}
