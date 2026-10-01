// ---------------------------------------------------------------------------
// A property's status, per category.
//
// A property can be offered for sale, for rent, or both. Each category has its
// own state, so one can close without the other:
//
//   sale_status   available | reserved | sold     (when offered for sale)
//   rent_status   available | reserved | rented   (when offered for rent)
//
// The single `status` column (available / reserved / sold / leased) is kept
// as the OVERALL state, derived from the two, because reports, filters and
// contracts read it:
//   * every offered category closed -> sold (if the sale closed) or leased
//   * any offered category available -> available
//   * otherwise                       -> reserved
// A property offered for neither keeps the status it was given.
// ---------------------------------------------------------------------------

export const SALE_STATUSES = new Set(["available", "reserved", "sold"]);
export const RENT_STATUSES = new Set(["available", "reserved", "rented"]);

/** The overall status for a property's offers and per-category states. */
export function overallStatus({ offer_buy, offer_rent, sale_status, rent_status }, fallback = "available") {
  const sale = offer_buy ? sale_status || "available" : null;
  const rent = offer_rent ? rent_status || "available" : null;
  const states = [sale, rent].filter(Boolean);
  if (!states.length) return fallback;
  const closed = (state) => state === "sold" || state === "rented";
  if (states.every(closed)) return sale === "sold" ? "sold" : "leased";
  if (states.includes("available")) return "available";
  return "reserved";
}

/** An overall status set by hand (edit form, older clients) -> per category. */
export function categoryStatusesFrom(status, current = {}) {
  switch (status) {
    case "sold": return { sale_status: "sold", rent_status: current.rent_status || "available" };
    case "leased": return { sale_status: current.sale_status || "available", rent_status: "rented" };
    case "reserved": return { sale_status: "reserved", rent_status: "reserved" };
    default: return { sale_status: "available", rent_status: "available" };
  }
}
