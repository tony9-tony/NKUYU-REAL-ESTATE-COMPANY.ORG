// Outgoing e-mail with no extra package: a small SMTP client on Node's own
// net/tls modules. Used for the customer's receipt (when Finance approves a
// payment) and for payment reminders (3 days before an installment is due).
//
// Nothing is sent until the server is given an SMTP account in .env:
//   SMTP_HOST=smtp.gmail.com   SMTP_PORT=465   SMTP_SECURE=true
//   SMTP_USER=payments@yourcompany.co.tz      SMTP_PASS=<app password>
//   MAIL_FROM="MKUYU Real Estate <payments@yourcompany.co.tz>"
// Port 465 is TLS from the start (SMTP_SECURE=true); port 587 starts plain and
// upgrades with STARTTLS. Every message is written to email_log.
import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import crypto from "node:crypto";
import { query } from "./db.js";

export function mailSettings() {
  const port = Number(process.env.SMTP_PORT || 465);
  return {
    host: process.env.SMTP_HOST || "",
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.MAIL_FROM || process.env.SMTP_USER || "",
    // TLS certificates are checked unless explicitly turned off (test servers only).
    rejectUnauthorized: process.env.SMTP_TLS_INSECURE !== "1",
  };
}
export function mailConfigured() {
  const settings = mailSettings();
  return Boolean(settings.host && settings.from);
}

const b64 = (value) => Buffer.from(value, "utf8").toString("base64");
const encodeHeader = (value) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${b64(value)}?=`);
const addressOnly = (value) => (String(value).match(/<([^>]+)>/) || [null, String(value)])[1].trim();

function buildMessage({ from, to, subject, text, html, attachments = [] }) {
  const boundary = `mkuyu-${crypto.randomBytes(12).toString("hex")}`;
  const alt = `${boundary}-alt`;
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${addressOnly(from).split("@")[1] || os.hostname()}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(text).replace(/.{1,76}/g, "$&\r\n").trim(),
  ];
  if (html) lines.push(`--${alt}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(html).replace(/.{1,76}/g, "$&\r\n").trim());
  lines.push(`--${alt}--`);
  for (const file of attachments) {
    lines.push(`--${boundary}`, `Content-Type: ${file.contentType || "application/octet-stream"}; name="${file.filename}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${file.filename}"`, "", file.content.toString("base64").replace(/.{1,76}/g, "$&\r\n").trim());
  }
  lines.push(`--${boundary}--`, "");
  // Dot-stuffing: a line that starts with "." is sent as "..".
  return lines.join("\r\n").replace(/\r\n\./g, "\r\n..");
}

/** One SMTP conversation. Resolves when the server accepted the message. */
function smtpSend(settings, envelopeFrom, recipients, data) {
  return new Promise((resolve, reject) => {
    let socket = settings.secure
      ? tls.connect({ host: settings.host, port: settings.port, servername: settings.host, rejectUnauthorized: settings.rejectUnauthorized })
      : net.connect({ host: settings.host, port: settings.port });
    let buffer = "";
    let waiting = null;
    const timer = setTimeout(() => fail(new Error("the mail server did not answer in time")), 30000);
    const fail = (error) => { clearTimeout(timer); try { socket.destroy(); } catch { /* closed */ } reject(error); };
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      // A reply is complete when its last line is "NNN text" (no dash).
      const lines = buffer.split("\r\n");
      const complete = lines.slice(0, -1);
      const last = complete[complete.length - 1];
      if (!last || !/^\d{3} /.test(last)) return;
      buffer = "";
      const code = Number(last.slice(0, 3));
      const handler = waiting; waiting = null;
      if (handler) handler(code, complete.join("\n"));
    };
    const attach = () => { socket.on("data", onData); socket.on("error", fail); };
    attach();
    const expect = (okCodes) => new Promise((ok, no) => { waiting = (code, reply) => (okCodes.includes(code) ? ok(reply) : no(new Error(`mail server refused: ${reply}`))); });
    const send = (line, okCodes) => { const answer = expect(okCodes); socket.write(`${line}\r\n`); return answer; };
    (async () => {
      try {
        await expect([220]);
        const hello = `EHLO ${os.hostname() || "mkuyu"}`;
        let ehlo = await send(hello, [250]);
        if (!settings.secure && /STARTTLS/i.test(ehlo)) {
          await send("STARTTLS", [220]);
          socket.removeListener("data", onData);
          socket = tls.connect({ socket, servername: settings.host, rejectUnauthorized: settings.rejectUnauthorized });
          attach();
          await new Promise((ok, no) => { socket.once("secureConnect", ok); socket.once("error", no); });
          ehlo = await send(hello, [250]);
        }
        if (settings.user) {
          if (/AUTH[^\n]*PLAIN/i.test(ehlo)) await send(`AUTH PLAIN ${Buffer.from(`\0${settings.user}\0${settings.pass}`).toString("base64")}`, [235]);
          else { await send("AUTH LOGIN", [334]); await send(b64(settings.user), [334]); await send(b64(settings.pass), [235]); }
        }
        await send(`MAIL FROM:<${envelopeFrom}>`, [250]);
        for (const to of recipients) await send(`RCPT TO:<${to}>`, [250, 251]);
        await send("DATA", [354]);
        await send(`${data}\r\n.`, [250]);
        socket.write("QUIT\r\n");
        clearTimeout(timer);
        socket.end();
        resolve();
      } catch (error) {
        fail(error);
      }
    })();
  });
}

/**
 * Sends one e-mail and records it in email_log. Never throws: a mail problem
 * must not undo a payment approval. Returns { sent, error }.
 */
export async function sendMail({ to, subject, text, html, attachments, kind, related = {} }) {
  const settings = mailSettings();
  const recipient = String(to || "").trim();
  // Until an SMTP account is configured nothing is sent and nothing is logged.
  if (!mailConfigured()) return { sent: false, error: "e-mail is not set up (SMTP_HOST / MAIL_FROM)" };
  let error = null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) error = "no valid e-mail address";
  if (!error) {
    try {
      await smtpSend(settings, addressOnly(settings.from), [recipient], buildMessage({ from: settings.from, to: recipient, subject, text, html, attachments }));
    } catch (failure) {
      error = failure.message;
    }
  }
  try {
    await query("INSERT INTO email_log (kind, recipient, subject, payment_id, debt_id, contract_id, status, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [kind || "other", recipient || null, subject, related.payment_id || null, related.debt_id || null, related.contract_id || null, error ? "failed" : "sent", error]);
  } catch { /* the log is best-effort */ }
  if (error) console.warn(`e-mail (${kind}) to ${recipient || "?"} not sent: ${error}`);
  return { sent: !error, error };
}
