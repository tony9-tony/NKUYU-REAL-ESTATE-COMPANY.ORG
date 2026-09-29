// Task assignment / attention badge / submit-review-approve workflow test.
//
// Isolated by construction: it must be started with
//   node --import ./test_support/guard.mjs task_assignment_test.mjs
// which repoints DATABASE_URL at mkuyu_org_test and refuses to run against
// mkuyu_org. The harness additionally spawns its own API server bound to that
// throwaway database, so nothing here can reach live business data.
import { query, queryOne, closeDatabase } from "./backend/src/db.js";
import { assertTestDatabase, prepareTestDatabase, startIsolatedServer, reapOrphanServers } from "./test_support/harness.mjs";
import { demoPasswordFor } from "./backend/src/org/demoCredentials.js";
import { TASK_TRANSITIONS, canTransitionTask } from "./backend/src/tasks/workflow.js";

reapOrphanServers();
const testDb = await assertTestDatabase("task_assignment_test");
// Schema, roles, departments, duties and the seeded accounts. This is what makes
// the sign-ins below possible, and it only ever touches the throwaway database.
await prepareTestDatabase();

let failures = 0;
const check = (condition, label) => {
  console.log(`${condition ? "ok  " : "FAIL"}  ${label}`);
  if (!condition) failures += 1;
};

const server = await startIsolatedServer({ port: Number(process.env.TASKS_PORT || 3189), label: "tasks" });
const BASE = server.base;

async function call(pathname, { token, method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${BASE}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

async function signIn(email) {
  const res = await call("/auth/login", { method: "POST", body: { email, password: demoPasswordFor(email) } });
  if (res.status !== 200) throw new Error(`sign-in failed for ${email}: ${res.status} ${JSON.stringify(res.payload)}`);
  return res.payload.token;
}

// /org/me is the authorization bootstrap: it carries the caller's real
// permissions, effective scope and the server-computed attention count.
const me = async (token) => (await call("/org/me", { token })).payload;

const ACCOUNTS = {
  // The administrator is the legacy account; every business role is a demo one.
  admin: "admin@mkuyu.local",
  md: "md@demo.mkuyu.local",
  salesManager: "sales.manager@demo.mkuyu.local",
  sales: "sales@demo.mkuyu.local",
  legalManager: "legal.manager@demo.mkuyu.local",
  finance: "finance@demo.mkuyu.local",
  cs: "cs@demo.mkuyu.local",
};
const sessions = {};
const ids = {};
for (const [name, email] of Object.entries(ACCOUNTS)) {
  sessions[name] = await signIn(email);
  ids[name] = (await queryOne("SELECT id FROM users WHERE email=$1", [email])).id;
}

// A real business record to link a task to, created only in the test database.
const clientRow = await queryOne("INSERT INTO clients (organization_id,name,client_type,status) SELECT id,'Task Test Client','buyer','active' FROM organizations LIMIT 1 RETURNING id");

// The attention badge counts REAL rows, so a stale fixture from an earlier run
// would make the expected numbers wrong. The test database is a throwaway, so
// clearing the task tables here is safe; the live database is never involved.
await query("DELETE FROM task_comments");
await query("DELETE FROM tasks");

const assign = (token, body) => call("/org/tasks", { token, method: "POST", body });
const act = (token, id, body) => call(`/org/tasks/${id}/actions`, { token, method: "POST", body });
const attention = (token) => call("/org/tasks/attention", { token });

// A fresh task owned by the sales manager and reviewed by the sales manager, so
// each stage below starts from a known status.
async function newSalesTask(overrides = {}) {
  const res = await assign(sessions.salesManager, {
    title: "Prepare the September sales report",
    description: "New clients, renewals and completed contracts.",
    assigned_to: ids.sales,
    reviewer_id: ids.salesManager,
    priority: "high",
    due_date: "2026-10-05",
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`fixture creation failed: ${res.status} ${JSON.stringify(res.payload)}`);
  return res.payload.id;
}

try {
  // ---- 0. the additive permissions are wired into the existing RBAC -----------
  console.log("\n=== 0. additive permissions, wired into the existing RBAC ===");
  const adminPerms = (await me(sessions.admin)).permissions;
  const mdPerms = (await me(sessions.md)).permissions;
  const salesManagerPerms = (await me(sessions.salesManager)).permissions;
  const salesPerms = (await me(sessions.sales)).permissions;
  check(adminPerms.includes("assign_tasks") && adminPerms.includes("review_tasks"), "the system administrator holds the task workflow");
  check(mdPerms.includes("assign_tasks") && mdPerms.includes("review_tasks"), "the managing director holds the task workflow");
  check(salesManagerPerms.includes("assign_tasks") && salesManagerPerms.includes("review_tasks"), "a department manager holds the task workflow");
  check(!salesPerms.includes("assign_tasks") && !salesPerms.includes("review_tasks"), "a sales officer holds neither assignment nor review authority");
  check(!mdPerms.some((key) => key.startsWith("manage_")), "the MD gained no system administration from this feature");
  check(!mdPerms.includes("approve_legal") && !mdPerms.includes("review_legal"), "task review did not grant the MD contract legal authority");
  check(!salesPerms.includes("access_debts") && !salesPerms.includes("view_financial"), "task permissions granted no access to any financial module");

  // ---- 1-4. assignment authority ---------------------------------------------
  console.log("\n=== 1-4. assignment authority ===");
  // The fixtures below deliberately assign to accounts whose attention is NOT
  // measured later, so the exact badge numbers asserted further down stay exact.
  // The in-scope fixture is cancelled immediately, which also exercises the
  // cancel edge and keeps it out of everybody's attention count.
  const adminTask = await assign(sessions.admin, { title: "Admin authorized task", assigned_to: ids.cs, priority: "high", due_date: "2026-10-05" });
  check(adminTask.status === 201, "1. an administrator may create an authorized task");
  const mdTask = await assign(sessions.md, { title: "Prepare Monthly Sales Report", assigned_to: ids.salesManager, priority: "high", due_date: "2026-10-05" });
  check(mdTask.status === 201, "2. the MD may create an authorized business task");
  const scoped = await assign(sessions.salesManager, { title: "Department task", assigned_to: ids.sales });
  check(scoped.status === 201, "3. an authorized manager may assign within their department scope");
  const cancelled = await act(sessions.salesManager, scoped.payload.id, { action: "cancel" });
  check(cancelled.status === 200 && cancelled.payload.status === "cancelled", "3b. the assigner may cancel a task");
  check((await assign(sessions.salesManager, { title: "Not my department", assigned_to: ids.finance })).status === 403, "4a. a department manager may NOT assign outside their department (403)");
  check((await assign(sessions.sales, { title: "Self assigned work", assigned_to: ids.sales })).status === 403, "4b. an unauthorized staff member cannot assign (403)");
  check((await assign(sessions.cs, { title: "Self assignment", assigned_to: ids.cs })).status === 403, "4c. a staff member cannot assign themselves unauthorized work (403)");

  // ---- 5-8. the task appears for its assignee, and the badge is real ---------
  console.log("\n=== 5-8. the task appears for the assigned user, and the badge is real ===");
  const taskId = await newSalesTask();
  const mineList = await call("/org/tasks?box=mine", { token: sessions.sales });
  check(mineList.status === 200 && mineList.payload.some((task) => task.id === taskId), "5. the task appears in the assigned user's 'My tasks'");
  // The sales officer holds exactly this one attention item, so the count is
  // exact rather than merely non-zero.
  const salesAttention = await attention(sessions.sales);
  check(salesAttention.payload.mine === 1, `6. the attention badge appears for the assignee (mine=${salesAttention.payload.mine})`);
  check(salesAttention.payload.total === 1, `7. the attention badge count is correct (total=${salesAttention.payload.total})`);
  const startResult = await act(sessions.sales, taskId, { action: "start" });
  check(startResult.status === 200 && startResult.payload.status === "in_progress", "8a. handling the attention item advances the task to In Progress");
  check((await attention(sessions.sales)).payload.total === 0, "8b. the badge drops to zero once the item is handled");

  // ---- 9-11. submit, and who may submit --------------------------------------
  console.log("\n=== 9-11. submission ===");
  const otherSubmit = await act(sessions.salesManager, taskId, { action: "submit" });
  check(otherSubmit.status === 403, "9a. only the assignee may submit (403)");
  const foreignSubmit = await act(sessions.finance, taskId, { action: "submit" });
  check(foreignSubmit.status === 403 || foreignSubmit.status === 404, "9b. another user cannot submit somebody else's task");
  const submitted = await act(sessions.sales, taskId, { action: "submit" });
  check(submitted.status === 200 && submitted.payload.status === "submitted", "9c. the assigned user can submit");
  check(submitted.payload.submitted_at !== null && Number(submitted.payload.submitted_by) === Number(ids.sales), "9d. submitted_by and submitted_at are server-stamped");
  check((submitted.payload.available_actions || []).includes("submit") === false, "10. the Submit action disappears once submitted (backend-authorized)");
  const attentionAfterSubmit = await attention(sessions.sales);
  const reviewerAttention = await attention(sessions.salesManager);
  check(attentionAfterSubmit.payload.total === 0, "11a. the assignee's attention is cleared by submitting");
  check(reviewerAttention.payload.review === 1, "11b. the submitted task becomes an attention item for the correct reviewer");

  // ---- 12-16. the correct reviewer, review, approve, request changes ----------
  console.log("\n=== 12-16. review, approval, and changes requested ===");
  // The reviewer is the configured one: routing to the MD by default is exactly
  // what this feature must NOT do.
  const mdReviewBox = await call("/org/tasks?box=needs_review", { token: sessions.md });
  check(!mdReviewBox.payload.some((task) => task.id === taskId), "12. the work reaches the configured reviewer, not the MD by default");
  check((await call("/org/tasks?box=needs_review", { token: sessions.salesManager })).payload.some((task) => task.id === taskId), "12b. it appears in the configured reviewer's 'Needs my review'");
  check((await act(sessions.md, taskId, { action: "begin_review" })).status === 403, "12c. someone who is not the reviewer cannot begin the review (403)");
  const review = await act(sessions.salesManager, taskId, { action: "begin_review" });
  check(review.status === 200 && review.payload.status === "under_review", "13. the configured reviewer can review");
  check(review.payload.reviewed_at !== null, "13b. review is timestamped server-side");
  check((await act(sessions.salesManager, taskId, { action: "request_changes" })).status === 400, "14a. requesting changes without a comment is refused (400)");
  const changes = await act(sessions.salesManager, taskId, { action: "request_changes", comment: "Please break out renewals separately." });
  check(changes.status === 200 && changes.payload.status === "changes_requested", "14b. the reviewer can request changes");
  check(Number(changes.payload.assigned_to) === Number(ids.sales), "15. the returned task goes back to the assigned person");
  check((await attention(sessions.sales)).payload.total === 1, "15b. the returned task becomes an attention item for the assigned person again");

  // ---- 17-18. approval authority and self-approval --------------------------
  console.log("\n=== 17-18. approval authority ===");
  await act(sessions.sales, taskId, { action: "start" });
  await act(sessions.sales, taskId, { action: "submit" });
  await act(sessions.salesManager, taskId, { action: "begin_review" });
  check((await act(sessions.sales, taskId, { action: "approve" })).status === 403, "17. an unauthorized user cannot approve (403)");
  // A manager outside the department is refused twice over: the task is not even
  // visible to them (404), and the reviewer slot is not theirs (403).
  const foreignApproval = await act(sessions.legalManager, taskId, { action: "approve" });
  check(foreignApproval.status === 403 || foreignApproval.status === 404, `17b. a manager from another department cannot approve (${foreignApproval.status})`);
  check((await act(sessions.md, taskId, { action: "approve" })).status === 403, "17c. organization scope does not override a named reviewer (403)");
  const approved = await act(sessions.salesManager, taskId, { action: "approve" });
  check(approved.status === 200 && approved.payload.status === "approved", "18. the authorized reviewer can approve");
  check(Number(approved.payload.approved_by) === Number(ids.salesManager) && approved.payload.approved_at !== null, "18b. approval is server-stamped, never taken from the request");

  // Self-approval: the MD assigns work to themselves with no reviewer named.
  // MD scope plus `review_tasks` would otherwise let them approve it, so this is
  // exactly the case the self-approval guard exists for.
  const selfReview = await assign(sessions.md, { title: "MD reviews own work", assigned_to: ids.md, priority: "low" });
  check(selfReview.status === 201, "18c. the MD may assign work organization-wide");
  await act(sessions.md, selfReview.payload.id, { action: "start" });
  await act(sessions.md, selfReview.payload.id, { action: "submit" });
  check((await act(sessions.md, selfReview.payload.id, { action: "begin_review" })).status === 403, "18d. a user cannot review their own submission (403)");
  check((await act(sessions.md, selfReview.payload.id, { action: "approve" })).status === 403, "18e. a user cannot approve their own submission (403)");
  // Creating a task that names the assignee as its own reviewer is refused at the
  // door, so the self-approval situation cannot even be constructed deliberately.
  check((await assign(sessions.md, { title: "Self reviewer", assigned_to: ids.sales, reviewer_id: ids.sales })).status === 400, "18f. the assignee may not be named as their own reviewer (400)");

  // ---- 19-22. persistence, audit history, linked records ---------------------
  console.log("\n=== 19-22. persistence, audit, and linked records ===");
  // A due date is a calendar date, so it is read back as one rather than as an
  // instant the driver happens to parse.
  const stored = await queryOne("SELECT priority, to_char(due_date,'YYYY-MM-DD') AS due, description FROM tasks WHERE id=$1", [taskId]);
  check(stored.priority === "high", "19. priority/rank is persisted server-side");
  check(stored.due === "2026-10-05", `20. the due date is persisted server-side (${stored.due})`);
  check(String(stored.description).includes("renewals"), "12c. the assignment instructions are stored and readable by the assignee");

  const history = (await call(`/org/tasks/${taskId}`, { token: sessions.salesManager })).payload.history;
  const actions = history.map((entry) => entry.action);
  for (const expected of ["task_created", "task_assigned", "task_submitted", "task_review_started", "task_approved", "task_changes_requested", "task_commented"]) {
    check(actions.includes(expected), `21. history contains ${expected}`);
  }
  const approvedEntry = history.find((entry) => entry.action === "task_approved");
  check(Boolean(approvedEntry) && Number(approvedEntry.user_id) === Number(ids.salesManager) && approvedEntry.details_json?.from === "under_review" && approvedEntry.details_json?.to === "approved", "21b. the audit entry records actor, previous state and new state");
  const changeEntry = history.find((entry) => entry.action === "task_changes_requested");
  check(typeof changeEntry?.details_json?.comment === "string" && changeEntry.details_json.comment.length > 0, "21c. a review comment is recorded on the changes-requested event");
  const finished = await act(sessions.sales, taskId, { action: "complete" });
  check(finished.status === 200 && finished.payload.status === "completed", "21d. approved work can be completed by the assignee");
  check(finished.payload.completed_at !== null, "completed_at is server-stamped");

  // Linked records are pointers, never copies of the business record.
  const linked = await assign(sessions.md, { title: "Review client follow-up", assigned_to: ids.salesManager, linked_entity: "client", linked_record_id: clientRow.id, priority: "urgent" });
  check(linked.status === 201 && Number(linked.payload.linked_record_id) === Number(clientRow.id), "22. a task may reference an existing client record");
  const clientStillThere = await queryOne("SELECT id, name FROM clients WHERE id=$1", [clientRow.id]);
  check(Boolean(clientStillThere) && clientStillThere.name === "Task Test Client", "22b. the linked business record is untouched");
  check((await assign(sessions.md, { title: "Broken link", assigned_to: ids.salesManager, linked_entity: "client", linked_record_id: 99999999 })).status === 400, "22c. a link to a record that does not exist is refused");
  check((await assign(sessions.md, { title: "Bad entity", assigned_to: ids.salesManager, linked_entity: "user", linked_record_id: ids.sales })).status === 400, "22d. a link to a non-business entity is refused");
  const contracts = (await query("SELECT COUNT(*)::int AS n FROM contracts")).rows[0].n;
  const payments = (await query("SELECT COUNT(*)::int AS n FROM payments")).rows[0].n;
  check(contracts > 0 && payments > 0, `22e. existing contracts and payments are intact (${contracts} contracts, ${payments} payments)`);

  // ---- 15. the security sweep ------------------------------------------------
  console.log("\n=== 15. the security sweep ===");
  const forged = await assign(sessions.md, { title: "Forged author", assigned_to: ids.sales, assigned_by: ids.admin, submitted_by: ids.md, approved_at: "2020-01-01", completed_at: "2020-01-01", status: "approved", priority: "urgent" });
  check(forged.status === 201 && Number(forged.payload.assigned_by) === Number(ids.md), "15a. a caller cannot forge assigned_by (the server stamps the session user)");
  check(forged.payload.submitted_by === null && forged.payload.approved_at === null && forged.payload.completed_at === null, "15b. a caller cannot forge submitted_by / approved_at / completed_at");
  check(forged.payload.status === "assigned", "15c. a caller cannot set the status at creation time");
  check((await assign(sessions.md, { title: "Invented rank", assigned_to: ids.sales, priority: "catastrophic" })).status === 400, "15d. an invented priority is refused (400)");
  const statusJump = await act(sessions.sales, forged.payload.id, { action: "approve" });
  check(statusJump.status === 400 || statusJump.status === 403, "15e. a caller cannot manipulate the status directly (400/403)");
  check((await call(`/org/tasks/${forged.payload.id}/assign`, { token: sessions.sales, method: "PUT", body: { assigned_to: ids.sales, reviewer_id: ids.md } })).status === 403, "15f. a staff member cannot change assigned_to or set a reviewer (403)");
  check((await call(`/org/tasks/${taskId}`, { token: sessions.finance })).status === 404, "15g. a task id the caller may not access is not readable (404)");
  check(!(await call("/org/tasks", { token: sessions.finance })).payload.some((task) => task.id === taskId), "15h. another department's task never appears in a list");
  check((await call("/org/tasks/assignees", { token: sessions.sales })).status === 403, "15i. a staff member cannot enumerate assignable people (403)");
  check((await call("/org/tasks")).status === 401, "15j. the task endpoints are closed to anonymous callers");
  // The assignee is named on a task the sales officer owns, and their own record
  // was never given a reviewer slot they could self-approve.
  const ownRecord = await call(`/org/tasks/${forged.payload.id}`, { token: sessions.sales });
  check(ownRecord.status === 200 && (ownRecord.payload.available_actions || []).includes("approve") === false, "15k. the assignee is never offered Approve");

  // ---- 4. the lifecycle cannot be bypassed -----------------------------------
  console.log("\n=== 4. the lifecycle cannot be bypassed ===");
  check(canTransitionTask("assigned", "submitted") === false, "4a. assigned -> submitted is not a legal edge");
  check(canTransitionTask("submitted", "approved") === false, "4b. submitted -> approved is not a legal edge (review is required)");
  check(canTransitionTask("in_progress", "approved") === false, "4c. in_progress -> approved is not a legal edge");
  check(TASK_TRANSITIONS.changes_requested.includes("in_progress"), "4d. changes_requested -> in_progress is the return path");
  const filtered = await call("/org/tasks?priority=urgent", { token: sessions.md });
  check(filtered.status === 200 && filtered.payload.every((task) => task.priority === "urgent"), "3b. priority is filterable server-side");

  // ---- the data the New Task button depends on ------------------------------
  // The entry point is only usable if these two lists come back, and they are
  // the endpoint an unauthorized caller must be refused by.
  console.log("\n=== the New Task entry point's data is authorized ===");
  const mdAssignees = await call("/org/tasks/assignees", { token: sessions.md });
  check(mdAssignees.status === 200 && Array.isArray(mdAssignees.payload) && mdAssignees.payload.length > 0, "the MD can list the people they may assign to");
  const mdReviewers = await call("/org/tasks/reviewers", { token: sessions.md });
  check(mdReviewers.status === 200 && mdReviewers.payload.length > 0, "the MD can list the people who may review");
  const managerAssignees = await call("/org/tasks/assignees", { token: sessions.salesManager });
  check(managerAssignees.status === 200 && managerAssignees.payload.some((person) => person.id === ids.sales), "a department manager is offered their own department staff");
  check(!managerAssignees.payload.some((person) => person.id === ids.finance), "a department manager is NOT offered anybody outside their department");
  check((await call("/org/tasks/assignees", { token: sessions.sales })).status === 403, "a staff member cannot read the assignable-people list (403)");
  check((await call("/org/tasks/reviewers", { token: sessions.sales })).status === 403, "a staff member cannot read the reviewer list (403)");

  // The create call the modal makes, driven exactly as the form sends it.
  const created = await call("/org/tasks", { token: sessions.md, method: "POST", body: { title: "Prepare Monthly Sales Report", description: "New clients, renewals, completed contracts.", assigned_to: ids.sales, reviewer_id: ids.md, priority: "high", due_date: "2026-10-05" } });
  check(created.status === 201 && created.payload.status === "assigned", "the MD can create and assign a task through the modal's call");
  check(Number(created.payload.assigned_by) === Number(ids.md), "the new task records the MD as the assigner, from the session");
  check((await call("/org/tasks?box=mine", { token: sessions.sales })).payload.some((task) => task.id === created.payload.id), "the assigned user receives the task");
  const mdReviewBadge = await call("/org/tasks/attention", { token: sessions.md });
  check(mdReviewBadge.payload.review === 0, "an assigned task is not yet an attention item for its reviewer");
  await act(sessions.sales, created.payload.id, { action: "start" });
  await act(sessions.sales, created.payload.id, { action: "submit" });
  check((await call("/org/tasks/attention", { token: sessions.md })).payload.review === 1, "once submitted, the reviewer's attention badge counts it");

  console.log(`\nconnected database: ${testDb}`);
  if (failures) throw new Error(`${failures} task check(s) failed`);
  console.log("\nTASK_ASSIGNMENT_ALL_PASSED");
} catch (error) {
  console.error("TASK FAILURE:", error.message);
  if (server.logs.length) console.error("---- server logs ----\n" + server.logs.join(""));
  process.exitCode = 1;
} finally {
  await server.stop();
  try {
    // The test database is a throwaway; clear the tasks this run created so a
    // repeat run starts from a known state.
    await query("DELETE FROM tasks WHERE organization_id = (SELECT id FROM organizations ORDER BY id LIMIT 1)");
  } catch (error) { console.error("cleanup failed:", error.message); }
  await closeDatabase();
}
