import { query, queryOne } from "../db.js";
import { organizationId } from "../org/rbac.js";
import { currentAccess, scopeCondition } from "../org/access.js";

// Reminders have no ownership of their own: they inherit the scope of the
// installment (debt) they belong to.
const ENTITY = "debt";
const select = `SELECT r.id, r.remind_at, r.sent, d.id AS debt_id, d.amount, d.due_date, d.client_name, d.status AS debt_status, d.notes, c.project_id, c.contract_type, p.name AS project_name FROM reminders r JOIN debts d ON d.id = r.debt_id JOIN contracts c ON c.id = d.contract_id JOIN projects p ON p.id = c.project_id`;

export const Reminder = {
  async due() {
    const values = [await organizationId()];
    const access = await currentAccess();
    return query(`${select} WHERE r.organization_id=$1 AND ${scopeCondition("d", ENTITY, access, values)} AND r.sent=FALSE AND r.remind_at<=NOW() ORDER BY r.remind_at ASC`, values).then((x) => x.rows);
  },
  async upcoming(days = 30) {
    const values = [await organizationId(), days];
    const access = await currentAccess();
    return query(`${select} WHERE r.organization_id=$1 AND ${scopeCondition("d", ENTITY, access, values)} AND r.sent=FALSE AND r.remind_at>NOW() AND r.remind_at<=NOW()+($2*INTERVAL '1 day') ORDER BY r.remind_at ASC`, values).then((x) => x.rows);
  },
  async acknowledge(id) {
    const values = [id, await organizationId()];
    const access = await currentAccess();
    return query(`UPDATE reminders r SET sent=TRUE FROM debts d WHERE d.id = r.debt_id AND r.id=$1 AND r.organization_id=$2 AND ${scopeCondition("d", ENTITY, access, values)}`, values);
  },
  async sync(debtId, remindAt) {
    if (!debtId) return;
    const orgId = await organizationId();
    const existing = await queryOne("SELECT id FROM reminders WHERE debt_id=$1 AND organization_id=$2 AND sent=FALSE", [debtId, orgId]);
    if (!remindAt) { if (existing) await query("DELETE FROM reminders WHERE id=$1 AND organization_id=$2", [existing.id, orgId]); return; }
    if (existing) await query("UPDATE reminders SET remind_at=$1 WHERE id=$2 AND organization_id=$3", [remindAt, existing.id, orgId]);
    else await query("INSERT INTO reminders(organization_id,debt_id,remind_at) VALUES($1,$2,$3)", [orgId, debtId, remindAt]);
  },
};


