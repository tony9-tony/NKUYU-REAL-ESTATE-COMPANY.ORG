// ---------------------------------------------------------------------------
// Owner listing endpoints, mounted under /org/owner-listings.
// Every write re-checks the caller's permission and the listing's stage on the
// server; the screen only shows the actions this file says are allowed.
//   run_owner_listings - Property Officer (Sales Department Manager, MD)
//   check_owner_documents - Legal Officer
//   sign_sell_mandate     - Managing Director
// ---------------------------------------------------------------------------
import { Router } from "express";
import { query, queryOne, withTransaction } from "../db.js";
import { can, organizationId } from "../org/rbac.js";
import { audit } from "../org/audit.js";
import {
  OFFER_DECISIONS, OWNER_LISTING_STAGES, OWNER_LISTING_STAGE_LABELS, UPDATE_CHANNELS,
  STANDARD_COMMISSION_SETTING, canMoveListing, commissionBelowStandard, isActiveStage, listingActionsFor, offerActionsFor,
} from "../sales/ownerListing.js";
import { LISTING_SELECT, OVERDUE_SQL, closeOverdueReminder, getListing, listingSummary, standardCommission } from "../sales/ownerListingStore.js";

const router = Router();
const MAX_INT4 = 2147483647;
const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };
const id = (value, field = "id") => { const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > MAX_INT4) fail(`${field} must be a positive integer`); return n; };
const text = (value, field, max = 160) => { if (typeof value !== "string" || !value.trim() || value.trim().length > max) fail(`${field} is required`); return value.trim(); };
const maybeText = (value, field, max = 2000) => { if (value === undefined || value === null || value === "") return null; if (typeof value !== "string" || value.trim().length > max) fail(`${field} is invalid`); return value.trim(); };
const amount = (value, field) => { const n = Number(value); if (value === "" || value === null || value === undefined || !Number.isFinite(n) || n <= 0 || n > 1e13) fail(`${field} must be an amount in TZS`); return Math.round(n * 100) / 100; };
const maybeAmount = (value, field) => (value === undefined || value === null || value === "" ? null : amount(value, field));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
/** A calendar date (YYYY-MM-DD). `past` refuses a date after today. */
const date = (value, field, { past = false, future = false } = {}) => {
  const raw = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(new Date(`${raw}T00:00:00`).getTime())) fail(`${field} must be a date`);
  if (past && raw > today()) fail(`${field} cannot be in the future`);
  if (future && raw <= today()) fail(`${field} must be after today`);
  return raw;
};
const dateOrToday = (value, field) => (value === undefined || value === null || value === "" ? today() : date(value, field, { past: true }));
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

const mayManage = (req) => can(req.access, "run_owner_listings");
const mayCheck = (req) => can(req.access, "check_owner_documents");
const maySign = (req) => can(req.access, "sign_sell_mandate");
const mayView = (req) => mayManage(req) || mayCheck(req) || maySign(req);
const refuse = (res, error) => res.status(403).json({ error });

// Seeing owner listings at all needs one of the three duties.
router.use((req, res, next) => (mayView(req) ? next() : refuse(res, "owner listings are for the Property Officer, Legal and the Managing Director")));

function decorate(listing, req, standard) {
  if (!listing) return listing;
  const below = listing.commission_percent === null || listing.commission_percent === undefined ? null : commissionBelowStandard(listing.commission_percent, listing.standard_commission ?? standard);
  return {
    ...listing,
    stage_label: OWNER_LISTING_STAGE_LABELS[listing.stage] || listing.stage,
    commission_below_standard: below,
    available_actions: listingActionsFor(listing, req.user.id, { canManage: mayManage(req), canCheck: mayCheck(req), canSign: maySign(req), hasAcceptedOffer: listing.has_accepted_offer }),
  };
}

async function writeAudit(req, action, listing, details = {}) {
  await audit(req, action, "owner_listing", listing.id, { stage: listing.stage, ...details });
}

/**
 * Runs one step on a locked listing row. `check` refuses with a message when
 * the step is not allowed now; `apply` returns { sql, values } for the update.
 */
async function step(listingId, check, apply) {
  return withTransaction(async (client) => {
    const row = (await client.query("SELECT * FROM owner_listings WHERE id=$1 AND organization_id=$2 FOR UPDATE", [listingId, await organizationId()])).rows[0];
    if (!row) fail("owner listing not found", 404);
    const problem = await check(row, client);
    if (problem) fail(problem, 409);
    const result = await apply(row, client);
    return { before: row, result };
  });
}

/** Moves the stage, refusing any edge the stage list does not allow. */
const move = (row, to) => (canMoveListing(row.stage, to) ? null : `This listing is "${OWNER_LISTING_STAGE_LABELS[row.stage]}"; it cannot move to "${OWNER_LISTING_STAGE_LABELS[to]}" yet.`);

async function respond(req, res, listingId, status = 200) {
  const listing = await getListing(listingId);
  res.status(status).json(decorate(listing, req, await standardCommission()));
}

// ---- Reading -----------------------------------------------------------------

router.get("/summary", route(async (req, res) => {
  res.json(await listingSummary(req.user.id));
}));

router.get("/settings", route(async (req, res) => {
  res.json({ standard_commission: await standardCommission(), stages: OWNER_LISTING_STAGES.map((key) => ({ key, label: OWNER_LISTING_STAGE_LABELS[key] })), update_channels: UPDATE_CHANNELS });
}));

// The standard commission rate is the MD's to set. Audited like every setting.
router.put("/settings", route(async (req, res) => {
  if (!maySign(req)) return refuse(res, "only the Managing Director sets the standard commission rate");
  const value = Number(req.body?.standard_commission);
  if (!Number.isFinite(value) || value <= 0 || value > 20) fail("standard_commission must be a percent between 0 and 20");
  const before = await standardCommission();
  await query("INSERT INTO settings(organization_id,setting_key,setting_value) VALUES($1,$2,$3) ON CONFLICT(organization_id,setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value", [await organizationId(), STANDARD_COMMISSION_SETTING, String(value)]);
  await audit(req, "owner_listing_commission_setting", "owner_listing", null, { from: before, to: value });
  res.json({ standard_commission: value });
}));

// People who may run owner listings, for "Give to a Property Officer".
router.get("/officers", route(async (req, res) => {
  res.json((await query(
    `SELECT DISTINCT u.id, u.display_name FROM users u
       JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id AND r.active
       JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id
      WHERE u.organization_id=$1 AND u.active AND u.role <> 'admin' AND p.permission_key='run_owner_listings'
      ORDER BY u.display_name LIMIT 200`, [await organizationId()])).rows);
}));

router.get("/", route(async (req, res) => {
  const values = [await organizationId()];
  const where = ["o.organization_id=$1"];
  if (req.query.stage) {
    if (!OWNER_LISTING_STAGES.includes(String(req.query.stage))) fail("stage is invalid");
    values.push(String(req.query.stage));
    where.push(`o.stage=$${values.length}`);
  }
  if (req.query.overdue === "1") where.push(OVERDUE_SQL);
  if (req.query.mine === "1") { values.push(req.user.id); where.push(`o.officer_id=$${values.length}`); }
  if (req.query.active === "1") where.push("o.stage NOT IN ('sold','withdrawn')");
  const rows = (await query(`${LISTING_SELECT} WHERE ${where.join(" AND ")} ORDER BY (${OVERDUE_SQL}) DESC, o.updated_at DESC, o.id DESC LIMIT 500`, values)).rows;
  const standard = await standardCommission();
  res.json(rows.map((row) => decorate(row, req, standard)));
}));

router.get("/:id", route(async (req, res) => {
  const listingId = id(req.params.id, "listing_id");
  const listing = await getListing(listingId);
  if (!listing) return res.status(404).json({ error: "owner listing not found" });
  const offers = (await query(
    `SELECT f.*, ru.display_name AS recorded_by_name, pu.display_name AS presented_by_name, du.display_name AS decision_recorded_by_name
       FROM owner_listing_offers f
       LEFT JOIN users ru ON ru.id=f.recorded_by LEFT JOIN users pu ON pu.id=f.presented_by LEFT JOIN users du ON du.id=f.decision_recorded_by
      WHERE f.listing_id=$1 ORDER BY f.created_at, f.id`, [listingId])).rows;
  const updates = (await query(
    "SELECT w.*, u.display_name AS recorded_by_name FROM owner_listing_updates w LEFT JOIN users u ON u.id=w.recorded_by WHERE w.listing_id=$1 ORDER BY w.sent_on DESC, w.id DESC", [listingId])).rows;
  const history = (await query(
    "SELECT a.action, a.created_at, a.details_json, u.display_name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.organization_id=$1 AND a.module='owner_listing' AND a.record_id=$2 ORDER BY a.created_at DESC, a.id DESC LIMIT 100",
    [await organizationId(), String(listingId)])).rows;
  const anotherAccepted = (offer) => offers.some((other) => other.id !== offer.id && other.decision === "accepted" && !other.fell_through_at);
  res.json({
    ...decorate(listing, req, await standardCommission()),
    offers: offers.map((offer) => ({ ...offer, available_actions: offerActionsFor(offer, listing, { canManage: mayManage(req), anotherAccepted: anotherAccepted(offer) }) })),
    updates,
    history,
  });
}));

// ---- Owner side (Property Officer) -------------------------------------------

/** The officer must be someone who may run owner listings. */
async function assertOfficer(userId) {
  const ok = await queryOne(
    `SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id AND r.active
       JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id
      WHERE u.id=$1 AND u.organization_id=$2 AND u.active AND u.role <> 'admin' AND p.permission_key='run_owner_listings' LIMIT 1`, [userId, await organizationId()]);
  if (!ok) fail("choose a Property Officer (someone who runs owner listings)");
  return userId;
}

// A walk-in owner, or a seller client MKUYU already has.
router.post("/", route(async (req, res) => {
  if (!mayManage(req)) return refuse(res, "only the Property Officer (or the Sales manager or MD) opens an owner listing");
  const body = req.body || {};
  const org = await organizationId();
  let client = null;
  if (body.client_id !== undefined && body.client_id !== null && body.client_id !== "") {
    client = await queryOne("SELECT id, name, phone, email FROM clients WHERE id=$1 AND organization_id=$2", [id(body.client_id, "client_id"), org]);
    if (!client) return res.status(404).json({ error: "client not found" });
  }
  const ownerName = client ? client.name : text(body.owner_name, "owner_name");
  const ownerPhone = maybeText(body.owner_phone, "owner_phone", 40) ?? client?.phone ?? null;
  if (!ownerPhone && !client?.email && !maybeText(body.owner_email, "owner_email", 160)) fail("add the owner's phone number or email, so they can get their weekly update");
  const officer = body.officer_id ? await assertOfficer(id(body.officer_id, "officer_id")) : (can(req.access, "sign_sell_mandate") ? null : req.user.id);
  const created = await queryOne(
    `INSERT INTO owner_listings (organization_id, client_id, owner_name, owner_phone, owner_email, property_type, location, asking_price, description, officer_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [org, client?.id ?? null, ownerName, ownerPhone, maybeText(body.owner_email, "owner_email", 160) ?? client?.email ?? null,
      maybeText(body.property_type, "property_type", 60), text(body.location, "location", 160), maybeAmount(body.asking_price, "asking_price"),
      maybeText(body.description, "description"), officer, req.user.id],
  );
  await writeAudit(req, "owner_listing_created", created, { officer_id: officer, client_id: created.client_id });
  await respond(req, res, created.id, 201);
}));

router.post("/:id/officer", route(async (req, res) => {
  if (!mayManage(req)) return refuse(res, "only owner-listing staff can give a listing to a Property Officer");
  const officer = await assertOfficer(id(req.body?.officer_id, "officer_id"));
  const { before } = await step(id(req.params.id, "listing_id"),
    (row) => (isActiveStage(row.stage) ? null : "This listing is closed."),
    (row, client) => client.query("UPDATE owner_listings SET officer_id=$2, updated_at=NOW() WHERE id=$1", [row.id, officer]));
  await writeAudit(req, "owner_listing_officer_set", before, { from: before.officer_id, to: officer });
  await respond(req, res, before.id);
}));

router.post("/:id/visit", route(async (req, res) => {
  if (!mayManage(req)) return refuse(res, "only the Property Officer books the valuation visit");
  const when = new Date(String(req.body?.visit_at || ""));
  if (Number.isNaN(when.getTime())) fail("visit_at must be a date and time");
  const { before } = await step(id(req.params.id, "listing_id"),
    (row) => (row.stage === "visit_booked" ? null : move(row, "visit_booked")),
    (row, client) => client.query("UPDATE owner_listings SET stage='visit_booked', visit_at=$2, officer_id=COALESCE(officer_id,$3), updated_at=NOW() WHERE id=$1", [row.id, when.toISOString(), mayManage(req) && !maySign(req) ? req.user.id : null]));
  await writeAudit(req, "owner_listing_visit_booked", { ...before, stage: "visit_booked" }, { from: before.stage, visit_at: when.toISOString() });
  await respond(req, res, before.id);
}));

// Valuation: the visit happened; a suggested price range and a written note.
router.post("/:id/valuation", route(async (req, res) => {
  if (!mayManage(req)) return refuse(res, "only the Property Officer values the property");
  const body = req.body || {};
  const low = amount(body.price_low, "price_low");
  const high = amount(body.price_high, "price_high");
  if (high < low) fail("the high price must not be below the low price");
  const note = text(body.note, "note", 4000);
  const visited = body.visit_date ? date(body.visit_date, "visit_date", { past: true }) : null;
  const { before } = await step(id(req.params.id, "listing_id"),
    (row) => move(row, "valued") || (!row.visit_at && !visited ? "Record the visit date first." : null),
    (row, client) => client.query(
      `UPDATE owner_listings SET stage='valued', visit_at=COALESCE($2::date::timestamptz, visit_at), price_low=$3, price_high=$4, valuation_note=$5,
         valued_by=$6, valued_at=NOW(), updated_at=NOW() WHERE id=$1`, [row.id, visited, low, high, note, req.user.id]));
  await writeAudit(req, "owner_listing_valued", { ...before, stage: "valued" }, { from: before.stage, price_low: low, price_high: high });
  await respond(req, res, before.id);
}));

// ---- Legal -------------------------------------------------------------------

// Title and documents: Legal only. The Property Officer can never mark this.
router.post("/:id/documents", route(async (req, res) => {
  if (!mayCheck(req)) return refuse(res, "only Legal checks the owner's title and documents");
  const body = req.body || {};
  const deed = text(body.title_deed_number, "title_deed_number", 80);
  const identity = body.owner_identity_confirmed === true;
  const authority = body.owner_authority_confirmed === true;
  if (!identity || !authority) fail("Confirm the owner's identity and their authority to sell before marking the documents checked. If something is wrong, write it in the note and tell the Property Officer.");
  const { before } = await step(id(req.params.id, "listing_id"),
    (row) => move(row, "documents_checked"),
    (row, client) => client.query(
      `UPDATE owner_listings SET stage='documents_checked', title_deed_number=$2, owner_identity_confirmed=TRUE, owner_authority_confirmed=TRUE,
         documents_note=$3, documents_checked_by=$4, documents_checked_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [row.id, deed, maybeText(body.note, "note"), req.user.id]));
  await writeAudit(req, "owner_listing_documents_checked", { ...before, stage: "documents_checked" }, { from: before.stage, title_deed_number: deed });
  await respond(req, res, before.id);
}));

// ---- Sell mandate --------------------------------------------------------------

// The Property Officer agrees the terms with the owner; it waits for the MD.
router.post("/:id/mandate", route(async (req, res) => {
  if (!mayManage(req)) return refuse(res, "only the Property Officer agrees the mandate with the owner");
  const body = req.body || {};
  const price = amount(body.mandate_price, "mandate_price");
  const commission = Number(body.commission_percent);
  if (!Number.isFinite(commission) || commission <= 0 || commission > 20) fail("commission_percent must be a percent between 0 and 20");
  const ends = date(body.mandate_end_date, "mandate_end_date", { future: true });
  const standard = await standardCommission();
  const { before } = await step(id(req.params.id, "listing_id"),
    (row) => (row.stage !== "documents_checked" ? "Legal must check the title and documents before the mandate."
      : row.mandate_status === "awaiting_md" ? "This mandate is already waiting for the Managing Director." : null),
    (row, client) => client.query(
      `UPDATE owner_listings SET mandate_status='awaiting_md', mandate_price=$2, commission_percent=$3, standard_commission=$4, mandate_end_date=$5,
         mandate_note=$6, mandate_agreed_by=$7, mandate_agreed_at=NOW(), mandate_signed_by=NULL, mandate_signed_at=NULL, updated_at=NOW() WHERE id=$1`,
      [row.id, price, commission, standard, ends, maybeText(body.note, "note"), req.user.id]));
  await writeAudit(req, "owner_listing_mandate_agreed", before, { mandate_price: price, commission_percent: commission, standard_commission: standard, below_standard: commissionBelowStandard(commission, standard), mandate_end_date: ends });
  await respond(req, res, before.id);
}));

// The MD signs every mandate. Nobody signs a mandate they agreed themselves.
router.post("/:id/mandate/sign", route(async (req, res) => {
  if (!maySign(req)) return refuse(res, "only the Managing Director signs a sell mandate");
  const { before } = await step(id(req.params.id, "listing_id"),
    (row) => (row.mandate_status !== "awaiting_md" ? "There is no mandate waiting for signature."
      : Number(row.mandate_agreed_by) === Number(req.user.id) ? "You agreed this mandate yourself; nobody signs their own mandate." : move(row, "mandate_signed")),
    (row, client) => client.query("UPDATE owner_listings SET stage='mandate_signed', mandate_status='signed', mandate_signed_by=$2, mandate_signed_at=NOW(), updated_at=NOW() WHERE id=$1", [row.id, req.user.id]));
  await writeAudit(req, "owner_listing_mandate_signed", { ...before, stage: "mandate_signed" }, { from: before.stage, commission_percent: Number(before.commission_percent), below_standard: commissionBelowStandard(before.commission_percent, before.standard_commission) });
  await respond(req, res, before.id);
}));

router.post("/:id/mandate/return", route(async (req, res) => {
  if (!maySign(req)) return refuse(res, "only the Managing Director sends a mandate back");
  const reason = text(req.body?.reason, "reason", 2000);
  const { before } = await step(id(req.params.id, "listing_id"),
    (row) => (row.mandate_status !== "awaiting_md" ? "There is no mandate waiting for signature."
      : Number(row.mandate_agreed_by) === Number(req.user.id) ? "You agreed this mandate yourself; another person must decide it." : null),
    (row, client) => client.query("UPDATE owner_listings SET mandate_status='returned', mandate_note=$2, updated_at=NOW() WHERE id=$1", [row.id, `Returned by the MD: ${reason}`]));
  await writeAudit(req, "owner_listing_mandate_returned", before, { reason });
  await respond(req, res, before.id);
}));

router.post("/:id/listed", route(async (req, res) => {
  if (!mayManage(req)) return refuse(res, "only the Property Officer marks the property listed");
  const propertyId = req.body?.property_id ? id(req.body.property_id, "property_id") : null;
  if (propertyId && !await queryOne("SELECT 1 FROM properties WHERE id=$1 AND organization_id=$2", [propertyId, await organizationId()])) return res.status(404).json({ error: "property not found" });
  const { before } = await step(id(req.params.id, "listing_id"),
    (row) => move(row, "listed"),
    (row, client) => client.query("UPDATE owner_listings SET stage='listed', listed_at=NOW(), property_id=COALESCE($2, property_id), updated_at=NOW() WHERE id=$1", [row.id, propertyId]));
  await writeAudit(req, "owner_listing_listed", { ...before, stage: "listed" }, { from: before.stage, property_id: propertyId });
  await respond(req, res, before.id);
}));

// ---- Offers --------------------------------------------------------------------

// Every offer is recorded, however low.
router.post("/:id/offers", route(async (req, res) => {
  if (!mayManage(req)) return refuse(res, "only the Property Officer records offers");
  const body = req.body || {};
  const listingId = id(req.params.id, "listing_id");
  const offerAmount = amount(body.amount, "amount");
  const offeredOn = dateOrToday(body.offered_on, "offered_on");
  const { before, result } = await step(listingId,
    (row) => (["listed", "under_offer"].includes(row.stage) ? null : "Offers are recorded once the property is listed."),
    (row, client) => client.query(
      `INSERT INTO owner_listing_offers (listing_id, buyer_name, buyer_phone, amount, offered_on, conditions, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [row.id, text(body.buyer_name, "buyer_name"), maybeText(body.buyer_phone, "buyer_phone", 40), offerAmount, offeredOn, maybeText(body.conditions, "conditions"), req.user.id]));
  await writeAudit(req, "owner_listing_offer_recorded", before, { offer_id: result.rows[0].id, amount: offerAmount, offered_on: offeredOn });
  await respond(req, res, listingId, 201);
}));

/** Locks the offer with its listing and checks they belong together. */
async function offerStep(req, check, apply) {
  const listingId = id(req.params.id, "listing_id");
  const offerId = id(req.params.offerId, "offer_id");
  return step(listingId, async (row, client) => {
    if (!["listed", "under_offer"].includes(row.stage)) return "This listing is not taking offers.";
    const offer = (await client.query("SELECT * FROM owner_listing_offers WHERE id=$1 AND listing_id=$2 FOR UPDATE", [offerId, row.id])).rows[0];
    if (!offer) fail("offer not found", 404);
    req.offer = offer;
    return check(row, offer, client);
  }, (row, client) => apply(row, req.offer, client));
}

// Presented to the owner IN WRITING: letter, email, WhatsApp or SMS.
router.post("/:id/offers/:offerId/present", route(async (req, res) => {
  if (!mayManage(req)) return refuse(res, "only the Property Officer presents offers to the owner");
  const how = String(req.body?.presented_how || "");
  if (!["letter", "email", "whatsapp", "sms"].includes(how)) fail("Present the offer in writing: letter, email, WhatsApp or SMS.");
  const on = dateOrToday(req.body?.presented_on, "presented_on");
  const { before } = await offerStep(req,
    (row, offer) => (offer.presented_on ? "This offer was already presented to the owner." : null),
    (row, offer, client) => client.query("UPDATE owner_listing_offers SET presented_on=$2, presented_how=$3, presented_by=$4, presented_note=$5 WHERE id=$1", [offer.id, on, how, req.user.id, maybeText(req.body?.note, "note")]));
  await writeAudit(req, "owner_listing_offer_presented", before, { offer_id: req.offer.id, presented_on: on, presented_how: how });
  await respond(req, res, before.id);
}));

// The owner's answer, with its date. Accepting puts the listing "Under offer".
router.post("/:id/offers/:offerId/decision", route(async (req, res) => {
  if (!mayManage(req)) return refuse(res, "only the Property Officer records the owner's decision");
  const body = req.body || {};
  const decision = String(body.decision || "");
  if (!OFFER_DECISIONS.includes(decision)) fail("decision must be accepted, rejected or countered");
  const on = dateOrToday(body.decision_date, "decision_date");
  const counter = decision === "countered" ? amount(body.counter_amount, "counter_amount") : null;
  const { before } = await offerStep(req,
    async (row, offer, client) => {
      if (!offer.presented_on) return "Present the offer to the owner in writing first.";
      if (offer.decision) return "The owner's decision on this offer is already recorded.";
      if (on < String(offer.presented_on).slice(0, 10)) return "The decision date cannot be before the offer was presented.";
      if (decision === "accepted") {
        const other = (await client.query("SELECT 1 FROM owner_listing_offers WHERE listing_id=$1 AND id<>$2 AND decision='accepted' AND fell_through_at IS NULL", [row.id, offer.id])).rows[0];
        if (other) return "The owner already accepted another offer. Put the listing back on the market first if that buyer fell away.";
      }
      return null;
    },
    async (row, offer, client) => {
      await client.query("UPDATE owner_listing_offers SET decision=$2, decision_date=$3, counter_amount=$4, decision_note=$5, decision_recorded_by=$6 WHERE id=$1", [offer.id, decision, on, counter, maybeText(body.note, "note"), req.user.id]);
      if (decision === "accepted" && row.stage === "listed") await client.query("UPDATE owner_listings SET stage='under_offer', updated_at=NOW() WHERE id=$1", [row.id]);
      else await client.query("UPDATE owner_listings SET updated_at=NOW() WHERE id=$1", [row.id]);
    });
  await writeAudit(req, "owner_listing_offer_decided", { ...before, stage: decision === "accepted" ? "under_offer" : before.stage }, { offer_id: req.offer.id, decision, decision_date: on, counter_amount: counter });
  await respond(req, res, before.id);
}));

// The accepted buyer fell away: back to "Listed".
router.post("/:id/back-to-market", route(async (req, res) => {
  if (!mayManage(req)) return refuse(res, "only the Property Officer puts a listing back on the market");
  const reason = text(req.body?.reason, "reason", 2000);
  const { before } = await step(id(req.params.id, "listing_id"),
    (row) => move(row, "listed"),
    async (row, client) => {
      await client.query("UPDATE owner_listing_offers SET fell_through_at=NOW(), fell_through_reason=$2 WHERE listing_id=$1 AND decision='accepted' AND fell_through_at IS NULL", [row.id, reason]);
      await client.query("UPDATE owner_listings SET stage='listed', updated_at=NOW() WHERE id=$1", [row.id]);
    });
  await writeAudit(req, "owner_listing_back_to_market", { ...before, stage: "listed" }, { from: before.stage, reason });
  await respond(req, res, before.id);
}));

router.post("/:id/sold", route(async (req, res) => {
  if (!mayManage(req)) return refuse(res, "only the Property Officer marks the property sold");
  const soldOn = dateOrToday(req.body?.sold_on, "sold_on");
  const { before, result } = await step(id(req.params.id, "listing_id"),
    async (row, client) => {
      const problem = move(row, "sold");
      if (problem) return problem;
      const accepted = (await client.query("SELECT amount FROM owner_listing_offers WHERE listing_id=$1 AND decision='accepted' AND fell_through_at IS NULL LIMIT 1", [row.id])).rows[0];
      return accepted ? null : "A sale needs the owner's accepted offer.";
    },
    async (row, client) => {
      const accepted = (await client.query("SELECT amount FROM owner_listing_offers WHERE listing_id=$1 AND decision='accepted' AND fell_through_at IS NULL LIMIT 1", [row.id])).rows[0];
      const price = maybeAmount(req.body?.sold_price, "sold_price") ?? Number(accepted.amount);
      await client.query("UPDATE owner_listings SET stage='sold', sold_at=$2::date::timestamptz, sold_price=$3, updated_at=NOW() WHERE id=$1", [row.id, soldOn, price]);
      return price;
    });
  await writeAudit(req, "owner_listing_sold", { ...before, stage: "sold" }, { from: before.stage, sold_price: result, sold_on: soldOn });
  await respond(req, res, before.id);
}));

router.post("/:id/withdraw", route(async (req, res) => {
  if (!mayManage(req) && !maySign(req)) return refuse(res, "only the Property Officer or the MD withdraws a listing");
  const reason = text(req.body?.reason, "reason", 2000);
  const { before } = await step(id(req.params.id, "listing_id"),
    (row) => move(row, "withdrawn"),
    (row, client) => client.query("UPDATE owner_listings SET stage='withdrawn', withdrawn_at=NOW(), withdrawn_reason=$2, updated_at=NOW() WHERE id=$1", [row.id, reason]));
  await closeOverdueReminder(before, req.user.id);
  await writeAudit(req, "owner_listing_withdrawn", { ...before, stage: "withdrawn" }, { from: before.stage, reason });
  await respond(req, res, before.id);
}));

// ---- Weekly owner update -----------------------------------------------------------

router.post("/:id/updates", route(async (req, res) => {
  if (!mayManage(req)) return refuse(res, "only the Property Officer logs owner updates");
  const body = req.body || {};
  const channel = String(body.channel || "");
  if (!UPDATE_CHANNELS.includes(channel)) fail(`channel must be one of: ${UPDATE_CHANNELS.join(", ")}`);
  const sentOn = dateOrToday(body.sent_on, "sent_on");
  const note = text(body.note, "note", 4000);
  const { before } = await step(id(req.params.id, "listing_id"),
    (row) => (isActiveStage(row.stage) ? null : "This listing is closed."),
    async (row, client) => {
      await client.query("INSERT INTO owner_listing_updates (listing_id, sent_on, channel, note, recorded_by) VALUES ($1,$2,$3,$4,$5)", [row.id, sentOn, channel, note, req.user.id]);
      // Today's update counts from now; a late entry for an earlier day counts from that day.
      await client.query(
        `UPDATE owner_listings SET last_update_at=GREATEST(COALESCE(last_update_at, '-infinity'::timestamptz), CASE WHEN $2::date = CURRENT_DATE THEN NOW() ELSE $2::date::timestamptz END), updated_at=NOW() WHERE id=$1`,
        [row.id, sentOn]);
    });
  const after = await getListing(before.id);
  if (!after.update_overdue) await closeOverdueReminder(before, req.user.id);
  await writeAudit(req, "owner_listing_update_logged", before, { sent_on: sentOn, channel });
  await respond(req, res, before.id, 201);
}));

export default router;
