import { query, queryOne } from "../db.js";
import { UNPAGED_LIMIT } from "../pagination.js";
import { organizationId } from "../org/rbac.js";
import { clearRecordShares, currentAccess, isReadOnlyModule, OWNERSHIP_COLUMNS, ownershipValues, scopeCondition } from "../org/access.js";
import { propertyUploadsDir, storedFileExists } from "../uploads.js";

// A gallery row is not proof that its file exists: the row and the artefact are
// stored separately, so a restore, a moved data directory or a cleanup can leave
// the row behind after the file is gone. `image_count` and `cover_image_id` are
// therefore resolved against the filesystem before a caller is told which
// pictures it can actually fetch. This only changes what is REPORTED; no row is
// ever written, hidden or removed here.
async function withAvailableImages(propertyRows) {
  if (!propertyRows) return propertyRows;
  const rows = Array.isArray(propertyRows) ? propertyRows : [propertyRows];
  const withImages = rows.filter((row) => row && row.image_count > 0);
  if (!withImages.length) return propertyRows;

  const galleries = await query(
    "SELECT id, property_id, stored_name FROM property_images WHERE organization_id=$1 AND property_id = ANY($2::int[]) ORDER BY id",
    [await organizationId(), withImages.map((row) => row.id)],
  );
  const byProperty = new Map();
  for (const image of galleries.rows) {
    if (!byProperty.has(image.property_id)) byProperty.set(image.property_id, []);
    byProperty.get(image.property_id).push(image);
  }
  for (const row of withImages) {
    const images = byProperty.get(row.id) || [];
    const available = images.filter((image) => storedFileExists(propertyUploadsDir, image.stored_name));
    // The cover is the first picture that can actually be served, so a property
    // whose lowest-id picture was lost still shows a real one instead of a 404.
    row.cover_image_id = available.length ? available[0].id : null;
    row.image_count = available.length;
    // Surfaces the discrepancy instead of hiding it: the records still exist and
    // an administrator can still act on them.
    row.missing_image_count = images.length - available.length;
  }
  return propertyRows;
}

const propertySelect = `SELECT p.*,pr.name AS project_name,(SELECT COUNT(*)::int FROM property_images pi WHERE pi.property_id=p.id) AS image_count,(SELECT id FROM property_images pi WHERE pi.property_id=p.id ORDER BY pi.id LIMIT 1) AS cover_image_id,pr.kind AS project_kind FROM properties p LEFT JOIN projects pr ON pr.id=p.project_id`;
const clientSelect = "SELECT c.*,pr.name AS project_name FROM clients c LEFT JOIN projects pr ON pr.id=c.project_id";
const appointmentSelect = "SELECT a.*,c.name AS client_name,c.phone AS client_phone,p.name AS property_name,pr.name AS project_name,cb.display_name AS completed_by_name FROM appointments a JOIN clients c ON c.id=a.client_id LEFT JOIN properties p ON p.id=a.property_id LEFT JOIN projects pr ON pr.id=a.project_id LEFT JOIN users cb ON cb.id=a.completed_by";
const documentSelect = "SELECT d.*,c.name AS client_name,co.client_name AS contract_client,pr.name AS project_name,ub.display_name AS uploaded_by_name FROM documents d LEFT JOIN clients c ON c.id=d.client_id LEFT JOIN contracts co ON co.id=d.contract_id LEFT JOIN projects pr ON pr.id=d.project_id LEFT JOIN users ub ON ub.id=COALESCE(d.created_by,d.owner_id)";

async function list(sql, alias, entity, values, conditions, order = "") {
  const access = await currentAccess();
  const all = [await organizationId(), ...values];
  const where = [`${alias}.organization_id=$1`, ...conditions, scopeCondition(alias, entity, access, all, { read: true })];
  return query(`${sql} WHERE ${where.join(" AND ")}${order} LIMIT ${UNPAGED_LIMIT}`, all).then((x) => x.rows);
}

/**
 * Builds a paginated SELECT and its matching COUNT using ONE `where` fragment.
 *
 * The authorization predicate and the caller's filters are built once and used
 * verbatim by both statements. That is deliberate: a count that drifted even
 * slightly from the data query would disclose how many records the caller is
 * not allowed to see, so the two must not be built independently.
 *
 * `table` is the real table name. The count cannot reuse `alias` alone - a
 * single-letter alias is not a relation name in FROM, so `FROM clients c` must
 * be restated for the count query.
 *
 * Ordering is supplied by the caller and must be stable - the unique `id` is
 * appended as a tiebreaker so two records sharing a timestamp cannot swap
 * between pages and make a row appear twice or vanish.
 */
async function buildPaged(sql, table, alias, entity, values, conditions, order, search = null, searchColumns = []) {
  const access = await currentAccess();
  const all = [await organizationId(), ...values];
  const where = [`${alias}.organization_id=$1`, ...conditions, scopeCondition(alias, entity, access, all, { read: true })];
  // Server-side search, applied INSIDE the same scoped statement. The term is
  // bound as a parameter, never interpolated, and it is ANDed with the scope
  // predicate - so search can only ever narrow what the caller may already see,
  // never widen it. Searching here rather than in the browser is what makes the
  // result complete: the browser only ever holds one page.
  if (search && searchColumns.length) {
    all.push(`%${search}%`);
    const placeholder = `$${all.length}`;
    where.push(`(${searchColumns.map((column) => `COALESCE(${column},'') ILIKE ${placeholder}`).join(" OR ")})`);
  }
  const fragment = ` WHERE ${where.join(" AND ")}`;
  return {
    sql: `${sql}${fragment}${order}`,
    countSql: `SELECT COUNT(*)::int AS total FROM ${table} ${alias}${fragment}`,
    values: all,
  };
}

async function get(sql, alias, entity, id, { read = true } = {}) {
  const values = [id, await organizationId()];
  const access = await currentAccess();
  return queryOne(`${sql} WHERE ${alias}.id=$1 AND ${alias}.organization_id=$2 AND ${scopeCondition(alias, entity, access, values, { read })}`, values);
}

/**
 * Sets `can_edit` on appointment rows: true only where the caller's normal
 * record scope reaches (the shared calendar is wider for reading than for
 * writing) and they hold Appointments in full, not the read-only grant.
 */
async function markWritableAppointments(rows) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  if (!list.length) return rows;
  const access = await currentAccess();
  let writable = new Set(list.map((row) => row.id));
  if (access && !access.isAdmin && access.scope !== "organization") {
    if (isReadOnlyModule(access, "appointments")) writable = new Set();
    else {
      const values = [list.map((row) => row.id), await organizationId()];
      const scope = scopeCondition("a", "appointment", access, values);
      writable = new Set((await query(`SELECT a.id FROM appointments a WHERE a.id = ANY($1::int[]) AND a.organization_id=$2 AND ${scope}`, values)).rows.map((row) => row.id));
    }
  }
  for (const row of list) row.can_edit = writable.has(row.id);
  return rows;
}

async function create(sql, values) {
  const access = await currentAccess();
  const all = [await organizationId(), ...values];
  ownershipValues(all, access);
  return queryOne(sql, all);
}

// For tables without ownership metadata (gallery rows, reached through a
// property that the route has already scope-checked).
async function createPlain(sql, values) {
  return queryOne(sql, [await organizationId(), ...values]);
}

async function update(entity, table, id, sql, values) {
  const access = await currentAccess();
  // Bind order: the SET values, then the row id and the organization id, then the
  // scope predicate's own values. The scope predicate APPENDS to this array, so
  // the id/organization placeholders are numbered from `values.length` BEFORE it
  // runs. Numbering them afterwards reused the scope's numbers and Postgres
  // compared an integer id against a text value.
  const all = [...values, id, await organizationId()];
  const alias = table.charAt(0);
  const idParam = values.length + 1;
  const orgParam = values.length + 2;
  const scope = scopeCondition(alias, entity, access, all);
  // The statement must carry the same alias the WHERE clause refers to, or
  // Postgres raises "missing FROM-clause entry for table <alias>".
  const aliased = sql.replace(new RegExp(`^UPDATE\\s+${table}\\s`, "i"), `UPDATE ${table} ${alias} `);
  return query(`${aliased} WHERE ${alias}.id=$${idParam} AND ${alias}.organization_id=$${orgParam} AND ${scope}`, all);
}

async function remove(entity, table, id) {
  const access = await currentAccess();
  const values = [id, await organizationId()];
  const alias = table.charAt(0);
  const scope = scopeCondition(alias, entity, access, values);
  const result = await query(`DELETE FROM ${table} ${alias} WHERE ${alias}.id=$1 AND ${alias}.organization_id=$2 AND ${scope}`, values);
  if (result.rowCount) await clearRecordShares(entity, id);
  return result;
}

export const Property = {
  all(projectId = null, status = null) { const v = [], c = []; if (projectId) { v.push(projectId); c.push(`p.project_id=$${v.length + 1}`); } if (status) { v.push(status); c.push(`p.status=$${v.length + 1}`); } return list(propertySelect, "p", "property", v, c, " ORDER BY p.created_at DESC").then(withAvailableImages); },
  // Paginated twin of `all`. The `id` tiebreaker keeps the order total, so a row
  // cannot shift between two pages when timestamps collide. `withAvailableImages`
  // then resolves picture counts for THIS page only, exactly as `all` does.
  async paged(projectId = null, status = null, search = null) {
    const v = [], c = [];
    if (projectId) { v.push(projectId); c.push(`p.project_id=$${v.length + 1}`); }
    if (status) { v.push(status); c.push(`p.status=$${v.length + 1}`); }
    const built = await buildPaged(propertySelect, "properties", "p", "property", v, c, " ORDER BY p.created_at DESC, p.id DESC", search, ["p.name", "p.location", "p.description"]);
    return {
      ...built,
      resolve: (rows) => withAvailableImages(rows),
    };
  },
  async get(id) { return withAvailableImages(await get(propertySelect, "p", "property", id)); },
  create(data) { return create(`INSERT INTO properties(organization_id,project_id,name,property_type,status,price,location,area,bedrooms,bathrooms,description,featured,floor,unit_number,${OWNERSHIP_COLUMNS}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`, [data.project_id || null, data.name, data.property_type, data.status, data.price, data.location, data.area, data.bedrooms || 0, data.bathrooms || 0, data.description || null, Boolean(data.featured), data.floor ?? null, data.unit_number || null]); },
  update(id, data) { return update("property", "properties", id, "UPDATE properties SET project_id=$1,name=$2,property_type=$3,status=$4,price=$5,location=$6,area=$7,bedrooms=$8,bathrooms=$9,description=$10,featured=$11,floor=$12,unit_number=$13", [data.project_id || null, data.name, data.property_type, data.status, data.price, data.location, data.area, data.bedrooms || 0, data.bathrooms || 0, data.description || null, Boolean(data.featured), data.floor ?? null, data.unit_number || null]); },
  remove(id) { return remove("property", "properties", id); },
  /** Public-website listing fields. The route has already scope-checked `id`. */
  async setListing(id, listing) {
    return query(
      `UPDATE properties SET offer_rent=$1, offer_buy=$2, rent_price=$3, rent_period=$4, summary=$5, features=$6,
         public_listing=$7, public_listing_status=CASE WHEN $7 THEN 'approved' ELSE 'private' END
       WHERE id=$8 AND organization_id=$9`,
      [listing.offer_rent, listing.offer_buy, listing.rent_price, listing.rent_period, listing.summary, listing.features, listing.public_listing, id, await organizationId()],
    );
  },
};


export const PropertyImage = {
  async listFor(propertyId) { const o=await organizationId(); return query("SELECT * FROM property_images WHERE property_id=$1 AND organization_id=$2 ORDER BY id",[propertyId,o]).then((x)=>x.rows); },
  async get(propertyId,imageId) { const o=await organizationId(); return queryOne("SELECT * FROM property_images WHERE property_id=$1 AND id=$2 AND organization_id=$3",[propertyId,imageId,o]); },
  async countFor(propertyId) { const o=await organizationId(); return (await queryOne("SELECT COUNT(*)::int AS count FROM property_images WHERE property_id=$1 AND organization_id=$2",[propertyId,o])).count; },
  create(propertyId,data) { return createPlain("INSERT INTO property_images(organization_id,property_id,original_filename,stored_name,file_size,mime_type) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[propertyId,data.original_filename||null,data.stored_name,data.file_size??null,data.mime_type||null]); },
  async remove(imageId) { const o=await organizationId(); return query("DELETE FROM property_images WHERE id=$1 AND organization_id=$2",[imageId,o]); },
};

export const Client = {
  all(projectId = null, status = null) { const v = [], c = []; if (projectId) { v.push(projectId); c.push(`c.project_id=$${v.length + 1}`); } if (status) { v.push(status); c.push(`c.status=$${v.length + 1}`); } return list(clientSelect, "c", "client", v, c, " ORDER BY c.created_at DESC"); },
  paged(projectId = null, status = null, search = null) {
    const v = [], c = [];
    if (projectId) { v.push(projectId); c.push(`c.project_id=$${v.length + 1}`); }
    if (status) { v.push(status); c.push(`c.status=$${v.length + 1}`); }
    return buildPaged(clientSelect, "clients", "c", "client", v, c, " ORDER BY c.created_at DESC, c.id DESC", search, ["c.name", "c.email", "c.phone", "c.notes"]);
  },
  get(id) { return get(clientSelect, "c", "client", id); },
  create(data) { return create(`INSERT INTO clients(organization_id,project_id,name,email,phone,client_type,status,notes,${OWNERSHIP_COLUMNS}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [data.project_id || null, data.name, data.email || null, data.phone || null, data.client_type, data.status, data.notes || null]); },
  update(id, data) { return update("client", "clients", id, "UPDATE clients SET project_id=$1,name=$2,email=$3,phone=$4,client_type=$5,status=$6,notes=$7", [data.project_id || null, data.name, data.email || null, data.phone || null, data.client_type, data.status, data.notes || null]); },
  remove(id) { return remove("client", "clients", id); },
};


export const Appointment = {
  all(status = null, projectId = null) { const v = [], c = []; if (status) { v.push(status); c.push(`a.status=$${v.length + 1}`); } if (projectId) { v.push(projectId); c.push(`a.project_id=$${v.length + 1}`); } return list(appointmentSelect, "a", "appointment", v, c, " ORDER BY a.starts_at ASC").then(markWritableAppointments); },
  async paged(status = null, projectId = null, search = null) {
    const v = [], c = [];
    if (status) { v.push(status); c.push(`a.status=$${v.length + 1}`); }
    if (projectId) { v.push(projectId); c.push(`a.project_id=$${v.length + 1}`); }
    const built = await buildPaged(appointmentSelect, "appointments", "a", "appointment", v, c, " ORDER BY a.starts_at ASC, a.id DESC", search, ["a.title", "a.notes"]);
    return { ...built, resolve: markWritableAppointments };
  },
  get(id) { return get(appointmentSelect, "a", "appointment", id).then(markWritableAppointments); },
  /** The appointment only if the caller may change it (their normal record scope). */
  writable(id) { return get(appointmentSelect, "a", "appointment", id, { read: false }); },
  create(data) { return create(`INSERT INTO appointments(organization_id,client_id,property_id,project_id,title,appointment_type,starts_at,ends_at,status,notes,${OWNERSHIP_COLUMNS}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`, [data.client_id, data.property_id || null, data.project_id || null, data.title, data.appointment_type, data.starts_at, data.ends_at || null, data.status, data.notes || null]); },
  update(id, data) { return update("appointment", "appointments", id, "UPDATE appointments SET client_id=$1,property_id=$2,project_id=$3,title=$4,appointment_type=$5,starts_at=$6,ends_at=$7,status=$8,notes=$9", [data.client_id, data.property_id || null, data.project_id || null, data.title, data.appointment_type, data.starts_at, data.ends_at || null, data.status, data.notes || null]); },
  remove(id) { return remove("appointment", "appointments", id); },
  /** Marks a held meeting done; an optional outcome note is added to the notes. */
  complete(id, userId, note = null) { return update("appointment", "appointments", id, "UPDATE appointments SET status='completed',completed_by=$1,completed_at=NOW(),notes=CASE WHEN $2::text IS NULL THEN notes ELSE CONCAT_WS(E'\\n', notes, $2::text) END", [userId, note]); },
};

export const Document = {
  all(status = null, projectId = null) { const v = [], c = []; if (status) { v.push(status); c.push(`d.status=$${v.length + 1}`); } if (projectId) { v.push(projectId); c.push(`d.project_id=$${v.length + 1}`); } return list(documentSelect, "d", "document", v, c, " ORDER BY d.created_at DESC"); },
  paged(status = null, projectId = null, search = null) {
    const v = [], c = [];
    if (status) { v.push(status); c.push(`d.status=$${v.length + 1}`); }
    if (projectId) { v.push(projectId); c.push(`d.project_id=$${v.length + 1}`); }
    return buildPaged(documentSelect, "documents", "d", "document", v, c, " ORDER BY d.created_at DESC, d.id DESC", search, ["d.title", "d.category", "d.original_filename", "d.notes"]);
  },
  get(id) { return get(documentSelect, "d", "document", id); },
  create(data) { return create(`INSERT INTO documents(organization_id,project_id,contract_id,client_id,title,category,status,file_reference,notes,original_filename,stored_name,file_size,mime_type,uploaded_at,${OWNERSHIP_COLUMNS}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`, [data.project_id || null, data.contract_id || null, data.client_id || null, data.title, data.category, data.status, data.file_reference || null, data.notes || null, data.original_filename || null, data.stored_name || null, data.file_size ?? null, data.mime_type || null, data.uploaded_at || null]); },
  update(id, data) { return update("document", "documents", id, "UPDATE documents SET project_id=$1,contract_id=$2,client_id=$3,title=$4,category=$5,status=$6,file_reference=$7,notes=$8", [data.project_id || null, data.contract_id || null, data.client_id || null, data.title, data.category, data.status, data.file_reference || null, data.notes || null]); },
  remove(id) { return remove("document", "documents", id); },
};
