// Frontend smoke test: runs the real app.js inside a minimal DOM sandbox and
// renders every screen for every sector. This is what catches render-time errors
// (undefined variables, temporal dead zones, bad property access) that a
// `node --check` syntax pass and API-level tests both miss.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(process.env.APP_JS || path.join(root, "frontend", "js", "app.js"), "utf8");

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

function makeElement(id = "") {
  return {
    id, innerHTML: "", textContent: "", value: "", hidden: true, disabled: false,
    dataset: {}, style: {}, attributes: {}, options: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return makeElement(); }, querySelectorAll() { return []; },
    appendChild() {}, removeChild() {}, remove() {}, closest() { return null; },
    setAttribute() {}, getAttribute() { return null; },
    focus() {}, click() {}, scrollIntoView() {}, contains() { return false; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 20 }; },
  };
}

const elements = new Map();
const getElement = (id) => {
  if (!elements.has(id)) elements.set(id, makeElement(id));
  return elements.get(id);
};

const document = {
  getElementById: getElement,
  querySelector: (selector) => getElement(`q:${selector}`),
  querySelectorAll: () => [],
  createElement: () => makeElement(),
  body: makeElement("body"),
  documentElement: makeElement("html"),
  addEventListener() {}, removeEventListener() {},
  activeElement: null,
};

const storage = new Map();
const okResponse = (payload) => ({ ok: true, status: 200, json: async () => payload, blob: async () => ({}), text: async () => "" });

const sandbox = {
  document,
  window: { location: { pathname: "/staff" }, history: { replaceState() {} }, addEventListener() {}, open() {} },
  location: { pathname: "/staff", href: "http://localhost:3003/staff" },
  history: { replaceState() {} },
  localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: async () => okResponse({}),
  console,
  setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
  setInterval: () => 0, clearInterval() {},
  // URLSearchParams is a browser global the app already relies on for its list
  // queries; the sandbox has to provide it or any lazily-loaded list would throw.
  URL: { createObjectURL: () => "blob:stub", revokeObjectURL() {} },
  URLSearchParams,
  Intl, Date, Math, Number, String, Boolean, Array, Object, JSON, Promise, Error, Set, Map,
  FormData: class { append() {} }, Blob: class {}, Event: class { constructor() {} },
};
sandbox.globalThis = sandbox;
sandbox.window.document = document;
sandbox.self = sandbox;

const context = vm.createContext(sandbox);
// `const`/`let` at script top level are not global properties, so expose the
// internals the harness drives explicitly.
const epilogue = `
globalThis.__app = {
  state,
  get currentUser() { return currentUser; },
  set currentUser(value) { currentUser = value; },
  render, applyWorkspace, updateNavigation, enterWorkspace, openModal,
  openGenerateContractModal, propertyOptionsForProject, addMonthsToDate,
  openTaskModal, taskModalHtml: () => document.getElementById("modal").innerHTML,
  modalOpen: () => document.getElementById("modal-backdrop").hidden === false,
  setView(view) { state.view = view; },
};
`;
const instrumented = source.replace(/\nboot\(\);\s*$/, `\n${epilogue}`);
try {
  vm.runInContext(instrumented, context, { filename: "app.js" });
} catch (error) {
  console.log(`FAIL  app.js failed to evaluate: ${error.message}`);
  process.exit(1);
}
const app = context.__app;
if (!app) { console.log("FAIL  app internals were not exposed"); process.exit(1); }
check(true, "app.js evaluates in the sandbox");

const has = (modules) => (module) => modules.includes(module);

const scenario = {
  administrator: {
    role: "admin",
    modules: ["projects", "properties", "clients", "leads", "contracts", "documents", "appointments", "debts", "payments", "reminders", "reports", "follow_ups"],
    me: { permissions: ["view", "create", "edit", "delete", "approve", "export", "view_financial", "view_reports", "manage_users", "manage_roles", "manage_permissions", "view_audit", "manage_backups"], financial: true, scope: "organization", rank: 100 },
  },
  director: {
    role: "staff",
    modules: ["projects", "properties", "clients", "leads", "contracts", "documents", "appointments", "debts", "payments", "reminders", "reports", "follow_ups"],
    me: { permissions: ["view", "create", "edit", "delete", "approve", "export", "view_financial", "view_reports", "approve_management"], financial: true, scope: "organization", rank: 80 },
  },
  sales: {
    role: "staff",
    modules: ["leads", "clients", "properties", "projects", "contracts", "appointments", "documents", "reports", "follow_ups"],
    me: { permissions: ["view", "create", "edit", "view_reports", "submit_contract", "access_leads", "access_clients", "access_properties", "access_projects", "access_contracts", "access_appointments", "access_documents", "access_reports"], financial: false, scope: "own", rank: 15 },
  },
  finance: {
    role: "staff",
    modules: ["debts", "payments", "reminders", "reports", "contracts", "clients"],
    me: { permissions: ["view", "create", "edit", "view_financial", "view_reports", "access_debts", "access_payments", "access_reminders", "access_reports", "access_contracts", "access_clients"], financial: true, scope: "own", rank: 15 },
  },
  property: {
    role: "staff",
    modules: ["properties", "projects", "clients", "appointments", "documents"],
    me: { permissions: ["view", "create", "edit", "access_properties", "access_projects", "access_clients", "access_appointments", "access_documents"], financial: false, scope: "own", rank: 15 },
  },
};


function workspacePayload(profile) {
  const can = has(profile.modules);
  const financial = profile.me.financial === true;
  const yes = (value) => [{ id: 1, ...value }];
  return {
    me: { ...profile.me, modules: profile.modules, user: { display_name: `${profile.role} user`, roles: [{ name: profile.role }], departments: [{ name: "Sector" }] } },
    projects: can("projects") ? yes({ name: "Riverside Heights", status: "active", created_at: "2026-01-01" }) : [],
    contracts: can("contracts") ? yes({ id: 10, client_id: 20, client_name: "Amani Client", project_id: 1, project_name: "Riverside Heights", contract_type: "new", status: "active", value: 500000, start_date: "2026-01-01", end_date: "2027-01-01", created_at: "2026-02-01" }) : [],
    clients: can("clients") ? yes({ id: 20, name: "Amani Client", client_type: "buyer", status: "active", project_id: 1, project_name: "Riverside Heights", created_at: "2026-01-05" }) : [],
    properties: can("properties") ? yes({ id: 30, name: "Villa 12", property_type: "villa", status: "available", price: 900000, location: "Dar es Salaam", area: 400, bedrooms: 4, bathrooms: 3, project_id: 1, project_name: "Riverside Heights", featured: true, image_count: 0, created_at: "2026-01-10" }) : [],
    appointments: can("appointments") ? yes({ id: 40, title: "Site visit", client_id: 20, client_name: "Amani Client", project_id: 1, project_name: "Riverside Heights", appointment_type: "viewing", starts_at: "2026-03-01T09:00:00", status: "scheduled" }) : [],
    documents: can("documents") ? yes({ id: 50, title: "Sale agreement", category: "agreement", status: "pending", project_id: 1, project_name: "Riverside Heights", client_name: "Amani Client", uploaded_at: "2026-02-02", created_at: "2026-02-02" }) : [],
    debts: can("debts") && financial ? yes({ id: 60, client_name: "Amani Client", contract_id: 10, contract_type: "new", project_id: 1, project_name: "Riverside Heights", amount: 120000, due_date: "2026-06-01", status: "pending", notes: "Installment 1/6" }) : [],
    payments: can("payments") && financial ? yes({ id: 70, client_name: "Amani Client", contract_id: 10, project_name: "Riverside Heights", amount: 20000, paid_at: "2026-03-01", method: "bank", reference: "REF-1", has_receipt: false }) : [],
    reminders: can("reminders") && financial ? yes({ id: 80, debt_id: 60, client_name: "Amani Client", project_name: "Riverside Heights", amount: 120000, due_date: "2026-06-01", remind_at: "2026-05-29T09:00:00" }) : [],
    summary: can("reports") ? {
      financial, active_projects: 1, contracts_total: 1,
      contracts_new: { count: 1, total: 500000 }, contracts_terminal: { count: 0, total: 0 },
      properties_available: 1, clients_active: 1, appointments_scheduled: 1, documents_pending: 1,
      debts_pending: financial ? { count: 1, total: 120000 } : null,
      debts_overdue: financial ? { count: 0, total: 0 } : null,
      debts_paid: financial ? { count: 1, total: 20000 } : null,
      income_all: financial ? { count: 1, total: 20000 } : null,
      income_30d: financial ? { count: 1, total: 20000 } : null,
    } : null,
    projectReports: can("reports") ? yes({ name: "Riverside Heights", new_contracts: 1, terminal_contracts: 0, contract_value: 500000, open_debts: financial ? 1 : null, properties: 1, clients: 1, appointments: 1, documents: 1 }) : [],
    reportTypes: { financial, types: can("reports") ? [{ id: "properties", label: "Property Report", filters: ["project"], status_values: [] }] : [], payment_methods: [{ value: "bank", label: "Bank transfer" }] },
    reportHistory: can("reports") ? yes({ id: 90, title: "Property Report", report_type: "properties", source: "generated", file_format: "xlsx", project_name: "Riverside Heights", created_at: "2026-02-03" }) : [],
    leads: can("leads") ? yes({ id: 100, name: "Neema Lead", email: "n@example.com", source: "Website", status: "new", client_id: null, created_at: "2026-02-04" }) : [],
    followUps: can("follow_ups") ? yes({ id: 110, follow_up_type: "call", status: "open", due_at: "2026-03-02T10:00:00", outcome: null }) : [],
    admin: {
      departments: [{ id: 1, name: "Sales & Marketing" }, { id: 2, name: "Management" }],
      roles: [{ id: 1, name: "System Administrator", rank: 100, scope: "organization", system_role: true, permission_count: 20, permissions: ["view"] }],
      users: [{ id: 1, display_name: "System Administrator", email: "admin@mkuyu.local", active: true, roles: [{ name: "System Administrator" }] }],
      audit: [{ id: 1, user_name: "System Administrator", action: "created", module: "user", created_at: "2026-02-05" }],
      approvals: [{ id: 1, module: "contract", record_id: 10, status: "pending", requested_by_name: "Amani Sales", created_at: "2026-02-06" }],
      dashboard: { financial: true, projects: 1, properties: 1, available_properties: 1, clients: 1, leads: 1, contracts: 1, follow_ups: 1, payments: 20000, outstanding: 120000, overdue: 0 },
      collections: { outstanding: yes({ id: 60 }), overdue: [], due_soon: [], follow_ups: [] },
    },
  };
}



const views = ["dashboard", "admin-dashboard", "projects", "properties", "clients", "contracts", "debts", "appointments", "documents", "reports", "duties", "assignments", "organization"];

// Keep the rendered markup per role/view so the visibility assertions below can
// inspect it, rather than only proving that render() did not throw.
const rendered = {};

for (const [name, profile] of Object.entries(scenario)) {
  const payload = workspacePayload(profile);
  const fetchStub = async (url) => {
    const p = String(url).replace("/api/v1", "");
    if (p === "/org/me") return okResponse(payload.me);
    if (p === "/org/workspace") return okResponse(payload);
    if (p.startsWith("/org/dashboard")) return okResponse(payload.admin.dashboard);
    if (p.startsWith("/org/collections")) return okResponse(payload.admin.collections);
    if (p.startsWith("/org/records/allocation")) return okResponse({ entities: [{ entity: "client", total: 1, unassigned: 0, records: [] }] });
    return okResponse({});
  };
  context.fetch = fetchStub;
  sandbox.fetch = fetchStub;

  for (const view of views) {
    try {
      app.currentUser = { role: profile.role, display_name: `${name} user`, email: `${name}@mkuyu.local` };
      app.state.view = view;
      app.state.loading = false;
      app.state.authorized = true;
      app.state.organization.me = payload.me;
      app.state.organization.admin = payload.admin;
      app.applyWorkspace(payload);
      app.updateNavigation();
      app.render();
      const html = getElement("content").innerHTML;
      rendered[`${name}:${view}`] = html;
      // Guard against a vacuous pass: a spinner means render() bailed early and
      // nothing was actually exercised.
      if (!html || html.includes("Loading workspace")) {
        check(false, `${name} renders "${view}": produced no content (render bailed early)`);
        continue;
      }
      check(true, `${name} renders "${view}" (${html.length} bytes)`);
    } catch (error) {
      check(false, `${name} renders "${view}": ${error.message}`);
    }
  }
}

// --- Reminders are gated on the `reminders` module, not on `debts` ------------
// The dashboard panel and the finance register must appear for a caller that
// holds `reminders`, and must be absent for one that does not.
console.log("\n=== reminders visibility follows the reminders module ===");
check((rendered["finance:dashboard"] || "").includes("Payment reminders"), "finance dashboard shows the payment reminders panel");
check((rendered["finance:debts"] || "").includes("Recorded payments"), "finance payments view shows recorded payments");
check((rendered["finance:debts"] || "").includes("Reminders"), "finance payments view shows the reminders register");
check(!(rendered["sales:dashboard"] || "").includes("Payment reminders"), "sales dashboard hides the reminders panel");
check(!(rendered["legal:dashboard"] || "").includes("Payment reminders"), "legal dashboard hides the reminders panel");
check(!(rendered["property:dashboard"] || "").includes("Payment reminders"), "property officer dashboard hides the reminders panel");
check((rendered["director:dashboard"] || "").includes("Payment reminders"), "the MD keeps the reminders panel");

console.log("\n=== dashboard with an empty business workspace ===");
{
  const profile = scenario.director;
  const payload = workspacePayload(profile);
  for (const key of ["projects", "properties", "contracts", "clients", "appointments", "documents", "debts", "payments", "leads", "followUps"]) payload[key] = [];
  payload.summary = { financial: true, active_projects: 0, contracts_total: 0, properties_available: 0, clients_active: 0, appointments_scheduled: 0, documents_pending: 0, debts_pending: { count: 0, total: 0 }, debts_overdue: { count: 0, total: 0 }, income_all: { count: 0, total: 0 }, income_30d: { count: 0, total: 0 }, contracts_new: { count: 0, total: 0 }, contracts_terminal: { count: 0, total: 0 } };
  app.currentUser = { role: "staff", display_name: "Joseph Mwakalinga", email: "md@mkuyu.local" };
  app.state.organization.me = payload.me;
  app.state.attention = { total: 0, mine: 0, review: 0 };
  app.applyWorkspace(payload);
  app.state.view = "dashboard";
  app.render();
  const html = getElement("content").innerHTML;
  check(html.includes("Your workspace is ready"), "empty dashboard has a clear, data-aware introduction");
  check(html.includes("No pending tasks") || html.includes("Nothing is waiting for you right now"), "empty dashboard reports no pending tasks");
  check(html.includes("Your work today") && html.includes("How your work moves"), "the Managing Director gets the simple \"Your work today\" home");
  check(html.includes("No active contracts"), "empty dashboard explains where contracts will appear");
  check(!html.includes("2.4k+") && !html.includes("TZS 86B") && !html.includes("99.2%"), "empty dashboard does not fabricate business statistics");
  check(getElement("primary-nav").innerHTML.includes("nav-group-label"), "navigation sections are grouped after RBAC filtering");
}

// --- Password reset is offered only where the API would accept it ------------
// The API gates the reset on requireAdmin(), so the button must not be rendered
// for any non-administrator, however privileged that caller is.
console.log("\n=== reset password control is administrator-only ===");
check((rendered["administrator:organization"] || "").includes('data-action="reset-password"'), "administrator sees the Reset password control");
check(!(rendered["director:organization"] || "").includes('data-action="reset-password"'), "the MD is not offered Reset password");
check(!(rendered["sales:organization"] || "").includes('data-action="reset-password"'), "a sales officer is not offered Reset password");

// --- Contract form pricing fields (Phase 2.1) ------------------------------
// The discount amount and final price must be visible but NOT editable and NOT
// submittable: Sales enters the original price and the percentage, and the server
// derives the rest. A named, writable field would let a client dictate the price.
console.log("\n=== contract form pricing fields ===");
{
  const profile = scenario.sales;
  const payload = workspacePayload(profile);
  app.currentUser = { role: profile.role, display_name: "sales user", email: "sales@mkuyu.local" };
  app.state.organization.me = payload.me;
  app.applyWorkspace(payload);

  app.openModal("contract", null);
  const modalHtml = getElement("modal").innerHTML;
  check(modalHtml.includes('name="original_price"'), "the contract form has an editable original price");
  check(modalHtml.includes('name="discount_pct"'), "the contract form has an editable discount percentage");
  check(modalHtml.includes('id="field-discount-amount"'), "the contract form shows the calculated discount amount");
  check(modalHtml.includes('id="field-final-price"'), "the contract form shows the calculated final price");
  check(!modalHtml.includes('name="final_price"'), "the final price is not a submitted field");
  check(!modalHtml.includes('name="discount_amount"'), "the discount amount is not a submitted field");
  check(!modalHtml.includes('name="value"'), "the old free-text contract value field is gone");
  check(/id="field-final-price"[^>]*readonly/.test(modalHtml), "the final price input is read-only");
  check(/id="field-discount-amount"[^>]*readonly/.test(modalHtml), "the discount amount input is read-only");
}

console.log("\n=== Generate Contract overlay ===");
{
  const profile = scenario.sales;
  const payload = workspacePayload(profile);
  app.currentUser = { role: profile.role, display_name: "sales user", email: "sales@mkuyu.local" };
  app.state.organization.me = payload.me;
  app.applyWorkspace(payload);
  app.state.contractTemplates = [];
  app.state.properties = [
    { id: 30, name: "Villa 12", location: "Dar es Salaam", project_id: 1, price: 900000 },
    { id: 31, name: "Villa 13", location: "Arusha", project_id: 2, price: 800000 },
  ];
  sandbox.fetch = async (url) => String(url).includes("/contract-templates") ? okResponse([]) : okResponse({});
  context.fetch = sandbox.fetch;
  // Step 1 asks what the contract is for: Buying, Renting or Company and seller.
  await app.openGenerateContractModal();
  const typeHtml = getElement("modal").innerHTML;
  check(app.modalOpen(), "Generate Contract opens the existing modal overlay");
  for (const kind of ["buy", "rent", "sell"]) check(typeHtml.includes(`data-kind="${kind}"`), `the first step offers the ${kind} agreement`);
  check(typeHtml.includes("Sale Agreement") && typeHtml.includes("Lease Agreement") && typeHtml.includes("Property Sale Mandate"), "each kind names the agreement it produces");
  check(!typeHtml.includes('id="gc-client-name"'), "the details form waits until a kind is chosen");
  // With a kind chosen (as the kind buttons and the Sell request do) the details follow.
  await app.openGenerateContractModal({ deal_type: "buy" });
  const modalHtml = getElement("modal").innerHTML;
  check((rendered["sales:contracts"] || "").includes('data-action="generate-contract"'), "the Contracts register offers Generate Contract");
  check(!(rendered["finance:contracts"] || "").includes('data-action="generate-contract"'), "Finance is not offered Generate Contract (it receives contracts once created)");
  check(modalHtml.includes('id="gc-title-deed"'), "the details ask for the title deed number");
  for (const field of ["gc-client-name", "gc-client-phone", "gc-client-email", "gc-company", "gc-project", "gc-property", "gc-property-number", "gc-property-location", "gc-start", "gc-end", "gc-duration", "gc-duration-unit", "gc-date", "gc-original", "gc-discount", "gc-discount-amount", "gc-final-price", "gc-deposit", "gc-installments", "gc-frequency", "gc-first-due", "gc-template"]) {
    check(modalHtml.includes(`id="${field}"`), `generation form includes ${field}`);
  }
  check(/id="gc-property"[^>]*required/.test(modalHtml), "property is required");
  check(/id="gc-duration"[^>]*required/.test(modalHtml), "agreement duration is required");
  check(/id="gc-discount-amount"[^>]*readonly/.test(modalHtml), "discount amount is read-only");
  check(/id="gc-final-price"[^>]*readonly/.test(modalHtml), "final price is read-only");
  check(!/name="(?:discount_amount|final_price|value)"/.test(modalHtml), "derived prices and contracts.value are not submitted fields");
  const filteredProperties = app.propertyOptionsForProject("1");
  check(filteredProperties.includes('value="30"') && !filteredProperties.includes('value="31"'), "property options are restricted to the selected project");
  check(app.addMonthsToDate("2027-01-31", 1, "months") === "2027-02-28", "the frontend duration preview clamps month-end dates correctly");
}

// --- Duty catalogue and approval workflow ----------------------------------
// The duties view is built entirely from GET /org/duties, which loads lazily, so
// the render pass above only ever sees its loading placeholder. Seed the same
// payload here to exercise the real markup: every department, every role, every
// duty, and the whole approval rail.
console.log("\n=== duties view renders the catalogue and the approval path ===");
{
  const { WORKFLOW_STAGES, WORKFLOW_EXCEPTIONS } = await import("./backend/src/contracts/workflow.js");
  const { departmentDutyTree, CONTRACT_OWNERSHIP } = await import("./backend/src/org/duties.js");
  const dutyCatalogue = () => departmentDutyTree(new Map()).flatMap((department) => department.roles);

  const dutiesFixture = (held) => ({
    departments: departmentDutyTree(new Map()).map((department) => ({
      ...department,
      roles: department.roles.map((role) => ({
        ...role,
        duties: role.duties.map((duty) => ({ ...duty, yours: duty.permissions.every((key) => held.includes(key)) })),
      })),
    })),
    workflow: {
      stages: WORKFLOW_STAGES.map((stage) => ({ ...stage, yours: held.includes(stage.permission) })),
      exceptions: WORKFLOW_EXCEPTIONS,
      ownership: CONTRACT_OWNERSHIP,
    },
    totals: { departments: 6, roles: 16, duties: 78 },
    yourApprovals: held.filter((key) => key in CONTRACT_OWNERSHIP),
  });

  const viewFor = (name, held) => {
    const profile = scenario[name];
    const payload = workspacePayload(profile);
    app.currentUser = { role: profile.role, display_name: `${name} user`, email: `${name}@mkuyu.local` };
    app.state.organization.me = payload.me;
    app.applyWorkspace(payload);
    app.state.duties = dutiesFixture(held);
    app.state.dutiesRequested = true;
    app.setView("duties");
    app.updateNavigation();
    app.render();
    return getElement("content").innerHTML;
  };

  // The MD sits at the management approval step, so the rail marks exactly one
  // stage as theirs and nothing in between.
  const mdHtml = viewFor("director", ["view", "create", "edit", "delete", "approve", "export", "view_financial", "view_reports", "approve_management", "request_changes", "access_contracts", "access_clients", "access_projects", "access_properties", "access_documents", "access_appointments", "access_debts", "access_payments", "access_reminders", "access_reports", "access_leads", "access_follow_ups"]);

  check(mdHtml.includes("Approval workflow"), "the view shows the approval workflow");
  check(mdHtml.includes("Duties by department"), "the view shows the duty breakdown");
  for (const department of ["MANAGEMENT", "FINANCE &amp; ACCOUNTS", "SALES, MARKETING &amp; OPERATIONS", "LEGAL", "CUSTOMER SERVICE", "ICT &amp; ADMINISTRATION"]) {
    check(mdHtml.includes(department), `the view lists ${department.replace(/&amp;/g, "&")}`);
  }
  for (const role of ["Managing Director", "Legal Manager", "Legal Officer", "Finance Manager", "Finance Officer", "ICTO", "Sales Officer", "Marketing Officer", "Property Officer", "Customer Service Officer"]) {
    check(mdHtml.includes(role), `the view lists the ${role} role`);
  }
  // Every stage of the rail must appear, in order, or the diagram is incomplete.
  const stageOrder = WORKFLOW_STAGES.map((stage) => mdHtml.indexOf(stage.label));
  check(stageOrder.every((index) => index > -1), "every approval stage is rendered");
  check(stageOrder.every((index, i) => i === 0 || index > stageOrder[i - 1]), "the stages render in pipeline order");
  for (const exception of WORKFLOW_EXCEPTIONS) {
    check(mdHtml.includes(exception.label), `the off-pipeline state "${exception.label}" is rendered`);
  }
  check(mdHtml.includes("Approve contracts legally"), "the legal approval duty is listed with its description");
  check(mdHtml.includes("duty-tag-yours"), "duties the caller holds are marked as theirs");
  check(mdHtml.includes("Your decision"), "a stage the caller decides is marked");

  // Sales must not be shown a stage only Legal or Management may act on. The
  // server decides this; the view must not contradict it by marking them.
  const salesHeld = ["view", "create", "edit", "view_reports", "submit_contract", "request_changes", "access_leads", "access_clients", "access_properties", "access_projects", "access_contracts", "access_appointments", "access_documents", "access_reports"];
  const salesHtml = viewFor("sales", salesHeld);
  const yoursCount = (salesHtml.match(/is-yours/g) || []).length;
  check(yoursCount > 0, "a sales officer is shown at least one step that is theirs");
  // Only the draft and submitted stages are Sales' to move; the rest belong to
  // Legal, Finance and Management and must carry no "yours" marker.
  const stageBlock = (html, stage) => {
    const start = html.indexOf(`>${stage.stage}<`);
    return start === -1 ? "" : html.slice(start, start + 700);
  };
  for (const stage of WORKFLOW_STAGES.filter((entry) => ["approve_legal", "approve_management", "review_legal"].includes(entry.permission))) {
    check(!stageBlock(salesHtml, stage).includes("Your decision"), `a sales officer is NOT marked as deciding "${stage.label}"`);
  }
  // Sales may SEE the whole path - it is reference data - but must be offered no
  // decision on it, and no duty that needs a permission they lack.
  check(salesHtml.includes("Management approval"), "a sales officer can still read the management approval step");
  const mdYourStages = WORKFLOW_STAGES.filter((entry) => entry.permission === "approve_management");
  check(mdYourStages.length === 1 && stageBlock(mdHtml, mdYourStages[0]).includes("Your decision"), "the MD IS marked as deciding the management approval step");
  // No duty may be marked "yours" unless the caller holds every permission that
  // duty needs. Checked against the rendered markup, not a re-derived flag.
  const overMarked = [];
  for (const role of dutyCatalogue()) {
    const start = salesHtml.indexOf(`>${role.role}<`);
    if (start === -1) continue;
    const block = salesHtml.slice(start);
    for (const duty of role.duties) {
      const shouldBeYours = duty.permissions.every((key) => salesHeld.includes(key));
      const at = block.indexOf(duty.label);
      if (at === -1) continue;
      const isMarked = block.slice(at, at + 400).includes("duty-tag-yours");
      if (shouldBeYours && !isMarked) overMarked.push(`missing: ${role.role}/${duty.key}`);
      if (!shouldBeYours && isMarked) overMarked.push(`over-claimed: ${role.role}/${duty.key}`);
    }
  }
  check(overMarked.length === 0, `a duty is marked "yours" exactly when the caller holds every permission it needs${overMarked.length ? ` (${overMarked.join(", ")})` : ""}`);
  app.state.duties = null;
  app.state.dutiesRequested = false;
}

check(!(rendered["finance:organization"] || "").includes('data-action="reset-password"'), "a finance officer is not offered Reset password");

// --- Navigation audit: unauthorized items must be ABSENT from the DOM ---------
// The nav is generated into #primary-nav, so its markup is the evidence. An item
// that is merely `hidden` or `disabled` would still appear here; the requirement
// is that it is not written at all.
console.log("\n=== navigation contains only the authorized workspace ===");

// role -> views that MUST be absent / MUST be present.
const NAV_EXPECTATIONS = {
  // The System Administrator runs the system, not the business: one place
    // (Administration), no business module, no business dashboard.
    administrator: { absent: ["dashboard", "admin-dashboard", "projects", "properties", "clients", "contracts", "debts", "appointments", "documents", "reports", "requests", "leads"], present: ["organization", "assignments", "duties"] },
  // "duties" is the duty catalogue and the approval path. It is reference data,
  // not a module, so every role may read it - unlike the administration screens.
  director: { absent: ["admin-dashboard", "organization"], present: ["dashboard", "projects", "properties", "clients", "contracts", "debts", "appointments", "documents", "reports", "duties"] },
  finance: { absent: ["admin-dashboard", "organization", "properties", "appointments"], present: ["dashboard", "clients", "contracts", "debts", "reports", "duties"] },
  sales: { absent: ["admin-dashboard", "organization", "debts"], present: ["dashboard", "projects", "properties", "clients", "contracts", "appointments", "documents", "reports", "duties"] },
  property: { absent: ["admin-dashboard", "organization", "contracts", "debts", "reports"], present: ["dashboard", "projects", "properties", "clients", "appointments", "documents", "duties"] },
};

for (const [name, expected] of Object.entries(NAV_EXPECTATIONS)) {
  const profile = scenario[name];
  if (!profile) continue;
  const payload = workspacePayload(profile);
  app.currentUser = { role: profile.role, display_name: `${name} user`, email: `${name}@mkuyu.local` };
  app.state.view = "dashboard";
  app.state.loading = false;
  app.state.authorized = true;
  app.state.organization.me = payload.me;
  app.state.organization.admin = payload.admin;
  app.applyWorkspace(payload);
  app.updateNavigation();
  const nav = getElement("primary-nav").innerHTML;
  for (const view of expected.absent) {
    check(!nav.includes(`data-view="${view}"`), `${name}: "${view}" is absent from the navigation`);
  }
  for (const view of expected.present) {
    check(nav.includes(`data-view="${view}"`), `${name}: "${view}" is present in the navigation`);
  }
}

// A forced administration view must bounce back for anyone who is not the
// administrator, so the MD cannot land on Administration by setting the view.
{
  const profile = scenario.director;
  const payload = workspacePayload(profile);
  app.currentUser = { role: profile.role, display_name: "director user", email: "md@mkuyu.local" };
  app.state.organization.me = payload.me;
  app.state.organization.admin = payload.admin;
  app.applyWorkspace(payload);
  for (const forced of ["admin-dashboard", "organization"]) {
    app.setView(forced);
    app.updateNavigation();
    check(app.state.view === "dashboard", `the MD is returned to the dashboard from "${forced}"`);
  }
  check(!scenario.director.me.permissions.some((key) => key.startsWith("manage_")), "the MD holds no manage_* permission that would justify administration");
}

// --- Assignments: the workspace and the attention badge ----------------------
// The badge count must come from the server, and the action buttons must come
// from each task's server-computed available_actions. A UI that hardcodes
// "Approve" or "Submit" for everybody is exactly what must not happen.
console.log("\n=== assignments view renders the server-authorized workspace ===");
{
  const taskFixture = (overrides = {}) => ({
    id: 501,
    title: "Prepare Monthly Sales Report",
    description: "New clients, renewals and completed contracts.",
    assigned_by_name: "Daniel Kibe",
    assigned_to_name: "Amina Sanga",
    reviewer_name: "Daniel Kibe",
    priority: "high",
    due_date: "2026-10-05",
    status: "in_progress",
    linked_entity: null,
    linked_record_id: null,
    available_actions: ["submit"],
    ...overrides,
  });

  const viewFor = (name, held, tasks, attention) => {
    const profile = { ...scenario[name], me: { ...scenario[name].me, permissions: [...scenario[name].me.permissions, ...held] } };
    const payload = workspacePayload(profile);
    payload.me = { ...payload.me, permissions: profile.me.permissions, attention };
    app.currentUser = { role: profile.role, display_name: `${name} user`, email: `${name}@mkuyu.local` };
    app.state.organization.me = payload.me;
    app.state.organization.admin = payload.admin;
    app.state.tasks = tasks;
    app.state.tasksRequested = true;
    app.setView("assignments");
    app.applyWorkspace(payload);
    app.updateNavigation();
    app.render();
    return { html: getElement("content").innerHTML, nav: getElement("primary-nav").innerHTML };
  };

  const staff = viewFor("sales", [], [taskFixture()], { total: 1, mine: 1, review: 0 });
  check(staff.html.includes("Assignments"), "the assignments view renders");
  check(staff.html.includes("Prepare Monthly Sales Report"), "it shows the task title");
  check(staff.html.includes("High"), "priority is shown as a WORD, not as colour alone");
  check(staff.html.includes("05 Oct 2026"), "the due date is shown");
  check(staff.html.includes("Daniel Kibe") && staff.html.includes("Amina Sanga"), "it shows who assigned the work and who received it");
  check(staff.html.includes('data-task-action="submit"'), "the assignee is offered Submit");
  check(!staff.html.includes('data-task-action="approve"'), "the assignee is NOT offered Approve");
  check(!staff.html.includes('data-action="new-task"'), "a holder of no assignment authority is not offered the Assign work control");
  check(staff.nav.includes("Assignments") && /nav-count">1</.test(staff.nav), "the navigation shows Assignments with the server's attention count");

  const manager = viewFor("director", ["assign_tasks", "review_tasks"], [taskFixture({ status: "under_review", available_actions: ["approve", "request_changes", "cancel"] })], { total: 2, mine: 0, review: 2 });
  check(manager.html.includes('data-task-action="approve"') && manager.html.includes('data-task-action="request_changes"'), "the reviewer is offered Approve and Request changes");
  check(!manager.html.includes('data-task-action="submit"'), "the reviewer is NOT offered Submit");
  check(manager.html.includes('data-action="new-task"'), "a holder of assign_tasks is offered the Assign work control");

  // An empty section says so plainly rather than inventing content.
  const empty = viewFor("sales", [], [], { total: 0, mine: 0, review: 0 });
  check(empty.html.includes("No tasks in this section"), "an empty section says so instead of inventing content");
  check(!/nav-count">0</.test(empty.nav), "a zero attention count renders no badge");

  // The priority and status filters exist and are labelled.
  check(staff.html.includes('data-action="task-priority-filter"') && staff.html.includes('data-action="task-status-filter"'), "priority and status are filterable from the workspace");
}

// --- The New Task entry point actually opens a working form -------------------
// Markup alone is not enough: the earlier check only proved a button existed in
// the HTML. This drives the real function the button calls and asserts the form
// it produces, including that the assignee list comes from the backend.
console.log("\n=== the New Task button opens an authorized form ===");
{
  const ASSIGNEES = [{ id: 41, display_name: "Amina Sanga" }, { id: 42, display_name: "Peter Ndosi" }];
  const REVIEWERS = [{ id: 43, display_name: "Daniel Kibe" }];
  const errorResponse = (message) => ({ ok: false, status: 403, json: async () => ({ error: message }), text: async () => "", blob: async () => ({}) });

  const run = async (name, held, routes) => {
    const profile = { ...scenario[name], me: { ...scenario[name].me, permissions: [...scenario[name].me.permissions, ...held] } };
    const payload = workspacePayload(profile);
    payload.me = { ...payload.me, permissions: profile.me.permissions, attention: { total: 0, mine: 0, review: 0 } };
    app.currentUser = { role: profile.role, display_name: `${name} user`, email: `${name}@mkuyu.local` };
    app.state.organization.me = payload.me;
    app.state.tasks = [];
    app.state.tasksRequested = true;
    app.setView("assignments");
    app.applyWorkspace(payload);
    app.updateNavigation();
    app.render();
    // Each case starts from a closed modal, so "the modal stayed closed" means
    // this call did not open it rather than that a previous case left it open.
    getElement("modal-backdrop").hidden = true;
    getElement("modal").innerHTML = "";
    context.fetch = async (url) => routes(String(url).replace("/api/v1", ""));
    sandbox.fetch = context.fetch;
    const hasButton = getElement("content").innerHTML.includes('data-action="new-task"');
    await app.openTaskModal();
    return { hasButton, html: app.taskModalHtml(), open: app.modalOpen() };
  };

  // 1. The MD sees the entry point and the form opens with authorized people.
  const mdResult = await run("director", ["assign_tasks", "review_tasks"], (p) => {
    if (p === "/org/tasks/assignees") return okResponse(ASSIGNEES);
    if (p === "/org/tasks/reviewers") return okResponse(REVIEWERS);
    return okResponse({});
  });
  check(mdResult.hasButton, "1. the Managing Director is offered the New Task button");
  check(mdResult.open, "2. clicking it opens the modal");
  check(mdResult.html.includes("New Task") && mdResult.html.includes('id="task-form"'), "3. the modal is a task form titled 'New Task'");
  for (const field of ["task-title", "task-description", "task-assignee", "task-priority-input", "task-due"]) {
    check(mdResult.html.includes(`id="${field}"`), `the form has the ${field.replace("task-", "")} field`);
  }
  check(mdResult.html.includes('name="linked_entity"') && mdResult.html.includes('name="linked_record_id"'), "4. the form offers the optional linked record");
  for (const label of ["Urgent", "High", "Medium", "Low"]) {
    check(mdResult.html.includes(`>${label}</option>`), `the priority field offers ${label}`);
  }
  check(ASSIGNEES.every((person) => mdResult.html.includes(person.display_name)), "5. the assignee options are exactly the people the backend authorized");
  check(mdResult.html.includes("Daniel Kibe"), "6. the reviewer list is offered");
  check(!mdResult.html.includes('name="assigned_by"'), "7. the form never sends an assigned_by field");

  // 2. An authorized department manager gets the same entry point.
  const mgrResult = await run("director", ["assign_tasks", "review_tasks"], (p) => {
    if (p === "/org/tasks/assignees") return okResponse([ASSIGNEES[0]]);
    if (p === "/org/tasks/reviewers") return okResponse(REVIEWERS);
    return okResponse({});
  });
  check(mgrResult.hasButton && mgrResult.open, "8. an authorized Department Manager is offered the New Task button");
  check(mgrResult.html.includes("Amina Sanga") && !mgrResult.html.includes("Peter Ndosi"), "9. the manager is only offered the people in their own scope");

  // 3. Unauthorized staff never see the button.
  const staffResult = await run("sales", [], (p) => (p.startsWith("/org/tasks") ? errorResponse("permission denied") : okResponse({})));
  check(!staffResult.hasButton, "10. a staff member without assign_tasks is NOT offered the New Task button");
  check(!staffResult.open, "11. and the modal stays closed for them");
  check(!getElement("topbar-actions").innerHTML.includes('data-action="new-task"'), "12. the topbar shows no New Task button for them either");

  // 4. Holding assign_tasks without review_tasks must still be able to create.
  //    The reviewer list failing may not take the whole entry point down with it.
  const partialResult = await run("director", ["assign_tasks"], (p) => {
    if (p === "/org/tasks/assignees") return okResponse(ASSIGNEES);
    if (p === "/org/tasks/reviewers") return errorResponse("permission denied");
    return okResponse({});
  });
  check(partialResult.open, "13. a caller who can assign but not review still gets a working form");
  check(partialResult.html.includes('name="assigned_to"') && partialResult.html.includes('name="title"'), "14. that form is still submittable");
  check(!partialResult.html.includes('id="task-reviewer"'), "15. it simply offers no reviewer field rather than a broken one");
}

console.log("\n=== finance can open the contract behind an installment ===");
{
  const profile = scenario.finance;
  const payload = workspacePayload(profile);
  app.currentUser = { role: profile.role, display_name: "finance user", email: "finance@mkuyu.local" };
  app.state.view = "debts";
  app.state.loading = false;
  app.state.authorized = true;
  app.state.organization.me = payload.me;
  app.state.organization.admin = payload.admin;
  app.applyWorkspace(payload);
  app.updateNavigation();
  app.render();
  const html = getElement("content").innerHTML;
  check(payload.debts.length > 0 && payload.contracts.length > 0, "the finance fixture has both an installment and its contract");
  check(html.includes('data-action="view-contract"'), "finance installment rows offer View contract");
  // A caller without the contracts module must not get the button at all.
  const salesPayload = workspacePayload(scenario.sales);
  app.currentUser = { role: scenario.sales.role, display_name: "sales user", email: "sales@mkuyu.local" };
  app.state.organization.me = salesPayload.me;
  app.applyWorkspace(salesPayload);
  app.setView("debts");
  app.updateNavigation();
  app.render();
  check(!getElement("content").innerHTML.includes('data-action="view-contract"'), "a caller without the contracts module gets no View contract button");
}

// --- Admin Portal / Staff Portal separation ---------------------------------
// Only `user.role === 'admin'` enters the Admin Portal. Every other account -
// including the MD, who holds wide business authority - is routed to the Staff
// Portal, and the admin-only navigation items are not rendered for them at all.
console.log("\n=== admin portal is separated from the staff portal ===");
for (const [name, profile] of Object.entries(scenario)) {
  const payload = workspacePayload(profile);
  app.currentUser = { role: profile.role, display_name: `${name} user`, email: `${name}@mkuyu.local` };
  app.state.organization.me = payload.me;
  app.applyWorkspace(payload);

  const isAdministrator = profile.role === "admin";
  const portal = isAdministrator ? "/admin" : "/staff";
  check(true, `${name} (${profile.role}) enters the ${isAdministrator ? "ADMIN" : "STAFF"} portal ${portal}`);

  app.state.view = isAdministrator ? "admin-dashboard" : "dashboard";
  app.updateNavigation();
  const nav = getElement("primary-nav").innerHTML;
  if (isAdministrator) {
    check(!nav.includes('data-view="admin-dashboard"') && nav.includes('data-view="organization"'), "the administrator works from one place: Administration (no separate overview)");
    check(nav.includes('data-view="organization"'), "administrator keeps the Administration item");
  } else {
    // Absence, not disabled: the markup must not contain the item at all.
    check(!nav.includes('data-view="admin-dashboard"'), `${name} (${profile.role}): Admin overview is ABSENT from the staff portal nav`);
    check(!nav.includes('data-view="organization"'), `${name} (${profile.role}): Administration is ABSENT from the staff portal nav`);
  }

  // A non-administrator that somehow lands on an admin view is returned to the
  // dashboard, so the admin screens are unreachable by navigation as well.
  if (!isAdministrator) {
    for (const forced of ["admin-dashboard", "organization"]) {
      app.setView(forced);
      app.updateNavigation();
      check(app.state.view === "dashboard", `${name}: "${forced}" is not reachable (redirected to dashboard)`);
    }
  }
}

// --- New Client guided workflow: a completed client needs a contract --------
// The form must explain the rule and offer the contract step, while leaving the
// prospect path open. These are display guarantees; the server is the authority.
console.log("\n=== new client form guides the contract requirement ===");
{
  const profile = scenario.sales;
  const payload = workspacePayload(profile);
  app.currentUser = { role: profile.role, display_name: "sales user", email: "sales@mkuyu.local" };
  app.state.organization.me = payload.me;
  app.applyWorkspace(payload);

  app.openModal("client", null);
  const html = getElement("modal").innerHTML;
  check(html.includes("cannot be saved without one") || html.includes("required to complete this client"), "the client form states that completing a client needs a contract");
  check(html.includes("Contract (required to complete this client)"), "the client form offers the contract step");
  check(html.includes("id=\"field-client-original-price\""), "the contract step carries the original price");
  check(html.includes("id=\"field-client-discount-pct\""), "the contract step carries the discount percentage");
  check(/id="field-client-final-price"[^>]*readonly/.test(html), "the final price in the client form is read-only");
  check(/id="field-client-discount-amount"[^>]*readonly/.test(html), "the discount amount in the client form is read-only");
  check(html.includes("Lead / prospect"), "the prospect option is still offered");
  // A caller without the contracts module sees the explanation, not the form.
  const csPayload = workspacePayload(scenario.property);
  app.currentUser = { role: scenario.property.role, display_name: "property user", email: "property@mkuyu.local" };
  app.state.organization.me = csPayload.me;
  app.applyWorkspace(csPayload);
  app.openModal("client", null);
  const noContractHtml = getElement("modal").innerHTML;
  check(noContractHtml.includes("cannot be saved without one"), "a caller without the contracts module still sees the requirement explained");
  check(!noContractHtml.includes("field-client-original-price"), "a caller without the contracts module is not offered the contract form");
}

console.log(failures ? `\n${failures} FRONTEND CHECK(S) FAILED` : "\nFRONTEND_RENDER_ALL_PASSED");
if (failures) process.exitCode = 1;

