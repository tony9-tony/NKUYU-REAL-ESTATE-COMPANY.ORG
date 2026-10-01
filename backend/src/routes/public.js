// ---------------------------------------------------------------------------
// Public website API — no login.
//
//   Sales Officer → Internal MKUYU System → this API → public website
//
// Reads return ONLY what the Sales Officer has published (`public_listing`),
// and only the fields a visitor may see: never owners, clients, contracts,
// money owed, staff, internal notes or record-sharing data.
//
// Writes are limited to what a visitor may send: a Rent/Buy request for a
// published property, or a general enquiry. Both become Leads for the Sales
// team; nothing else in the system can be reached from here.
//
// The public website's contract for these endpoints is documented in
// mkuyu_ui/docs/PUBLIC-API.md. CORS for this path is set in server.js.
// ---------------------------------------------------------------------------
import { Router } from "express";
import { query, queryOne } from "../db.js";
import { organizationId } from "../org/rbac.js";
import { propertyUploadsDir, resolveStoredFile, storedFileExists } from "../uploads.js";

const router = Router();
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const notFound = (res, what) => res.status(404).json({ error: `${what} not found` });
const bad = (res, message) => res.status(400).json({ error: message });
const MAX_INT4 = 2147483647;
const parseId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= MAX_INT4 ? n : null;
};

// Public vocabulary: the website says "rented", the internal system "leased".
const PUBLIC_STATUS = { available: "available", reserved: "reserved", leased: "rented", sold: "sold" };
const titleCase = (value) => String(value || "").replace(/^\w/, (c) => c.toUpperCase());
// Picture links are absolute (the website lives on another origin). When
// PUBLIC_API_URL is configured it is used, so a forged Host header can never
// end up inside a cached public response; otherwise the request's own host is
// used, which is what a local install needs.
const base = (req) => {
  const configured = String(process.env.PUBLIC_API_URL || "").trim().replace(/\/+$/, "");
  if (configured) return `${configured}/api/v1/public`;
  const host = String(req.get("host") || "");
  return /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) ? `${req.protocol}://${host}/api/v1/public` : "/api/v1/public";
};

/* ---------------------------------------------------------------------------
   Reads
   --------------------------------------------------------------------------- */

/** Pictures of published properties, as absolute public URLs. */
async function photosFor(req, ids) {
  if (!ids.length) return new Map();
  const rows = (await query("SELECT id, property_id, stored_name FROM property_images WHERE property_id = ANY($1::int[]) ORDER BY id", [ids])).rows;
  const map = new Map();
  for (const row of rows) {
    if (!storedFileExists(propertyUploadsDir, row.stored_name)) continue;
    if (!map.has(row.property_id)) map.set(row.property_id, []);
    map.get(row.property_id).push({ url: `${base(req)}/properties/${row.property_id}/images/${row.id}`, alt: "" });
  }
  return map;
}

const serviceList = (row) => [row.offer_rent ? "rent" : null, row.offer_buy ? "buy" : null].filter(Boolean);

function toPublicProperty(row, photos) {
  // Per category, so the Buy page can say "Sold" while the Rent page still
  // takes requests (or the other way round).
  const availability = {
    buy: row.offer_buy ? (row.sale_status || "available") : null,
    rent: row.offer_rent ? (row.rent_status === "rented" ? "rented" : row.rent_status || "available") : null,
  };
  return {
    id: row.id,
    slug: String(row.id),
    title: row.name,
    type: titleCase(row.property_type),
    services: serviceList(row),
    status: PUBLIC_STATUS[row.status] || "available",
    availability,
    currency: "TZS",
    price: {
      sale: row.offer_buy ? Number(row.price) || 0 : 0,
      rent: row.offer_rent && Number(row.rent_price) > 0 ? { amount: Number(row.rent_price), period: row.rent_period || "month" } : null,
    },
    location: row.location,
    // A project is a category; the property carries its name.
    project: row.project_id ? { slug: String(row.project_id), name: row.project_name } : null,
    bedrooms: Number(row.bedrooms) || 0,
    bathrooms: Number(row.bathrooms) || 0,
    area: Number(row.area) || 0,
    featured: Boolean(row.featured),
    photos: (photos.get(row.id) || []).map((photo) => ({ ...photo, alt: row.name })),
    summary: row.summary || "",
    description: row.description || "",
    features: String(row.features || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  };
}

const propertySelect = `SELECT p.id, p.name, p.property_type, p.status, p.sale_status, p.rent_status, p.price, p.rent_price, p.rent_period,
    p.offer_rent, p.offer_buy, p.location, p.area, p.bedrooms, p.bathrooms, p.description, p.summary,
    p.features, p.featured, p.project_id, pr.name AS project_name
  FROM properties p LEFT JOIN projects pr ON pr.id = p.project_id`;

// Listed = published and offered for at least one service. Sold and rented
// properties stay listed, marked as such for their category, so visitors see
// what MKUYU has sold and rented; open ones come first.
// Public = the Sales Officer ticked "show on the website" AND the listing is
// approved (both are set together by Property.setListing); either alone is not enough.
const PUBLISHED = "p.public_listing AND p.public_listing_status = 'approved'";
const LISTED = ["p.organization_id = $1", PUBLISHED, "(p.offer_rent OR p.offer_buy)"];
// Projects show while they have homes still open to a visitor.
const OPEN = "p.status IN ('available','reserved')";
const OPEN_FIRST = "CASE WHEN p.status IN ('available','reserved') THEN 0 ELSE 1 END";

function serviceFilter(req, res) {
  const service = req.query.service;
  if (service !== undefined && !["rent", "buy"].includes(service)) { bad(res, "service must be rent or buy"); return false; }
  return service === "rent" ? "p.offer_rent" : service === "buy" ? "p.offer_buy" : null;
}

router.get("/properties", route(async (req, res) => {
  const filter = serviceFilter(req, res);
  if (filter === false) return;
  const conditions = [...LISTED, ...(filter ? [filter] : [])];
  const rows = (await query(`${propertySelect} WHERE ${conditions.join(" AND ")} ORDER BY ${OPEN_FIRST}, p.featured DESC, p.created_at DESC, p.id DESC`, [await organizationId()])).rows;
  const photos = await photosFor(req, rows.map((r) => r.id));
  res.set("Cache-Control", "public, max-age=60");
  res.json(rows.map((row) => toPublicProperty(row, photos)));
}));

// One property, whatever its status, so an old link can say "sold".
router.get("/properties/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res, "Property");
  const row = await queryOne(`${propertySelect} WHERE p.id = $1 AND p.organization_id = $2 AND ${PUBLISHED}`, [id, await organizationId()]);
  if (!row) return notFound(res, "Property");
  const photos = await photosFor(req, [row.id]);
  res.set("Cache-Control", "public, max-age=60");
  res.json(toPublicProperty(row, photos));
}));

// Projects are categories of properties FOR SALE: renting is about a single
// property, so a project never appears on the Rent side. A project shows while
// it has homes for sale on the website, with a cover photo from one of them.
router.get("/projects", route(async (req, res) => {
  const filter = serviceFilter(req, res);
  if (filter === false) return;
  res.set("Cache-Control", "public, max-age=60");
  if (req.query.service === "rent") return res.json([]);
  const conditions = [...LISTED, OPEN, "p.offer_buy", "p.project_id IS NOT NULL", "pr.status = 'active'"];
  const rows = (await query(
    `SELECT pr.id, pr.name, string_agg(DISTINCT p.location, ' · ') AS locations, array_agg(p.id ORDER BY p.featured DESC, p.id) AS property_ids
       FROM properties p JOIN projects pr ON pr.id = p.project_id
      WHERE ${conditions.join(" AND ")}
      GROUP BY pr.id, pr.name ORDER BY pr.name`,
    [await organizationId()],
  )).rows;
  const photos = await photosFor(req, rows.flatMap((r) => r.property_ids));
  res.json(rows.map((row) => {
    const cover = row.property_ids.map((id) => (photos.get(id) || [])[0]).find(Boolean);
    return {
      slug: String(row.id),
      name: row.name,
      location: row.locations || "",
      summary: "",
      status: "",
      services: ["buy"],
      photos: cover ? [{ ...cover, alt: row.name }] : [],
    };
  }));
}));

/** A picture is public only while its property is published. */
router.get("/properties/:id/images/:imageId", route(async (req, res) => {
  const id = parseId(req.params.id);
  const imageId = parseId(req.params.imageId);
  if (!id || !imageId) return notFound(res, "Picture");
  const image = await queryOne(
    `SELECT i.stored_name, i.mime_type FROM property_images i JOIN properties p ON p.id = i.property_id
      WHERE i.id = $1 AND i.property_id = $2 AND p.organization_id = $3 AND ${PUBLISHED}`,
    [imageId, id, await organizationId()],
  );
  const fullPath = image && resolveStoredFile(propertyUploadsDir, image.stored_name);
  if (!fullPath) return notFound(res, "Picture");
  res.set("Content-Type", image.mime_type || "application/octet-stream");
  res.set("Cache-Control", "public, max-age=3600");
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  return res.sendFile(fullPath);
}));

/* ---------------------------------------------------------------------------
   Writes: visitor requests and enquiries → Leads for Sales
   --------------------------------------------------------------------------- */

const CONTACT_METHODS = new Set(["phone", "whatsapp", "email"]);
const PHONE = /^\+?[0-9][0-9\s-]{6,18}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A small in-memory limiter: enough to stop a script flooding the Leads list,
// never noticeable to a real visitor. (Per process; resets on restart.)
const recent = new Map();
function tooMany(keys, limit, windowMs = 60 * 60 * 1000) {
  const now = Date.now();
  let blocked = false;
  for (const key of keys) {
    const hits = (recent.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= limit) blocked = true;
    recent.set(key, hits);
  }
  if (!blocked) for (const key of keys) recent.get(key).push(now);
  if (recent.size > 5000) for (const [key, hits] of recent) if (!hits.some((t) => now - t < windowMs)) recent.delete(key);
  return blocked;
}

/** Validates the visitor's details; returns { value } or { error }. */
function contactDetails(body) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!name || name.length > 80) return { error: "Enter your full name (up to 80 characters)." };
  if (!PHONE.test(phone)) return { error: "Enter a valid phone number." };
  if (email && (email.length > 120 || !EMAIL.test(email))) return { error: "Enter a valid email address, or leave it empty." };
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 1000) : "";
  return { value: { name, phone, email: email || null, message } };
}

/** Bots fill every field; people never see this one. Pretend success. */
const isBot = (body) => typeof body.website === "string" && body.website.trim() !== "";

async function createLead(org, fields) {
  return queryOne(
    `INSERT INTO leads (organization_id, name, email, phone, source, status, notes, budget, service, property_id, preferred_contact)
     VALUES ($1,$2,$3,$4,$5,'new',$6,$7,$8,$9,$10) RETURNING id`,
    [org, fields.name, fields.email, fields.phone, fields.source, fields.notes, fields.budget, fields.service, fields.property_id, fields.preferred_contact],
  );
}

// Rent / Buy request for a published, available property.
router.post("/requests", route(async (req, res) => {
  const body = req.body || {};
  if (isBot(body)) return res.status(201).json({ reference: "W-0" });
  const details = contactDetails(body);
  if (details.error) return bad(res, details.error);
  const service = body.service;
  if (!["rent", "buy"].includes(service)) return bad(res, "Choose whether you want to rent or buy.");
  const budget = Number(body.budget);
  if (!Number.isFinite(budget) || budget <= 0 || budget > 1e13) return bad(res, "Enter your budget in TZS.");
  const preferred = CONTACT_METHODS.has(body.preferred_contact) ? body.preferred_contact : "phone";
  if (preferred === "email" && !details.value.email) return bad(res, "Add your email address, or choose phone or WhatsApp.");
  const propertyId = parseId(body.property);
  const org = await organizationId();
  const property = propertyId && await queryOne(
    "SELECT id, name, status, sale_status, rent_status, offer_rent, offer_buy FROM properties WHERE id = $1 AND organization_id = $2 AND public_listing AND public_listing_status = 'approved'",
    [propertyId, org],
  );
  if (!property) return notFound(res, "Property");
  const offered = service === "rent" ? property.offer_rent : property.offer_buy;
  // Each category is open or closed on its own: a rented house can still be for sale.
  const categoryState = service === "rent" ? property.rent_status : property.sale_status;
  if (!offered || (categoryState || "available") !== "available") return res.status(409).json({ error: `This property is no longer open to ${service === "rent" ? "rent" : "buy"}.` });
  const digits = details.value.phone.replace(/\D/g, "");
  if (tooMany([`phone:${digits}`], 5) || tooMany([`ip:${req.ip}`], 20)) return res.status(429).json({ error: "Too many requests. Please try again later or call MKUYU." });

  const lead = await createLead(org, {
    ...details.value,
    source: "website",
    notes: [`Website request to ${service} "${property.name}".`, details.value.message].filter(Boolean).join("\n\n"),
    budget,
    service,
    property_id: property.id,
    preferred_contact: preferred,
  });
  res.status(201).json({ reference: `W-${lead.id}` });
}));

// Sell: a property owner offers their property to MKUYU. No account and no
// login: it becomes a Sell request for Sales (Requests), who hands it to
// Customer Service to contact the owner. Nothing is published and no client
// is created until MKUYU accepts the seller.
const SELL_TYPES = { house: "House", apartment: "Apartment", villa: "Villa", land: "Land / plot", commercial: "Commercial", other: "Other" };
router.post("/sell", route(async (req, res) => {
  const body = req.body || {};
  if (isBot(body)) return res.status(201).json({ reference: "W-0" });
  const details = contactDetails(body);
  if (details.error) return bad(res, details.error);
  const type = SELL_TYPES[body.property_type] ? body.property_type : null;
  if (!type) return bad(res, "Choose the type of property.");
  const location = typeof body.location === "string" ? body.location.trim() : "";
  if (location.length < 2 || location.length > 120) return bad(res, "Say where the property is (area and town).");
  const numberOrNull = (value, max) => {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 && n <= max ? n : NaN;
  };
  const asking = numberOrNull(body.asking_price, 1e13);
  if (Number.isNaN(asking)) return bad(res, "Enter the asking price in TZS, or leave it empty.");
  const area = numberOrNull(body.area, 1e7);
  if (Number.isNaN(area)) return bad(res, "Enter the size in square metres, or leave it empty.");
  const bedrooms = numberOrNull(body.bedrooms, 50);
  if (Number.isNaN(bedrooms)) return bad(res, "Enter the number of bedrooms, or leave it empty.");
  const titleDeed = ["yes", "no", "in_progress"].includes(body.title_deed) ? body.title_deed : null;
  const preferred = CONTACT_METHODS.has(body.preferred_contact) ? body.preferred_contact : "phone";
  if (preferred === "email" && !details.value.email) return bad(res, "Add your email address, or choose phone or WhatsApp.");
  const digits = details.value.phone.replace(/\D/g, "");
  if (tooMany([`phone:${digits}`], 5) || tooMany([`ip:${req.ip}`], 20)) return res.status(429).json({ error: "Too many submissions. Please try again later or call MKUYU." });

  const sell = { property_type: type, location, asking_price: asking, area, bedrooms: bedrooms === null ? null : Math.round(bedrooms), title_deed: titleDeed };
  const org = await organizationId();
  const lead = await queryOne(
    `INSERT INTO leads (organization_id, name, email, phone, source, status, notes, budget, service, property_id, preferred_contact, sell_details)
     VALUES ($1,$2,$3,$4,'website','new',$5,$6,'sell',NULL,$7,$8::jsonb) RETURNING id`,
    [org, details.value.name, details.value.email, details.value.phone,
     [`Website sell submission: ${SELL_TYPES[type]} in ${location}.`, details.value.message].filter(Boolean).join("\n\n"),
     asking, preferred, JSON.stringify(sell)],
  );
  res.status(201).json({ reference: `W-${lead.id}` });
}));

// General question from the Contact page. It goes straight to Customer
// Service (their department owns it), who answers the visitor and marks it
// answered under Requests. Sales and the MD can still see it.
router.post("/enquiries", route(async (req, res) => {
  const body = req.body || {};
  if (isBot(body)) return res.status(201).json({ reference: "W-0" });
  const details = contactDetails(body);
  if (details.error) return bad(res, details.error);
  if (!details.value.message) return bad(res, "Write your message.");
  const digits = details.value.phone.replace(/\D/g, "");
  if (tooMany([`phone:${digits}`], 5) || tooMany([`ip:${req.ip}`], 20)) return res.status(429).json({ error: "Too many messages. Please try again later or call MKUYU." });
  const topics = { general: "General question", rent: "Renting", buy: "Buying", sell: "Selling a property", diaspora: "Miliki Ardhi Diaspora" };
  const topic = topics[body.topic] || topics.general;
  const budget = Number(body.budget);
  const org = await organizationId();
  const lead = await createLead(org, {
    ...details.value,
    source: "website-contact",
    notes: `Website enquiry · ${topic}\n\n${details.value.message}`,
    budget: Number.isFinite(budget) && budget > 0 && budget <= 1e13 ? budget : null,
    service: ["rent", "buy"].includes(body.topic) ? body.topic : null,
    property_id: null,
    preferred_contact: CONTACT_METHODS.has(body.preferred_contact) ? body.preferred_contact : "phone",
  });
  await query(
    `UPDATE leads SET department_id = (SELECT id FROM departments WHERE organization_id = $2 AND name = 'CUSTOMER SERVICE' LIMIT 1), visibility = 'department'
      WHERE id = $1`,
    [lead.id, org],
  );
  res.status(201).json({ reference: `W-${lead.id}` });
}));

export default router;
