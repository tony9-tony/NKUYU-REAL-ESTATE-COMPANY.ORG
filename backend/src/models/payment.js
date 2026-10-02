import { query, queryOne } from "../db.js";
import { UNPAGED_LIMIT } from "../pagination.js";
import { organizationId } from "../org/rbac.js";
import { clearRecordShares, currentAccess, OWNERSHIP_COLUMNS, ownershipValues, scopeCondition } from "../org/access.js";
import { deriveInstallmentStatus } from "./debt.js";

const ENTITY = "payment";
const paymentSelect = `SELECT p.*, ab.display_name AS approved_by_name, rb.display_name AS reversed_by_name, c.project_id, c.contract_type, c.status AS contract_status, pr.name AS project_name, d.due_date AS installment_due, d.notes AS installment_notes, doc.original_filename AS receipt_filename, doc.stored_name AS receipt_stored_name, doc.mime_type AS receipt_mime_type FROM payments p JOIN contracts c ON c.id=p.contract_id LEFT JOIN projects pr ON pr.id=c.project_id LEFT JOIN debts d ON d.id=p.debt_id LEFT JOIN documents doc ON doc.id=p.receipt_document_id LEFT JOIN users ab ON ab.id=p.approved_by LEFT JOIN users rb ON rb.id=p.reversed_by`;

export const Payment = {
  async all(filters = {}) {
    const values = [await organizationId()];
    const access = await currentAccess();
    const c = ["p.organization_id=$1", scopeCondition("p", ENTITY, access, values)];
    for (const [key, sql] of [["projectId", "c.project_id"], ["contractId", "p.contract_id"], ["method", "p.method"], ["from", "p.paid_at >="], ["to", "p.paid_at <="]]) {
      if (filters[key]) { values.push(filters[key]); c.push(`${sql} $${values.length}`); }
    }
    return (await query(`${paymentSelect} WHERE ${c.join(" AND ")} ORDER BY p.paid_at DESC,p.id DESC LIMIT ${UNPAGED_LIMIT}`, values)).rows;
  },
  // Paginated twin. Same `c` array feeds the data query and the count, so filters
  // (project, contract, method, date window) scope the total identically.
  async paged(filters = {}) {
    const values = [await organizationId()];
    const access = await currentAccess();
    const c = ["p.organization_id=$1", scopeCondition("p", ENTITY, access, values)];
    for (const [key, sql] of [["projectId", "c.project_id"], ["contractId", "p.contract_id"], ["method", "p.method"], ["from", "p.paid_at >="], ["to", "p.paid_at <="]]) {
      if (filters[key]) { values.push(filters[key]); c.push(`${sql} $${values.length}`); }
    }
    if (filters.search) {
      values.push(`%${filters.search}%`);
      const placeholder = `$${values.length}`;
      c.push(`(COALESCE(p.client_name,'') ILIKE ${placeholder} OR COALESCE(p.reference,'') ILIKE ${placeholder})`);
    }
    const where = ` WHERE ${c.join(" AND ")}`;
    return {
      sql: `${paymentSelect}${where} ORDER BY p.paid_at DESC, p.id DESC`,
      // The filter conditions reference joined columns (c.project_id), so the
      // count needs the same join rather than a bare `FROM payments p`.
      countSql: `SELECT COUNT(*)::int AS total FROM payments p JOIN contracts c ON c.id=p.contract_id${where}`,
      values,
    };
  },
  async get(id) {
    const values = [id, await organizationId()];
    const access = await currentAccess();
    return queryOne(`${paymentSelect} WHERE p.id=$1 AND p.organization_id=$2 AND ${scopeCondition("p", ENTITY, access, values)}`, values);
  },
  async create(data) {
    const access = await currentAccess();
    const values = [await organizationId(), data.contract_id, data.debt_id || null, data.client_name, data.amount, data.paid_at, data.method || "cash", data.reference || null, data.notes || null, data.evidence_text || null];
    ownershipValues(values, access);
    return queryOne(`INSERT INTO payments(organization_id,contract_id,debt_id,client_name,amount,paid_at,method,reference,notes,evidence_text,${OWNERSHIP_COLUMNS}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`, values);
  },
  async update(id, data) {
    const access = await currentAccess();
    const values = [data.contract_id, data.debt_id || null, data.client_name, data.amount, data.paid_at, data.method || "cash", data.reference || null, data.notes || null, data.evidence_text ?? null, id, await organizationId()];
    const scope = scopeCondition("p", ENTITY, access, values);
    // Only a PENDING payment may be corrected; an approved one is reversed instead
    // (the route refuses first, this keeps the database honest as well).
    return query(`UPDATE payments p SET contract_id=$1,debt_id=$2,client_name=$3,amount=$4,paid_at=$5,method=$6,reference=$7,notes=$8,evidence_text=$9,status='pending',approved_by=NULL,approved_at=NULL WHERE p.id=$10 AND p.organization_id=$11 AND p.status='pending' AND ${scope}`, values);
  },
  async setReceipt(id, documentId) {
    const values = [documentId || null, id, await organizationId()];
    return query("UPDATE payments SET receipt_document_id=$1 WHERE id=$2 AND organization_id=$3", values);
  },
  /** Marks a pending payment approved; scoped like every other write. */
  async approve(id, userId, { selfApproved = false } = {}) {
    const access = await currentAccess();
    const values = [userId, id, await organizationId(), Boolean(selfApproved)];
    const scope = scopeCondition("p", ENTITY, access, values);
    return query(`UPDATE payments p SET status='approved', approved_by=$1, approved_at=NOW(), self_approved=$4 WHERE p.id=$2 AND p.organization_id=$3 AND p.status='pending' AND ${scope}`, values);
  },
  /**
   * How many OTHER active staff could approve payments (Finance authority plus
   * financial access, never the administrator account). Zero means the caller
   * is the only Finance person, and may then approve their own entries.
   */
  async otherApprovers(userId) {
    const row = await queryOne(`SELECT COUNT(DISTINCT u.id)::int AS n FROM users u
      WHERE u.organization_id=$1 AND u.active=TRUE AND u.role <> 'admin' AND u.id <> $2
        AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id AND r.active=TRUE
                    JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id
                    WHERE ur.user_id=u.id AND p.permission_key='validate_finance')
        AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id AND r.active=TRUE
                    JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id
                    WHERE ur.user_id=u.id AND p.permission_key='view_financial')`, [await organizationId(), userId]);
    return row?.n || 0;
  },
  /**
   * Reverses an approved payment. The row stays in the ledger (who, when, why)
   * but no longer counts towards any installment, balance or report.
   */
  async reverse(id, userId, reason) {
    const access = await currentAccess();
    const values = [userId, reason, id, await organizationId()];
    const scope = scopeCondition("p", ENTITY, access, values);
    return query(`UPDATE payments p SET status='reversed', reversed_by=$1, reversed_at=NOW(), reversal_reason=$2 WHERE p.id=$3 AND p.organization_id=$4 AND p.status='approved' AND ${scope}`, values);
  },
  /** Finds a live (not reversed) payment already using this transaction reference. */
  async findByReference(reference, exceptId = null) {
    const values = [await organizationId(), reference, exceptId];
    return queryOne(`SELECT p.id, p.client_name, p.amount, p.paid_at, p.status FROM payments p
      WHERE p.organization_id=$1 AND p.status <> 'reversed'
        AND upper(regexp_replace(p.reference, '\\s', '', 'g')) = upper(regexp_replace($2, '\\s', '', 'g'))
        AND ($3::int IS NULL OR p.id <> $3) LIMIT 1`, values);
  },
  async remove(id) {
    const access = await currentAccess();
    const values = [id, await organizationId()];
    const scope = scopeCondition("p", ENTITY, access, values);
    // Only a pending (not yet counted) payment may be deleted; approved money is
    // reversed so the ledger never loses a record.
    const result = await query(`DELETE FROM payments p WHERE p.id=$1 AND p.organization_id=$2 AND p.status='pending' AND ${scope}`, values);
    if (result.rowCount) await clearRecordShares(ENTITY, id);
    return result;
  },
  async incomeTotals() {
    const values = [await organizationId()];
    const access = await currentAccess();
    return queryOne(`SELECT COUNT(*)::int AS count,COALESCE(SUM(amount),0) AS total FROM payments p WHERE p.organization_id=$1 AND p.status='approved' AND ${scopeCondition("p", ENTITY, access, values)}`, values);
  },
  // Derived installment state. The payment/debt was already scope-checked by the
  // route that reached this point, so these stay organization-wide on purpose.
  // Only APPROVED money counts: a recorded payment is a claim until a second
  // Finance person has confirmed it against the bank or mobile-money statement.
  async syncInstallment(debtId, force = false) {
    if (!debtId) return;
    const orgId = await organizationId();
    const debt = await queryOne("SELECT id,amount,due_date,status FROM debts WHERE id=$1 AND organization_id=$2", [debtId, orgId]);
    if (!debt) return;
    const paid = Number((await queryOne("SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE debt_id=$1 AND organization_id=$2 AND status='approved'", [debtId, orgId])).total);
    if (!force && paid === 0 && debt.status === "paid") return;
    // `partial` is derived here too, so a part-paid installment is a first-class
    // state rather than something the ledger implies but the record cannot show.
    const status = deriveInstallmentStatus(debt.amount, paid, debt.due_date);
    if (status !== debt.status) await query("UPDATE debts SET status=$1 WHERE id=$2 AND organization_id=$3", [status, debtId, orgId]);
  },
  async forDebt(debtId) {
    const orgId = await organizationId();
    return Number((await queryOne("SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE debt_id=$1 AND organization_id=$2 AND status='approved'", [debtId, orgId])).total);
  },
};


