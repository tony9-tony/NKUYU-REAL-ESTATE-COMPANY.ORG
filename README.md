# MKUYU Real Estate System

Internal MKUYU real estate workspace with projects, properties, clients, contracts, installments, payments, reports, organization management, RBAC, leads, follow-ups, approvals, and audit activity.

## Run locally

```powershell
npm install
npm start
```

Do not run `npm run seed` on the real database: it resets every demo and legacy account (the administrator included) to the published `MkuDemo#` passwords. It refuses unless `MKUYU_ALLOW_DEMO_RESEED=1` is set.

The application runs at `http://localhost:3003`.

The first account is created from the private setup screen and receives the initial System Administrator role. There is no public signup after the workspace is configured.

## Production deployment security

Before exposing a production instance, set `NODE_ENV=production` and configure a unique `SETUP_TOKEN`; first-account setup is denied in production unless that token is supplied. Use HTTPS at the edge. If a reverse proxy sits in front of Node, set `TRUST_PROXY` to only the proxy IPs/CIDRs that connect directly to this server. Leave it unset when users can reach Node directly. Never use `*` or a public client subnet as the trusted proxy list.

`npm run seed` is for development only and refuses to run with `NODE_ENV=production`. Normal startup runs schema migrations but does not create or reset demo accounts. For local proxy testing, configure `TRUST_PROXY` explicitly rather than relying on forwarded headers from arbitrary clients.

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

The interface uses a dark sidebar with bronze accents on a warm light canvas. Body text is **Manrope** and headings use **Cormorant Garamond** (both from Google Fonts, with system fallbacks). All colours and fonts are CSS variables at the top of `frontend/css/app.css`.

Dev utilities:

- `node tools/list_css_classes.mjs --check` — reports any class the JS can emit that the stylesheet never defines. Run it after any render change.
- `node tools/check_css_balance.mjs` — reports unmatched braces and declarations that escaped their rule. Run it after any stylesheet edit.
- `node tools/verify_duties.mjs` — checks the approval diagram against the enforced state machine, and confirms the duty endpoint leaks no records. Takes `DEMO_EMAIL` to check a different role.
- `node tools/verify_live_ui.mjs` — confirms the running server (and the ngrok tunnel) are serving the current frontend.

Only `frontend/` holds the live interface; the server serves that directory and nothing else. An earlier copy of `index.html`, `app.css` and `app.js` sat in the repository root and was removed so that a later edit cannot silently target a file the browser never loads.

## Duties & approvals

The **Duties & approvals** view (`GET /org/duties`) publishes two things that previously existed only in code:

- **The approval path** — all nine pipeline stages in the order a contract actually moves through them, each with the department that holds the contract at that step, the department that moves it there, and the permission that permits the move. The three off-pipeline states (changes requested, rejected, cancelled) are listed separately.
- **Every duty on every department** — 7 departments, 18 roles and 90 duties, each duty carrying its description and the permissions granted to perform it.

The stage data is derived from `CONTRACT_ACTIONS` in `backend/src/contracts/workflow.js` rather than written by hand, so the diagram cannot drift from the state machine the server enforces. `tools/verify_duties.mjs` asserts that every stage's acting department is one `CONTRACT_OWNERSHIP` really grants that permission, and that the Sales handover to Legal happens at step 2.

### What this endpoint deliberately does and does not do

It is open to any signed-in member, unlike `GET /org/access-matrix`, which stays administrator-only. The distinction is deliberate: the duty catalogue and the approval path are organizational reference data and contain no business record, no other person's data, and no way to act. The access matrix additionally reports which permissions each role *really holds* and runs the misconfiguration audit, so it keeps the stricter gate.

The caller's own permissions are echoed back so the UI can mark which steps are theirs. That is a highlight, never a grant — a stage or duty is marked "yours" only when the caller holds every permission it needs, and the buttons that actually move a contract still come from each contract's server-computed `available_actions`. `tools/verify_duties.mjs` fails if a stage or duty is ever marked for someone who lacks the permission, and if the payload ever grows a record field.

### Why the stylesheet integrity check exists

`frontend/css/app.css` once contained four separate brace errors, including an unclosed `.sidebar-footer` rule. A CSS parser does not stop at a missing `}` — it keeps reading until the next one, so roughly 700 lines of rules were silently re-parented as children of `.sidebar-footer` and never applied. The visible symptoms were content sliding underneath the sidebar, unstyled inputs, and default-styled buttons.

The failure mode is specific: the sheet had a *net-zero* brace imbalance, so counting `{` against `}` reported a clean balance while the page was broken. `tools/check_css_balance.mjs` and the equivalent inline check in `ui_audit_regression.mjs` track nesting position instead of totals, and also flag any line sitting at depth 0 that is not a selector, at-rule or comment.

## Contract workflow

Sales prepares → Legal reviews and approves → Finance validates the money terms → Legal sends it to the MD (when needed) → MD approves → Legal releases it to the customer → the customer signs → active → completed.

Every contract carries a **position** (`GET /contracts` returns it): *Under Sales review*, *Under Legal review*, *Legal approved · Finance review*, *With the MD*, *With the customer*, … The MD dashboard shows how many contracts sit at each step.

- One live Buy (or Rent) contract per property. The property becomes **Reserved** when the contract goes to the customer, **Sold/Rented** when it is active, and available again if that contract is cancelled, rejected or sent back.
- A contract always belongs to a client in the register: typing a new name registers the client (matched by phone or e-mail first).
- **Cash or installments** is chosen when the contract is prepared. Rent price = monthly rent × months.
- When Finance validates, the payment plan (deposit + installments) is created from the contract terms. The customer signature can only be recorded after the deposit is paid and approved.

## Signed contracts made outside the system

The agreement the system generates has no signatures. When a contract is signed on paper, or was prepared outside the system, Legal, Sales or the MD opens the contract and presses **Replace with signed contract**, attaches the scan, photo or PDF and writes who signed it. That file becomes the contract's official copy (**Open signed contract**). Nothing is deleted: the generated agreement and any earlier signed copy stay in Documents, and every upload or replacement is in the audit log. Endpoints: `POST` / `GET /contracts/:id/signed-document`.

## Payments

There is no bank/mobile-money API: Finance records every payment by hand, with proof.

- A payment needs a **transaction reference** (unique — the same reference cannot be entered twice) and **proof** (receipt file or the pasted SMS).
- A payment starts **pending**; only **approved** money counts anywhere (installments, balances, reports). A second Finance person approves it. While MKUYU has only one Finance person, they may approve their own entries — these are marked *self-approved*.
- Approved money is spread over the installments: the chosen installment first, then the oldest unpaid; an overpayment rolls on to the next one.
- Each approved payment gets an MKUYU receipt number (`RCT-YYYY-NNNNNN`) and a PDF receipt (`GET /payments/:id/mkuyu-receipt`).
- Mistakes are **reversed** with a reason (never deleted or edited once approved). Refunds are recorded with proof and need approval too.
- `GET /contracts/:id/account` gives one contract's money picture: price, received, balance, next due, overdue, payments and refunds. The contract view shows it to Finance and the MD.

## Forgotten passwords

Staff do not reset their own password by e-mail. They contact the administrator:

1. The administrator presses **Reset password** on the person's row (Staff page). The old password stops working at once and every session ends. The row shows "Password reset: waiting for them to choose a new one".
2. The person opens the sign-in page and clicks **Forgot password?**. One form opens: *Work email*, *Enter your new password* and *Confirm your new password*.
3. They save it and sign in with the new password.

Without a reset from the administrator, saving the form only says "Contact your administrator". A reset is open for 24 hours, works once, and both steps are written to the audit log (`password_reset_opened`, `password_set_after_reset`). Endpoints: `POST /org/users/:id/reset-password`, `POST /auth/forgot-password`, `POST /auth/reset-password`.

## Your work today

Finance, Sales and the Managing Director open on a simple home: a short numbered list of the jobs waiting for them, one sentence each and one button that opens the job already filtered (for example *Payments waiting for your approval*). A strip under it shows how their work moves, and their main pages carry a one-line tip saying what their step is. The menus, permissions and screens are unchanged.

## Backups

The server makes **one automatic database backup a day** (a PostgreSQL dump, or a JSON snapshot of every table when `pg_dump` is not installed) in `data/backups`, named `system-auto-…`. The newest 14 automatic backups are kept; backups made by hand from **System & backups** are never removed automatically. Settings in `.env`:

- `BACKUP_COPY_DIR=` a folder outside this computer's disk, for example a Google Drive or OneDrive synced folder or a USB drive. Every backup is copied there and the uploaded files (receipts, contracts, photos) are mirrored there.
- `AUTO_BACKUP_KEEP=14` how many daily backups to keep.
- `AUTO_BACKUP=0` turns automatic backups off.

The System & backups page shows whether automatic backups are on and when the last one was made.

## Bank statement upload

Finance downloads the day's statement from internet banking (CSV or Excel .xlsx) and presses **Upload bank statement** (Payments & debts, or "Your work today"). Every credit is listed with the customer it most likely belongs to (contract number in the narration, a payer seen before, phone, name, amount). Finance ticks the lines, checks the customer and presses **Save selected** (or **Save & approve** when they are the only Finance person). Money out, fees and balances are skipped; a line already recorded is shown as such, so the same statement can be uploaded twice safely. A line with no bank reference gets a stable one built from its date, amount and description.

## Customer e-mails (receipts and reminders)

When Finance approves a payment the customer receives the MKUYU receipt (PDF) by e-mail, and three days before an installment is due they receive a reminder. Nothing is sent until the company's e-mail account is set in `.env`:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=payments@yourcompany.co.tz
SMTP_PASS=<app password>
MAIL_FROM="MKUYU Real Estate <payments@yourcompany.co.tz>"
```

`MAIL_RECEIPTS=0` / `MAIL_REMINDERS=0` turn either off and `MAIL_REMINDER_DAYS` changes the 3 days. Every e-mail is logged (`email_log`); the System & backups page shows whether e-mail is on and the last one sent. No extra package is used (a small SMTP client in `backend/src/mail.js`).

## Diaspora Desk

A department (**DIASPORA DESK**: *Diaspora Desk Manager*, *Diaspora Desk Officer*) that serves every customer who lives abroad. Each member signs in with their own account; the desk works as **one shared queue** (department scope), so several members can serve the same customers at the same time. Every diaspora customer also has a *contact person* on the desk (the member with the fewest customers when they signed up), for reference only.

- **Self sign-up** (website → *Diaspora login* → *Create a diaspora account*): full name, e-mail, phone with country code, country of residence, nationality, password, and consent. A 6-digit code is e-mailed; nothing is created until it is entered.
  - Lives **in Tanzania** → a lead for **Sales** (source `website-signup`); no account.
  - Lives **abroad** → a diaspora client on the **Diaspora Desk**, signed straight in. The phone's country is compared with the declared country; a mismatch is flagged *ask the customer* for the desk.
- **Sign-in**: e-mail + password; *Forgot password* and *Sign in with a code* use a code sent to the e-mail. The code only ever goes by e-mail.
- **Verification** (menu **Diaspora verification**): the customer uploads a passport/NIDA and proof of residence abroad → the **Desk** checks they match → **Legal** confirms nationality (it decides the contract MKUYU may offer) → the customer's contracts, payments and receipts open in the portal. Desk or Legal can send it back with a note the customer reads. Before verification the customer can still browse and request. Clients added by staff are trusted and need no verification.
- **Two sides everywhere**: *Clients* and *Requests* have **Ndani ya nchi / Diaspora** tabs; Sales do not see diaspora customers, the desk opens on the Diaspora side.
- **Admin logs**: System & backups → *Activity log* → choose *Diaspora Desk (all members)* or one person to see their sign-ins and every action.

### Diaspora contracts

A contract for a diaspora client (Buy or Rent; a Sell mandate stays with Sales) gets its own wording and its own path:

- **Wording**: the **Diaspora Sale Agreement** (26 clauses and 3 schedules: identity and form of ownership by nationality, payments only to MKUYU's Official Accounts, late payment, termination and refunds, construction updates and delay, handover, title transfer, taxes, representative in Tanzania by power of attorney, electronic signature, source of funds, personal data, disputes) or the **Diaspora Lease Agreement** (the lease plus Diaspora Terms). Text: `backend/src/contracts/agreements.js`. **It must be reviewed by MKUYU's Legal Department before real use**, in particular clause 4 (non-citizens) and the rates in clauses 8 to 10; Legal completes Schedule 3 on each contract.
- **Path**: Diaspora Desk prepares → (customer must be verified) → Legal → Finance → **MD (always)** → Legal sends → the customer **reads and signs in the portal** → Finance confirms the deposit → Legal presses *Record customer signature* → active.
- **Signing in the portal**: the button opens only after the whole text has been scrolled; the customer ticks five confirmations, types their full name and enters their password. The system keeps the exact signed text, its SHA-256 fingerprint, the time, the internet address and the browser, e-mails a confirmation, and records it in the audit log. If the text changes after it was opened, the signature is refused.

### Sign-in

Customers sign in with their **username or e-mail and password**. The e-mailed code is used only to sign up and to reset (or, when invited by staff, first set) a password; there is no sign-in by code. The sign-up form adapts: the country where you live fills the phone's country code (+1, +254…), a phone typed with a code picks the country, and a non-Tanzanian nationality suggests the same country of residence. Nationality is never guessed from the phone.

`npm run test:diaspora-desk` runs 14 checks of this flow, including the full contract path.

## Diaspora customer portal

Customers who live abroad (Miliki Ardhi Diaspora) can follow their property online on the public website (**Diaspora login**). Customers in Tanzania have no account and see no change.

1. **Sales** opens the client, ticks **Diaspora client (lives abroad)**, makes sure the e-mail is right, saves, and presses **Invite to the portal**. The client gets an e-mail (when e-mail is set up) telling them how to sign in.
2. **The client** opens the website → *Diaspora login*, types their e-mail and receives a **6-digit code** (valid 10 minutes, 5 tries). No password.
3. **They see only their own contracts**: status in four simple steps, total / paid / balance, every installment (paid, pending, overdue), payment history with **receipt PDFs**, the **signed agreement** once Legal attaches it, and **construction progress**.
4. **Construction progress**: on *Projects*, **Construction updates** → title, date, a short note and up to 8 photos. Every diaspora customer with a contract in that project sees it at once.

Safety: customer accounts and sessions are separate from staff ones (a customer cookie opens nothing in the staff system and a staff token opens no portal); every receipt, document and photo is checked against the signed-in customer; the sign-in form answers the same for any address; un-ticking *Diaspora* or pressing **Disable portal** signs the client out at once. `PUBLIC_SITE_URL` (link in the invitation), `MKUYU_CONTACT_EMAIL`, `CUSTOMER_SESSION_HOURS` (default 24) are optional settings. The sign-in code is sent ONLY by e-mail (never shown on screen or in the server window), so SMTP must be set in `.env`; without it the server window says the code was not sent. `npm run test:customer-portal` runs the 11 security and flow checks.

## Customer SMS notices

The system tells customers by SMS (Kiswahili by default) when something happens on their account:

| Notice | When | Also by e-mail |
|---|---|---|
| **Payment received** | Finance approves a payment: amount, receipt number, balance and the next installment | (the PDF receipt e-mail, as before) |
| **Fully paid** | the approved payment that clears the contract | yes |
| **Installment reminder** | 7, 3 and 0 days before an installment is due (`SMS_DUE_DAYS`) | (the 3-day e-mail reminder, as before) |
| **Overdue** | 1, 7, 14 and 30 days after the oldest unpaid installment was due, then every 30 days (`SMS_OVERDUE_DAYS`); one SMS per contract with the total late | yes |
| **New property** | a property is published, or becomes available again after a cancelled sale/rent, to clients and leads who **agreed** to receive offers | yes |

- **Consent.** New-property messages go only to clients with *Agrees to receive SMS / e-mail about new properties* ticked on the client form, and website leads who ticked the same box (`marketing_opt_in` on `POST /public/requests` and `/public/enquiries`). Payment and installment messages go to every customer, because they are about their own contract.
- **Sent once.** Every notice is written to `notification_log` under a unique key *before* it is sent, so a restart, a second server or a retry never sends it twice. A failed one is retried on the next hourly pass.
- **Test mode first.** Until an SMS account is in `.env`, nothing leaves the server: each message appears in **System & backups → Customer notices** marked *Test (not sent)*, so the wording and the timing can be checked on real data. Then set `SMS_PROVIDER=nextsms` (or `beem`) with its credentials and `SMS_SENDER_ID`, and restart.
- **No SMS at night.** The hourly reminder pass skips 20:00–08:00 (`SMS_QUIET_HOURS`). Payment SMS go at once, when Finance approves.
- **Buttons.** *Send test SMS* sends one message to a number you type; *Check reminders now* runs the hourly pass immediately. Both are administrator-only and recorded in the audit log.

All settings are listed in `.env.example`. Code: `backend/src/notify/` (`messages.js` the wording, `sms.js` the gateway, `customerNotices.js` the rules). `npm run test:notices` checks the wording and the rules without a database; `npm run test:notices:db` runs every notice against the isolated test database.

## Language (English / Kiswahili)

Each person picks the language in **My profile → Settings → Language · Lugha**, or with the English / Kiswahili switch on the sign-in page. The choice is kept on that computer (browser). `frontend/js/i18n.js` holds the Kiswahili wording; the interface is written in English and shown in Kiswahili as it appears. Names, numbers, references, what people typed and the contract documents are never translated. To fix a word, change its line in `i18n.js`.

## Website AI assistant (Qwen through Ollama)

The "Ask MKUYU" chat on the public website answers free questions with a local AI model (Ollama, the first installed Qwen model by default). The website sends the question to this server (`POST /api/v1/public/chat`), never to Ollama directly.

- The model is given **public information only**: `backend/src/public/assistant-knowledge.md` and the homes published on the website. It has no database access, so it cannot reveal staff, customers, contracts, payments or reports.
- Questions about internal matters (passwords, staff, contracts, payments, "ignore your rules") are refused before the model is asked. Invented phone numbers, e-mails and links are removed from every reply.
- Searches for homes and projects are still answered from the live listings. If Ollama is off or slow, the website uses its built-in answers.
- To change what it knows, edit `assistant-knowledge.md` (public facts only) and restart the server. Settings: `ASSISTANT_AI`, `OLLAMA_URL`, `OLLAMA_MODEL` in `.env`.
- Ollama must be running on the same computer as this server (`ollama serve`; check with `ollama list`). On a hosting server it needs its own Ollama and enough memory (about 8 GB for a 7B model).

## Buildings, floors and units

A project is an **Estate** (separate homes or plots) or a **Building** (floors and numbered units), chosen on the project form.

- Each unit is a property in that project with a **Floor** (0 = ground floor) and a **Unit number** typed by the staff (for example 304 or B-12). A unit number is used once per project; a second unit with the same number is refused.
- Every unit is offered to **rent, buy or both**, with its own price and state, like any property. A building can therefore have flats to rent and flats for sale at the same time.
- On the website, a building appears on the Rent and Buy pages as **one card**. Opening it shows the building floor by floor (`projects.html?p=<id>`); the visitor chooses a unit, opens it and presses Request. The request reaches Sales under Requests & leads with the unit, floor and building named.

## Fonts without internet

The interface fonts can be served by MKUYU itself: on a computer with internet, double-click `fetch-fonts.bat` (or `node tools/fetch_fonts.mjs`) once. The files land in `frontend/fonts`; until then Google Fonts is used.

## Tests

Tests never touch the live database: `test_support/guard.mjs` derives a separate test database from `.env` (override with `MKUYU_TEST_DB`).

```powershell
npm run test          # unit, access matrix, frontend smoke, end-to-end
npm run test:final    # payments, refunds, property/contract rules
```

On Windows, double-click `run-tests.bat`; the results are written to `test-results.txt`.

## ngrok

If the system is exposed through ngrok, the tunnel must point at port **3003** (`ngrok http 3003`). A tunnel left on another port serves a different, older copy of the project. Use `node tools/check_tunnel.mjs` to confirm the current mapping and `node tools/check_port.mjs <port>` to identify what a given port is serving.
