// Access-matrix test: proves that sector roles are enforced server-side, not
// just hidden in the UI. It provisions one user per sector, drives the real HTTP
// API, and asserts what each sector may and may not do.
// Run: node access_matrix_test.mjs  (optional: MATRIX_PORT=3188)
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { query, queryOne, closeDatabase } from "./backend/src/db.js";
import { assertTestDatabase } from "./test_support/harness.mjs";
import { runMigrations } from "./backend/src/migrate.js";
import { hashPassword } from "./backend/src/auth.js";

// Refuse to create users, roles and records in the live workspace.
await assertTestDatabase("access_matrix_test");

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MATRIX_PORT || 3188);
const BASE = `http://localhost:${PORT}/api/v1`;
const PASSWORD = "MatrixTest123!";
let serverProcess = null;
let serverLogs = "";
let failures = 0;

function check(condition, label) {
  if (condition) { console.log(`ok: ${label}`); return; }
  failures += 1;
  console.log(`FAIL: ${label}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startServer() {
  const child = spawn(process.execPath, [path.join(projectRoot, "backend", "src", "server.js")], {
    cwd: projectRoot,
    // DATABASE_URL is inherited from the isolation guard, so this server is bound
    // to the throwaway test database. DATA_DIR is likewise redirected so uploads
    // and backups stay out of the live data/ directory.
    env: { ...process.env, PORT: String(PORT), DATABASE_URL: process.env.DATABASE_URL, DATA_DIR: process.env.DATA_DIR || path.join(projectRoot, "data", "test-runtime") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess = child;
  child.stdout.on("data", (chunk) => { serverLogs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { serverLogs += chunk.toString(); });
  child.on("exit", (code, signal) => { child.exited = { code, signal }; });
  return child;
}

async function stopServer() {
  if (!serverProcess) return;
  const child = serverProcess;
  if (!child.exited) {
    child.kill();
    const deadline = Date.now() + 5000;
    while (!child.exited && Date.now() < deadline) await sleep(100);
    if (!child.exited && child.pid) { try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ } }
  }
  serverProcess = null;
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (serverProcess?.exited) throw new Error(`server exited early (code ${serverProcess.exited.code})\n${serverLogs}`);
    try {
      const response = await fetch(`${BASE}/auth/state`);
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await sleep(250);
  }
  throw new Error(`server on port ${PORT} did not start: ${lastError?.message || "timeout"}\n${serverLogs}`);
}

async function call(pathname, { token, method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${BASE}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (response.status >= 500) console.log(`HTTP ${response.status} ${method} ${pathname}`, JSON.stringify(payload));
  return { status: response.status, payload };
}

async function login(email) {
  const result = await call("/auth/login", { method: "POST", body: { email, password: PASSWORD } });
  if (result.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(result.payload)}`);
  return result.payload.token;
}


// Departments and roles follow the MKUYU organization (see migrate.js). The
// matrix provisions one user per sector, drives the real HTTP API, and asserts
// what each sector may and may not do.
const SECTORS = [
  { key: "sales", role: "Sales Officer", department: "SALES, MARKETING & OPERATIONS" },
  { key: "sales2", role: "Sales Officer", department: "SALES, MARKETING & OPERATIONS" },
  { key: "marketing", role: "Marketing Officer", department: "SALES, MARKETING & OPERATIONS" },
  { key: "finance", role: "Finance Officer", department: "FINANCE & ACCOUNTS" },
  { key: "finance_manager", role: "Finance Manager", department: "FINANCE & ACCOUNTS" },
  { key: "legal_manager", role: "Legal Manager", department: "LEGAL" },
  { key: "property", role: "Property Officer", department: "SALES, MARKETING & OPERATIONS" },
  { key: "legal", role: "Legal Officer", department: "LEGAL" },
  { key: "legal2", role: "Legal Officer", department: "LEGAL" },
  { key: "customer_service", role: "Customer Service Officer", department: "CUSTOMER SERVICE" },
  { key: "icto", role: "ICTO", department: "ICT & ADMINISTRATION" },
  { key: "manager", role: "Department Manager", department: "SALES, MARKETING & OPERATIONS" },
  { key: "director", role: "Managing Director", department: "MANAGEMENT" },
];

const stamp = Date.now();
const created = { users: [] };
const userId = (key) => created.users.find((user) => user.key === key).id;

async function provisionSectors() {
  const org = (await query("SELECT id FROM organizations ORDER BY id LIMIT 1")).rows[0].id;
  for (const sector of SECTORS) {
    const email = `matrix.${sector.key}.${stamp}@mkuyu.local`;
    const user = (await query(
      "INSERT INTO users (organization_id, email, password_hash, display_name, role) VALUES ($1,$2,$3,$4,'staff') RETURNING id",
      [org, email, hashPassword(PASSWORD), `Matrix ${sector.key} ${stamp}`],
    )).rows[0];
    const role = (await query("SELECT id FROM roles WHERE organization_id=$1 AND name=$2", [org, sector.role])).rows[0];
    const department = (await query("SELECT id FROM departments WHERE organization_id=$1 AND name=$2", [org, sector.department])).rows[0];
    if (!role) throw new Error(`role missing: ${sector.role}`);
    await query("INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [user.id, role.id]);
    if (department) await query("INSERT INTO user_departments (user_id, department_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [user.id, department.id]);
    created.users.push({ ...sector, id: user.id, email });
  }
  // A dedicated administrator keeps the test independent of local credentials.
  const adminEmail = `matrix.admin.${stamp}@mkuyu.local`;
  const admin = (await query(
    "INSERT INTO users (organization_id, email, password_hash, display_name, role) VALUES ($1,$2,$3,$4,'admin') RETURNING id",
    [org, adminEmail, hashPassword(PASSWORD), `Matrix admin ${stamp}`],
  )).rows[0];
  const adminRole = (await query("SELECT id FROM roles WHERE organization_id=$1 AND name='System Administrator'", [org])).rows[0];
  await query("INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [admin.id, adminRole.id]);
  created.adminEmail = adminEmail;
  return org;
}

/**
 * Removes everything this suite created.
 *
 * Deliberately pattern-based rather than id-based: if the process is killed
 * mid-run the in-memory `created` list is lost, so deleting only those ids would
 * leak accounts into the database. Matching on the `matrix.<stamp>` email
 * pattern and the `Matrix ...` / `matrix-...` fixture names means a later run
 * cleans up after an earlier interrupted one as well.
 */
async function cleanup() {
  const stampPattern = `%${stamp}%`;
  const ids = created.users.map((user) => user.id);
  await query("DELETE FROM record_shares WHERE created_by = ANY($1::int[])", [ids]).catch(() => {});
  await query("DELETE FROM audit_logs WHERE user_id = ANY($1::int[])", [ids]).catch(() => {});
  // Fixtures created by this run, matched on their names rather than on ids.
  await query("DELETE FROM leads WHERE name LIKE $1", [`Matrix Lead ${stamp}%`]).catch(() => {});
  await query("DELETE FROM clients WHERE name LIKE $1", [`Matrix Client ${stamp}%`]).catch(() => {});
  await query("DELETE FROM projects WHERE name LIKE $1", [`Matrix Project ${stamp}%`]).catch(() => {});
  await query("DELETE FROM contracts WHERE notes LIKE $1", [`matrix-%-${stamp}`]).catch(() => {});
  await query("DELETE FROM contracts WHERE notes LIKE $1", [`matrix-${stamp}`]).catch(() => {});
  // Accounts: this run's, plus any left behind by an interrupted earlier run.
  await query("DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'matrix.%@mkuyu.local')").catch(() => {});
  await query("DELETE FROM users WHERE email LIKE 'matrix.%@mkuyu.local'").catch(() => {});
  if (created.adminEmail) await query("DELETE FROM users WHERE email = $1", [created.adminEmail]).catch(() => {});
  await query("DELETE FROM users WHERE id = ANY($1::int[])", [ids]).catch(() => {});
  // Sweep fixtures from interrupted runs too.
  await query("DELETE FROM leads WHERE name LIKE 'Matrix Lead %'").catch(() => {});
  await query("DELETE FROM clients WHERE name LIKE 'Matrix Client %'").catch(() => {});
  await query("DELETE FROM projects WHERE name LIKE 'Matrix Project %'").catch(() => {});
  await query("DELETE FROM contracts WHERE notes LIKE 'matrix-%'").catch(() => {});
  void stampPattern;
}

async function main() {
  const org = await provisionSectors();
  const sessions = { admin: await login(created.adminEmail) };
  for (const user of created.users) sessions[user.key] = await login(user.email);
  console.log(`matrix users: ${created.users.map((u) => u.key).join(", ")}`);

  // --- Ownership assignment on create -------------------------------------
  let res = await call("/projects", { token: sessions.sales, method: "POST", body: { name: `Matrix Project ${stamp}` } });
  check(res.status === 201, "sales officer can create a project");
  const salesProject = res.payload;
  check(salesProject.owner_id === userId("sales"), "created record records the creator as owner");
  check(["department", "own"].includes(salesProject.visibility), `new record is not organization-wide (got ${salesProject.visibility})`);

  res = await call("/clients", { token: sessions.sales, method: "POST", body: { name: `Matrix Client ${stamp}`, client_type: "buyer", status: "active" } });
  check(res.status === 201, "sales officer can create a client");
  const salesClient = res.payload;

  res = await call("/contracts", { token: sessions.sales, method: "POST", body: { project_id: salesProject.id, client_id: salesClient.id, client_name: `Matrix Client ${stamp}`, contract_type: "new", deal_type: "buy", value: 500000, notes: `matrix-${stamp}` } });
  check(res.status === 201, "sales officer can create a contract");
  const salesContract = res.payload;
  res = await call("/clients", { token: sessions.legal, method: "POST", body: { name: `Matrix Legal Client ${stamp}`, client_type: "buyer", status: "lead" } });
  check(res.status === 201, "legal creates a client in its own scope");
  const legalClient = res.payload;
  res = await call("/appointments", { token: sessions.sales, method: "POST", body: { client_id: legalClient.id, title: `Matrix Cross-scope Appointment ${stamp}`, starts_at: "2026-10-15 10:00" } });
  check(res.status === 404, "sales cannot create an appointment against a Legal-private client");
  res = await call("/debts", { token: sessions.finance_manager, method: "POST", body: { contract_id: salesContract.id, client_name: "Hidden Sales Contract", amount: 100, due_date: "2027-01-05" } });
  check(res.status === 404, "Finance cannot create debt against a Sales-private contract");
  res = await call("/documents", { token: sessions.legal, method: "POST", body: { client_id: salesClient.id, title: `Matrix Cross-scope Document ${stamp}` } });
  check(res.status === 404, "Legal cannot create a document linked to a Sales-private client");
  res = await call(`/contracts/${salesContract.id}/schedule`, { token: sessions.sales, method: "POST", body: { deposit: 0, installments: 2, first_due_date: "2027-01-05" } });
  check(res.status === 403, "sales officer cannot create a payment schedule (financial)");
  res = await call(`/contracts/${salesContract.id}/schedule`, { token: sessions.manager, method: "POST", body: { deposit: 0, installments: 2, first_due_date: "2027-01-05" } });
  check(res.status === 403, "a sales department manager cannot create a payment schedule either (no view_financial)");
  res = await call(`/contracts/${salesContract.id}/schedule`, { token: sessions.finance_manager, method: "POST", body: { deposit: 0, installments: 2, first_due_date: "2027-01-05" } });
  check(res.status === 404, "finance cannot schedule a contract that is outside its scope");
  // An organization-visible contract is in Finance's scope, so it can be worked.
  res = await call("/contracts", { token: sessions.director, method: "POST", body: { project_id: salesProject.id, client_name: `Matrix Fin ${stamp}`, contract_type: "new", deal_type: "buy", value: 750000, notes: `matrix-fin-${stamp}` } });
  const financeContract = res.payload;
  res = await call(`/contracts/${financeContract.id}/schedule`, { token: sessions.finance_manager, method: "POST", body: { deposit: 0, installments: 2, first_due_date: "2027-01-05" } });
  check(res.status === 201, "the finance manager generates a payment schedule on an organization-visible contract");
  const visibleApproval = await queryOne("INSERT INTO approvals (organization_id,module,record_id,requested_by,status) VALUES ($1,'contract',$2,$3,'pending') RETURNING id", [org, String(financeContract.id), userId("director")]);
  const hiddenApproval = await queryOne("INSERT INTO approvals (organization_id,module,record_id,requested_by,status) VALUES ($1,'contract',$2,$3,'pending') RETURNING id", [org, String(salesContract.id), userId("sales")]);
  const financeApprovals = await call("/org/approvals", { token: sessions.finance_manager });
  check(financeApprovals.status === 200 && financeApprovals.payload.some((approval) => approval.id === visibleApproval.id) && !financeApprovals.payload.some((approval) => approval.id === hiddenApproval.id), "approval inbox follows contract scope");
  const hiddenDecision = await call(`/org/approvals/${hiddenApproval.id}`, { token: sessions.finance_manager, method: "PUT", body: { status: "approved" } });
  check(hiddenDecision.status === 404, "Finance cannot decide an approval for a Sales-private contract");
  res = await call(`/contracts/${financeContract.id}/schedule`, { token: sessions.legal, method: "POST", body: { deposit: 0, installments: 3, first_due_date: "2027-01-05", replace: true } });
  check(res.status === 403, "legal cannot create or replace a payment schedule");

  // --- Record scope: who can see the sales-owned records -------------------
  res = await call("/contracts", { token: sessions.sales2 });
  check(res.payload.some((c) => c.id === salesContract.id), "same-sector colleague sees department-visible records");
  res = await call("/contracts", { token: sessions.finance });
  check(!res.payload.some((c) => c.id === salesContract.id), "finance officer cannot see another department's contract");
  res = await call(`/contracts/${salesContract.id}`, { token: sessions.finance });
  check(res.status === 404, "out-of-scope contract detail is not found (404, not 403)");
  res = await call(`/contracts/${salesContract.id}`, { token: sessions.legal });
  check(res.status === 404, "legal officer (other department) cannot read a sales contract");
  res = await call(`/contracts/${salesContract.id}`, { token: sessions.property });
  check(res.status === 403, "property officer is denied the contract module entirely");
  res = await call(`/contracts/${salesContract.id}`, { token: sessions.legal, method: "PUT", body: { value: 1 } });
  check(res.status === 404, "out-of-scope contract update is refused");
  res = await call(`/contracts/${salesContract.id}`, { token: sessions.legal, method: "DELETE" });
  check(res.status === 404, "out-of-scope contract delete is refused by the record scope");
  res = await call("/contracts", { token: sessions.director });
  check(res.payload.some((c) => c.id === salesContract.id), "managing director sees organization-wide records");
  res = await call("/contracts", { token: sessions.admin });
  check(res.status === 403, `the System Administrator does not see business records (${res.status})`);
  res = await call("/debts", { token: sessions.finance });
  check(Array.isArray(res.payload), "finance officer can list installments");
  res = await call("/debts", { token: sessions.sales2 });
  check(res.status === 403, "sales colleague is denied installments");

  // --- A record owned by the legal department, for cross-department checks ---
  res = await call("/contracts", { token: sessions.legal, method: "POST", body: { project_id: salesProject.id, client_name: `Matrix Legal ${stamp}`, contract_type: "terminal", deal_type: "buy", value: 900, notes: `matrix-legal-${stamp}` } });
  check(res.status === 201, "legal officer can create a contract in their own sector");
  const legalContract = res.payload;
  res = await call(`/contracts/${legalContract.id}`, { token: sessions.legal });
  check(res.status === 200, "legal officer can read their own contract");
  res = await call(`/contracts/${legalContract.id}`, { token: sessions.manager, method: "DELETE" });
  check(res.status === 404, "department manager cannot delete a record outside their department");
  res = await call(`/contracts/${legalContract.id}`, { token: sessions.admin, method: "DELETE" });
  check(res.status === 403, `the System Administrator cannot delete business records (${res.status})`);
  res = await call(`/contracts/${legalContract.id}`, { token: sessions.legal, method: "DELETE" });
  check(res.status === 200, "Legal, which owns the final record, deletes it");
  res = await call("/contracts", { token: sessions.sales2 });
  check(!res.payload.some((c) => c.id === legalContract.id), "deleted record disappears from every list");

  // Legal holds the delete permission, because Legal controls the final record.
  res = await call("/contracts", { token: sessions.legal, method: "POST", body: { project_id: salesProject.id, client_name: `Matrix Legal Own ${stamp}`, contract_type: "new", deal_type: "buy", value: 700, notes: `matrix-legalown-${stamp}` } });
  check(res.status === 201, "legal opens a record it owns");
  const legalOwnContract = res.payload;
  res = await call(`/contracts/${legalOwnContract.id}`, { token: sessions.sales, method: "DELETE" });
  check([403, 404].includes(res.status), `sales may not delete Legal's contract record (${res.status})`);
  res = await call(`/contracts/${legalOwnContract.id}`, { token: sessions.legal, method: "DELETE" });
  check(res.status === 200, "legal may delete the contract record it controls");

  // Deleting a contract is for the MD, Legal and Sales. Sales may delete its
  // own contract only while it is still before approval.
  res = await call("/contracts", { token: sessions.sales, method: "POST", body: { project_id: salesProject.id, client_name: `Matrix Sales Draft ${stamp}`, contract_type: "new", deal_type: "buy", value: 500, notes: `matrix-salesdraft-${stamp}` } });
  check(res.status === 201, "sales opens a draft contract");
  const salesDraft = res.payload;
  res = await call(`/contracts/${salesDraft.id}`, { token: sessions.sales, method: "DELETE" });
  check(res.status === 200, `sales deletes its own draft before approval (${res.status})`);


  // --- Financial data never leaks into non-financial dashboards ------------
  res = await call("/reports/summary", { token: sessions.sales });
  check(res.status === 200, "sales officer can read the summary endpoint");
  check(res.payload.financial === false, "summary marks itself non-financial for sales");
  check(res.payload.debts_pending === null && res.payload.income_all === null && res.payload.income_30d === null, "summary withholds every monetary figure from sales");
  check(typeof res.payload.contracts_new.count === "number" && res.payload.contracts_new.total === null, "summary returns contract counts but withholds contract value from sales");
  res = await call("/reports/summary", { token: sessions.finance });
  check(res.payload.financial === true && res.payload.income_all && typeof res.payload.income_all.total === "number", "finance officer receives income totals");
  res = await call("/reports/by-project", { token: sessions.sales });
  check(res.payload.every((row) => row.open_debts === null && row.contract_value === null), "by-project withholds financial values from sales");
  res = await call("/reports/types", { token: sessions.sales });
  const salesTypes = res.payload.types.map((type) => type.id);
  check(!["income", "debt", "payments", "properties", "projects", "contracts"].some((type) => salesTypes.includes(type)), "financial report types are not offered to sales");
  res = await call("/reports/preview", { token: sessions.sales, method: "POST", body: { report_type: "contracts" } });
  check(res.status === 403, "sales cannot request a financial contract report directly");
  res = await call("/reports/preview", { token: sessions.finance_manager, method: "POST", body: { report_type: "contracts" } });
  check(res.status === 200 && res.payload.rows.some((row) => row.client_name === `Matrix Fin ${stamp}`) && !res.payload.rows.some((row) => row.client_name === `Matrix Client ${stamp}`), "finance reports include visible contracts but exclude another department's private contract");

  // --- Explicit sharing ----------------------------------------------------
  res = await call("/org/leads", { token: sessions.sales, method: "POST", body: { name: `Matrix Lead ${stamp}`, status: "new" } });
  check(res.status === 201, "sales officer can create a lead");
  const salesLead = res.payload;
  await query("UPDATE leads SET owner_id=$1, created_by=$1, department_id=NULL, visibility='own' WHERE id=$2", [userId("sales"), salesLead.id]);
  res = await call(`/org/leads/${salesLead.id}/convert`, { token: sessions.sales2 });
  check(res.status === 404, "private lead is invisible to a colleague before sharing");
  res = await call(`/org/records/lead/${salesLead.id}/shares`, { token: sessions.sales, method: "POST", body: { user_id: userId("sales2") } });
  check(res.status === 201, "owner can share a record with a colleague");
  res = await call("/org/leads", { token: sessions.sales2 });
  check(res.payload.some((lead) => lead.id === salesLead.id), "shared record becomes visible to the colleague");
  res = await call(`/org/records/lead/${salesLead.id}/shares`, { token: sessions.legal, method: "POST", body: { user_id: userId("legal") } });
  check(res.status === 404, "unrelated sector cannot even discover a private record to share it");
  const shares = (await call(`/org/records/lead/${salesLead.id}/shares`, { token: sessions.sales })).payload;
  if (shares.length) {
    const otherLead = await call("/org/leads", { token: sessions.sales, method: "POST", body: { name: `Matrix Other Lead ${stamp}`, status: "new" } });
    check(otherLead.status === 201, "owner can create a second shareable record");
    res = await call(`/org/records/lead/${otherLead.payload.id}/shares/${shares[0].id}`, { token: sessions.sales, method: "DELETE" });
    check(res.status === 404, "a share ID from another record cannot be revoked through this record's URL");
    check((await call(`/org/records/lead/${salesLead.id}/shares`, { token: sessions.sales })).payload.some((share) => share.id === shares[0].id), "failed cross-record revocation leaves the original share intact");
    res = await call(`/org/records/lead/${salesLead.id}/shares/${shares[0].id}`, { token: sessions.sales, method: "DELETE" });
    check(res.status === 200, "owner can revoke a share");
  }
  res = await call("/org/leads", { token: sessions.sales2 });
  check(!res.payload.some((lead) => lead.id === salesLead.id), "revoked share hides the record again");

  // --- Administrator record allocation ------------------------------------
  res = await call(`/org/records/client/${salesClient.id}/access`, { token: sessions.sales, method: "PUT", body: { visibility: "organization" } });
  check(res.status === 403, "non-admin cannot reassign record ownership");

  // --- Authorization bootstrap --------------------------------------------
  res = await call("/org/me", { token: sessions.sales });
  check(res.status === 200 && res.payload.scope === "own", "sales officer reports the own scope");
  check(res.payload.financial === false, "sales officer is reported as non-financial");
  check(Array.isArray(res.payload.modules) && res.payload.modules.includes("clients") && !res.payload.modules.includes("debts"), "authorization bootstrap reports only the caller's modules");
  res = await call("/org/me", { token: sessions.director });
  check(res.payload.scope === "organization", "managing director reports the organization scope");
  res = await call("/org/me", { token: sessions.manager });
  check(res.payload.scope === "department", "department manager reports the department scope");
  res = await call("/org/workspaces/sales", { token: sessions.property });
  check(res.status === 200 && res.payload.modules.every((module) => module !== "debts"), "workspace response is filtered by the caller's access");
  res = await call("/org/workspaces/sales", { token: sessions.sales });
  check(res.payload.modules.includes("leads") && !res.payload.modules.includes("payments"), "sales workspace advertises leads but not payments");

  // --- Contract lifecycle: Sales initiates, Legal owns, Finance validates, MD approves
  res = await call("/contracts", { token: sessions.sales, method: "POST", body: { project_id: salesProject.id, client_name: `Matrix Draft ${stamp}`, contract_type: "new", deal_type: "buy", value: 250000, notes: `matrix-draft-${stamp}` } });
  check(res.status === 201 && res.payload.status === "draft", "a new contract starts as a draft");
  const draft = res.payload;
  check(Boolean(draft.contract_number), `contract gets a reference number (${draft.contract_number})`);

  res = await call(`/contracts/${draft.id}`, { token: sessions.sales, method: "PUT", body: { value: 1, status: "active" } });
  check(res.status === 409, "a contract cannot be jumped straight to active by editing it");
  res = await call(`/contracts/${draft.id}/transition`, { token: sessions.sales, method: "POST", body: { action: "legal_approve" } });
  check(res.status === 403, "sales officer cannot grant legal approval");
  res = await call(`/contracts/${draft.id}/transition`, { token: sessions.sales, method: "POST", body: { action: "submit" } });
  check(res.status === 200 && res.payload.status === "submitted", "sales submits the deal to Legal");
  res = await call(`/contracts/${draft.id}/transition`, { token: sessions.sales, method: "POST", body: { action: "submit" } });
  check(res.status === 409, "a contract cannot be submitted twice");
  res = await call(`/contracts/${draft.id}/history`, { token: sessions.sales });
  check(res.status === 200 && Array.isArray(res.payload) && res.payload.length >= 2, "the revision trail records creation and submission");

  // ICT controls the system, not the business. The module permission refuses
  // the request before the handler ever runs, which is the stronger outcome.
  res = await call(`/contracts/${draft.id}/transition`, { token: sessions.icto, method: "POST", body: { action: "request_changes" } });
  check(res.status === 403, "ICTO is refused at the module gate before any contract logic runs");
  res = await call("/contracts", { token: sessions.icto });
  check(res.status === 403, "ICTO has no access to the contracts module");
  res = await call("/org/me", { token: sessions.icto });
  check(res.payload.permissions.includes("manage_users") && !res.payload.permissions.includes("approve_legal"), "ICTO manages the system but holds no contract authority");
  check(!res.payload.permissions.some((key) => key.startsWith("access_")), "ICTO holds no business module access");

  // Customer Service communicates but does not own contract content.
  res = await call(`/contracts/${draft.id}/transition`, { token: sessions.customer_service, method: "POST", body: { action: "start_review" } });
  check(res.status === 403, "customer service cannot drive the contract lifecycle");

  res = await call("/org/me", { token: sessions.director });
  check(res.payload.permissions.includes("approve_management"), "managing director may approve contracts");

  // The full lifecycle, each step taken by the department that owns it. The
  // record is opened by the administrator so it is organization-visible, which is
  // what lets Finance and the MD act on a contract Legal owns.
  res = await call("/contracts", { token: sessions.director, method: "POST", body: { project_id: salesProject.id, client_name: `Matrix Flow ${stamp}`, contract_type: "new", deal_type: "buy", value: 400000, requires_management_approval: true, notes: `matrix-flow-${stamp}` } });
  check(res.status === 201, "an organization-visible contract can be opened");
  const flow = res.payload;
  const step = async (action, token, extra = {}) => call(`/contracts/${flow.id}/transition`, { token, method: "POST", body: { action, ...extra } });
  // Submission is a Sales duty; review and approval are Legal duties.
  res = await step("submit", sessions.legal);
  check(res.status === 403, "legal cannot submit a deal to itself");
  check((await step("submit", sessions.sales)).status === 200, "sales submits the deal to Legal");
  check((await step("start_review", sessions.legal)).status === 200, "legal starts the review");
  res = await step("request_changes", sessions.legal, { notes: "Please attach the title deed." });
  check(res.status === 200 && res.payload.status === "changes_requested", "legal can request changes");
  check((await step("submit", sessions.sales)).status === 200, "sales resubmits after making the corrections");
  check((await step("start_review", sessions.legal)).status === 200, "legal resumes review");
  res = await step("finance_validate", sessions.legal);
  check(res.status === 403, "legal alone cannot sign off the financial terms");
  res = await step("legal_approve", sessions.legal);
  check(res.status === 200 && res.payload.status === "legal_approved", "legal approves the contract on the legal side");
  await query(
    `UPDATE contracts SET legal_signed_by=$1,legal_signed_at=NOW(),finance_validated_by=$2,finance_validated_at=NOW(),
       finance_notes='old validation',management_approved_by=$3,management_approved_at=NOW(),management_notes='old approval',
       customer_signed_by='Old Customer',customer_signed_at=NOW() WHERE id=$4`,
    [userId("legal"), userId("finance"), userId("director"), flow.id],
  );
  res = await step("request_changes", sessions.legal, { notes: "Terms changed after prior approval." });
  check(res.status === 200 && res.payload.status === "changes_requested", "a post-approval correction returns the contract to changes_requested");
  const invalidated = await queryOne("SELECT legal_signed_by,legal_signed_at,finance_validated_by,finance_validated_at,finance_notes,management_approved_by,management_approved_at,management_notes,customer_signed_by,customer_signed_at FROM contracts WHERE id=$1", [flow.id]);
  check(["legal_signed_by", "legal_signed_at", "finance_validated_by", "finance_validated_at", "finance_notes", "management_approved_by", "management_approved_at", "management_notes", "customer_signed_by", "customer_signed_at"].every((field) => invalidated[field] === null), "request_changes invalidates every prior signature and approval stamp");
  check((await step("submit", sessions.sales)).status === 200, "Sales resubmits the corrected contract");
  check((await step("start_review", sessions.legal)).status === 200, "Legal reviews the corrected contract again");
  res = await step("finance_validate", sessions.finance);
  check(res.status === 409, "finance cannot validate while Legal is still reviewing (Legal -> Finance -> MD)");
  res = await step("legal_approve", sessions.legal);
  check(res.status === 200 && res.payload.status === "legal_approved", "Legal must approve the corrected contract again");
  check(res.payload.position?.key === "finance" && res.payload.position?.label === "Under Finance review", "a legally approved contract is shown as Under Finance review");
  res = await step("submit_management", sessions.legal);
  check(res.status === 409, "legal cannot send a contract to the MD before Finance has validated it");
  res = await call(`/contracts/${flow.id}`, { token: sessions.legal });
  check(!(res.payload.available_actions || []).some((entry) => entry.action === "submit_management"), "the Send-to-MD button is hidden until Finance validates");
  res = await step("finance_validate", sessions.finance);
  check(res.status === 200 && Boolean(res.payload.finance_validated_at), "finance validates the financial terms");
  check(res.payload.position?.key === "legal_to_md", "after Finance validates, the contract is back with Legal to send to the MD");
  res = await step("finance_validate", sessions.finance);
  check(res.status === 409, "financial terms cannot be validated twice");
  res = await step("submit_management", sessions.finance);
  check(res.status === 403, "finance cannot drive the contract to management approval");
  res = await step("submit_management", sessions.legal);
  check(res.status === 200 && res.payload.status === "pending_management_approval", "legal sends it to management");
  check(res.payload.position?.label === "Under MD review" && res.payload.position?.desk === "Managing Director", "a contract waiting for the MD is shown as Under MD review");
  res = await step("management_approve", sessions.legal);
  check(res.status === 403, "legal cannot grant management approval");
  res = await step("management_approve", sessions.finance);
  check(res.status === 403, "finance cannot grant management approval");
  res = await step("management_approve", sessions.sales);
  check(res.status === 403, "sales cannot grant management approval");
  res = await step("management_approve", sessions.icto);
  check(res.status === 403, "ICTO cannot grant management approval");
  res = await step("management_approve", sessions.director);
  check(res.status === 200 && res.payload.status === "approved", "the managing director approves");
  check((await step("send_to_customer", sessions.legal)).status === 200, "legal sends the contract to the customer");
  res = await step("record_signature", sessions.legal, { signed_by: "Matrix Customer" });
  check(res.status === 200 && res.payload.status === "active", "legal records the signature and activates the contract");
  check(Boolean(res.payload.customer_signed_at), "the signature is stamped on the record");
  res = await call(`/contracts/${flow.id}`, { token: sessions.legal, method: "PUT", body: { notes: "unauthorized post-signature edit" } });
  check(res.status === 409, "a signed active contract cannot be edited outside the changes-requested workflow");
  res = await step("complete", sessions.legal);
  check(res.status === 200 && res.payload.status === "completed", "legal closes the final record");
  res = await call(`/contracts/${flow.id}/history`, { token: sessions.legal });
  check(res.status === 200 && res.payload.length >= 10, `the revision trail records the whole lifecycle (${res.payload?.length} entries)`);

  res = await call(`/contracts/${flow.id}`, { token: sessions.sales, method: "DELETE" });
  check(res.status === 403, "sales cannot delete a contract record; only Legal can");
  res = await call(`/contracts/${flow.id}`, { token: sessions.legal, method: "DELETE" });
  check(res.status === 200, "legal may delete a contract record");

  // --- Access matrix integrity, read from the live API ---------------------
  res = await call("/org/access-matrix", { token: sessions.admin });
  check(res.status === 200 && Array.isArray(res.payload.roles), "the administrator can read the access matrix");
  const matrix = res.payload;
  check(matrix.departments.length === 6, `the organization has exactly six departments (got ${matrix.departments.length})`);
  check(matrix.roles.every((role) => Array.isArray(role.duties) && role.duties.length >= 2), "every role declares at least two duties");
  check(matrix.audit.dutyProblems.length === 0, `no duty/permission mismatch: ${JSON.stringify(matrix.audit.dutyProblems).slice(0, 200)}`);
  check(matrix.audit.contractOwnershipViolations.length === 0, `contract lifecycle is owned by one department: ${JSON.stringify(matrix.audit.contractOwnershipViolations).slice(0, 200)}`);
  check(matrix.audit.systemAdminLeaks.length === 0, `system administration sits only in ICT: ${JSON.stringify(matrix.audit.systemAdminLeaks).slice(0, 200)}`);
  check(matrix.audit.deadPermissions.length === 0, `no role holds an unusable permission: ${JSON.stringify(matrix.audit.deadPermissions).slice(0, 200)}`);
  check(matrix.audit.unmappedRoles.length === 0, "every role maps to a home department");
  for (const key of ["submit_contract", "review_legal", "approve_legal", "validate_finance", "approve_management"]) {
    const holders = matrix.roles.filter((role) => role.permissions.includes(key)).map((role) => role.name);
    check(!holders.includes("ICTO") && !holders.includes("Managing Director") || key === "approve_management",
      `${key} is not held by ICT or the MD (${holders.join(", ") || "nobody"})`);
  }

  res = await call("/org/access-matrix", { token: sessions.director });
  check(res.status === 403, "the access matrix is administrator-only (MD refused)");
  res = await call("/org/access-matrix", { token: sessions.icto });
  check(res.status === 403, "the access matrix is administrator-only (ICTO refused)");

  // --- Cross-department authorization, not just UI visibility --------------
  res = await call("/org/departments", { token: sessions.legal });
  check(res.status === 403, "legal cannot administer departments");
  res = await call("/org/roles", { token: sessions.finance });
  check(res.status === 403, "finance cannot administer roles");
  res = await call("/org/permissions", { token: sessions.sales });
  check(res.status === 403, "sales cannot read the permission catalogue");
  res = await call("/org/users", { token: sessions.customer_service });
  check(res.status === 403, "customer service cannot read the staff list");
  res = await call("/org/users", { token: sessions.director });
  check(res.status === 403, "the managing director cannot read the staff list (no system administration)");
  res = await call("/org/audit", { token: sessions.icto });
  check(res.status === 200 && res.payload?.scope === "system", "ICTO reads the system-scoped audit trail, not the full one");
  res = await call("/org/audit", { token: sessions.sales });
  check(res.status === 403, "audit logs remain closed to business roles");
  res = await call("/org/audit", { token: sessions.director });
  check(res.status === 403, "the managing director is not given system administration or the audit trail");
  res = await call("/org/audit", { token: sessions.admin });
  check(res.status === 200 && Array.isArray(res.payload), "the administrator still receives the full audit trail");

  // The MD sees business; the MD does not get administration.
  res = await call("/org/me", { token: sessions.director });
  check(res.payload.modules.includes("contracts") && res.payload.modules.includes("payments"), "MD workspace covers business modules");
  check(res.payload.permissions.includes("approve_management") && !res.payload.permissions.includes("approve_legal"), "MD approves contracts but does not approve them legally");
  check(!res.payload.permissions.some((key) => key.startsWith("manage_")), "MD holds no system administration");

  res = await call("/org/me", { token: sessions.finance });
  check(!res.payload.modules.includes("documents"), "finance is not given the documents module");
  check(res.payload.modules.includes("debts") && res.payload.modules.includes("payments"), "finance keeps its money modules");
  res = await call("/org/me", { token: sessions.legal });
  check(res.payload.modules.includes("contracts") && !res.payload.modules.includes("debts"), "legal sees contracts but not the finance registers");
  res = await call("/org/me", { token: sessions.customer_service });
  check(res.payload.modules.includes("appointments") && !res.payload.modules.includes("contracts"), "customer service is not given contract content");
  res = await call("/org/me", { token: sessions.icto });
  check(res.payload.modules.length === 0, "ICTO is given no business workspace at all");

  // A hidden module is also a request the server refuses.
  res = await call("/documents", { token: sessions.finance });
  check(res.status === 403, "finance is refused the documents endpoint");
  res = await call("/contracts", { token: sessions.customer_service });
  check(res.status === 403, "customer service is refused the contracts endpoint");

  if (failures) throw new Error(`${failures} matrix check(s) failed`);
}

try {
  await runMigrations();
  startServer();
  await waitForServer();
  await main();
  console.log("\nACCESS_MATRIX_ALL_PASSED");
} catch (error) {
  console.error("MATRIX FAILURE:", error.message);
  if (serverLogs.trim()) console.error("---- server logs ----\n" + serverLogs);
  process.exitCode = 1;
} finally {
  await stopServer();
  try { await cleanup(); } catch (error) { console.error("cleanup failed:", error.message); }
  await closeDatabase();
}
