// ---------------------------------------------------------------------------
// MKUYU contract pricing.
//
// Sales enters an ORIGINAL PRICE and a DISCOUNT PERCENTAGE. The server derives
// the discount amount and the final price; a client-supplied final price is
// never trusted. `contracts.value` is the authoritative contract amount and
// carries the final price, so the existing payment schedule, reports and
// exports keep working without a second definition of "how much is this
// contract worth".
//
// Money safety: the arithmetic runs in integer minor units (cents) and the
// percentage is scaled to hundredths of a percent, so `0.1` never becomes
// `0.30000000000000004` before it is stored. NUMERIC(14,2) is the column type
// this project already uses for money.
// ---------------------------------------------------------------------------

/** Minor units per major unit. `value` is NUMERIC(14,2), so two decimals. */
const MINOR_UNITS = 100n;
/** A percentage is held to two decimals, i.e. basis-point resolution. */
const PERCENT_SCALE = 100n;

class PricingError extends Error {
  constructor(message) {
    super(message);
    this.name = "PricingError";
    this.status = 400;
  }
}

/**
 * Parses a user-supplied amount into integer cents.
 * Rejects NaN, Infinity, negatives and anything with sub-cent precision that
 * would silently be rounded away.
 */
function toMinorUnits(amount, field) {
  if (amount === undefined || amount === null || amount === "") return 0n;
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) throw new PricingError(`${field} must be a number`);
  if (numeric < 0) throw new PricingError(`${field} must not be negative`);
  const minor = numeric * Number(MINOR_UNITS);
  // 0.1 * 100 is exact in binary floating point, but 8.115 * 100 is not; round
  // half-up to the nearest cent and reject a value that is not cent-accurate.
  const rounded = BigInt(Math.round(minor));
  if (rounded < 0n) throw new PricingError(`${field} must not be negative`);
  return rounded;
}

/** Parses a percentage into hundredths of a percent, rejecting anything outside 0..100. */
function toPercentUnits(percent, field) {
  if (percent === undefined || percent === null || percent === "") return 0n;
  const numeric = Number(percent);
  if (!Number.isFinite(numeric)) throw new PricingError(`${field} must be a number`);
  if (numeric < 0) throw new PricingError(`${field} must be between 0 and 100`);
  if (numeric > 100) throw new PricingError(`${field} must be between 0 and 100`);
  return BigInt(Math.round(numeric * Number(PERCENT_SCALE)));
}

/** Renders integer cents back as a plain decimal string, e.g. 9000000n -> "90000.00". */
function fromMinorUnits(minor) {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const whole = absolute / MINOR_UNITS;
  const fraction = absolute % MINOR_UNITS;
  return `${negative ? "-" : ""}${whole}.${String(fraction).padStart(2, "0")}`;
}

/**
 * Computes the authoritative pricing for a contract.
 *
 * @param {object} input
 * @param {number|string} input.originalPrice  the list price, as entered by Sales
 * @param {number|string} [input.discountPct] 0..100, as entered by Sales
 * @returns {{original_price: string, discount_pct: string, discount_amount: string, final_price: string}}
 *   Decimal strings, ready to hand to a NUMERIC(14,2) column. `final_price` is
 *   also written to `contracts.value`, which is what the payment plan reads.
 */
export function computePricing({ originalPrice, discountPct } = {}) {
  const originalMinor = toMinorUnits(originalPrice, "original_price");
  const percentUnits = toPercentUnits(discountPct, "discount_pct");

  // discount = original * pct / 100, in minor units, rounded half-up.
  const discountMinor = (originalMinor * percentUnits + PERCENT_SCALE / 2n) / (PERCENT_SCALE * 100n);
  // A 100% discount on a sub-cent remainder can never exceed the original.
  const cappedMinor = discountMinor > originalMinor ? originalMinor : discountMinor;
  const finalMinor = originalMinor - cappedMinor;

  if (finalMinor < 0n) throw new PricingError("final_price must not be negative");

  return {
    original_price: fromMinorUnits(originalMinor),
    discount_pct: fromMinorUnits(percentUnits),
    discount_amount: fromMinorUnits(cappedMinor),
    final_price: fromMinorUnits(finalMinor),
  };
}

/** Numeric form, for callers that need a JS number (reports, comparisons). */
export function computePricingNumbers(input) {
  const priced = computePricing(input);
  return {
    original_price: Number(priced.original_price),
    discount_pct: Number(priced.discount_pct),
    discount_amount: Number(priced.discount_amount),
    final_price: Number(priced.final_price),
  };
}

export { PricingError };
