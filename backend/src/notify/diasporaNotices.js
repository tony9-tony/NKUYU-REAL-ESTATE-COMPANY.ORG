// E-mail notices to diaspora customers about what happens to THEIR matters:
// the Desk replies, documents are checked, Legal updates a title or a transfer,
// a construction update is published, a passport is about to expire.
//
// A customer can switch these off in the portal (clients.notify_email). Nothing
// is sent unless SMTP is set up in .env; a failed e-mail never fails the action
// that caused it. Every message is also kept in email_log by sendMail.
import { query, queryOne } from "../db.js";
import { mailConfigured, sendMail } from "../mail.js";

const site = () => String(process.env.DIASPORA_SITE_URL || process.env.PUBLIC_SITE_URL || "").trim().replace(/\/+$/, "");
const portalLink = (hash = "") => `${site() ? `${site()}/login.html` : "Website → Diaspora login"}${hash ? `  → ${hash}` : ""}`;

/** Sends one notice to one customer (if they want e-mail and have an address). Never throws. */
export async function notifyCustomer(clientId, { subject, lines, where = "" }) {
  try {
    if (!mailConfigured()) return false;
    const client = await queryOne("SELECT name, email, notify_email FROM clients WHERE id=$1 AND is_diaspora=TRUE", [clientId]);
    if (!client?.email || client.notify_email === false) return false;
    await sendMail({ to: client.email, subject: `MKUYU: ${subject}`,
      text: `Dear ${client.name},\n\n${[].concat(lines).join("\n\n")}\n\n${portalLink(where)}\n\nYou can switch these e-mails off in your portal.\n\nMKUYU Africa`, kind: "diaspora-notice" });
    return true;
  } catch { return false; }
}

/** Every diaspora customer who holds a contract on this project / property. */
export async function customersOf({ projectId = null, propertyId = null }) {
  const rows = (await query(
    `SELECT DISTINCT c.client_id FROM contracts c JOIN clients cl ON cl.id=c.client_id AND cl.is_diaspora=TRUE
      WHERE c.status IN ('approved','customer_pending','active','completed')
        AND (($1::int IS NOT NULL AND c.project_id=$1) OR ($2::int IS NOT NULL AND c.property_id=$2))`, [projectId, propertyId])).rows;
  return rows.map((r) => r.client_id);
}

/** Records a step in a customer's identity check. */
export async function recordVerificationEvent(clientId, userId, action, note = null) {
  await query("INSERT INTO verification_events (client_id, actor_user_id, action, note) VALUES ($1,$2,$3,$4)", [clientId, userId || null, action, note]);
}

const DAY = 24 * 60 * 60 * 1000;
/** A passport or residence document that expires within 30 days: ask for a new one, once. */
export async function sendExpiryReminders() {
  const rows = (await query(
    `SELECT d.id, d.client_id, d.category, to_char(d.expires_on,'DD/MM/YYYY') AS on_text
       FROM documents d JOIN clients c ON c.id=d.client_id
      WHERE d.category LIKE 'kyc\\_%' AND d.status <> 'superseded' AND d.expires_on IS NOT NULL AND d.expiry_notified_at IS NULL
        AND d.expires_on <= CURRENT_DATE + 30 AND c.is_diaspora=TRUE LIMIT 100`)).rows;
  for (const row of rows) {
    const label = row.category === "kyc_passport" ? "passport" : "residence document";
    await query("UPDATE documents SET expiry_notified_at=NOW() WHERE id=$1", [row.id]);
    await recordVerificationEvent(row.client_id, null, "expiry_reminder", `${label} expires ${row.on_text}`);
    await notifyCustomer(row.client_id, { subject: `your ${label} expires soon`,
      lines: [`Your ${label} on file expires on ${row.on_text}.`, "Please upload a new one so your verification stays valid and your requests are not delayed."], where: "Verify my identity" });
  }
  return rows.length;
}
export function startExpiryReminders() {
  if (process.env.EXPIRY_REMINDERS === "0") return;
  const run = () => sendExpiryReminders().catch((error) => console.error("expiry reminders:", error.message));
  setTimeout(run, 60 * 1000).unref?.();
  setInterval(run, 12 * 60 * 60 * 1000).unref?.();
}
