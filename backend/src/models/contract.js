import { query, queryOne } from "../db.js";
import { UNPAGED_LIMIT } from "../pagination.js";
import { organizationId } from "../org/rbac.js";
import { clearRecordShares, currentAccess, OWNERSHIP_COLUMNS, ownershipValues, scopeCondition } from "../org/access.js";
import { carryPaidInvoices, contractBlockedMessage, invoiceBlockingContract } from "../payments/invoices.js";

const ENTITY = "contract";
// `final_price` is exposed as an alias of the authoritative `value` column rather
// than stored twice: callers get the pricing breakdown, and there is still only
// one number in the database that defines what the contract is worth.
const select = `SELECT c.*, c.value AS final_price, p.name AS project_name,cl.name AS linked_client_name,cl.verification_status AS client_verification_status,cl.citizenship_confirmed_at AS client_citizenship_confirmed_at,cl.is_diaspora AS client_is_diaspora,pr.name AS property_name,
  lr.display_name AS legal_reviewer_name,fv.display_name AS finance_validator_name,ma.display_name AS management_approver_name,su.display_name AS signed_uploaded_by_name,sd.original_filename AS signed_file_name
  FROM contracts c
  LEFT JOIN projects p ON p.id = c.project_id
  LEFT JOIN clients cl ON cl.id=c.client_id
  LEFT JOIN properties pr ON pr.id=c.property_id
  LEFT JOIN users lr ON lr.id=c.legal_reviewed_by
  LEFT JOIN users fv ON fv.id=c.finance_validated_by
  LEFT JOIN users ma ON ma.id=c.management_approved_by
  LEFT JOIN users su ON su.id=c.signed_uploaded_by
  LEFT JOIN documents sd ON sd.id=c.signed_document_id`;

export const Contract = {
  // How many contracts sit at each point of the workflow, scoped exactly like the
  // register, so the MD's "where contracts are" panel counts every contract the
  // caller may see rather than only the first page.
  async pipelineCounts() {
    const values = [await organizationId()];
    const access = await currentAccess();
    const conditions = ["c.organization_id=$1", scopeCondition("c", ENTITY, access, values)];
    return (await query(`SELECT c.status, (c.finance_validated_at IS NOT NULL) AS finance_done, COUNT(*)::int AS n
      FROM contracts c WHERE ${conditions.join(" AND ")} GROUP BY 1, 2`, values)).rows;
  },
  async all(projectId = null, type = null) {
    const values = [await organizationId()];
    const access = await currentAccess();
    const conditions = ["c.organization_id=$1", scopeCondition("c", ENTITY, access, values)];
    if (projectId) { values.push(projectId); conditions.push(`c.project_id=$${values.length}`); }
    if (type) { values.push(type); conditions.push(`c.contract_type=$${values.length}`); }
    return (await query(`${select} WHERE ${conditions.join(" AND ")} ORDER BY c.created_at DESC LIMIT ${UNPAGED_LIMIT}`, values)).rows;
  },
  // Paginated twin. The count is built from the same `conditions` array the data
  // query uses, so a filtered or scope-limited total can never exceed what the
  // caller can actually page through.
  async paged(projectId = null, type = null, search = null) {
    const values = [await organizationId()];
    const access = await currentAccess();
    const conditions = ["c.organization_id=$1", scopeCondition("c", ENTITY, access, values)];
    if (projectId) { values.push(projectId); conditions.push(`c.project_id=$${values.length}`); }
    if (type) { values.push(type); conditions.push(`c.contract_type=$${values.length}`); }
    // Server-side search, ANDed with the scope predicate so it can only narrow
    // what this caller may already read.
    if (search) {
      values.push(`%${search}%`);
      const placeholder = `$${values.length}`;
      conditions.push(`(COALESCE(c.client_name,'') ILIKE ${placeholder} OR COALESCE(c.contract_number,'') ILIKE ${placeholder})`);
    }
    const where = ` WHERE ${conditions.join(" AND ")}`;
    return {
      sql: `${select}${where} ORDER BY c.created_at DESC, c.id DESC`,
      countSql: `SELECT COUNT(*)::int AS total FROM contracts c${where}`,
      values,
    };
  },
  async get(id) {
    const values = [id, await organizationId()];
    const access = await currentAccess();
    return queryOne(`${select} WHERE c.id=$1 AND c.organization_id=$2 AND ${scopeCondition("c", ENTITY, access, values)}`, values);
  },
  async nextNumber() {
    const row = await queryOne("SELECT contract_number FROM contracts WHERE organization_id=$1 AND contract_number ~ '^MK-C-[0-9]+$' ORDER BY id DESC LIMIT 1", [await organizationId()]);
    const last = row?.contract_number ? Number(row.contract_number.replace("MK-C-", "")) : 0;
    return `MK-C-${String(last + 1).padStart(6, "0")}`;
  },
  async create(data) {
    const access = await currentAccess();
    // The contract for a request waits until that request's invoice is Paid
    // (customer invoices, payments/invoices.js). A request with no invoice is not held.
    const unpaid = await invoiceBlockingContract(data.client_id || null, data.property_id || null);
    if (unpaid) { const error = new Error(contractBlockedMessage(unpaid)); error.status = 409; throw error; }
    // `pricing` carries the server-calculated original price, discount and final
    // price. Its `final_price` is what lands in `value`, so the payment plan reads
    // the discounted amount without a second calculation.
    const pricing = data.pricing || {};
    const values = [
      await organizationId(), data.project_id, data.property_id || null, data.client_id || null, data.client_name,
      data.contract_type, data.status || "draft", pricing.final_price ?? 0,
      pricing.original_price ?? pricing.final_price ?? 0, pricing.discount_pct ?? 0, pricing.discount_amount ?? 0,
      data.start_date || null, data.end_date || null, data.terms || null, data.notes || null,
      data.requires_management_approval ? true : false,
      data.contract_number || await Contract.nextNumber(),
    ];
    ownershipValues(values, access);
    values.push(
      data.contract_date || null,
      data.agreement_duration ?? null,
      data.agreement_duration_unit || null,
      data.client_phone || null,
      data.client_email || null,
      data.payment_frequency || null,
      data.deposit_amount ?? null,
      data.installment_count ?? null,
      data.first_due_date || null,
      data.template_document_id || null,
      data.generated_document_id || null,
      data.deal_type || null,
      data.title_deed_number || null,
    );
    const row = await queryOne(
      `INSERT INTO contracts(organization_id,project_id,property_id,client_id,client_name,contract_type,status,value,original_price,discount_pct,discount_amount,start_date,end_date,terms,notes,requires_management_approval,contract_number,${OWNERSHIP_COLUMNS},contract_date,agreement_duration,agreement_duration_unit,client_phone,client_email,payment_frequency,deposit_amount,installment_count,first_due_date,template_document_id,generated_document_id,deal_type,title_deed_number)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34) RETURNING id`,
      values,
    );
    await Contract.recordRevision(row.id, { status: data.status || "draft", action: "created", actorId: access?.userId });
    // Money the customer paid on the request's invoice counts on the new contract.
    await carryPaidInvoices({ id: row.id, client_id: data.client_id || null, property_id: data.property_id || null });
    return row;
  },

  async update(id, data) {
    const access = await currentAccess();
    // Same rule as create: the final price is the server-calculated one, so a
    // client-supplied `value` is never written.
    const pricing = data.pricing || {};
    const values = [data.project_id, data.property_id || null, data.client_id || null, data.client_name, data.contract_type,
      pricing.final_price ?? 0, pricing.original_price ?? pricing.final_price ?? 0, pricing.discount_pct ?? 0, pricing.discount_amount ?? 0,
      data.start_date || null, data.end_date || null, data.terms || null, data.notes || null, data.requires_management_approval ? true : false,
      access?.userId ?? null, await organizationId(), id, data.deal_type || null, data.title_deed_number ?? null];
    const scope = scopeCondition("c", ENTITY, access, values);
    const result = await query(
      `UPDATE contracts c SET project_id=$1,property_id=$2,client_id=$3,client_name=$4,contract_type=$5,value=$6,original_price=$7,discount_pct=$8,discount_amount=$9,start_date=$10,end_date=$11,terms=$12,notes=$13,requires_management_approval=$14,updated_by=$15,updated_at=NOW(),deal_type=COALESCE($18,c.deal_type),title_deed_number=COALESCE($19,c.title_deed_number)
       WHERE c.id=$17 AND c.organization_id=$16 AND ${scope}`,
      values,
    );
    if (result.rowCount) await Contract.recordRevision(id, { status: data.status, action: "edited", actorId: access?.userId });
    return result;
  },
  async remove(id) {
    const access = await currentAccess();
    const values = [id, await organizationId()];
    const scope = scopeCondition("c", ENTITY, access, values);
    const result = await query(`DELETE FROM contracts c WHERE c.id=$1 AND c.organization_id=$2 AND ${scope}`, values);
    if (result.rowCount) await clearRecordShares(ENTITY, id);
    return result;
  },
  /**
   * Applies a workflow action. The resulting status is always derived from the
   * action table, never from the request body, and the per-action columns (who
   * reviewed it, who approved it, when) are stamped here so the record carries
   * its own audit trail alongside contract_revisions.
   */
  async transition(id, action, { notes = null, actorId = null, actorName = null, signedBy = null } = {}) {
    const result = await query(
      `UPDATE contracts SET
         status=$1,
         status_note=COALESCE($2,status_note),
         submitted_at = CASE WHEN $3='submit' THEN NOW() ELSE submitted_at END,
         legal_reviewed_by = CASE WHEN $3='request_changes' THEN NULL WHEN $3 IN ('start_review','legal_approve','record_signature','complete') THEN COALESCE($4,legal_reviewed_by) ELSE legal_reviewed_by END,
         legal_reviewed_at = CASE WHEN $3='request_changes' THEN NULL WHEN $3 IN ('start_review','legal_approve') THEN NOW() ELSE legal_reviewed_at END,
         legal_notes = CASE WHEN $3 IN ('legal_approve','request_changes') THEN $2 ELSE legal_notes END,
         finance_validated_by = CASE WHEN $3='request_changes' THEN NULL WHEN $3='finance_validate' THEN $5 ELSE finance_validated_by END,
         finance_validated_at = CASE WHEN $3='request_changes' THEN NULL WHEN $3='finance_validate' THEN NOW() ELSE finance_validated_at END,
         finance_notes = CASE WHEN $3='request_changes' THEN NULL WHEN $3='finance_validate' THEN $2 ELSE finance_notes END,
         management_approved_by = CASE WHEN $3='request_changes' THEN NULL WHEN $3 IN ('management_approve','management_reject') THEN $6 ELSE management_approved_by END,
         management_approved_at = CASE WHEN $3='request_changes' THEN NULL WHEN $3='management_approve' THEN NOW() ELSE management_approved_at END,
         management_notes = CASE WHEN $3='request_changes' THEN NULL WHEN $3 IN ('management_approve','management_reject') THEN $2 ELSE management_notes END,
         customer_signed_at = CASE WHEN $3='request_changes' THEN NULL WHEN $3='record_signature' THEN NOW() ELSE customer_signed_at END,
         customer_signed_by = CASE WHEN $3='request_changes' THEN NULL ELSE COALESCE($7,customer_signed_by) END,
         legal_signed_by = CASE WHEN $3='request_changes' THEN NULL ELSE legal_signed_by END,
         legal_signed_at = CASE WHEN $3='request_changes' THEN NULL ELSE legal_signed_at END,
         legal_owner_id = CASE WHEN $3 IN ('start_review','legal_approve') THEN COALESCE(legal_owner_id,$4) ELSE legal_owner_id END,
         updated_by=$4,
         updated_at=NOW()
       WHERE id=$9 AND organization_id=$8
       RETURNING id,status,contract_number,legal_owner_id`,
      [action.to, notes, action.action, actorId, actorId, actorId, signedBy, await organizationId(), id],
    );
    if (result.rowCount) {
      await Contract.recordRevision(id, { status: action.to, action: action.action, notes, actorId, actorName });
    }
    return result;
  },
  async recordRevision(contractId, { status, action, notes = null, actorId = null, actorName = null } = {}) {
    const orgId = await organizationId();
    const next = await queryOne("SELECT COALESCE(MAX(revision),0)+1 AS next FROM contract_revisions WHERE contract_id=$1 AND organization_id=$2", [contractId, orgId]);
    return query(
      `INSERT INTO contract_revisions (organization_id,contract_id,revision,status,action,notes,changed_by,changed_by_name)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [orgId, contractId, Number(next?.next) || 1, status || "draft", action || null, notes, actorId ?? currentAccess()?.userId ?? null, actorName],
    );
  },
  // Revisions inherit the contract's visibility. The caller has already loaded
  // the contract through the scope predicate, so the trail is read directly
  // rather than re-filtered: contract_revisions carries no owner of its own.
  async history(contractId) {
    return (await query(
      `SELECT r.*,u.display_name AS changed_by_display_name
         FROM contract_revisions r
         LEFT JOIN users u ON u.id=r.changed_by
        WHERE r.contract_id=$1 AND r.organization_id=$2
        ORDER BY r.revision DESC`,
      [contractId, await organizationId()],
    )).rows;
  },
};




