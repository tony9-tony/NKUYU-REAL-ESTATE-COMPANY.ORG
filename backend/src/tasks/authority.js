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
    if (!shared.length) return { ok: false, reason: "assignee is outside your department scope" };
    return { ok: true, assignee, departmentId: shared[0] };
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
