// What the customer receives by e-mail: the MKUYU receipt when Finance approves
// a payment, and a reminder a few days before an installment is due. Both use
// the address on the contract (or the client register). Settings in .env:
//   MAIL_RECEIPTS=0        stop sending receipts
//   MAIL_REMINDERS=0       stop sending reminders
//   MAIL_REMINDER_DAYS=3   how many days before the due date
import PDFDocument from "pdfkit";
import { query, queryOne } from "../db.js";
import { mailConfigured, sendMail } from "../mail.js";

const money = (value) => `TZS ${Number(value).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
// A calendar day as YYYY-MM-DD in the server's own time zone. Database DATE and
// TIMESTAMPTZ values arrive as Date objects at local midnight or local time, so
// toISOString() (UTC) would show the day before in Tanzania (UTC+3).
const day = (value) => {
  if (!value) return "—";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * What an approved payment paid for: each installment it went to (how much,
 * and what was still left on it right after this payment), any money not yet
 * on an installment, and the contract balance right after this payment.
 * "Right after" counts only payments approved up to and including this one,
 * so a receipt downloaded again later still shows the same figures.
 */
export async function receiptCoverage(paymentId) {
  const payment = await queryOne("SELECT id, contract_id, amount, status, approved_at FROM payments WHERE id=$1", [paymentId]);
  if (!payment || payment.status !== "approved") return null;
  const items = (await query(
    `SELECT d.id, d.notes AS label, d.due_date, d.amount AS installment_amount, pa.amount AS applied,
            d.amount - COALESCE((SELECT SUM(pa2.amount) FROM payment_allocations pa2 JOIN payments p2 ON p2.id=pa2.payment_id
                                 WHERE pa2.debt_id=d.id AND p2.status='approved'
                                   AND (p2.approved_at, p2.id) <= (SELECT me.approved_at, me.id FROM payments me WHERE me.id=$1)), 0) AS left_after
       FROM payment_allocations pa JOIN debts d ON d.id=pa.debt_id
      WHERE pa.payment_id=$1 ORDER BY d.due_date NULLS LAST, d.id`, [payment.id])).rows
    .map((row) => ({ label: row.label || "Installment", due_date: row.due_date, applied: Number(row.applied), installment_amount: Number(row.installment_amount), left_after: Math.max(0, Number(row.left_after)) }));
  const applied = items.reduce((total, row) => total + row.applied, 0);
  const totals = await queryOne(
    `SELECT c.value,
            COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.contract_id=c.id AND p.status='approved' AND (p.approved_at, p.id) <= (SELECT me.approved_at, me.id FROM payments me WHERE me.id=$2)), 0) AS received,
            COALESCE((SELECT SUM(r.amount) FROM refunds r WHERE r.contract_id=c.id AND r.status='approved'), 0) AS refunded
       FROM contracts c WHERE c.id=$1`, [payment.contract_id, payment.id]);
  const balance = totals ? Math.max(0, Number(totals.value || 0) - Number(totals.received) + Number(totals.refunded)) : null;
  return { items, credit: Math.max(0, Math.round((Number(payment.amount) - applied) * 100) / 100), balance };
}

/** The MKUYU receipt as a PDF document (A5). `coverage` comes from receiptCoverage(). */
export function writeReceiptPdf(doc, payment, contract, orgName, coverage = null) {
  doc.font("Helvetica-Bold").fontSize(18).text(orgName || "MKUYU", { align: "left" });
  doc.font("Helvetica").fontSize(9).fillColor("#666").text("Official payment receipt");
  doc.moveDown(1.2).fillColor("#000").font("Helvetica-Bold").fontSize(13).text(`Receipt ${payment.receipt_number}`);
  doc.moveDown(0.6).font("Helvetica").fontSize(10);
  const line = (label, value) => { doc.font("Helvetica-Bold").text(`${label}: `, { continued: true }).font("Helvetica").text(String(value ?? "—")); };
  line("Received from", payment.client_name);
  line("Contract", `${contract.contract_number || `#${contract.id}`}${contract.property_name ? ` · ${contract.property_name}` : ""}`);
  line("Amount", money(payment.amount));
  line("Paid on", day(payment.paid_at));
  line("Method", payment.method);
  line("Transaction reference", payment.reference);
  const covered = coverage && coverage.items && coverage.items.length;
  if (!covered && payment.installment_notes) line("For", payment.installment_notes);
  line("Approved by", `${payment.approved_by_name || "Finance"}${payment.self_approved ? " (self-approved)" : ""}`);
  line("Approved on", day(payment.approved_at));
  if (covered) {
    doc.moveDown(0.8).font("Helvetica-Bold").fontSize(10).text("This payment covers");
    doc.font("Helvetica").fontSize(10);
    for (const item of coverage.items) {
      const state = item.left_after > 0 ? `${money(item.left_after)} still to pay` : "now fully paid";
      doc.text(`•  ${item.label}${item.due_date ? ` (due ${day(item.due_date)})` : ""}: ${money(item.applied)} of ${money(item.installment_amount)}, ${state}`);
    }
    if (coverage.credit > 0) doc.text(`•  Kept as credit for the next installment: ${money(coverage.credit)}`);
  } else if (coverage && coverage.credit > 0) {
    doc.moveDown(0.4); line("Kept as credit", money(coverage.credit));
  }
  if (coverage && coverage.balance !== null && coverage.balance !== undefined) {
    doc.moveDown(0.6); line("Contract balance after this payment", money(coverage.balance));
  }
  doc.moveDown(1.5).fontSize(8).fillColor("#666").text("This receipt was issued by the MKUYU Real Estate Management System after Finance confirmed the payment against the bank or mobile-money statement.");
}

function receiptPdfBuffer(payment, contract, orgName, coverage = null) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A5", margin: 40 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    writeReceiptPdf(doc, payment, contract, orgName, coverage);
    doc.end();
  });
}

async function customerEmail(contractId) {
  return queryOne(`SELECT c.id, c.contract_number, c.client_name, COALESCE(NULLIF(c.client_email,''), cl.email) AS email, pr.name AS property_name, o.name AS org_name
    FROM contracts c LEFT JOIN clients cl ON cl.id=c.client_id LEFT JOIN properties pr ON pr.id=c.property_id LEFT JOIN organizations o ON o.id=c.organization_id WHERE c.id=$1`, [contractId]);
}

/** E-mails the receipt of an approved payment to the customer, once. */
export async function emailReceipt(paymentId) {
  if (!mailConfigured() || process.env.MAIL_RECEIPTS === "0") return { sent: false, skipped: true };
  const payment = await queryOne(`SELECT p.*, ab.display_name AS approved_by_name, d.notes AS installment_notes FROM payments p
    LEFT JOIN users ab ON ab.id=p.approved_by LEFT JOIN debts d ON d.id=p.debt_id WHERE p.id=$1`, [paymentId]);
  if (!payment || payment.status !== "approved" || !payment.receipt_number || payment.receipt_emailed_at) return { sent: false, skipped: true };
  const contract = await customerEmail(payment.contract_id);
  if (!contract?.email) return { sent: false, skipped: true, reason: "no customer e-mail" };
  const pdf = await receiptPdfBuffer(payment, contract, contract.org_name, await receiptCoverage(payment.id));
  const company = contract.org_name || "MKUYU";
  const result = await sendMail({
    to: contract.email,
    subject: `${company} receipt ${payment.receipt_number} – ${money(payment.amount)}`,
    text: `Dear ${contract.client_name},\n\nThank you. We have received your payment of ${money(payment.amount)} on ${day(payment.paid_at)} (reference ${payment.reference}) for contract ${contract.contract_number || ""}${contract.property_name ? `, ${contract.property_name}` : ""}.\n\nYour receipt ${payment.receipt_number} is attached.\n\n${company}`,
    attachments: [{ filename: `${payment.receipt_number}.pdf`, contentType: "application/pdf", content: pdf }],
    kind: "receipt",
    related: { payment_id: payment.id, contract_id: payment.contract_id, debt_id: payment.debt_id },
  });
  if (result.sent) await query("UPDATE payments SET receipt_emailed_at=NOW() WHERE id=$1", [payment.id]);
  return result;
}

/** Reminds every customer whose installment falls due in N days (once per installment). */
export async function sendDueReminders() {
  if (!mailConfigured() || process.env.MAIL_REMINDERS === "0") return { sent: 0, skipped: true };
  const days = Number(process.env.MAIL_REMINDER_DAYS || 3);
  const due = (await query(`SELECT d.id, d.contract_id, d.notes AS label, d.due_date, d.amount,
        d.amount - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.status='approved' WHERE pa.debt_id=d.id), 0) AS balance
      FROM debts d JOIN contracts c ON c.id=d.contract_id
      WHERE c.status IN ('approved','customer_pending','active') AND d.status <> 'paid'
        AND d.due_date = CURRENT_DATE + $1::int
        AND NOT EXISTS (SELECT 1 FROM email_log e WHERE e.kind='reminder' AND e.debt_id=d.id AND e.status='sent')`, [Number.isInteger(days) && days >= 0 ? days : 3])).rows;
  let sent = 0;
  for (const debt of due) {
    if (!(Number(debt.balance) > 0)) continue;
    const contract = await customerEmail(debt.contract_id);
    if (!contract?.email) continue;
    const company = contract.org_name || "MKUYU";
    const result = await sendMail({
      to: contract.email,
      subject: `${company}: payment reminder – ${money(debt.balance)} due ${day(debt.due_date)}`,
      text: `Dear ${contract.client_name},\n\nThis is a friendly reminder that ${debt.label || "an installment"} of ${money(debt.balance)} for contract ${contract.contract_number || ""}${contract.property_name ? `, ${contract.property_name}` : ""} is due on ${day(debt.due_date)}.\n\nWhen you pay, please write ${contract.contract_number || "your contract number"} as the reference. If you have already paid, thank you, and please ignore this message.\n\n${company}`,
      kind: "reminder",
      related: { debt_id: debt.id, contract_id: debt.contract_id },
    });
    if (result.sent) sent += 1;
  }
  return { sent, due: due.length };
}

/** Checks a few minutes after start, then every hour; each installment is reminded once. */
export function startDueReminders() {
  if (process.env.MAIL_REMINDERS === "0") return;
  const run = () => sendDueReminders().catch((error) => console.warn(`payment reminders failed: ${error.message}`));
  setTimeout(run, 6 * 60 * 1000).unref();
  setInterval(run, 60 * 60 * 1000).unref();
}
