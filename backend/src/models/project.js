import { query, queryOne } from "../db.js";
import { organizationId } from "../org/rbac.js";
import { clearRecordShares, currentAccess, OWNERSHIP_COLUMNS, ownershipValues, scopeCondition } from "../org/access.js";

const ENTITY = "project";

export const Project = {
  async all() {
    const values = [await organizationId()];
    const access = await currentAccess();
    const scope = scopeCondition("p", ENTITY, access, values);
    return (await query(`SELECT p.* FROM projects p WHERE p.organization_id=$1 AND ${scope} ORDER BY p.created_at DESC`, values)).rows;
  },
  // Paginated twin of `all`. The count reuses the same `scope` fragment, so it can
  // never report projects the caller is not allowed to see.
  async paged(search = null) {
    const values = [await organizationId()];
    const access = await currentAccess();
    const scope = scopeCondition("p", ENTITY, access, values);
    const conditions = ["p.organization_id=$1", scope];
    if (search) {
      values.push(`%${search}%`);
      conditions.push(`COALESCE(p.name,'') ILIKE $${values.length}`);
    }
    const where = ` WHERE ${conditions.join(" AND ")}`;
    return {
      sql: `SELECT p.* FROM projects p${where} ORDER BY p.created_at DESC, p.id DESC`,
      countSql: `SELECT COUNT(*)::int AS total FROM projects p${where}`,
      values,
    };
  },
  async get(id) {
    const values = [id, await organizationId()];
    const access = await currentAccess();
    const scope = scopeCondition("p", ENTITY, access, values);
    return queryOne(`SELECT p.* FROM projects p WHERE p.id=$1 AND p.organization_id=$2 AND ${scope}`, values);
  },
  async create(name, status = "active") {
    const access = await currentAccess();
    const values = [await organizationId(), name, status];
    ownershipValues(values, access);
    return queryOne(`INSERT INTO projects (organization_id,name,status,${OWNERSHIP_COLUMNS}) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, values);
  },
  async update(id, name, status) {
    const values = [name, status, id, await organizationId()];
    const access = await currentAccess();
    const scope = scopeCondition("p", ENTITY, access, values);
    return query(`UPDATE projects p SET name=$1,status=$2 WHERE p.id=$3 AND p.organization_id=$4 AND ${scope}`, values);
  },
  async remove(id) {
    const values = [id, await organizationId()];
    const access = await currentAccess();
    const scope = scopeCondition("p", ENTITY, access, values);
    const result = await query(`DELETE FROM projects p WHERE p.id=$1 AND p.organization_id=$2 AND ${scope}`, values);
    if (result.rowCount) await clearRecordShares(ENTITY, id);
    return result;
  },
};

