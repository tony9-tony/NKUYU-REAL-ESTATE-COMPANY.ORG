// ---------------------------------------------------------------------------
// Task assignment authority.
//
// Additive check on top of the existing RBAC model; it never replaces it.
// A caller may assign only when they hold `assign_tasks` AND:
//   - admin/organization scope: any active staff member in the organization;
//   - department scope: members of one of the caller's own departments;
//   - own scope: nobody (receives and works, never assigns).
//
// Review/approval additionally needs `review_tasks` and the task's reviewer
// slot (or organization scope). Approving one's own submission is refused.
// ---------------------------------------------------------------------------
import { query } from "../db.js";
import { organizationId, hasPermission } from "../org/rbac.js";
import { TASK_HANDOFF } from "../org/duties.js";

async function userRow(id) {
  return (await query(
    `SELECT u.id, u.active, u.organization_id,
      COALESCE((SELECT json_agg(d.id) FROM user_departments ud JOIN departments d ON d.id=ud.department_id WHERE ud.user_id=u.id AND d.active=TRUE), '[]'::json) AS departments
     FROM users u WHERE u.id=$1`,
    [id],
  )).rows[0] || null;
}

async function callerContext(req) {
  const access = req.access || null;
  const org = await organizationId();
  const departments = access?.departmentIds || [];
  return {
    access,
    org,
    userId: req.user.id,
    isAdmin: req.user?.role === "admin" || access?.isAdmin === true,
    scope: access?.scope || "own",
    departments,
  };
}

/**
 * Every department a department-scoped assigner may assign into: their own,
 * plus the declared hand-off targets. The assignee picker and canAssignTo both
 * use this rule, so the list can never offer someone the server would refuse.
 */
export async function assignableDepartmentIds(callerDepartmentIds) {
  const own = (callerDepartmentIds || []).map(Number);
  if (!own.length) return [];
  const rows = (await query("SELECT id, name FROM departments WHERE active = TRUE AND organization_id = $1", [await organizationId()])).rows;
  const byId = new Map(rows.map((row) => [Number(row.id), row.name]));
  const targets = new Set(own.flatMap((id) => TASK_HANDOFF[byId.get(id)] || []));
  return [...new Set([...own, ...rows.filter((row) => targets.has(row.name)).map((row) => Number(row.id))])];
}

/** The assignee's department the caller may hand work to, per TASK_HANDOFF. */
async function handoffDepartment(callerDepartmentIds, assigneeDepartmentIds) {
  if (!callerDepartmentIds.length || !assigneeDepartmentIds.length) return null;
  const rows = (await query("SELECT id, name FROM departments WHERE id = ANY($1::int[]) AND active = TRUE", [[...callerDepartmentIds, ...assigneeDepartmentIds].map(Number)])).rows;
  const name = new Map(rows.map((row) => [Number(row.id), row.name]));
  const allowed = new Set(callerDepartmentIds.flatMap((id) => TASK_HANDOFF[name.get(Number(id))] || []));
  const target = assigneeDepartmentIds.map(Number).find((id) => allowed.has(name.get(id)));
  return target || null;
}

/** Whether the caller may create/assign tasks at all. */
export async function mayAssign(req) {
  const ctx = await callerContext(req);
  if (ctx.isAdmin) return true;
  return hasPermission(ctx.userId, "assign_tasks");
}

export async function mayReview(req) {
  const ctx = await callerContext(req);
  if (ctx.isAdmin) return true;
  return hasPermission(ctx.userId, "review_tasks");
}

/** Whether `userId` may review work assigned by this caller. */
export async function mayAssignReviewer(req, userId) {
  const ctx = await callerContext(req);
  const reviewer = await userRow(userId);
  if (!reviewer || !reviewer.active || Number(reviewer.organization_id) !== Number(ctx.org)) return false;
  if (!await hasPermission(userId, "review_tasks")) return false;
  if (ctx.isAdmin || ctx.scope === "organization") return true;
  const allowed = new Set((await assignableDepartmentIds(ctx.departments)).map(Number));
  return (reviewer.departments || []).some((departmentId) => allowed.has(Number(departmentId)));
}

/**
 * Whether the caller may assign work to `assigneeId`.
 * Returns { ok, reason?, assignee?, departmentId? }.
 */
export async function canAssignTo(req, assigneeId) {
  const ctx = await callerContext(req);
  const granted = ctx.isAdmin ? true : await hasPermission(ctx.userId, "assign_tasks");
  if (!granted) return { ok: false, reason: "assignment requires the assign_tasks permission" };
  const assignee = await userRow(assigneeId);
  if (!assignee || !assignee.active || Number(assignee.organization_id) !== Number(ctx.org)) {
    return { ok: false, reason: "assignee not found" };
  }
  if (ctx.isAdmin || ctx.scope === "organization") {
    return { ok: true, assignee, departmentId: (assignee.departments || [])[0] || null };
  }
  if (ctx.scope === "department") {
    const mine = new Set((ctx.departments || []).map(Number));
    const shared = (assignee.departments || []).map(Number).filter((id) => mine.has(id));
    if (shared.length) return { ok: true, assignee, departmentId: shared[0] };
    // Declared cross-department hand-offs only (e.g. Sales → Customer Service).
    const handoff = await handoffDepartment(ctx.departments || [], assignee.departments || []);
    if (handoff) return { ok: true, assignee, departmentId: handoff };
    return { ok: false, reason: "assignee is outside your department scope" };
  }
  return { ok: false, reason: "your scope may not assign tasks" };
}

/**
 * Whether the caller may act as reviewer/approver on this task row.
 *
 * A NAMED reviewer is binding: organization scope does not override it, because
 * the whole point of routing work to the configured reviewer is that the MD is
 * not a universal fallback. Organization scope (and the administrator) may only
 * act on a slot that names nobody yet.
 *
 * Nobody may review or approve a submission they made themselves.
 */
export async function canReviewTask(req, task) {
  const ctx = await callerContext(req);
  const granted = ctx.isAdmin ? true : await hasPermission(ctx.userId, "review_tasks");
  if (!granted) return { ok: false, reason: "review requires the review_tasks permission" };
  const named = task?.reviewer_id !== null && task?.reviewer_id !== undefined;
  if (named && Number(task.reviewer_id) !== Number(ctx.userId)) {
    return { ok: false, reason: "you are not this task's reviewer" };
  }
  if (Number(task?.submitted_by) === Number(ctx.userId)) {
    return { ok: false, reason: "you cannot review your own submission" };
  }
  return { ok: true };
}
