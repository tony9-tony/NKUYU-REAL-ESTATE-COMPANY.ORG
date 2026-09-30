// ---------------------------------------------------------------------------
// Public website API — read-only, no login.
//
//   Sales Officer → Internal MKUYU System → this API → public website
//
// Returns ONLY what the Sales Officer has published (`public_listing`), and
// only the fields a visitor may see. Never owners, clients, contracts, money
// owed, staff, internal notes or record-sharing data. The public website's
// contract for these endpoints is documented in mkuyu_ui/docs/PUBLIC-API.md.
//
// Any origin may read these endpoints (they carry no credentials and expose
// nothing private); see the CORS rule in server.js.
// ---------------------------------------------------------------------------
import { Router } from "express";
import { query, queryOne } from "../db.js";
import { organizationId } from "../org/rbac.js";
import { projectUploadsDir, propertyUploadsDir, resolveStoredFile, storedFileExists } from "../uploads.js";

const router = Router();
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const notFound = (res, what) => res.status(404).json({ error: `${what} not found` });
const MAX_INT4 = 2147483647;
const parseId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= MAX_INT4 ? n : null;
};

// Public vocabulary: the website says "rented", the internal system "leased".
const PUBLIC_STATUS = { available: "available", reserved: "reserved", leased: "rented", sold: "sold" };
const titleCase = (value) => String(value || "").replace(/^\w/, (c) => c.toUpperCase());

function base(req) {
  return `${req.protocol}://${req.get("host")}/api/v1/public`;
}

/** Published pictures for many records at once, as absolute public URLs. */
async function photosFor(req, table, column, dir, ids, kind) {
  if (!ids.length) return new Map();
  const rows = (await query(`SELECT id, ${column} AS owner, stored_name, original_filename FROM ${table} WHERE ${column} = ANY($1::int[]) ORDER BY id`, [ids])).rows;
  const map = new Map();
  for (const row of rows) {
    if (!storedFileExists(dir, row.stored_name)) continue;
    if (!map.has(row.owner)) map.set(row.owner, []);
    map.get(row.owner).push({ url: `${base(req)}/${kind}/${row.owner}/images/${row.id}`, alt: "" });
  }
  return map;
}

function serviceList(row) {
  return [row.offer_rent ? "rent" : null, row.offer_buy ? "buy" : null].filter(Boolean);
}

function toPublicProperty(row, photos) {
  const services = serviceList(row);
  return {
    id: row.id,
    slug: String(row.id),
    title: row.name,
    type: titleCase(row.property_type),
    services,
    status: PUBLIC_STATUS[row.status] || "available",
    currency: "TZS",
    price: {
      sale: row.offer_buy ? Number(row.price) || 0 : 0,
      rent: row.offer_rent && Number(row.rent_price) > 0 ? { amount: Number(row.rent_price), period: row.rent_period || "month" } : null,
    },
    location: row.location,
    project: row.project_id && row.project_public ? { slug: String(row.project_id), name: row.project_name } : null,
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

const propertySelect = `SELECT p.id, p.name, p.property_type, p.status, p.price, p.rent_price, p.rent_period,
    p.offer_rent, p.offer_buy, p.location, p.area, p.bedrooms, p.bathrooms, p.description, p.summary,
    p.features, p.featured, p.project_id, pr.name AS project_name, pr.public_listing AS project_public
  FROM properties p LEFT JOIN projects pr ON pr.id = p.project_id`;

// Listings: published, offered for at least one service, and not yet sold or
// rented (a sold or rented home leaves the listings by itself).
router.get("/properties", route(async (req, res) => {
  const service = req.query.service;
  if (service !== undefined && !["rent", "buy"].includes(service)) return res.status(400).json({ error: "service must be rent or buy" });
  const conditions = ["p.organization_id = $1", "p.public_listing", "(p.offer_rent OR p.offer_buy)", "p.status IN ('available','reserved')"];
  if (service === "rent") conditions.push("p.offer_rent");
  if (service === "buy") conditions.push("p.offer_buy");
  const rows = (await query(`${propertySelect} WHERE ${conditions.join(" AND ")} ORDER BY p.featured DESC, p.created_at DESC, p.id DESC`, [await organizationId()])).rows;
  const photos = await photosFor(req, "property_images", "property_id", propertyUploadsDir, rows.map((r) => r.id), "properties");
  res.set("Cache-Control", "public, max-age=60");
  res.json(rows.map((row) => toPublicProperty(row, photos)));
}));

// One property, whatever its status, so an old link can say "sold".
router.get("/properties/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res, "Property");
  const row = await queryOne(`${propertySelect} WHERE p.id = $1 AND p.organization_id = $2 AND p.public_listing`, [id, await organizationId()]);
  if (!row) return notFound(res, "Property");
  const photos = await photosFor(req, "property_images", "property_id", propertyUploadsDir, [row.id], "properties");
  res.set("Cache-Control", "public, max-age=60");
  res.json(toPublicProperty(row, photos));
}));

router.get("/projects", route(async (req, res) => {
  const service = req.query.service;
  if (service !== undefined && !["rent", "buy"].includes(service)) return res.status(400).json({ error: "service must be rent or buy" });
  const conditions = ["organization_id = $1", "public_listing", "(offer_rent OR offer_buy)", "status = 'active'"];
  if (service === "rent") conditions.push("offer_rent");
  if (service === "buy") conditions.push("offer_buy");
  const rows = (await query(`SELECT id, name, location, summary, offer_rent, offer_buy FROM projects WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, id DESC`, [await organizationId()])).rows;
  const photos = await photosFor(req, "project_images", "project_id", projectUploadsDir, rows.map((r) => r.id), "projects");
  res.set("Cache-Control", "public, max-age=60");
  res.json(rows.map((row) => ({
    slug: String(row.id),
    name: row.name,
    location: row.location || "",
    summary: row.summary || "",
    status: "",
    services: serviceList(row),
    photos: (photos.get(row.id) || []).map((photo) => ({ ...photo, alt: row.name })),
  })));
}));

/** A picture is public only while its property/project is published. */
function servePicture(kind) {
  const table = kind === "properties" ? "property_images" : "project_images";
  const owner = kind === "properties" ? "properties" : "projects";
  const column = kind === "properties" ? "property_id" : "project_id";
  const dir = kind === "properties" ? propertyUploadsDir : projectUploadsDir;
  return route(async (req, res) => {
    const id = parseId(req.params.id);
    const imageId = parseId(req.params.imageId);
    if (!id || !imageId) return notFound(res, "Picture");
    const image = await queryOne(
      `SELECT i.stored_name, i.mime_type FROM ${table} i JOIN ${owner} o ON o.id = i.${column}
        WHERE i.id = $1 AND i.${column} = $2 AND o.organization_id = $3 AND o.public_listing`,
      [imageId, id, await organizationId()],
    );
    const fullPath = image && resolveStoredFile(dir, image.stored_name);
    if (!fullPath) return notFound(res, "Picture");
    res.set("Content-Type", image.mime_type || "application/octet-stream");
    res.set("Cache-Control", "public, max-age=3600");
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    return res.sendFile(fullPath);
  });
}
router.get("/properties/:id/images/:imageId", servePicture("properties"));
router.get("/projects/:id/images/:imageId", servePicture("projects"));

// Website enquiries are not built yet. Answer honestly instead of a generic
// 404, so the website can say so. (Customer accounts are switched off on the
// website side until they exist; see CUSTOMER_ACCOUNTS in its config.js.)
router.all("/enquiries", (req, res) => res.status(501).json({ error: "Online enquiries are not available yet. Please contact MKUYU directly." }));

export default router;
