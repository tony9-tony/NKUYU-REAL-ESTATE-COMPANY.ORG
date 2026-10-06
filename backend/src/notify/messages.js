// The words a customer receives by SMS (and e-mail) for each notice. Pure
// functions: no database, no network, so they are unit-tested directly
// (notifications_test.mjs). Kiswahili by default; SMS_LANGUAGE=en for English.
//
// An SMS is 160 characters per part; every text here keeps to two parts at most
// even with a long property name, because each part is charged.

export const NOTICE_KINDS = ["payment_received", "fully_paid", "due_soon", "overdue", "new_listing"];

const pad = (n) => String(n).padStart(2, "0");

/** 1,250,000 — whole shillings, grouped with commas. */
export function money(value) {
  const n = Math.round(Number(value) || 0);
  return `TZS ${n.toLocaleString("en-US")}`;
}

/** 05/11/2026 from a Date, a YYYY-MM-DD string, or a timestamp. */
export function shortDate(value) {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const [y, m, d] = value.slice(0, 10).split("-");
    return `${d}/${m}/${y}`;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

/**
 * The international form an SMS gateway wants (255712345678) for a Tanzanian
 * mobile number written as 0712…, +255 712…, 255712… or 712…. Anything else is
 * not a number we can text, and gives null.
 */
export function smsNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 9) return null;
  const last9 = digits.slice(-9);
  if (!/^[67]\d{8}$/.test(last9)) return null;
  // Reject a longer number that is not Tanzanian (e.g. +254 Kenya).
  const prefix = digits.slice(0, -9);
  if (prefix && !["0", "255", "2550"].includes(prefix)) return null;
  return `255${last9}`;
}

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";
const clip = (text, max) => (String(text || "").length > max ? `${String(text).slice(0, max - 1).trim()}…` : String(text || ""));

const TEXT = {
  sw: {
    payment_received: (d) => [
      `${d.company}: Tumepokea malipo yako ya ${money(d.amount)}${d.receipt ? ` (Risiti ${d.receipt})` : ""} kwa mkataba ${d.contract}.`,
      d.balance > 0 ? `Salio: ${money(d.balance)}.` : null,
      d.next ? `Awamu ijayo: ${money(d.next.amount)} tarehe ${shortDate(d.next.due_date)}.` : "Asante.",
    ],
    fully_paid: (d) => [
      `${d.company}: Hongera ${firstName(d.name)}! Umekamilisha malipo yote ya mkataba ${d.contract}${d.property ? ` (${clip(d.property, 40)})` : ""}.`,
      `Jumla uliyolipa: ${money(d.total)}.`,
      "Asante kwa kuwa nasi.",
    ],
    due_soon: (d) => [
      `${d.company}: Kumbusho, awamu ya ${money(d.amount)} (mkataba ${d.contract})`,
      d.days === 0 ? `inatakiwa kulipwa LEO ${shortDate(d.due_date)}.` : `inatakiwa tarehe ${shortDate(d.due_date)}, siku ${d.days} zijazo.`,
      `Tumia ${d.contract} kama kumbukumbu ya malipo.`,
    ],
    overdue: (d) => [
      `${d.company}: Una deni la ${money(d.amount)} kwa mkataba ${d.contract}, limechelewa siku ${d.days}.`,
      `Tafadhali lipa mapema${d.phone ? ` au piga ${d.phone}` : " au wasiliana nasi"}. Kama umeshalipa, asante.`,
    ],
    new_listing: (d) => [
      `${d.company}: ${d.service === "rent" ? "Inapangishwa" : "Inauzwa"} sasa! ${clip(d.property, 45)}${d.location ? `, ${clip(d.location, 30)}` : ""}.`,
      d.price > 0 ? `Bei: ${money(d.price)}${d.service === "rent" && d.period ? ` kwa ${d.period === "year" ? "mwaka" : "mwezi"}` : ""}.` : null,
      d.link ? d.link : (d.phone ? `Piga ${d.phone}.` : null),
      "Kuacha kupokea matangazo, tujulishe.",
    ],
  },
  en: {
    payment_received: (d) => [
      `${d.company}: We received your payment of ${money(d.amount)}${d.receipt ? ` (Receipt ${d.receipt})` : ""} for contract ${d.contract}.`,
      d.balance > 0 ? `Balance: ${money(d.balance)}.` : null,
      d.next ? `Next installment: ${money(d.next.amount)} on ${shortDate(d.next.due_date)}.` : "Thank you.",
    ],
    fully_paid: (d) => [
      `${d.company}: Congratulations ${firstName(d.name)}! You have fully paid contract ${d.contract}${d.property ? ` (${clip(d.property, 40)})` : ""}.`,
      `Total paid: ${money(d.total)}.`,
      "Thank you for choosing us.",
    ],
    due_soon: (d) => [
      `${d.company}: Reminder, an installment of ${money(d.amount)} (contract ${d.contract})`,
      d.days === 0 ? `is due TODAY ${shortDate(d.due_date)}.` : `is due on ${shortDate(d.due_date)}, in ${d.days} day${d.days === 1 ? "" : "s"}.`,
      `Use ${d.contract} as the payment reference.`,
    ],
    overdue: (d) => [
      `${d.company}: You have ${money(d.amount)} overdue on contract ${d.contract}, ${d.days} day${d.days === 1 ? "" : "s"} late.`,
      `Please pay soon${d.phone ? ` or call ${d.phone}` : " or contact us"}. If you have paid, thank you.`,
    ],
    new_listing: (d) => [
      `${d.company}: Now ${d.service === "rent" ? "for rent" : "for sale"}! ${clip(d.property, 45)}${d.location ? `, ${clip(d.location, 30)}` : ""}.`,
      d.price > 0 ? `Price: ${money(d.price)}${d.service === "rent" && d.period ? ` per ${d.period === "year" ? "year" : "month"}` : ""}.` : null,
      d.link ? d.link : (d.phone ? `Call ${d.phone}.` : null),
      "To stop these messages, let us know.",
    ],
  },
};

const SUBJECTS = {
  sw: { payment_received: "Tumepokea malipo yako", fully_paid: "Umekamilisha malipo yote", due_soon: "Kumbusho la awamu ya malipo", overdue: "Deni lililochelewa", new_listing: "Nyumba mpya sokoni" },
  en: { payment_received: "Payment received", fully_paid: "Your contract is fully paid", due_soon: "Installment reminder", overdue: "Overdue payment", new_listing: "New property available" },
};

export function noticeLanguage(value = process.env.SMS_LANGUAGE) {
  return String(value || "sw").toLowerCase().startsWith("en") ? "en" : "sw";
}

/** The SMS text for one notice. `data.company` defaults to MKUYU. */
export function smsText(kind, data, lang = noticeLanguage()) {
  const build = TEXT[lang]?.[kind];
  if (!build) throw new Error(`unknown notice kind: ${kind}`);
  return build({ company: "MKUYU", ...data }).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

/** Subject and body for the e-mail copy of the same notice. */
export function emailText(kind, data, lang = noticeLanguage()) {
  const company = data.company || "MKUYU";
  const greeting = lang === "en" ? `Dear ${data.name || "customer"},` : `Ndugu ${data.name || "mteja"},`;
  const body = smsText(kind, { ...data, company }, lang).replace(new RegExp(`^${company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*`), "");
  return { subject: `${company}: ${SUBJECTS[lang][kind]}`, text: `${greeting}\n\n${body}\n\n${company}` };
}

/** How many 160-character parts (GSM) or 70-character parts (Unicode) a text costs. */
export function smsParts(text) {
  const value = String(text || "");
  // eslint-disable-next-line no-control-regex
  const unicode = /[^\x00-\x7F]/.test(value.replace(/[…]/g, "..."));
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  return value.length <= single ? 1 : Math.ceil(value.length / multi);
}

/**
 * Due-soon stage: the smallest configured offset that is still >= the days left.
 * With offsets 7,3,0 a debt 5 days away is stage 7, 2 days away is stage 3, due
 * today is stage 0. Each stage is sent once, so a server that was off for a day
 * still sends the stage it is in, never every stage it missed.
 */
export function dueSoonStage(daysLeft, offsets) {
  if (!Number.isInteger(daysLeft) || daysLeft < 0) return null;
  const fits = offsets.filter((o) => o >= daysLeft).sort((a, b) => a - b);
  return fits.length ? fits[0] : null;
}

/**
 * Overdue stage: the largest configured offset already reached (1, 7, 14, 30),
 * then one more every 30 days after the last offset ("m60", "m90", …), so a
 * long-unpaid debt keeps being reminded monthly but never daily.
 */
export function overdueStage(daysLate, offsets) {
  if (!Number.isInteger(daysLate) || daysLate < 1) return null;
  const sorted = [...offsets].sort((a, b) => a - b);
  const last = sorted[sorted.length - 1];
  if (last !== undefined && daysLate >= last + 30) return `m${last + 30 * Math.floor((daysLate - last) / 30)}`;
  const reached = sorted.filter((o) => o <= daysLate);
  return reached.length ? `d${reached[reached.length - 1]}` : null;
}

/** "7,3,0" → [7,3,0]; bad entries are dropped; falls back to `fallback`. */
export function parseOffsets(value, fallback) {
  const list = String(value ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 365);
  return list.length ? [...new Set(list)] : fallback;
}

/** True when `hour` (0-23) is inside quiet hours "20-8" (wraps midnight). */
export function inQuietHours(hour, range = process.env.SMS_QUIET_HOURS ?? "20-8") {
  const match = String(range).match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match) return false;
  const [from, to] = [Number(match[1]), Number(match[2])];
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/**
 * Whether saving a property should announce it to opted-in customers, and as
 * what ("buy" or "rent"). Only a change that newly OPENS it counts: being
 * published, or a sold/reserved/rented category becoming available again. Plain
 * edits of an already-open listing (price, photos, wording) announce nothing.
 */
export function listingAnnouncement(before, after) {
  const published = (p) => Boolean(p?.public_listing) && (p.public_listing_status || "approved") === "approved";
  if (!published(after)) return null;
  const buyOpen = (p) => Boolean(p?.offer_buy) && (p.sale_status || "available") === "available" && !(p.offer_rent && p.rent_status === "rented" && p.sale_status !== "sold");
  const rentOpen = (p) => Boolean(p?.offer_rent) && (p.rent_status || "available") === "available";
  const wasPublished = published(before);
  if (buyOpen(after) && (!wasPublished || !buyOpen(before))) return "buy";
  if (rentOpen(after) && (!wasPublished || !rentOpen(before))) return "rent";
  return null;
}
