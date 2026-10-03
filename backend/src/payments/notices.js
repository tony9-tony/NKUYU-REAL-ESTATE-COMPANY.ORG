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
const day = (value) => (value ? new Date(value).toISOString().slice(0, 10) : "—");

/** The MKUYU receipt as a PDF document (A5). */
export function writeReceiptPdf(doc, payment, contract, orgName) {
  doc.font("Helvetica-Bold").fontSize(18).text(orgName || "MKUYU", { align: "left" });
  doc.font("Helvetica").fontSize(9).fillColor("#666").text("Official payment receipt");
  doc.moveDown(1.2).fillColor("#000").font("Helvetica-Bold").fontSize(13).text(`Receipt ${payment.receipt_number}`);
  doc.moveDown(0.6).font("Helvetica").fontSize(10);
  const line = (label, value) => { doc.font("Helvetica-Bold").text(`${label}: `, { continued: true }).font("Helvetica").text(String(value ?? "—")); };
  line("Received from", payment.client_name);
  line("Contract", `${contract.contract_number || `#${contract.id}`}${contract.property_name ? ` · ${contract.property_name}` : ""}`);
  line("Amount", money(payment.amount));
  line("Paid on", String(payment.paid_at).slice(0, 10));
  line("Method", payment.method);
  line("Transaction reference", payment.reference);
  if (payment.installment_notes) line("For", payment.installment_notes);
  line("Approved by", `${payment.approved_by_name || "Finance"}${payment.self_approved ? " (self-approved)" : ""}`);
  line("Approved on", String(payment.approved_at || "").slice(0, 10));
  doc.moveDown(1.5).fontSize(8).fillColor("#666").text("This receipt was issued by the MKUYU Real Estate Management System after Finance confirmed the payment against the bank or mobile-money statement.");
}

function receiptPdfBuffer(payment, contract, orgName) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A5", margin: 40 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    writeReceiptPdf(doc, payment, contract, orgName);
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
  const pdf = await receiptPdfBuffer(payment, contract, contract.org_name);
  const company = contract.org_name || "MKUYU";
  const result = await sendMail({
    to: contract.email,
    subject: `${company} receipt ${payment.receipt_number} – ${money(payment.amount)}`,
    text: `Dear ${contract.client_name},\n\nThank you. We have received your payment of ${money(payment.amount)} on ${String(payment.paid_at).slice(0, 10)} (reference ${payment.reference}) for contract ${contract.contract_number || ""}${contract.property_name ? `, ${contract.property_name}` : ""}.\n\nYour receipt ${payment.receipt_number} is attached.\n\n${company}`,
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
