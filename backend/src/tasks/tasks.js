// Task persistence behind the RBAC/authority checks in routes/tasks.js.
// Visibility mirrors business records: organization scope or admin sees all;
// department scope sees own/department/assigned/reviewer rows; own scope sees
// assigned/created/review rows plus explicitly shared rows.
import { query, queryOne } from "../db.js";
import { organizationId } from "../org/rbac.js";
import { currentAccess } from "../org/access.js";
import { TASK_LINK_ENTITIES } from "./workflow.js";

const ENTITY = "task";

const LINK_TABLE = {
  client: "clients",
  property: "properties",
  contract: "contracts",
  payment: "payments",
  debt: "debts",
  project: "projects",
  report: "reports",
  document: "documents",
  appointment: "appointments",
};

const select = `SELECT t.*,
  ab.display_name AS assigned_by_name, ab.email AS assigned_by_email,
  at.display_name AS assigned_to_name, at.email AS assigned_to_email,
  rv.display_name AS reviewer_name, rv.email AS reviewer_email,
  sb.display_name AS submitted_by_name, ap.display_name AS approved_by_name,
  cb.display_name AS completed_by_name,
  d.name AS department_name
 FROM tasks t
 LEFT JOIN users ab ON ab.id = t.assigned_by
 LEFT JOIN users at ON at.id = t.assigned_to
 LEFT JOIN users rv ON rv.id = t.reviewer_id
 LEFT JOIN users sb ON sb.id = t.submitted_by
 LEFT JOIN users ap ON ap.id = t.approved_by
 LEFT JOIN users cb ON cb.id = t.completed_by
 LEFT JOIN departments d ON d.id = t.department_id`;

function visibilityCondition(access, values) {
  if (!access || access.isAdmin || access.scope === "organization") return "TRUE";
  const bind = (value) => { values.push(value); return `$${values.length}`; };
  const parts = [
    `t.assigned_to = ${bind(access.userId)}`,
    `t.assigned_by = ${bind(access.userId)}`,
    `t.created_by = ${bind(access.userId)}`,
    `t.reviewer_id = ${bind(access.userId)}`,
  ];
  parts.push(`EXISTS (SELECT 1 FROM record_shares rs WHERE rs.organization_id = ${bind(access.organizationId)} AND rs.entity = 'task' AND rs.record_id = t.id AND (rs.user_id = ${bind(access.userId)}${access.departmentIds.length ? ` OR rs.department_id = ANY(${bind(access.departmentIds)})` : ""}))`);
  if (access.departmentIds.length) {
    parts.push(`(t.visibility = 'department' AND t.department_id = ANY(${bind(access.departmentIds)}))`);
  }
  return `(${parts.join(" OR ")})`;
}

export async function taskVisible(id, access) {
  const values = [id, await organizationId()];
  const scope = visibilityCondition(access || (await currentAccess()), values);
  return queryOne(`${select} WHERE t.id = $1 AND t.organization_id = $2 AND ${scope}`, values);
}

export async function listTasks({ status = null, priority = null, box = null, search = null } = {}, access = null) {
  const who = access || (await currentAccess());
  const values = [await organizationId()];
  const scope = visibilityCondition(who, values);
  const conditions = [scope];
  if (status) { values.push(status); conditions.push(`t.status = $${values.length}`); }
  if (priority) { values.push(priority); conditions.push(`t.priority = $${values.length}`); }
  if (box === "mine") { values.push(who?.userId); conditions.push(`t.assigned_to = $${values.length}`); }
  else if (box === "assigned_by_me") { values.push(who?.userId); conditions.push(`t.assigned_by = $${values.length}`); }
  else if (box === "needs_review") { values.push(who?.userId); conditions.push(`t.reviewer_id = $${values.length} AND t.status IN ('submitted','under_review')`); }
  if (search) { values.push(`%${search}%`); conditions.push(`(t.title ILIKE $${values.length} OR COALESCE(t.description,'') ILIKE $${values.length})`); }
  return (await query(`${select} WHERE t.organization_id = $1 AND ${conditions.join(" AND ")} ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.due_date NULLS LAST, t.id DESC LIMIT 250`, values)).rows;
}

/** Backend-driven attention count: items the caller must act on now. */
export async function attentionCount(access = null) {
  const who = access || (await currentAccess());
  if (!who) return { total: 0, mine: 0, review: 0 };
  const org = await organizationId();
  const mine = await query(
    "SELECT COUNT(*)::int AS n FROM tasks t WHERE t.organization_id=$1 AND t.assigned_to=$2 AND t.status IN ('assigned','changes_requested')",
    [org, who.userId],
  );
  const review = await query(
    "SELECT COUNT(*)::int AS n FROM tasks t WHERE t.organization_id=$1 AND t.reviewer_id=$2 AND t.status IN ('submitted','under_review')",
    [org, who.userId],
  );
  const mineCount = mine.rows[0]?.n || 0;
  const reviewCount = review.rows[0]?.n || 0;
  return { total: mineCount + reviewCount, mine: mineCount, review: reviewCount };
}

export async function listComments(taskId) {
  return (await query(
    `SELECT c.*, u.display_name AS author_name FROM task_comments c LEFT JOIN users u ON u.id=c.author_id WHERE c.task_id=$1 ORDER BY c.created_at, c.id`,
    [taskId],
  )).rows;
}

export async function listHistory(taskId) {
  const org = await organizationId();
  return (await query(
    `SELECT a.*, u.display_name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.organization_id=$1 AND a.module='task' AND a.record_id=$2 ORDER BY a.created_at, a.id`,
    [org, String(taskId)],
  )).rows;
}

/** Confirms a linked business record exists (pointer check, never a copy). */
export async function linkedRecordExists(entity, recordId) {
  const key = String(entity || "").toLowerCase();
  const table = LINK_TABLE[key];
  // The table map and the allow-list are the same decision, so an entity that is
  // not a recognised business record has no table to query and is refused.
  if (!table || !TASK_LINK_ENTITIES.has(key)) return false;
  const org = await organizationId();
  const row = await queryOne(`SELECT id FROM ${table} WHERE id=$1 AND organization_id=$2`, [recordId, org]);
  return Boolean(row);
}
