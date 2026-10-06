// Customer notices by SMS (and e-mail where it adds something):
//
//   payment_received  Finance approves a payment: amount, receipt, balance, next installment
//   fully_paid        the payment that clears the contract: congratulations + total
//   due_soon          an installment is coming: 7, 3 and 0 days before (SMS_DUE_DAYS)
//   overdue           money is late: 1, 7, 14, 30 days, then monthly (SMS_OVERDUE_DAYS)
//   new_listing       a property is published / available again: to customers who agreed
//
// Every notice is written to notification_log BEFORE it is sent, under a unique
// key (one per payment, per installment stage, per contract stage, per property
// and person). A second server, a retry or a restart therefore never sends the
// same notice twice; a FAILED notice frees its key so the next run retries it.
//
// The existing e-mails (receipt PDF on approval, reminder 3 days before) stay
// exactly as they were in payments/notices.js; the e-mail copies here are only
// for fully_paid, overdue and new_listing, which had no e-mail before.
import { query, queryOne } from "../db.js";
import { mailConfigured, sendMail } from "../mail.js";
import { sendSms, smsSettings } from "./sms.js";
import { dueSoonStage, emailText, inQuietHours, listingAnnouncement, noticeLanguage, overdueStage, parseOffsets, smsNumber, smsText } from "./messages.js";

const EMAIL_KINDS = new Set(["fully_paid", "overdue", "new_listing"]);
const LIVE_CONTRACT = "('approved','customer_pending','active')";

const company = () => String(process.env.SMS_COMPANY_NAME || "MKUYU").trim() || "MKUYU";
const contactPhone = () => String(process.env.MKUYU_CONTACT_PHONE || "").trim();
const dueOffsets = () => parseOffsets(process.env.SMS_DUE_DAYS, [7, 3, 0]);
const overdueOffsets = () => parseOffsets(process.env.SMS_OVERDUE_DAYS, [1, 7, 14, 30]).filter((n) => n >= 1);
const kindEnabled = (kind) => {
  const flags = { payment_received: "SMS_PAYMENTS", fully_paid: "SMS_PAYMENTS", due_soon: "SMS_REMINDERS", overdue: "SMS_OVERDUE", new_listing: "SMS_ANNOUNCE" };
  return process.env[flags[kind]] !== "0";
};

/** Claims a key; returns the log row id, or null when it was already sent. */
async function claim(channel, key, fields) {
  const row = await queryOne(
    `INSERT INTO notification_log (kind, channel, dedupe_key, recipient, message, status, contract_id, debt_id, payment_id, property_id, client_id, lead_id)
     VALUES ($1,$2,$3,$4,$5,'sending',$6,$7,$8,$9,$10,$11)
     ON CONFLICT (channel, dedupe_key) WHERE status IN ('sending','sent','test') DO NOTHING RETURNING id`,
    [fields.kind, channel, key, fields.recipient, fields.message, fields.contract_id || null, fields.debt_id || null,
      fields.payment_id || null, fields.property_id || null, fields.client_id || null, fields.lead_id || null],
  );
  return row?.id || null;
}

async function finish(id, result) {
  await query("UPDATE notification_log SET status=$1, error=$2, provider=$3, provider_ref=$4, sent_at=NOW() WHERE id=$5",
    [result.status, result.error || null, result.provider || null, result.ref || null, id]);
}

/**
 * Sends one notice to one person by SMS (when they have a mobile number) and by
 * e-mail (for the kinds that have an e-mail copy, when e-mail is set up).
 * Never throws: a notice must never undo the action that caused it.
 */
export async function deliver({ kind, key, phone, email, name, data, related = {} }) {
  const outcome = { sms: null, email: null };
  try {
    if (!kindEnabled(kind)) return outcome;
    const lang = noticeLanguage();
    const payload = { company: company(), phone: contactPhone(), name, ...data };
    const number = smsNumber(phone);
    if (number && smsSettings().enabled) {
      const text = smsText(kind, payload, lang);
      const id = await claim("sms", key, { kind, recipient: number, message: text, ...related });
      if (id) {
        const result = await sendSms(number, text);
        await finish(id, result);
        outcome.sms = result.status;
        if (result.status === "failed") console.warn(`SMS (${kind}) to ${number} not sent: ${result.error}`);
      } else outcome.sms = "already";
    }
    const address = String(email || "").trim();
    if (EMAIL_KINDS.has(kind) && address && mailConfigured() && process.env.NOTIFY_EMAIL !== "0") {
      const mail = emailText(kind, payload, lang);
      const id = await claim("email", key, { kind, recipient: address, message: mail.subject, ...related });
      if (id) {
        const result = await sendMail({ to: address, subject: mail.subject, text: mail.text, kind, related });
        await finish(id, { status: result.sent ? "sent" : "failed", error: result.error, provider: "smtp" });
        outcome.email = result.sent ? "sent" : "failed";
      } else outcome.email = "already";
    }
  } catch (error) {
    console.warn(`notice ${kind} (${key}) failed: ${error.message}`);
  }
  return outcome;
}

const contractSelect = `SELECT c.id, c.contract_number, c.client_id, c.client_name, c.value, c.status,
    COALESCE(NULLIF(c.client_phone,''), cl.phone) AS phone, COALESCE(NULLIF(c.client_email,''), cl.email) AS email,
    pr.name AS property_name
  FROM contracts c LEFT JOIN clients cl ON cl.id=c.client_id LEFT JOIN properties pr ON pr.id=c.property_id`;

const contractLabel = (c) => c.contract_number || `#${c.id}`;

async function contractMoney(contractId) {
  const row = await queryOne(
    `SELECT c.value,
       COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.contract_id=c.id AND p.status='approved'),0) AS received,
       COALESCE((SELECT SUM(r.amount) FROM refunds r WHERE r.contract_id=c.id AND r.status='approved'),0) AS refunded
     FROM contracts c WHERE c.id=$1`, [contractId]);
  if (!row) return null;
  const received = Number(row.received) - Number(row.refunded);
  return { value: Number(row.value), received, balance: Math.max(0, Math.round((Number(row.value) - received) * 100) / 100) };
}

/** The next installment still owed on a contract, if any. */
async function nextInstallment(contractId) {
  return queryOne(
    `SELECT d.id, d.due_date, d.amount - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.status='approved' WHERE pa.debt_id=d.id),0) AS amount
       FROM debts d WHERE d.contract_id=$1 AND d.status <> 'paid' AND d.due_date IS NOT NULL
        AND d.amount - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.status='approved' WHERE pa.debt_id=d.id),0) > 0
      ORDER BY d.due_date, d.id LIMIT 1`, [contractId]);
}

/**
 * After Finance approves a payment: "we received it" (with balance and next
 * installment), or, when this payment cleared the contract, "fully paid".
 */
export async function noticeAfterPayment(paymentId) {
  const payment = await queryOne("SELECT id, contract_id, amount, status, receipt_number FROM payments WHERE id=$1", [paymentId]);
  if (!payment || payment.status !== "approved") return null;
  const contract = await queryOne(`${contractSelect} WHERE c.id=$1`, [payment.contract_id]);
  if (!contract) return null;
  const money = await contractMoney(contract.id);
  const related = { contract_id: contract.id, payment_id: payment.id, client_id: contract.client_id };
  if (money && money.value > 0 && money.balance <= 0) {
    return deliver({ kind: "fully_paid", key: `fully_paid:contract:${contract.id}`, phone: contract.phone, email: contract.email, name: contract.client_name,
      data: { contract: contractLabel(contract), property: contract.property_name, total: money.received }, related });
  }
  const next = await nextInstallment(contract.id);
  return deliver({ kind: "payment_received", key: `payment:${payment.id}`, phone: contract.phone, email: contract.email, name: contract.client_name,
    data: { contract: contractLabel(contract), amount: payment.amount, receipt: payment.receipt_number, balance: money?.balance || 0,
      next: next ? { amount: Number(next.amount), due_date: next.due_date } : null }, related });
}

/** Installments coming up: one SMS per installment per stage (7, 3, 0 days). */
export async function sendDueSoonNotices() {
  const offsets = dueOffsets();
  const horizon = Math.max(...offsets);
  const rows = (await query(
    `SELECT d.id AS debt_id, d.contract_id, d.due_date, (d.due_date - CURRENT_DATE) AS days_left,
            d.amount - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.status='approved' WHERE pa.debt_id=d.id),0) AS balance
       FROM debts d JOIN contracts c ON c.id=d.contract_id
      WHERE c.status IN ${LIVE_CONTRACT} AND d.status <> 'paid'
        AND d.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int`, [horizon])).rows;
  let sent = 0;
  for (const row of rows) {
    if (!(Number(row.balance) > 0)) continue;
    const stage = dueSoonStage(Number(row.days_left), offsets);
    if (stage === null) continue;
    const contract = await queryOne(`${contractSelect} WHERE c.id=$1`, [row.contract_id]);
    if (!contract) continue;
    const result = await deliver({ kind: "due_soon", key: `due_soon:debt:${row.debt_id}:s${stage}`, phone: contract.phone, email: null, name: contract.client_name,
      data: { contract: contractLabel(contract), amount: Number(row.balance), due_date: row.due_date, days: Number(row.days_left) },
      related: { contract_id: contract.id, debt_id: row.debt_id, client_id: contract.client_id } });
    if (result.sms === "sent" || result.sms === "test") sent += 1;
  }
  return { checked: rows.length, sent };
}

/**
 * Late money, one notice per contract (not per installment): the total overdue
 * and how late the oldest unpaid installment is. Stages 1, 7, 14, 30 days, then
 * every 30 days. Paying the oldest one restarts the cycle for the next one.
 */
export async function sendOverdueNotices() {
  const offsets = overdueOffsets();
  if (!offsets.length) return { checked: 0, sent: 0 };
  const rows = (await query(
    `WITH owed AS (
       SELECT d.id, d.contract_id, d.due_date,
              d.amount - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.status='approved' WHERE pa.debt_id=d.id),0) AS balance
         FROM debts d JOIN contracts c ON c.id=d.contract_id
        WHERE c.status IN ${LIVE_CONTRACT} AND d.status <> 'paid' AND d.due_date < CURRENT_DATE)
     SELECT contract_id, SUM(balance) AS overdue,
            (ARRAY_AGG(id ORDER BY due_date, id))[1] AS oldest_debt_id,
            (CURRENT_DATE - MIN(due_date)) AS days_late
       FROM owed WHERE balance > 0 GROUP BY contract_id`)).rows;
  let sent = 0;
  for (const row of rows) {
    const stage = overdueStage(Number(row.days_late), offsets);
    if (!stage) continue;
    const contract = await queryOne(`${contractSelect} WHERE c.id=$1`, [row.contract_id]);
    if (!contract) continue;
    const result = await deliver({ kind: "overdue", key: `overdue:contract:${contract.id}:debt:${row.oldest_debt_id}:${stage}`,
      phone: contract.phone, email: contract.email, name: contract.client_name,
      data: { contract: contractLabel(contract), amount: Number(row.overdue), days: Number(row.days_late) },
      related: { contract_id: contract.id, debt_id: row.oldest_debt_id, client_id: contract.client_id } });
    if (result.sms === "sent" || result.sms === "test") sent += 1;
  }
  return { checked: rows.length, sent };
}

/** The public link to a property, when PUBLIC_SITE_URL is set. */
function listingLink(propertyId) {
  const site = String(process.env.PUBLIC_SITE_URL || "").trim().replace(/\/+$/, "");
  return site ? `${site}/property.html?id=${propertyId}` : null;
}

/**
 * Tells every customer and lead who AGREED to receive offers (marketing_opt_in)
 * that a property is now open to buy or rent. Each person hears about each
 * property once. Runs in the background; returns how many were told.
 */
export async function announceListing(propertyId, service) {
  if (!kindEnabled("new_listing") || !["buy", "rent"].includes(service)) return { sent: 0 };
  const property = await queryOne("SELECT id, name, location, price, rent_price, rent_period, public_listing FROM properties WHERE id=$1", [propertyId]);
  if (!property?.public_listing) return { sent: 0 };
  const people = (await query(
    `SELECT 'client' AS source, id, name, phone, email FROM clients WHERE marketing_opt_in = TRUE
     UNION ALL
     SELECT 'lead' AS source, id, name, phone, email FROM leads WHERE marketing_opt_in = TRUE AND client_id IS NULL
     ORDER BY source, id`)).rows;
  const limit = Number(process.env.SMS_ANNOUNCE_MAX || 2000);
  const seen = new Set();
  let sent = 0;
  for (const person of people) {
    const number = smsNumber(person.phone);
    const who = number || String(person.email || "").trim().toLowerCase();
    if (!who || seen.has(who)) continue;
    seen.add(who);
    if (seen.size > limit) break;
    const result = await deliver({
      kind: "new_listing", key: `listing:${property.id}:${service}:${who}`, phone: person.phone, email: person.email, name: person.name,
      data: { property: property.name, location: property.location, service, price: Number(service === "rent" ? property.rent_price || property.price : property.price), period: property.rent_period, link: listingLink(property.id) },
      related: { property_id: property.id, client_id: person.source === "client" ? person.id : null, lead_id: person.source === "lead" ? person.id : null },
    });
    if (result.sms === "sent" || result.sms === "test" || result.email === "sent") sent += 1;
  }
  return { sent, audience: seen.size };
}

/** Called by the property routes with the row before and after a save. */
export function maybeAnnounceListing(before, after) {
  const service = listingAnnouncement(before, after);
  if (!service || !after?.id) return null;
  announceListing(after.id, service).catch((error) => console.warn(`listing announcement failed: ${error.message}`));
  return service;
}

/** One pass of the scheduled notices (reminders and overdue). Skipped at night. */
export async function runScheduledNotices({ force = false } = {}) {
  if (!force && inQuietHours(new Date().getHours())) return { skipped: "quiet hours" };
  // A notice left half-way by a crash frees its key after an hour.
  await query("UPDATE notification_log SET status='failed', error='interrupted' WHERE status='sending' AND created_at < NOW() - INTERVAL '1 hour'");
  const due_soon = await sendDueSoonNotices();
  const overdue = await sendOverdueNotices();
  return { due_soon, overdue };
}

/** A few minutes after start, then every hour. NOTIFY_SCHEDULE=0 turns it off. */
export function startCustomerNotices() {
  if (process.env.NOTIFY_SCHEDULE === "0" || !smsSettings().enabled) return;
  const run = () => runScheduledNotices().catch((error) => console.warn(`customer notices failed: ${error.message}`));
  setTimeout(run, 7 * 60 * 1000).unref();
  setInterval(run, 60 * 60 * 1000).unref();
}

/** For the System page: how SMS is set up and the latest notices. */
export async function noticeStatus() {
  const settings = smsSettings();
  const recent = (await query(
    `SELECT kind, channel, recipient, message, status, error, created_at FROM notification_log ORDER BY id DESC LIMIT 30`)).rows;
  const today = await queryOne(
    `SELECT COUNT(*) FILTER (WHERE status='sent') AS sent, COUNT(*) FILTER (WHERE status='test') AS test, COUNT(*) FILTER (WHERE status='failed') AS failed
       FROM notification_log WHERE created_at >= CURRENT_DATE`);
  return {
    provider: settings.provider, requested: settings.requested, missing: settings.missing, live: settings.live, enabled: settings.enabled,
    sender_id: settings.senderId, language: noticeLanguage(),
    due_days: dueOffsets(), overdue_days: overdueOffsets(), quiet_hours: process.env.SMS_QUIET_HOURS ?? "20-8",
    kinds: { payments: kindEnabled("payment_received"), reminders: kindEnabled("due_soon"), overdue: kindEnabled("overdue"), announcements: kindEnabled("new_listing") },
    email_copies: mailConfigured() && process.env.NOTIFY_EMAIL !== "0",
    today: { sent: Number(today?.sent || 0), test: Number(today?.test || 0), failed: Number(today?.failed || 0) },
    recent,
  };
}
