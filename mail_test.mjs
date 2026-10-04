// Customer e-mails: receipt on approval and payment reminders, through a small
// fake mail server (nothing leaves this computer).
import net from "node:net";

const received = [];
const server = net.createServer((socket) => {
  let data = null;
  socket.write("220 fake.mkuyu.test ESMTP\r\n");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (data !== null) {
      const end = buffer.indexOf("\r\n.\r\n");
      if (end === -1) return;
      received.push(buffer.slice(0, end)); buffer = buffer.slice(end + 5); data = null;
      socket.write("250 queued\r\n");
    }
    let index;
    while (data === null && (index = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
      if (/^EHLO/i.test(line)) socket.write("250-fake.mkuyu.test\r\n250 AUTH LOGIN PLAIN\r\n");
      else if (/^AUTH PLAIN/i.test(line)) socket.write("235 ok\r\n");
      else if (/^(MAIL|RCPT)/i.test(line)) socket.write("250 ok\r\n");
      else if (/^DATA/i.test(line)) { socket.write("354 go\r\n"); data = ""; if (buffer.includes("\r\n.\r\n")) socket.emit("data", Buffer.alloc(0)); }
      else if (/^QUIT/i.test(line)) { socket.write("221 bye\r\n"); socket.end(); }
    }
  });
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
Object.assign(process.env, { SMTP_HOST: "127.0.0.1", SMTP_PORT: String(server.address().port), SMTP_SECURE: "false", SMTP_USER: "payments@mkuyu.test", SMTP_PASS: "test-only", MAIL_FROM: "MKUYU Real Estate <payments@mkuyu.test>" });

const { prepareTestDatabase } = await import("./test_support/harness.mjs");
await prepareTestDatabase(); // schema up to date (e-mail log, receipt flag)
const { sendMail } = await import("./backend/src/mail.js");
const { emailReceipt, sendDueReminders } = await import("./backend/src/payments/notices.js");
const { query, closeDatabase } = await import("./backend/src/db.js");
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };
let debtId = null;
try {
  const direct = await sendMail({ to: "someone@example.test", subject: "Test é", text: "Hello", kind: "test" });
  check(direct.sent && received.length === 1 && received[0].includes("Subject: =?UTF-8?B?"), "an e-mail is delivered through the mail server");
  check((await sendMail({ to: "not-an-address", subject: "x", text: "x", kind: "test" })).sent === false, "a wrong address is not sent");

  const payment = (await query("SELECT p.id, p.contract_id FROM payments p WHERE p.status='approved' AND p.receipt_number IS NOT NULL ORDER BY p.id DESC LIMIT 1")).rows[0];
  check(Boolean(payment), "an approved payment exists in the test database");
  await query("UPDATE contracts SET client_email='buyer@example.test' WHERE id=$1", [payment.contract_id]);
  await query("UPDATE payments SET receipt_emailed_at=NULL WHERE id=$1", [payment.id]);
  const before = received.length;
  const receipt = await emailReceipt(payment.id);
  const mail = received[received.length - 1] || "";
  check(receipt.sent && received.length === before + 1 && mail.includes("To: buyer@example.test") && mail.includes("application/pdf") && mail.includes("JVBERi"), "the customer receives the receipt with the PDF attached");
  {
    // The receipt says which installments the money went to, and what is left.
    const { receiptCoverage } = await import("./backend/src/payments/notices.js");
    const coverage = await receiptCoverage(payment.id);
    const amount = Number((await query("SELECT amount FROM payments WHERE id=$1", [payment.id])).rows[0].amount);
    const applied = (coverage?.items || []).reduce((total, row) => total + row.applied, 0);
    check(coverage && Math.abs(applied + coverage.credit - amount) < 0.01 && coverage.balance !== null
      && coverage.items.every((row) => row.left_after >= 0 && row.left_after <= row.installment_amount),
      "the receipt lists every installment the payment covered, the credit and the balance");
  }
  check((await emailReceipt(payment.id)).sent === false && received.length === before + 1, "a receipt is e-mailed only once");

  const contract = (await query("SELECT id, organization_id, client_name FROM contracts WHERE status='active' ORDER BY id DESC LIMIT 1")).rows[0];
  await query("UPDATE contracts SET client_email='tenant@example.test' WHERE id=$1", [contract.id]);
  debtId = (await query("INSERT INTO debts (organization_id, contract_id, client_name, amount, due_date, status, notes) VALUES ($1,$2,$3,750000,CURRENT_DATE + 3,'pending','Reminder test installment') RETURNING id", [contract.organization_id, contract.id, contract.client_name])).rows[0].id;
  const reminders = await sendDueReminders();
  const reminder = received.find((message) => message.includes("To: tenant@example.test")) || "";
  check(reminders.sent >= 1 && reminder.includes("Subject: =?UTF-8?B?"), "a reminder goes out 3 days before the due date");
  const again = await sendDueReminders();
  check(!received.slice(-again.sent || received.length).some((message) => message.includes("Reminder test installment")) || again.sent === 0, "each installment is reminded only once");
  check(Number((await query("SELECT COUNT(*) FROM email_log WHERE kind='reminder' AND debt_id=$1 AND status='sent'", [debtId])).rows[0].count) === 1, "the reminder is in the e-mail log");
} catch (error) {
  failures += 1; console.error(error);
} finally {
  if (debtId) await query("DELETE FROM debts WHERE id=$1", [debtId]);
  await closeDatabase();
  server.close();
}
console.log(failures ? `${failures} MAIL CHECK(S) FAILED` : "MAIL_CHECKS_ALL_PASSED");
if (failures) process.exitCode = 1;
