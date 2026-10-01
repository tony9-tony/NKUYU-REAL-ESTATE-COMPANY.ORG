import { query, queryOne } from "../db.js";
import { UNPAGED_LIMIT } from "../pagination.js";
import { organizationId } from "../org/rbac.js";
import { clearRecordShares, currentAccess, OWNERSHIP_COLUMNS, ownershipValues, scopeCondition } from "../org/access.js";

const ENTITY = "debt";
const select = `SELECT d.*, c.client_name AS contract_client, c.project_id, c.contract_type, p.name AS project_name FROM debts d JOIN contracts c ON c.id = d.contract_id LEFT JOIN projects p ON p.id = c.project_id`;
const normalize = (row) => row && ({ ...row, amount: Number(row.amount || 0) });

/**
 * The vocabulary of installment statuses. Exported so the API layer validates
 * against exactly the values this derivation can produce.
 */
export const DEBT_STATUSES = ["pending", "partial", "paid", "overdue"];

/**
 * Derives an installment's status from the payment ledger.
 *
 * This is the single source of truth for installment state, shared by
 * `Payment.syncInstallment` and the status filter, so the stored value and
 * anything computed on read can never disagree.
 *
 * Rules, in order:
 *   paid >= amount                  -> paid      (overpayment still counts)
 *   0 < paid < amount               -> partial   (money has arrived)
 *   paid = 0 and due date passed    -> overdue
 *   paid = 0 and not yet due        -> pending
 *
 * A part-paid installment is `partial` even when its due date has passed: the
 * money is not late, the remaining balance is. Marking it `overdue` would hide
 * the payment from Finance and lose the fact that the client is paying.
 */
export function deriveInstallmentStatus(amount, paid, dueDate, now = new Date()) {
  const due = Number(amount || 0);
  const received = Number(paid || 0);
  if (due > 0 && received >= due) return "paid";
  if (received > 0) return "partial";
  if (dueDate && new Date(dueDate) < now) return "overdue";
  return "pending";
}

export const Debt = {
  async all(status = null, projectId = null) {
    const values = [await organizationId()];
    const access = await currentAccess();
    const conditions = ["d.organization_id=$1", scopeCondition("d", ENTITY, access, values)];
    if (status) { values.push(status); conditions.push(`d.status=$${values.length}`); }
    if (projectId) { values.push(projectId); conditions.push(`c.project_id=$${values.length}`); }
    return (await query(`${select} WHERE ${conditions.join(" AND ")} ORDER BY d.due_date ASC,d.created_at DESC LIMIT ${UNPAGED_LIMIT}`, values)).rows.map(normalize);
  },
  // Paginated twin. `due_date` can repeat and is not unique, so `created_at` and
  // then `id` make the order total - otherwise a row could appear on two pages.
  async paged(status = null, projectId = null, search = null) {
    const values = [await organizationId()];
    const access = await currentAccess();
    const conditions = ["d.organization_id=$1", scopeCondition("d", ENTITY, access, values)];
    if (status) { values.push(status); conditions.push(`d.status=$${values.length}`); }
    if (projectId) { values.push(projectId); conditions.push(`c.project_id=$${values.length}`); }
    if (search) {
      values.push(`%${search}%`);
      const placeholder = `$${values.length}`;
      conditions.push(`(COALESCE(d.client_name,'') ILIKE ${placeholder} OR COALESCE(d.notes,'') ILIKE ${placeholder})`);
    }
    const where = ` WHERE ${conditions.join(" AND ")}`;
    return {
      sql: `${select}${where} ORDER BY d.due_date ASC, d.created_at DESC, d.id DESC`,
      // The project filter references the joined `contracts` table.
      countSql: `SELECT COUNT(*)::int AS total FROM debts d JOIN contracts c ON c.id = d.contract_id${where}`,
      values,
    };
  },
  async get(id) {
    const values = [id, await organizationId()];
    const access = await currentAccess();
    return normalize(await queryOne(`${select} WHERE d.id=$1 AND d.organization_id=$2 AND ${scopeCondition("d", ENTITY, access, values)}`, values));
  },
  async create(data) {
    const access = await currentAccess();
    const values = [await organizationId(), data.contract_id, data.client_name, data.amount || 0, data.due_date || null, data.status || "pending", data.notes || null];
    ownershipValues(values, access);
    return queryOne(`INSERT INTO debts(organization_id,contract_id,client_name,amount,due_date,status,notes,${OWNERSHIP_COLUMNS}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, values);
  },
  async update(id, data) {
    const access = await currentAccess();
    const values = [data.contract_id, data.client_name, data.amount || 0, data.due_date || null, data.status || "pending", data.notes || null, id, await organizationId()];
    const scope = scopeCondition("d", ENTITY, access, values);
    return query(`UPDATE debts d SET contract_id=$1,client_name=$2,amount=$3,due_date=$4,status=$5,notes=$6 WHERE d.id=$7 AND d.organization_id=$8 AND ${scope}`, values);
  },
  async remove(id) {
    const access = await currentAccess();
    const values = [id, await organizationId()];
    const scope = scopeCondition("d", ENTITY, access, values);
    const result = await query(`DELETE FROM debts d WHERE d.id=$1 AND d.organization_id=$2 AND ${scope}`, values);
    if (result.rowCount) await clearRecordShares(ENTITY, id);
    return result;
  },
  async markPaid(id) {
    const access = await currentAccess();
    const values = [id, await organizationId()];
    const scope = scopeCondition("d", ENTITY, access, values);
    return query(`UPDATE debts d SET status='paid' WHERE d.id=$1 AND d.organization_id=$2 AND ${scope}`, values);
  },
  async overdue() {
    const values = [await organizationId()];
    const access = await currentAccess();
    return query(`${select} WHERE d.organization_id=$1 AND ${scopeCondition("d", ENTITY, access, values)} AND (d.status='overdue' OR (d.status='pending' AND d.due_date<CURRENT_DATE)) ORDER BY d.due_date ASC`, values).then((x) => x.rows.map(normalize));
  },
  async upcoming(days = 7) {
    const values = [await organizationId(), days];
    const access = await currentAccess();
    return query(`${select} WHERE d.organization_id=$1 AND d.status='pending' AND d.due_date>=CURRENT_DATE AND d.due_date<=CURRENT_DATE+($2*INTERVAL '1 day') AND ${scopeCondition("d", ENTITY, access, values)} ORDER BY d.due_date ASC`, values).then((x) => x.rows.map(normalize));
  },
};


