// Reads a pasted payment message (bank alert, M-Pesa, Mixx, Airtel, HaloPesa)
// and returns what it can find: amount, reference, date, method and who paid.
// It never decides anything: the Finance officer checks the filled-in form.
// Unknown formats simply return fewer fields, and the officer types the rest.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function pad(value) { return String(value).padStart(2, "0"); }

function isoDate(day, month, year) {
  let y = Number(year);
  if (y < 100) y += 2000;
  const d = Number(day);
  const m = Number(month);
  if (!(d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 2000 && y <= 2100)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** 0712345678 for any Tanzanian mobile number written as +255…, 255… or 0…. */
export function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length >= 9) {
    const last9 = digits.slice(-9);
    if (/^[67]\d{8}$/.test(last9)) return `0${last9}`;
  }
  return null;
}

export function parsePaymentMessage(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const result = { amount: null, reference: null, paid_at: null, method: null, payer_name: null, payer_phone: null, provider: null, contract_number: null };
  if (!raw) return result;
  const lower = raw.toLowerCase();

  // Amount: the first "TSh/TZS 1,234,567.00".
  const amount = raw.match(/\b(?:tsh|tzs|tshs)\.?\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (amount) result.amount = Number(amount[1].replace(/,/g, ""));

  // Provider and method.
  const providers = [["M-Pesa", /m-?pesa|vodacom/i], ["Mixx by Yas", /mixx|tigo ?pesa|\byas\b/i], ["Airtel Money", /airtel/i], ["HaloPesa", /halo ?pesa|halotel/i]];
  const banks = /\b(crdb|nmb|nbc|stanbic|equity|absa|exim|azania|dtb|kcb|ncba|tcb|akiba|amana|bank|account|a\/c|credited)\b/i;
  for (const [name, pattern] of providers) if (pattern.test(raw)) { result.provider = name; result.method = "mobile"; break; }
  if (!result.method && banks.test(raw)) { result.method = "bank"; const bank = raw.match(/\b(CRDB|NMB|NBC|Stanbic|Equity|ABSA|Exim|Azania|DTB|KCB|NCBA|TCB|Akiba|Amana)\b/i); result.provider = bank ? bank[1].toUpperCase() : "Bank"; }
  if (!result.method && /\b(confirmed|imethibitishwa|umepokea|received)\b/i.test(raw)) result.method = "mobile";

  // Reference: labelled first, then the code an M-Pesa message starts with.
  const labelled = raw.match(/\b(?:ref(?:erence)?(?:\s*no)?|kumbukumbu(?:\s*no)?|muamala|tid|txn(?:\s*id)?|trans(?:action)?\s*(?:id|no)|receipt\s*no)\s*[:.#-]?\s*([A-Z0-9][A-Z0-9./-]{4,40})/i);
  if (labelled) result.reference = labelled[1].replace(/[.,]+$/, "").toUpperCase();
  if (!result.reference) {
    const leading = raw.match(/^([A-Z0-9]{8,14})\s+(?:confirmed|imethibitishwa|imekamilika)/i);
    if (leading) result.reference = leading[1].toUpperCase();
  }

  // Date: 3/10/26, 03-10-2026, 2026-10-03 or 3 Oct 2026 (day first).
  let date = raw.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (date) result.paid_at = isoDate(date[3], date[2], date[1]);
  if (!result.paid_at) {
    date = raw.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/);
    if (date) result.paid_at = isoDate(date[1], date[2], date[3]);
  }
  if (!result.paid_at) {
    date = raw.match(/\b(\d{1,2})[\s-]([A-Za-z]{3,4})[a-z]*[\s,-]*(\d{2,4})\b/);
    if (date && MONTHS[date[2].toLowerCase()]) result.paid_at = isoDate(date[1], MONTHS[date[2].toLowerCase()], date[3]);
  }

  // Who paid: a phone number, and the name written after "from" / "kutoka".
  const phone = raw.match(/(?:\+?255|\b0)[\s-]?[67]\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/);
  if (phone) result.payer_phone = normalizePhone(phone[0]);
  const from = raw.match(/\b(?:from|kutoka(?:\s+kwa)?)\s+((?:\+?\d[\d\s-]{8,}\s*[-–]?\s*)?)([A-Za-z][A-Za-z .'&-]{1,60}?)(?=\s+(?:\+?255|0)[67]\d|\s+(?:on|tarehe|ref|reference|kwenye|to|via|at|saa)\b|[.,;]|$)/i);
  if (from) {
    const name = from[2].replace(/\s+/g, " ").trim();
    if (name && !/^(account|a\/c|your|m-?pesa|bank)$/i.test(name)) result.payer_name = name.toUpperCase();
    if (!result.payer_phone && from[1]) result.payer_phone = normalizePhone(from[1]);
  }
  // A contract number written in the narration (MK-C-000004) settles who it is.
  const contractRef = raw.match(/\bMK-?C-?(\d{1,8})\b/i);
  if (contractRef) result.contract_number = `MK-C-${contractRef[1].padStart(6, "0")}`;
  if (lower.includes("sent to") && !lower.includes("received")) result.outgoing = true;
  return result;
}
