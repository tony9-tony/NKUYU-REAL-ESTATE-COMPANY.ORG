# MKUYU Real Estate System

Internal MKUYU real estate workspace with projects, properties, clients, contracts, installments, payments, reports, organization management, RBAC, leads, follow-ups, approvals, and audit activity.

## Run locally

```powershell
npm install
npm run seed
npm start
```

The application runs at `http://localhost:3003`.

The first account is created from the private setup screen and receives the initial System Administrator role. There is no public signup after the workspace is configured.

## Organization API

Authenticated organization endpoints are under `/api/v1/org`:

- `/me`
- `/departments`
- `/roles`
- `/permissions`
- `/users`
- `/audit`
- `/leads`
- `/follow-ups`
- `/approvals`
- `/tasks` — the task-assignment workflow (see below)

All organization mutations are permission-checked server-side and important changes are recorded in `audit_logs`.

## Task assignments

An organization task carries who assigned the work, who received it, instructions, a
priority rank, a due date, a status, the reviewer, and an audit trail.

**Model** — `backend/src/tasks/workflow.js` declares the vocabulary and the lifecycle;
`backend/src/tasks/tasks.js` persists and scopes it; `backend/src/tasks/authority.js`
decides who may act; `backend/src/routes/tasks.js` exposes it under `/api/v1/org/tasks`.

- **Priority** is exactly `urgent`, `high`, `medium`, `low`, stored in a `CHECK`
  constraint, filterable, and rendered as a word as well as a colour.
- **Status** is a controlled lifecycle: `assigned → in_progress → submitted →
  under_review → approved → completed`, with `under_review → changes_requested →
  in_progress` as the return path and `cancelled` available from any open state.
  `TASK_TRANSITIONS` is the only place an edge is declared, and the server refuses
  anything else — review cannot be skipped, because `submitted → approved` is not an edge.
- **Attention badge** — `GET /org/tasks/attention` counts the rows that actually need
  the caller: new or returned work they own, plus work awaiting their review. The
  navigation badge is that number, refreshed on load and after every task action.

### The two additive permissions

The existing permission list had no notion of handing work to somebody, so two keys
were added — `assign_tasks` and `review_tasks` — and nothing else was changed. They
are granted only to roles that already carry organizational authority: the System
Administrator, the Managing Director, and the department managers (Legal, Finance,
Department, Customer Service). Officers and staff hold neither.

`assign_tasks` is necessary but not sufficient: `authority.js` also requires the
assignee to be inside the caller's scope. Organization scope (MD, admin) may assign
organization-wide; department scope may assign only within its own departments;
own scope may assign to nobody. A task may never name its own assignee as reviewer,
and `canReviewTask` refuses a named reviewer to anyone else — organization scope does
**not** override it, because routing work to the configured reviewer rather than
defaulting to the MD is the point. Nobody may review or approve a submission they
made themselves.

### Server-authoritative fields

`assigned_by`, `submitted_by`, `submitted_at`, `reviewed_at`, `approved_by`,
`approved_at`, `completed_by`, `completed_at` and the initial `status` are all stamped
by the server from the session and the transition. They are accepted from a request
only to be ignored. The UI renders a task's `available_actions` as its buttons, but
that is presentation: every endpoint re-checks the caller before it acts.

Tasks may reference an existing `client`, `property`, `contract`, `payment`, `debt`,
`project`, `report`, `document` or `appointment` by id. The referenced row is
verified to exist and then left untouched — a task points at a record, it never
copies one.

Run `npm run test:tasks` for the focused suite (it uses the isolated
`mkuyu_org_test` database and never touches `mkuyu_org`).


## Frontend design

The interface follows the Banani design language: a solid deep-green navigation rail with a gold active state, white cards on a light neutral canvas, and DM Sans throughout. A pre-redesign copy of `index.html`, `app.css` and `app.js` is kept in `data/backups/ui-before-banani/`.

Two dev utilities support the stylesheet:

- `node tools/list_css_classes.mjs --check` — reports any class the JS can emit that the stylesheet never defines. Run it after any render change.
- `node tools/check_css_balance.mjs` — reports unmatched braces and declarations that escaped their rule. Run it after any stylesheet edit.
- `node tools/verify_duties.mjs` — checks the approval diagram against the enforced state machine, and confirms the duty endpoint leaks no records. Takes `DEMO_EMAIL` to check a different role.
- `node tools/verify_live_ui.mjs` — confirms the running server (and the ngrok tunnel) are serving the current frontend.

Only `frontend/` holds the live interface; the server serves that directory and nothing else. An earlier copy of `index.html`, `app.css` and `app.js` sat in the repository root and was removed so that a later edit cannot silently target a file the browser never loads.

## Duties & approvals

The **Duties & approvals** view (`GET /org/duties`) publishes two things that previously existed only in code:

- **The approval path** — all nine pipeline stages in the order a contract actually moves through them, each with the department that holds the contract at that step, the department that moves it there, and the permission that permits the move. The three off-pipeline states (changes requested, rejected, cancelled) are listed separately.
- **Every duty on every department** — 6 departments, 16 roles and 78 duties, each duty carrying its description and the permissions granted to perform it.

The stage data is derived from `CONTRACT_ACTIONS` in `backend/src/contracts/workflow.js` rather than written by hand, so the diagram cannot drift from the state machine the server enforces. `tools/verify_duties.mjs` asserts that every stage's acting department is one `CONTRACT_OWNERSHIP` really grants that permission, and that the Sales handover to Legal happens at step 2.

### What this endpoint deliberately does and does not do

It is open to any signed-in member, unlike `GET /org/access-matrix`, which stays administrator-only. The distinction is deliberate: the duty catalogue and the approval path are organizational reference data and contain no business record, no other person's data, and no way to act. The access matrix additionally reports which permissions each role *really holds* and runs the misconfiguration audit, so it keeps the stricter gate.

The caller's own permissions are echoed back so the UI can mark which steps are theirs. That is a highlight, never a grant — a stage or duty is marked "yours" only when the caller holds every permission it needs, and the buttons that actually move a contract still come from each contract's server-computed `available_actions`. `tools/verify_duties.mjs` fails if a stage or duty is ever marked for someone who lacks the permission, and if the payload ever grows a record field.

### Why the stylesheet integrity check exists

`frontend/css/app.css` once contained four separate brace errors, including an unclosed `.sidebar-footer` rule. A CSS parser does not stop at a missing `}` — it keeps reading until the next one, so roughly 700 lines of rules were silently re-parented as children of `.sidebar-footer` and never applied. The visible symptoms were content sliding underneath the sidebar, unstyled inputs, and default-styled buttons.

The failure mode is specific: the sheet had a *net-zero* brace imbalance, so counting `{` against `}` reported a clean balance while the page was broken. `tools/check_css_balance.mjs` and the equivalent inline check in `ui_audit_regression.mjs` track nesting position instead of totals, and also flag any line sitting at depth 0 that is not a selector, at-rule or comment.

## Known issue: the ngrok tunnel points at the wrong port

`https://error-unnamable-borrower.ngrok-free.dev` forwards to **port 3001**, not to this application's 3003. Port 3001 is a separate Node process (`node backend/src/server.js`, PID 12060) running from a *different* project copy — `C:\Users\nic\Desktop\RealEstate-System`, last edited 24 Sep — so the tunnel serves that project's older build.

This predates the UI work and was left running as found. To point the tunnel at this application, repoint or restart ngrok against port 3003. Use `node tools/check_tunnel.mjs` to confirm the current mapping and `node tools/check_port.mjs <port>` to identify what a given port is serving.

