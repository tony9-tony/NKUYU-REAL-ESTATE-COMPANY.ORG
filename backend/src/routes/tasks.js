// ---------------------------------------------------------------------------
// Task assignment endpoints, mounted under /org/tasks (additive).
// Every write re-checks authority server-side. The UI only renders the
// backend-computed available_actions; hiding a button is never security.
// ---------------------------------------------------------------------------
import { Router } from "express";
import { query, queryOne } from "../db.js";
import { organizationId } from "../org/rbac.js";
import { currentAccess } from "../org/access.js";
import { audit } from "../org/audit.js";
import { TASK_PRIORITIES, TASK_STATUSES, TASK_LINK_ENTITIES, canTransitionTask, normalizeTaskPriority, normalizeTaskStatus, taskActionsFor } from "../tasks/workflow.js";
import { attentionCount, linkedRecordExists, listComments, listHistory, listTasks, taskVisible } from "../tasks/tasks.js";
import { assignableDepartmentIds, canAssignTo, canReviewTask, mayAssign, mayReview } from "../tasks/authority.js";

const router = Router();
const MAX_INT4 = 2147483647;
const id = (value, field = "id") => { const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > MAX_INT4) { const e = new Error(`${field} must be a positive integer`); e.status = 400; throw e; } return n; };
const text = (value, field, max = 160) => { if (typeof value !== "string" || !value.trim() || value.trim().length > max) { const e = new Error(`${field} is required`); e.status = 400; throw e; } return value.trim(); };
const maybeText = (value, field, max = 2000) => { if (value === undefined || value === null || value === "") return null; if (typeof value !== "string" || value.trim().length > max) { const e = new Error(`${field} is invalid`); e.status = 400; throw e; } return value.trim(); };
// A due date is a CALENDAR date, not an instant. "05 October 2026" must read
// back as 2026-10-05 everywhere, so a date-only value is stored as midnight in
// the server's own time zone rather than being shifted through UTC.
const due = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const raw = String(value).trim();
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]} 00:00:00`;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) { const e = new Error("due_date is invalid"); e.status = 400; throw e; }
  return parsed.toISOString().slice(0, 19).replace("T", " ");
};
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

async function decorate(task, req) {
  if (!task) return task;
  const access = req.access || (await currentAccess());
  return { ...task, available_actions: taskActionsFor(task, req.user.id, { canAssign: await mayAssign(req), canReview: await mayReview(req) }), scope: access?.scope || "own" };
}

async function writeAudit(req, action, task, from, comment = null) {
  await audit(req, action, "task", task.id, { from: from || null, to: task.status, assigned_to: task.assigned_to, reviewer_id: task.reviewer_id || null, ...(comment ? { comment } : {}) });
}

router.get("/attention", route(async (req, res) => { res.json(await attentionCount(req.access || (await currentAccess()))); }));

router.get("/assignees", route(async (req, res) => {
  if (!await mayAssign(req)) return res.status(403).json({ error: "assignment requires the assign_tasks permission" });
  const org = await organizationId();
  const access = req.access || (await currentAccess());
  const values = [org];
  let scope = "";
  if (!(req.user?.role === "admin" || access?.isAdmin || access?.scope === "organization")) {
    // Own departments plus declared hand-offs (Sales → Customer Service).
    const departments = await assignableDepartmentIds(access?.departmentIds || []);
    if (!departments.length) return res.json([]);
    values.push(departments);
    scope = `AND EXISTS (SELECT 1 FROM user_departments ud JOIN departments d ON d.id=ud.department_id WHERE ud.user_id=u.id AND d.active=TRUE AND ud.department_id = ANY($${values.length}))`;
  }
  // ?department=<name> narrows the list to one department (a hand-off to
  // Customer Service lists only Customer Service). It can only narrow.
  if (req.query.department) {
    values.push(String(req.query.department).trim().toUpperCase());
    scope += ` AND EXISTS (SELECT 1 FROM user_departments ud2 JOIN departments d2 ON d2.id=ud2.department_id WHERE ud2.user_id=u.id AND d2.active=TRUE AND UPPER(d2.name)=$${values.length})`;
  }
  res.json((await query(`SELECT u.id, u.display_name, u.email,
      COALESCE((SELECT json_agg(json_build_object('id', d.id, 'name', d.name) ORDER BY d.name) FROM user_departments ud JOIN departments d ON d.id=ud.department_id WHERE ud.user_id=u.id AND d.active=TRUE), '[]'::json) AS departments
    FROM users u WHERE u.organization_id=$1 AND u.active=TRUE ${scope} ORDER BY u.display_name LIMIT 200`, values)).rows);
}));

router.get("/departments", route(async (req, res) => {
  if (!await mayAssign(req)) return res.status(403).json({ error: "assignment requires the assign_tasks permission" });
  const org = await organizationId();
  const access = req.access || (await currentAccess());
  const everyone = req.user?.role === "admin" || access?.isAdmin || access?.scope === "organization";
  const ids = everyone ? null : await assignableDepartmentIds(access?.departmentIds || []);
  res.json((await query(`SELECT d.id, d.name,
      (SELECT COUNT(*) FROM user_departments ud JOIN users u ON u.id=ud.user_id WHERE ud.department_id=d.id AND u.active)::int AS active_members
    FROM departments d WHERE d.organization_id=$1 AND d.active AND ($2::int[] IS NULL OR d.id = ANY($2::int[])) ORDER BY d.name`, [org, ids])).rows);
}));

router.get("/reviewers", route(async (req, res) => {
  if (!await mayAssign(req)) return res.status(403).json({ error: "assignment requires the assign_tasks permission" });
  const org = await organizationId();
  res.json((await query(`SELECT DISTINCT u.id, u.display_name, u.email FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id AND r.active=TRUE JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id WHERE u.organization_id=$1 AND u.active=TRUE AND p.permission_key='review_tasks' ORDER BY u.display_name LIMIT 200`, [org])).rows);
}));

router.get("/", route(async (req, res) => {
  const status = req.query.status ? normalizeTaskStatus(req.query.status) : null;
  const priority = req.query.priority ? normalizeTaskPriority(req.query.priority) : null;
  if (req.query.status && !TASK_STATUSES.includes(status)) return res.status(400).json({ error: "status is invalid" });
  if (req.query.priority && !TASK_PRIORITIES.includes(priority)) return res.status(400).json({ error: "priority is invalid" });
  const box = req.query.box ? String(req.query.box) : null;
  if (box && !["all", "mine", "assigned_by_me", "needs_review"].includes(box)) return res.status(400).json({ error: "box is invalid" });
  const rows = await listTasks({ status, priority, box, search: req.query.search || null }, req.access || (await currentAccess()));
  res.json(await Promise.all(rows.map((row) => decorate(row, req))));
}));

router.get("/:id", route(async (req, res) => {
  const task = await taskVisible(id(req.params.id, "task_id"), req.access || (await currentAccess()));
  if (!task) return res.status(404).json({ error: "task not found" });
  const decorated = await decorate(task, req);
  res.json({ ...decorated, comments: await listComments(task.id), history: await listHistory(task.id) });
}));

router.post("/", route(async (req, res) => {
  const body = req.body || {};
  const title = text(body.title, "title", 160);
  const description = maybeText(body.description, "description", 4000);
  const priority = normalizeTaskPriority(body.priority || "medium");
  if (!TASK_PRIORITIES.includes(priority)) return res.status(400).json({ error: "priority must be urgent, high, medium or low" });
  const assigneeId = id(body.assigned_to, "assigned_to");
  const grant = await canAssignTo(req, assigneeId);
  if (!grant.ok) return res.status(403).json({ error: grant.reason });
  let reviewerId = null;
  if (body.reviewer_id !== undefined && body.reviewer_id !== null && body.reviewer_id !== "") {
    reviewerId = id(body.reviewer_id, "reviewer_id");
    const found = (await query("SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND active=TRUE", [reviewerId, await organizationId()])).rows[0];
    if (!found) return res.status(400).json({ error: "reviewer not found" });
    if (Number(reviewerId) === Number(assigneeId)) return res.status(400).json({ error: "reviewer cannot be the assignee" });
  }
  let linkEntity = null;
  let linkId = null;
  if ((body.linked_entity || body.linked_record_id) && !(body.linked_entity && body.linked_record_id)) return res.status(400).json({ error: "linked_entity and linked_record_id must be sent together" });
  if (body.linked_entity && body.linked_record_id) {
    linkEntity = String(body.linked_entity).toLowerCase();
    linkId = id(body.linked_record_id, "linked_record_id");
    if (!TASK_LINK_ENTITIES.has(linkEntity)) return res.status(400).json({ error: "linked_entity is invalid" });
    if (!await linkedRecordExists(linkEntity, linkId)) return res.status(400).json({ error: "linked record not found" });
  }
  const access = req.access || (await currentAccess());
  const departmentId = body.department_id !== undefined && body.department_id !== null && body.department_id !== "" ? id(body.department_id, "department_id") : (grant.departmentId || (access?.departmentIds || [])[0] || null);
  const visibility = access?.isAdmin || access?.scope === "organization" ? "organization" : departmentId ? "department" : "own";
  const created = await queryOne("INSERT INTO tasks (organization_id,title,description,assigned_by,assigned_to,reviewer_id,department_id,visibility,priority,due_date,status,linked_entity,linked_record_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'assigned',$11,$12,$13) RETURNING id", [await organizationId(), title, description, req.user.id, assigneeId, reviewerId, departmentId, visibility, priority, due(body.due_date), linkEntity, linkId, req.user.id]);
  const task = await taskVisible(created.id, req.access || (await currentAccess()));
  await writeAudit(req, "task_created", task, null);
  await writeAudit(req, "task_assigned", task, null);
  res.status(201).json(await decorate(task, req));
}));

router.post("/action", route(async (req, res) => {
  return res.status(400).json({ error: "use POST /org/tasks/:id/actions" });
}));

async function applyTransition(req, res, task, from, access, to, patch, auditAction, comment) {
  if (!canTransitionTask(from, to)) return res.status(400).json({ error: "cannot move task from " + from + " to " + to });
  const keys = Object.keys(patch || {});
  const sets = ["status=$1", "updated_at=NOW()"];
  keys.forEach((key, i) => sets.push(key + "=$" + (i + 2)));
  const updated = await queryOne("UPDATE tasks SET " + sets.join(", ") + " WHERE id=$" + (keys.length + 2) + " RETURNING id", [to].concat(keys.map((key) => patch[key]), [task.id]));
  const next = await taskVisible(updated.id, access);
  await writeAudit(req, auditAction, next, from, comment);
  if (comment) {
    await query("INSERT INTO task_comments (task_id, author_id, body) VALUES ($1,$2,$3)", [task.id, req.user.id, comment]);
    await writeAudit(req, "task_commented", next, from, comment);
  }
  res.json(await decorate(next, req));
}

router.post("/:id/actions", route(async (req, res) => {
  const taskId = id(req.params.id, "task_id");
  const action = String(req.body?.action || "").toLowerCase();
  const comment = maybeText(req.body?.comment, "comment", 2000);
  const access = req.access || (await currentAccess());
  const task = await taskVisible(taskId, access);
  if (!task) return res.status(404).json({ error: "task not found" });
  const from = normalizeTaskStatus(task.status);
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  if (action === "start") {
    if (Number(task.assigned_to) !== Number(req.user.id)) return res.status(403).json({ error: "only the assignee may start this task" });
    return applyTransition(req, res, task, from, access, "in_progress", {}, "task_status_changed", comment);
  }
  if (action === "submit") {
    if (Number(task.assigned_to) !== Number(req.user.id)) return res.status(403).json({ error: "only the assignee may submit this task" });
    return applyTransition(req, res, task, from, access, "submitted", { submitted_by: req.user.id, submitted_at: stamp }, "task_submitted", comment);
  }
  if (action === "begin_review") {
    const grant = await canReviewTask(req, task);
    if (!grant.ok) return res.status(403).json({ error: grant.reason });
    return applyTransition(req, res, task, from, access, "under_review", { reviewed_at: stamp }, "task_review_started", comment);
  }
  if (action === "approve") {
    const grant = await canReviewTask(req, task);
    if (!grant.ok) return res.status(403).json({ error: grant.reason });
    if (Number(task.submitted_by) === Number(req.user.id)) return res.status(403).json({ error: "you cannot approve your own submission" });
    return applyTransition(req, res, task, from, access, "approved", { approved_by: req.user.id, approved_at: stamp }, "task_approved", comment);
  }
  if (action === "request_changes") {
    const grant = await canReviewTask(req, task);
    if (!grant.ok) return res.status(403).json({ error: grant.reason });
    if (!comment) return res.status(400).json({ error: "a review comment is required to request changes" });
    if (Number(task.submitted_by) === Number(req.user.id)) return res.status(403).json({ error: "you cannot review your own submission" });
    return applyTransition(req, res, task, from, access, "changes_requested", {}, "task_changes_requested", comment);
  }
  if (action === "complete") {
    if (Number(task.assigned_to) !== Number(req.user.id)) {
      const grant = await canReviewTask(req, task);
      if (!grant.ok) return res.status(403).json({ error: "only the assignee may complete this task" });
    }
    return applyTransition(req, res, task, from, access, "completed", { completed_by: req.user.id, completed_at: stamp }, "task_completed", comment);
  }
  if (action === "cancel") {
    if (!await mayAssign(req)) return res.status(403).json({ error: "cancelling requires the assign_tasks permission" });
    if (!(Number(task.assigned_by) === Number(req.user.id) || req.user?.role === "admin" || access?.scope === "organization")) return res.status(403).json({ error: "only the assigner may cancel this task" });
    return applyTransition(req, res, task, from, access, "cancelled", {}, "task_cancelled", comment);
  }
  return res.status(400).json({ error: "action must be start, submit, begin_review, approve, request_changes, complete or cancel" });
}));

router.put("/reassign", route(async (req, res) => {
  return res.status(400).json({ error: "use PUT /org/tasks/:id/assign" });
}));

router.put("/:id/assign", route(async (req, res) => {
  const taskId = id(req.params.id, "task_id");
  const access = req.access || (await currentAccess());
  const task = await taskVisible(taskId, access);
  if (!task) return res.status(404).json({ error: "task not found" });
  if (["completed", "cancelled"].includes(normalizeTaskStatus(task.status))) return res.status(400).json({ error: "completed or cancelled tasks cannot be reassigned" });
  const assigneeId = id(req.body?.assigned_to, "assigned_to");
  const grant = await canAssignTo(req, assigneeId);
  if (!grant.ok) return res.status(403).json({ error: grant.reason });
  let reviewerId = task.reviewer_id;
  if (req.body?.reviewer_id !== undefined) {
    if (req.body.reviewer_id === null || req.body.reviewer_id === "") reviewerId = null;
    else reviewerId = id(req.body.reviewer_id, "reviewer_id");
    if (reviewerId && Number(reviewerId) === Number(assigneeId)) return res.status(400).json({ error: "reviewer cannot be the assignee" });
  }
  const from = normalizeTaskStatus(task.status);
  const resetTo = ["submitted", "under_review", "approved"].includes(from) ? "assigned" : from;
  const updated = await queryOne("UPDATE tasks SET assigned_to=$1, reviewer_id=$2, department_id=COALESCE($3,department_id), status=$4, updated_at=NOW() WHERE id=$5 RETURNING id", [assigneeId, reviewerId, grant.departmentId || null, resetTo, taskId]);
  const next = await taskVisible(updated.id, access);
  await writeAudit(req, "task_reassigned", next, from);
  res.json(await decorate(next, req));
}));

router.post("/:id/comments", route(async (req, res) => {
  const taskId = id(req.params.id, "task_id");
  const access = req.access || (await currentAccess());
  const task = await taskVisible(taskId, access);
  if (!task) return res.status(404).json({ error: "task not found" });
  const body = text(req.body?.body, "body", 2000);
  const party = [task.assigned_to, task.assigned_by, task.reviewer_id, task.created_by].map(Number);
  if (!party.includes(Number(req.user.id)) && !(access?.isAdmin || access?.scope === "organization")) return res.status(403).json({ error: "you may not comment on this task" });
  const created = await queryOne("INSERT INTO task_comments (task_id, author_id, body) VALUES ($1,$2,$3) RETURNING *", [taskId, req.user.id, body]);
  await writeAudit(req, "task_commented", task, normalizeTaskStatus(task.status), body);
  res.status(201).json(created);
}));

export default router;
