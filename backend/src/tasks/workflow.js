// ---------------------------------------------------------------------------
// MKUYU task-assignment workflow.
//
// Additive organization workflow: WHO assigned WHAT to WHOM, with priority,
// due date, a controlled status lifecycle, submission/review/approval and an
// attention (badge) count. Never touches contracts/pricing/payments.
// ---------------------------------------------------------------------------

/** Task priorities. Stored server-side, filterable and never color-only. */
export const TASK_PRIORITIES = ["urgent", "high", "medium", "low"];

/** Controlled task lifecycle. */
export const TASK_STATUSES = [
  "assigned",
  "in_progress",
  "submitted",
  "under_review",
  "approved",
  "changes_requested",
  "completed",
  "cancelled",
];

/**
 * Allowed lifecycle edges. Review/approval can never be bypassed:
 * submitted must pass through under_review before approved, and only an
 * authorized reviewer may approve or request changes from under_review.
 */
export const TASK_TRANSITIONS = {
  assigned: ["in_progress", "cancelled"],
  in_progress: ["submitted", "cancelled"],
  submitted: ["under_review", "cancelled"],
  under_review: ["approved", "changes_requested", "cancelled"],
  approved: ["completed", "cancelled"],
  changes_requested: ["in_progress", "cancelled"],
  completed: [],
  cancelled: [],
};

/** Records a task may reference. The task stores a pointer, never a copy. */
export const TASK_LINK_ENTITIES = new Set([
  "client",
  "property",
  "contract",
  "payment",
  "debt",
  "project",
  "report",
  "document",
  "appointment",
]);

/** Audit/history events written to the existing audit_logs table. */
export const TASK_AUDIT_ACTIONS = new Set([
  "task_created",
  "task_assigned",
  "task_reassigned",
  "task_status_changed",
  "task_submitted",
  "task_review_started",
  "task_approved",
  "task_changes_requested",
  "task_completed",
  "task_cancelled",
  "task_commented",
]);

export function isTaskPriority(value) {
  return TASK_PRIORITIES.includes(String(value || "").toLowerCase());
}

export function normalizeTaskPriority(value) {
  return String(value || "").toLowerCase();
}

export function isTaskStatus(value) {
  return TASK_STATUSES.includes(String(value || "").toLowerCase());
}

export function normalizeTaskStatus(value) {
  return String(value || "").toLowerCase();
}

/** Whether the lifecycle permits moving from one status to another. */
export function canTransitionTask(from, to) {
  const next = TASK_TRANSITIONS[normalizeTaskStatus(from)] || [];
  return next.includes(normalizeTaskStatus(to));
}

/**
 * "Mark as done": the person who ASSIGNED the task closes it once the assignee
 * has handed the work in. It approves (when not yet approved) and completes in
 * one step, so the assigner is the approver of record. Guards:
 *   - only the assigner, and only while they still hold assign_tasks;
 *   - only after the assignee submitted (submitted / under_review / approved);
 *   - a NAMED reviewer other than the assigner keeps the decision until approval;
 *   - nobody approves their own submission;
 *   - a customer request must go through Approve (it books the appointment and
 *     registers the client), so its shortcut is available only once approved.
 */
export function markDoneAllowed(task, userId, canAssign) {
  const me = Number(userId);
  const status = normalizeTaskStatus(task?.status);
  if (!canAssign || Number(task?.assigned_by) !== me) return false;
  if (status === "approved") return true;
  if (!["submitted", "under_review"].includes(status)) return false;
  if (task?.request_id) return false;
  const reviewer = task?.reviewer_id === null || task?.reviewer_id === undefined ? null : Number(task.reviewer_id);
  if (reviewer !== null && reviewer !== me) return false;
  return Number(task?.submitted_by) !== me;
}

/**
 * Backend-authorized actions for one task row and one caller.
 *
 * Returns plain action keys the UI may render as buttons. This is a display
 * hint only: every action is re-authorized server-side before it runs.
 */
export function taskActionsFor(task, userId, { canAssign, canReview } = {}) {
  const me = Number(userId);
  const actions = [];
  const status = normalizeTaskStatus(task?.status);
  const mine = Number(task?.assigned_to) === me;
  const reviewer = task?.reviewer_id === null || task?.reviewer_id === undefined
    ? null
    : Number(task.reviewer_id);
  const iReview = reviewer !== null && reviewer === me && canReview;
  if (mine && status === "assigned") actions.push("start");
  if (mine && (status === "in_progress" || status === "changes_requested")) actions.push("submit");
  if (iReview && status === "submitted") actions.push("begin_review");
  if (iReview && status === "under_review") actions.push("approve", "request_changes");
  if (mine && status === "approved") actions.push("complete");
  if (markDoneAllowed(task, me, canAssign) && !actions.includes("complete")) actions.push("mark_done");
  if (canAssign && !["completed", "cancelled"].includes(status)) actions.push("cancel");
  return actions;
}
