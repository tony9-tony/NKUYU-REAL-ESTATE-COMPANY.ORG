// ---------------------------------------------------------------------------
// Customer invoices: the Finance Manager's and the MD's screens, mounted at
// /org/customer-payments. The customer's side is in routes/customer.js.
// Rules: payments/customerPayments.js; shared work: payments/invoices.js.
// Every step re-checks the caller and is written to the audit log.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { Router } from "express";
import { query, queryOne } from "../db.js";
import { can, organizationId } from "../org/rbac.js";
import { audit } from "../org/audit.js";
import { CUSTOMER_PAYMENT_PERMISSIONS as P, INVOICE_STATUS_LABELS, newInvoiceReference, proofActionsFor } from "../payments/customerPayments.js";
import { ACCEPTED_REQUEST_SQL, PROOF_SELECT, carryPaidInvoices, invoiceReceiptPdf, invoicesWithStatus, paymentDetails } from "../payments/invoices.js";
import { documentUploadsDir, resolveStoredFile } from "../uploads.js";

const MAX_INT4 = 2147483647;
const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };
const id = (value, field = "id") => { const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > MAX_INT4) fail(`${field} must be a positive integer`); return n; };
const text = (value, field, max = 160) => { if (typeof value !== "string" || !value.trim() || value.trim().length > max) fail(`${field} is required`); return value.trim(); };
const maybeText = (value, field, max = 2000) => { if (value === undefined || value === null || value === "") return null; if (typeof value !== "string" || value.trim().length > max) fail(`${field} is invalid`); return value.trim(); };
const amount = (value, field) => { const n = Number(value); if (value === "" || value === null || value === undefined || !Number.isFinite(n) || n <= 0 || n > 1e13) fail(`${field} must be an amount in TZS`); return Math.round(n * 100) / 100; };
const date = (value, field) => { const raw = String(value ?? "").trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(new Date(`${raw}T00:00:00`).getTime())) fail(`${field} must be a date`); return raw; };
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const mayView = (req) => Object.values(P).some((permission) => can(req.access, permission));

const router = Router();
router.use((req, res, next) => (mayView(req) ? next() : res.status(403).json({ error: "customer invoices are for the Finance Manager and the MD" })));

const shape = (req, invoice) => ({
  ...invoice,
  proofs: invoice.proofs.map((proof) => ({ ...proof, has_file: Boolean(proof.stored_name), available_actions: proofActionsFor(proof, { canAccept: can(req.access, P.accept) }) })),
  can_cancel: can(req.access, P.invoice) && !invoice.cancelled_at && !invoice.proofs.some((p) => p.status !== "rejected"),
});

async function invoiceDetail(req, invoiceId) {
  const [invoice] = await invoicesWithStatus("i.id=$1 AND i.organization_id=$2", [invoiceId, await organizationId()]);
  if (!invoice) fail("invoice not found", 404);
  const history = (await query("SELECT a.action, a.created_at, a.details_json, u.display_name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.module='invoice' AND a.record_id=$1 ORDER BY a.created_at DESC, a.id DESC LIMIT 100", [String(invoice.id)])).rows;
  return { ...shape(req, invoice), history };
}

router.get("/summary", route(async (req, res) => {
  const invoices = await invoicesWithStatus("i.organization_id=$1", [await organizationId()]);
  const counts = Object.fromEntries(Object.keys(INVOICE_STATUS_LABELS).map((key) => [key, 0]));
  for (const invoice of invoices) counts[invoice.status] += 1;
  res.json({
    ...counts,
    overdue_total: invoices.filter((row) => row.status === "overdue" || row.overdue).length,
    proofs_to_check: invoices.reduce((sum, row) => sum + row.proofs.filter((p) => p.status === "pending").length, 0),
    details: (await paymentDetails()).length,
  });
}));

// ---- Payment settings: MKUYU's bank accounts (customers pay by bank only) ---------
router.get("/details", route(async (req, res) => { res.json(await paymentDetails({ activeOnly: false })); }));
const detailFields = (body) => {
  if (body.kind !== undefined && body.kind !== "bank") fail("MKUYU takes customer payments by bank only");
  return {
    kind: "bank",
    bank_name: text(body.bank_name, "bank name", 120),
    branch: maybeText(body.branch, "branch", 120),
    swift_code: maybeText(body.swift_code, "SWIFT code", 20),
    network: null,
    account_name: text(body.account_name, "account name", 160),
    account_number: text(body.account_number, "account number", 60),
  };
};
router.post("/details", route(async (req, res) => {
  if (!can(req.access, P.details)) return res.status(403).json({ error: "only the Finance Manager keeps MKUYU's payment details" });
  const f = detailFields(req.body || {});
  const row = await queryOne(`INSERT INTO payment_details (organization_id, kind, bank_name, branch, swift_code, network, account_name, account_number, edited_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [await organizationId(), f.kind, f.bank_name, f.branch, f.swift_code, f.network, f.account_name, f.account_number, req.user.id]);
  await audit(req, "payment_details_added", "payment_details", row.id, f);
  res.status(201).json(row);
}));
router.put("/details/:id", route(async (req, res) => {
  if (!can(req.access, P.details)) return res.status(403).json({ error: "only the Finance Manager keeps MKUYU's payment details" });
  const f = detailFields(req.body || {});
  const row = await queryOne(`UPDATE payment_details SET kind=$3, bank_name=$4, branch=$5, swift_code=$6, network=$7, account_name=$8, account_number=$9, edited_by=$10, updated_at=NOW()
    WHERE id=$1 AND organization_id=$2 AND active RETURNING *`, [id(req.params.id), await organizationId(), f.kind, f.bank_name, f.branch, f.swift_code, f.network, f.account_name, f.account_number, req.user.id]);
  if (!row) return res.status(404).json({ error: "payment details not found" });
  await audit(req, "payment_details_changed", "payment_details", row.id, f);
  res.json(row);
}));
router.post("/details/:id/remove", route(async (req, res) => {
  if (!can(req.access, P.details)) return res.status(403).json({ error: "only the Finance Manager keeps MKUYU's payment details" });
  const row = await queryOne("UPDATE payment_details SET active=FALSE, edited_by=$3, updated_at=NOW() WHERE id=$1 AND organization_id=$2 AND active RETURNING *", [id(req.params.id), await organizationId(), req.user.id]);
  if (!row) return res.status(404).json({ error: "payment details not found" });
  await audit(req, "payment_details_removed", "payment_details", row.id, {});
  res.json(row);
}));

// ---- Invoices --------------------------------------------------------------------
// Accepted buy/rent requests Finance may invoice.
router.get("/accepted-requests", route(async (req, res) => {
  if (!can(req.access, P.invoice)) return res.status(403).json({ error: "only the Finance Manager raises invoices" });
  res.json((await query(
    `SELECT l.id, l.service, l.source, l.converted_at, c.id AS client_id, c.name AS client_name, c.is_diaspora, p.id AS property_id, p.name AS property_name,
            (SELECT COUNT(*)::int FROM invoices i WHERE i.lead_id=l.id AND i.cancelled_at IS NULL) AS invoices
       FROM leads l JOIN clients c ON c.id=l.client_id LEFT JOIN properties p ON p.id=l.property_id
      WHERE l.organization_id=$1 AND ${ACCEPTED_REQUEST_SQL} ORDER BY l.converted_at DESC NULLS LAST, l.id DESC LIMIT 300`, [await organizationId()])).rows);
}));

router.get("/invoices", route(async (req, res) => {
  const rows = await invoicesWithStatus("i.organization_id=$1", [await organizationId()]);
  res.json(rows.map((row) => {
    const { proofs, ...rest } = shape(req, row);
    return { ...rest, proofs_waiting: proofs.filter((p) => p.status === "pending").length, duplicate_flags: proofs.filter((p) => p.duplicate_flag && p.status !== "rejected").length };
  }));
}));
router.get("/invoices/:id", route(async (req, res) => { res.json(await invoiceDetail(req, id(req.params.id))); }));

// Before the contract: what the customer must pay on an accepted request.
router.post("/invoices", route(async (req, res) => {
  if (!can(req.access, P.invoice)) return res.status(403).json({ error: "only the Finance Manager raises invoices" });
  const body = req.body || {};
  const org = await organizationId();
  const lead = await queryOne(`SELECT l.*, c.name AS client_name FROM leads l JOIN clients c ON c.id=l.client_id WHERE l.id=$1 AND l.organization_id=$2 AND ${ACCEPTED_REQUEST_SQL}`, [id(body.lead_id, "lead_id"), org]);
  if (!lead) fail("An invoice is raised only on a buy or rent request MKUYU has accepted.", 409);
  const purpose = text(body.purpose, "what the payment is for", 120);
  const required = amount(body.amount_required, "amount_required");
  const due = date(body.due_date, "due_date");
  if (!(await paymentDetails()).length) fail("Add MKUYU's bank account in Payment settings first: the customer needs to know where to pay.", 409);
  let created = null;
  for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
    created = await queryOne(
      `INSERT INTO invoices (organization_id, reference, lead_id, client_id, client_name, property_id, service, purpose, amount_required, due_date, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (reference) DO NOTHING RETURNING id, reference`,
      [org, newInvoiceReference(), lead.id, lead.client_id, lead.client_name, lead.property_id, lead.service, purpose, required, due, maybeText(body.note, "note"), req.user.id]);
  }
  if (!created) fail("could not create a unique reference; try again", 500);
  await audit(req, "invoice_created", "invoice", created.id, { reference: created.reference, lead_id: lead.id, client_id: lead.client_id, purpose, amount_required: required, due_date: due });
  res.status(201).json(await invoiceDetail(req, created.id));
}));
router.post("/invoices/:id/cancel", route(async (req, res) => {
  if (!can(req.access, P.invoice)) return res.status(403).json({ error: "only the Finance Manager cancels invoices" });
  const invoiceId = id(req.params.id);
  const reason = text(req.body?.reason, "reason", 500);
  if (await queryOne("SELECT 1 FROM invoice_proofs WHERE invoice_id=$1 AND status IN ('pending','accepted')", [invoiceId])) fail("This invoice has proof or money on it; it cannot be cancelled.", 409);
  const row = await queryOne("UPDATE invoices SET cancelled_at=NOW(), cancelled_by=$3, cancel_reason=$4 WHERE id=$1 AND organization_id=$2 AND cancelled_at IS NULL RETURNING id", [invoiceId, await organizationId(), req.user.id, reason]);
  if (!row) return res.status(404).json({ error: "invoice not found" });
  await audit(req, "invoice_cancelled", "invoice", row.id, { reason });
  res.json(await invoiceDetail(req, row.id));
}));

// ---- Proof -----------------------------------------------------------------------
async function loadProof(proofId) {
  const proof = await queryOne(`${PROOF_SELECT} JOIN invoices i ON i.id=f.invoice_id WHERE f.id=$1 AND i.organization_id=$2`, [proofId, await organizationId()]);
  if (!proof) fail("proof not found", 404);
  return proof;
}
router.get("/proofs/:id/file", route(async (req, res) => {
  const proof = await loadProof(id(req.params.id));
  const full = proof.stored_name ? resolveStoredFile(documentUploadsDir, proof.stored_name) : null;
  if (!full || !fs.existsSync(full)) return res.status(404).json({ error: "this proof has no file" });
  res.setHeader("Content-Type", proof.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${String(proof.original_filename || "proof").replace(/["\r\n]/g, "")}"`);
  res.setHeader("Cache-Control", "private, no-store");
  fs.createReadStream(full).pipe(res);
}));

// Finance checks MKUYU's statement and accepts: "this customer paid this". Final.
router.post("/proofs/:id/accept", route(async (req, res) => {
  if (!can(req.access, P.accept)) return res.status(403).json({ error: "only the Finance Manager accepts a payment" });
  const proof = await loadProof(id(req.params.id));
  const received = amount(req.body?.amount_received, "amount_received");
  const row = await queryOne(`UPDATE invoice_proofs SET status='accepted', amount_received=$2, accept_note=$3, accepted_by=$4, accepted_at=NOW(),
      receipt_number='RCT-' || to_char(NOW(), 'YYYY') || '-' || lpad(nextval('payment_receipt_seq')::text, 6, '0')
    WHERE id=$1 AND status='pending' RETURNING invoice_id, receipt_number`, [proof.id, received, maybeText(req.body?.note, "note"), req.user.id]);
  if (!row) fail("This proof is not waiting for Finance.", 409);
  await audit(req, "invoice_payment_accepted", "invoice", row.invoice_id, { proof_id: proof.id, amount_received: received, amount_claimed: Number(proof.amount_claimed), receipt_number: row.receipt_number });
  // A contract already drafted for this request takes the money as soon as the invoice is paid.
  const [invoice] = await invoicesWithStatus("i.id=$1", [row.invoice_id]);
  if (invoice.status === "paid") {
    const contract = await queryOne(
      `SELECT id, client_id, property_id FROM contracts WHERE client_id=$1 AND ($2::int IS NULL OR property_id IS NULL OR property_id=$2)
         AND status NOT IN ('rejected','cancelled') ORDER BY id DESC LIMIT 1`, [invoice.client_id, invoice.property_id]);
    if (contract) await carryPaidInvoices(contract);
  }
  res.json(await invoiceDetail(req, row.invoice_id));
}));

router.post("/proofs/:id/reject", route(async (req, res) => {
  if (!can(req.access, P.accept)) return res.status(403).json({ error: "only the Finance Manager rejects a payment" });
  const proof = await loadProof(id(req.params.id));
  const reason = text(req.body?.reason, "reason", 500);
  const row = await queryOne("UPDATE invoice_proofs SET status='rejected', rejected_by=$2, rejected_at=NOW(), reject_reason=$3 WHERE id=$1 AND status='pending' RETURNING invoice_id", [proof.id, req.user.id, reason]);
  if (!row) fail("This proof is not waiting for Finance.", 409);
  await audit(req, "invoice_payment_rejected", "invoice", row.invoice_id, { proof_id: proof.id, reason });
  res.json(await invoiceDetail(req, row.invoice_id));
}));

router.get("/proofs/:id/receipt", route(async (req, res) => {
  const proof = await loadProof(id(req.params.id));
  if (proof.status !== "accepted") return res.status(404).json({ error: "a receipt is issued once Finance accepts the payment" });
  const [invoice] = await invoicesWithStatus("i.id=$1", [proof.invoice_id]);
  invoiceReceiptPdf(res, invoice, proof);
}));

export default router;
