// Sends a SAMPLE MKUYU receipt by e-mail through the system's own mail code,
// using the SMTP account in .env. Nothing in the database changes (only the
// e-mail log gets a line, when the database is running).
//
//   node tools/send_test_receipt.mjs you@example.com
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });

const to = String(process.argv[2] || "").trim();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
  console.log("Usage: node tools/send_test_receipt.mjs you@example.com");
  process.exit(2);
}

const PDFDocument = (await import("pdfkit")).default;
const { mailConfigured, mailSettings, sendMail } = await import("../backend/src/mail.js");
const { writeReceiptPdf } = await import("../backend/src/payments/notices.js");

if (!mailConfigured()) {
  console.log("E-mail is not set up yet: SMTP_HOST and MAIL_FROM are missing in .env. Run setup-email.bat first.");
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const payment = {
  receipt_number: "RCT-TEST-000001", client_name: "Test Customer", amount: 10000000, paid_at: today,
  method: "mobile", reference: "TEST12345", installment_notes: "Installment 1/3 (sample)", approved_by_name: "MKUYU Finance", approved_at: today,
};
const contract = { contract_number: "MK-C-TEST", property_name: "Sample property", client_name: "Test Customer" };

const pdf = await new Promise((resolve, reject) => {
  const doc = new PDFDocument({ size: "A5", margin: 40 });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject);
  writeReceiptPdf(doc, payment, contract, "MKUYU");
  doc.end();
});

const s = mailSettings();
console.log(`Sending a sample receipt to ${to} through ${s.host}:${s.port} as ${s.from} ...`);
const result = await sendMail({
  to,
  subject: "MKUYU receipt RCT-TEST-000001 – TZS 10,000,000 (TEST)",
  text: `Dear Test Customer,\n\nThis is a TEST e-mail from the MKUYU Real Estate Management System.\nWhen Finance approves a real payment, the customer receives a message like this one with the MKUYU receipt attached.\n\nMKUYU`,
  attachments: [{ filename: "RCT-TEST-000001.pdf", contentType: "application/pdf", content: pdf }],
  kind: "test",
});
console.log(result.sent ? "SENT. Check the inbox (and the Spam folder)." : `NOT SENT: ${result.error}`);
process.exit(result.sent ? 0 : 1);
