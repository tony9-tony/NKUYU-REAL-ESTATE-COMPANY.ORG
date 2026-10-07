// ---------------------------------------------------------------------------
// MKUYU owner selling: the steps between "an owner wants to sell" and "sold".
//
// One owner listing per seller property. The Property Officer runs the owner
// side (visit, valuation, mandate terms, offers, weekly updates); Legal checks
// the title and documents; the Managing Director signs every sell mandate.
// Same shape as tasks/workflow.js: a controlled stage list, the allowed edges,
// and the actions a caller may take. Every action is re-checked server-side.
// ---------------------------------------------------------------------------

/** Stages in order. Withdrawn can be reached from any active stage. */
export const OWNER_LISTING_STAGES = [
  "received",
  "visit_booked",
  "valued",
  "documents_checked",
  "mandate_signed",
  "listed",
  "under_offer",
  "sold",
  "withdrawn",
];

export const OWNER_LISTING_STAGE_LABELS = {
  received: "Received",
  visit_booked: "Visit booked",
  valued: "Valued",
  documents_checked: "Documents checked",
  mandate_signed: "Mandate signed",
  listed: "Listed",
  under_offer: "Under offer",
  sold: "Sold",
  withdrawn: "Withdrawn",
};

/** Stages where the owner is still waiting on MKUYU: they need a weekly update. */
export const ACTIVE_OWNER_LISTING_STAGES = OWNER_LISTING_STAGES.filter((stage) => !["sold", "withdrawn"].includes(stage));

/**
 * Allowed stage edges. No step can be skipped: Legal checks the documents
 * before a mandate, and the MD's signature is what moves a listing to
 * "Mandate signed". "Under offer" only follows an accepted offer, and goes
 * back to "Listed" if that buyer falls away.
 */
export const OWNER_LISTING_TRANSITIONS = {
  received: ["visit_booked", "withdrawn"],
  visit_booked: ["valued", "withdrawn"],
  valued: ["documents_checked", "withdrawn"],
  documents_checked: ["mandate_signed", "withdrawn"],
  mandate_signed: ["listed", "withdrawn"],
  listed: ["under_offer", "withdrawn"],
  under_offer: ["sold", "listed", "withdrawn"],
  sold: [],
  withdrawn: [],
};

/** Mandate approval state, kept beside the stage while the MD decides. */
export const MANDATE_STATUSES = ["none", "awaiting_md", "returned", "signed"];

/** An owner's answer to an offer presented to them in writing. */
export const OFFER_DECISIONS = ["accepted", "rejected", "countered"];

/** How a weekly update reached the owner. */
export const UPDATE_CHANNELS = ["phone", "whatsapp", "sms", "email", "visit", "letter"];

/** Days without an update before a listing is overdue. */
export const OWNER_UPDATE_DAYS = 7;

/** Standard commission rate (percent), stored as an organization setting. */
export const STANDARD_COMMISSION_SETTING = "owner_listing_standard_commission";
export const DEFAULT_STANDARD_COMMISSION = 3;

/** Audit actions written to the existing audit_logs table (module "owner_listing"). */
export const OWNER_LISTING_AUDIT_ACTIONS = new Set([
  "owner_listing_created",
  "owner_listing_officer_set",
  "owner_listing_visit_booked",
  "owner_listing_valued",
  "owner_listing_documents_checked",
  "owner_listing_mandate_agreed",
  "owner_listing_mandate_signed",
  "owner_listing_mandate_returned",
  "owner_listing_listed",
  "owner_listing_offer_recorded",
  "owner_listing_offer_presented",
  "owner_listing_offer_decided",
  "owner_listing_back_to_market",
  "owner_listing_sold",
  "owner_listing_withdrawn",
  "owner_listing_update_logged",
  "owner_listing_commission_setting",
]);

export function isOwnerListingStage(value) {
  return OWNER_LISTING_STAGES.includes(String(value || "").toLowerCase());
}

/** Whether the stage list permits moving from one stage to another. */
export function canMoveListing(from, to) {
  return (OWNER_LISTING_TRANSITIONS[String(from || "").toLowerCase()] || []).includes(String(to || "").toLowerCase());
}

export function isActiveStage(stage) {
  return ACTIVE_OWNER_LISTING_STAGES.includes(String(stage || "").toLowerCase());
}

/** A commission below the standard rate is a discount the MD sees when signing. */
export function commissionBelowStandard(commission, standard = DEFAULT_STANDARD_COMMISSION) {
  return Number(commission) < Number(standard);
}

/**
 * Days since the owner last heard from MKUYU. A listing with no update yet
 * counts from the day it was received.
 */
export function daysSinceUpdate(listing, now = new Date()) {
  const from = listing?.last_update_at || listing?.created_at;
  if (!from) return null;
  const then = new Date(from);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 86400000));
}

/** Active listing, no update for OWNER_UPDATE_DAYS days or more. */
export function isUpdateOverdue(listing, now = new Date()) {
  if (!isActiveStage(listing?.stage)) return false;
  const days = daysSinceUpdate(listing, now);
  return days !== null && days >= OWNER_UPDATE_DAYS;
}

/**
 * Actions the caller may take on a listing right now. A display hint for the
 * screen only: every action is re-authorized by the route before it runs.
 *
 *   canManage - holds run_owner_listings (Property Officer, Sales manager, MD)
 *   canCheck  - holds check_owner_documents (Legal Officer)
 *   canSign   - holds sign_sell_mandate (Managing Director)
 */
export function listingActionsFor(listing, userId, { canManage = false, canCheck = false, canSign = false, hasAcceptedOffer = false } = {}) {
  const me = Number(userId);
  const stage = String(listing?.stage || "").toLowerCase();
  const mandate = String(listing?.mandate_status || "none");
  const actions = [];
  if (!isActiveStage(stage)) return actions;
  if (canManage) {
    actions.push("set_officer");
    if (stage === "received" || stage === "visit_booked") actions.push("book_visit");
    if (stage === "visit_booked") actions.push("record_valuation");
    if (stage === "documents_checked" && (mandate === "none" || mandate === "returned")) actions.push("agree_mandate");
    if (stage === "mandate_signed") actions.push("mark_listed");
    if (stage === "listed" || stage === "under_offer") actions.push("record_offer");
    if (stage === "under_offer" && hasAcceptedOffer) actions.push("mark_sold");
    if (stage === "under_offer") actions.push("back_to_market");
    actions.push("log_update", "withdraw");
  }
  // Legal only: the Property Officer can never mark the documents checked.
  if (canCheck && stage === "valued") actions.push("check_documents");
  // The MD signs every mandate, but never one they agreed themselves.
  if (canSign && stage === "documents_checked" && mandate === "awaiting_md" && Number(listing?.mandate_agreed_by) !== me) {
    actions.push("sign_mandate", "return_mandate");
  }
  if (canSign && !canManage) actions.push("withdraw");
  return [...new Set(actions)];
}

/** Actions on one offer: present it to the owner in writing, then record their answer. */
export function offerActionsFor(offer, listing, { canManage = false, anotherAccepted = false } = {}) {
  if (!canManage || !["listed", "under_offer"].includes(String(listing?.stage || ""))) return [];
  if (offer?.decision) return [];
  if (!offer?.presented_at) return ["present_offer"];
  return anotherAccepted ? ["decide_reject", "decide_counter"] : ["decide_accept", "decide_reject", "decide_counter"];
}
