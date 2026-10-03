const API_ROOT = "/api/v1";
const ADMIN_PATH = "/admin";
const STAFF_PATH = "/staff";
// The session lives in an HttpOnly cookie that this page cannot read, so a
// script injected into the page cannot steal it (MK-05). Every request carries
// the CSRF header the server requires for cookie-authenticated changes.
// "Remember me" decides how long the server keeps the cookie.
const CSRF_HEADERS = { "X-MKUYU-CSRF": "1" };
// Tokens that earlier versions kept in browser storage are removed for good.
try { localStorage.removeItem("mkuyu_token"); sessionStorage.removeItem("mkuyu_session_token"); } catch (_) { /* storage unavailable */ }

const state = {
  view: "dashboard",
  projects: [],
  properties: [],
  clients: [],
  contracts: [],
  debts: [],
  appointments: [],
  documents: [],
  reminders: [],
  payments: [],
  summary: null,
  projectReports: [],
  reportTypes: [],
  reportPaymentMethods: [],
  reportHistory: [],
  reportPreview: null,
  organization: { departments: [], roles: [], permissions: [], users: [], leads: [], followUps: [], approvals: [], audit: [], me: null, dashboard: null, collections: null },
  // Duty catalogue + approval workflow from GET /org/duties. Reference data, not
  // a module, so it is loaded on demand when the view is first opened.
  duties: null,
  dutiesRequested: false,
  allocation: null,
  allocationEntity: "client",
  allocationUnassigned: true,
  shares: null,
  reportFilters: { source: "", reportType: "", projectId: "", search: "", from: "", to: "" },
  filters: { project: "", type: "", status: "", debtStatus: "", propertyStatus: "", clientStatus: "", appointmentStatus: "", documentStatus: "", documentSearch: "", sort: "", paymentStatus: "" },
  // ---- paginated list state -----------------------------------------------
  // The workspace returns the FIRST PAGE of each list, not the whole table, so
  // the dashboard must never derive a total from `state.X.length` - that is now
  // a page size. `counts` holds the server-computed, SCOPED totals;
  // `pages` holds the page descriptors so a pager needs no extra request.
  counts: {},
  pages: {},
  // Per-list request bookkeeping: which page is loaded, whether a fetch is in
  // flight (so a re-render cannot stack requests), and the last server search
  // term actually applied.
  listState: {},
  loading: true,
  // ---- task assignment workspace --------------------------------------------
  // Loaded on demand for the Assignments view. `attention` is the server's own
  // count (from /org/me and refreshed after every task action) - the badge is
  // never computed here from local rows, so it cannot drift from the backend.
  tasks: null,
  taskBox: "all",
  taskPriority: "",
  taskStatus: "",
  tasksRequested: false,
  taskAssignees: [],
  taskReviewers: [],
  attention: { total: 0, mine: 0, review: 0 },
  // ---- contract generation ---------------------------------------------------
  // The Generate Contract overlay collects everything, then the SERVER decides
  // the price, writes the contract, renders the template and returns the created
  // document. `step` drives form -> review -> success inside one modal, so the
  // flow never becomes a separate page or a second module.
  contractTemplates: null,
  contractGen: { step: "form", result: null, error: null },
  // Small-screen navigation drawer state, driven by the mobile menu button.
  navOpen: false,
  // Set once /org/me resolved; the workspace stays hidden until then.
  authorized: false,
  toastTimer: null,
  reportSearchTimer: null,
};

const content = document.getElementById("content");
const modalBackdrop = document.getElementById("modal-backdrop");
const modal = document.getElementById("modal");
const pageTitle = document.getElementById("page-title");
const pageSub = document.getElementById("page-sub");
const topbarActions = document.getElementById("topbar-actions");

const authScreen = document.getElementById("auth-screen");
const workspace = document.getElementById("workspace");
const authForm = document.getElementById("auth-form");
const authMessage = document.getElementById("auth-message");
const authSubmit = document.getElementById("auth-submit");
const authTitle = document.getElementById("auth-title");
const authSubtitle = document.getElementById("auth-subtitle");
const displayNameField = document.getElementById("display-name-field");
const authSwitchLabel = document.getElementById("auth-switch-label");
const authToggle = document.getElementById("auth-toggle");
const authRemember = document.getElementById("auth-remember");
const authForgot = document.getElementById("auth-forgot");
const portalTabs = document.getElementById("portal-tabs");
const brandSub = document.getElementById("brand-sub");
const globalSearch = document.getElementById("global-search");
const bellDot = document.getElementById("bell-dot");

let authMode = "login";
let currentUser = null;
// Which portal the user asked for on the sign-in screen. It is sent to the
// server with the credential, which refuses an account that does not belong to
// it; `enterWorkspace` still routes on the role the server reports.
let authPortal = "staff";

function showAuthMessage(message, tone = "error") {
  authMessage.textContent = message;
  authMessage.classList.toggle("info", tone === "info");
  authMessage.hidden = false;
}

function hideAuthMessage() {
  authMessage.hidden = true;
}

function setAuthMode(mode) {
  authMode = mode === "setup" ? "setup" : "login";
  const isSetup = authMode === "setup";
  displayNameField.hidden = !isSetup;
  document.getElementById("auth-name").required = isSetup;
  authTitle.textContent = isSetup ? "Create workspace" : "Welcome back";
  authSubtitle.textContent = isSetup
    ? "Set up the first private office account."
    : "Sign in to your MKUYU workspace";
  authSubmit.textContent = isSetup ? "Create workspace" : "Sign in to workspace";
  authSwitchLabel.textContent = isSetup ? "Already have access?" : "New private workspace?";
  authToggle.textContent = isSetup ? "Sign in" : "Create an account";
  // First-run setup creates the one administrator, so the portal switch is
  // meaningless there and would only invite the wrong expectation.
  if (portalTabs) portalTabs.hidden = isSetup;
  hideAuthMessage();
}

/** Highlights the chosen portal tab. The server enforces the pairing. */
function setAuthPortal(portal) {
  authPortal = portal === "admin" ? "admin" : "staff";
  if (!portalTabs) return;
  for (const tab of portalTabs.querySelectorAll(".portal-tab")) {
    const active = tab.dataset.portal === authPortal;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  }
}

function endSession(message = "") {
  currentUser = null;
  stopLive();
  closeModal();
  // Cached picture blobs belong to the session that fetched them. Signing out
  // releases them rather than leaving them for whoever signs in next.
  clearImageBlobCache();
  // Per-person lists loaded on demand must not survive into the next session:
  // the next person would see the previous person's tasks and buttons.
  Object.assign(state, {
    tasks: null, tasksRequested: false, taskBox: "all", attention: null,
    requests: null, requestsRequested: false, requestStage: "",
    taskAssignees: null, taskReviewers: null, pendingHandOff: null, smallFormSubmit: null,
  });
  state.navOpen = false;
  document.getElementById("primary-nav")?.classList.remove("nav-open");
  workspace.hidden = true;
  authScreen.hidden = false;
  // The next person to sign in on this computer starts with an empty form.
  authForm.reset();
  if (authRemember) authRemember.checked = true;
  if (message) showAuthMessage(message);
}

// Bumped after an upload so the cached picture is refetched.
let photoVersion = Date.now();

/** Shows the caller's photo in the sidebar, falling back to their initial. */
function renderUserAvatar() {
  const avatar = document.getElementById("user-avatar");
  if (!avatar) return;
  const user = state.organization.me?.user || currentUser || {};
  const initial = escapeHtml(String(user.display_name || user.email || "?").charAt(0).toUpperCase());
  avatar.innerHTML = user.has_photo && user.id
    ? `<span>${initial}</span><img data-src="${API_ROOT}/org/users/${user.id}/photo?v=${photoVersion}" alt="">`
    : `<span>${initial}</span>`;
  if (user.has_photo) hydrateImages(avatar);
}

function enterWorkspace(user) {
  currentUser = user;
  authScreen.hidden = true;
  // The workspace stays hidden until the authorization bootstrap resolves, so a
  // staff member never sees a flash of navigation they are not allowed to open.
  workspace.hidden = true;
  hideAuthMessage();
  const name = user.display_name || user.email || "Office";
  const isAdmin = currentUser?.role === "admin";
  const path = isAdmin ? ADMIN_PATH : STAFF_PATH;
  if (window.location.pathname !== path) window.history.replaceState({}, "", path);
  state.view = isAdmin ? "admin-dashboard" : "dashboard";
  state.authorized = false;
  document.getElementById("user-name").textContent = name;
  document.getElementById("user-email").textContent = user.email || "Private workspace";
  setUserAvatar(user);
  // The rail names the portal the caller actually landed in, which is the role
  // the server reported rather than the tab they happened to click.
  if (brandSub) brandSub.textContent = isAdmin ? "Admin Portal" : "Staff Portal";
  bootstrap();
  // Changes made by anyone appear here without a refresh.
  startLive();
  if (!isAdmin) showAppointmentReminders();
}

/**
 * Morning appointment reminder (MD and Sales). The server decides who gets it
 * and hands it out once per person per day, so a second login shows nothing.
 * Its own overlay, so it never disturbs the shared modal.
 */
async function showAppointmentReminders() {
  let reminders = [];
  try { ({ reminders = [] } = await api("/org/appointment-reminders")); } catch (_) { return; }
  if (!reminders.length) return;
  const when = (days) => (days === 1 ? "Appointment is tomorrow" : `Appointment is in ${days} days`);
  const items = reminders.map((apt) => `<li class="apt-reminder-item">
      <strong>${escapeHtml(when(Number(apt.days_left)))}</strong>
      <span>${escapeHtml(apt.title)}</span>
      <span class="muted">${escapeHtml(apt.client_name || "")}${apt.property_name ? ` · ${escapeHtml(apt.property_name)}` : ""} · ${formatDateTime(apt.starts_at, true)}</span>
    </li>`).join("");
  document.getElementById("apt-reminder")?.remove();
  const box = document.createElement("div");
  box.id = "apt-reminder";
  box.className = "apt-reminder-backdrop";
  box.innerHTML = `<div class="apt-reminder" role="dialog" aria-modal="true" aria-labelledby="apt-reminder-title">
      <div class="apt-reminder-head"><h2 id="apt-reminder-title">${icon("calendar")}Upcoming appointments</h2>
        <button type="button" class="close-btn" data-close-reminder aria-label="Close">${closeIcon()}</button></div>
      <ul class="apt-reminder-list">${items}</ul>
      <div class="form-actions"><button type="button" class="btn btn-primary" data-close-reminder>Close</button></div>
    </div>`;
  box.addEventListener("click", (event) => { if (event.target === box || event.target.closest("[data-close-reminder]")) box.remove(); });
  document.body.appendChild(box);
}

function setUserAvatar() {
  // One avatar implementation: renderUserAvatar() reads the signed-in profile.
  renderUserAvatar();
}

/** Resolves the caller's permissions, scope and module list before anything renders. */
async function bootstrap() {
  state.loading = true;
  try {
    const me = await api("/org/me");
    state.organization.me = me;
    currentUser = { ...currentUser, ...me.user };
    setUserAvatar(currentUser);
    state.authorized = true;
  } catch (error) {
    if (error?.sessionExpired) return;
    endSession("Unable to load your workspace permissions. Please sign in again.");
    return;
  }
  updateNavigation();
  workspace.hidden = false;
  await refresh();
}

const viewMeta = {
  dashboard: ["Dashboard", "What needs you today, and where the portfolio stands"],
  projects: ["Projects", "Developments and the properties, clients and contracts in each"],
  properties: ["Properties", "The property portfolio: status, price, location and photos"],
  clients: ["Clients", "People and companies, from first enquiry to signed agreement"],
  contracts: ["Contracts", "Every agreement and where it sits in the approval workflow"],
  debts: ["Payments & debts", "Installments, balances, recorded payments and reminders"],
  reminders: ["Reminders", "Installments due now and falling due soon, so no payment date is missed"],
  appointments: ["Appointments", "Viewings, calls, meetings and inspections"],
  requests: ["Requests", "Buy, Rent and Sell requests and Contact-page messages from the website, from arrival to answer"],
  leads: ["Leads", "Enquiries and prospects, before they become clients"],
  documents: ["Documents", "Agreements, titles, receipts, reports and permits"],
  templates: ["Contract templates", "The Word files every new contract is produced on"],
  reports: ["Reports", "Generated and uploaded management reports"],
  "admin-dashboard": ["Admin overview", "Staff access, privileges and organization health"],
  duties: ["Duties & approvals", "The approval path, and every duty on every department"],
  assignments: ["Assignments", "Work assigned to you, and the decisions waiting on you"],
  organization: ["Staff", "Staff accounts A to Z: add, reset passwords, move, change roles, deactivate"],
  departments: ["Departments", "Every department A to Z, with its staff"],
  roles: ["Roles & permissions", "Every role, its rank, its data scope and what it may do"],
  system: ["System & backups", "Activity log, record ownership and workspace backups"],
};

// Contract lifecycle labels. The status vocabulary is defined server-side in
// backend/src/contracts/workflow.js; this is the display layer over it, and the
// matching badge colours live in app.css.
const CONTRACT_STATUS_LABELS = {
  draft: "Under Sales review",
  submitted: "Submitted to Legal",
  under_review: "Under Legal review",
  changes_requested: "Under Sales review · changes requested",
  legal_approved: "Under Finance review / Finance validated",
  pending_management_approval: "Under MD review",
  approved: "MD approved · Legal to send to customer",
  customer_pending: "With the customer for signature",
  active: "Active",
  completed: "Completed",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

// Accepts a contract or a bare status. Given a contract, the badge says where it
// is right now (Under Sales / Legal / Finance / MD review ...) using the
// server-computed `position`, which also knows whether Finance has validated.
function contractStatusBadge(contractOrStatus) {
  const contract = contractOrStatus && typeof contractOrStatus === "object" ? contractOrStatus : null;
  const status = contract ? contract.status : contractOrStatus;
  const label = contract?.position?.label || contractStatusLabel(status);
  const desk = contract?.position?.key ? ` badge-position-${escapeHtml(contract.position.key)}` : "";
  return `<span class="badge badge-contract-${escapeHtml(String(status || "draft"))}${desk}">${escapeHtml(label)}</span>`;
}

/** "Step 4 of 10 · With Finance" for a contract still moving through the workflow. */
function contractPositionNote(contract) {
  const position = contract?.position;
  if (!position?.step || !position.desk) return "";
  return `<span class="cell-sub stage-note" title="Where this contract is right now">Step ${position.step} of ${position.total} · With ${escapeHtml(position.desk)}</span>`;
}

function contractStatusLabel(status) {
  return CONTRACT_STATUS_LABELS[status] || String(status || "—").replace(/_/g, " ");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[character]));
}

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function money(value) {
  try {
    return new Intl.NumberFormat("en-TZ", { style: "currency", currency: "TZS", maximumFractionDigits: 0 }).format(numberValue(value));
  } catch (_) {
    return `TZS ${numberValue(value).toLocaleString()}`;
  }
}

function formatDate(value, withTime = false) {
  if (!value) return "—";
  const date = value.length === 10 ? new Date(`${value}T00:00:00`) : new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return new Intl.DateTimeFormat("en-GB", withTime ? { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

function today() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// Display state for an installment.
//
// The stored `status` is authoritative whenever it is a real state, because it
// is derived from the payment ledger on the server. `partial` in particular
// cannot be inferred here: only the ledger knows some money arrived. The
// due-date branches below are the existing fallback for rows whose status has
// not been recomputed yet.
function debtState(debt) {
  if (debt.status === "paid") return "paid";
  // `partial` outranks the due-date branches: the ledger has already told us
  // money arrived, so the balance being late must not relabel it as unpaid.
  if (debt.status === "partial") return "partial";
  if (debt.status === "overdue" || (debt.due_date && debt.due_date < today())) return "overdue";
  if (debt.due_date && debt.due_date <= new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)) return "upcoming";
  return "pending";
}

// Label shown on the state badge. Kept in one place so the debts register, the
// filters and the reminder panel all call the installment the same thing.
function debtStateLabel(state) {
  return { paid: "Paid", partial: "Partial", overdue: "Overdue", upcoming: "Due soon", pending: "Pending", "due-today": "Due today" }[state] || state;
}

/**
 * The badge for one installment. Same states as `debtState` - the only
 * refinement is that an installment falling due TODAY is called out as such,
 * which is a presentation of the due date and changes no stored status.
 */
function debtBadge(debt) {
  const value = debtState(debt);
  const key = value === "upcoming" && debt.due_date === today() ? "due-today" : value;
  return badgeVariant(debtStateLabel(key), key);
}

function badge(value, variant) {
  const normalized = String(value || "").toLowerCase();
  const key = variant ? String(variant).toLowerCase() : normalized;
  return `<span class="badge badge-${escapeHtml(key)}">${escapeHtml(humanize(value))}</span>`;
}

function badgeVariant(value, variant) {
  const safe = String(value ?? "").trim() || "unknown";
  const key = String(variant || safe).toLowerCase();
  return `<span class="badge badge-${escapeHtml(key)}">${escapeHtml(safe)}</span>`;
}

function documentIcon(category) {
  const map = {
    agreement: "contract",
    title: "stamp",
    invoice: "receipt",
    receipt: "receipt",
    report: "chart",
    permit: "shield",
    other: "file",
  };
  return `<span class="doc-icon-mark">${icon(map[category] || map.other)}</span>`;
}

/* --------------------------------------------------------------------------
   Design-system primitives

   One outline icon set (24px grid, 1.8 stroke, currentColor) replaces the mixed
   unicode glyphs, so every icon inherits the text colour and scales with it.
   The helpers below are presentation only: they never decide what a caller may
   do. Callers pass in controls they have ALREADY permission-gated, and an empty
   list renders nothing, so no helper can surface an action on its own.
   -------------------------------------------------------------------------- */
const ICON_PATHS = {
  dashboard: '<rect x="3" y="3" width="7.5" height="9" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="5.5" rx="1.6"/><rect x="13.5" y="11.5" width="7.5" height="9.5" rx="1.6"/><rect x="3" y="15" width="7.5" height="6" rx="1.6"/>',
  tasks: '<path d="M9 11.5l2.5 2.5L20 5.5"/><path d="M20 12.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8.5"/>',
  shield: '<path d="M12 3l7.5 3v5.6c0 4.4-3.1 8.2-7.5 9.4-4.4-1.2-7.5-5-7.5-9.4V6z"/><path d="M9 12l2 2 4-4"/>',
  home: '<path d="M3.5 10.5L12 3.5l8.5 7"/><path d="M5.5 9v10.5a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9"/>',
  building: '<rect x="4.5" y="3" width="15" height="18" rx="1.6"/><path d="M9 7.5h1.5M13.5 7.5H15M9 11.5h1.5M13.5 11.5H15M9 15.5h1.5M13.5 15.5H15"/><path d="M10.5 21v-2.5h3V21"/>',
  users: '<circle cx="9" cy="8" r="3.4"/><path d="M2.8 20a6.2 6.2 0 0 1 12.4 0"/><path d="M15.5 4.8a3.4 3.4 0 0 1 0 6.5"/><path d="M18 14.6a6.2 6.2 0 0 1 3.2 5.4"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  contract: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 13h7M8.5 16.5h4.5"/>',
  folder: '<path d="M3.5 7.2a2 2 0 0 1 2-2h3.8l2 2.2h7.2a2 2 0 0 1 2 2v8.4a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  chart: '<path d="M4 20.5h16"/><path d="M7 17v-5M12 17V7M17 17v-8"/>',
  wallet: '<rect x="3" y="6.5" width="18" height="13.5" rx="2"/><path d="M3 10.5h18"/><path d="M15.5 15h2.5"/><path d="M6 6.5V5.2A1.7 1.7 0 0 1 7.7 3.5H18"/>',
  scale: '<path d="M12 4v16.5M7.5 20.5h9"/><path d="M5 7.5h14"/><path d="M5 7.5l-2.7 6.2a2.8 2.8 0 0 0 5.4 0z"/><path d="M19 7.5l-2.7 6.2a2.8 2.8 0 0 0 5.4 0z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2H4.5z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4l9 15.5H3z"/><path d="M12 10v4M12 17.2v.3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-4.8-4.8L7 20"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  stamp: '<path d="M9.5 3.5h5l-1 6.5h-3z"/><path d="M5 13a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2.5H5z"/><path d="M5 19.5h14"/>',
  inbox: '<path d="M3.5 13.5l2.6-7.3A2 2 0 0 1 8 5h8a2 2 0 0 1 1.9 1.2l2.6 7.3v4.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  spark: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/>',
  money: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6.5 9.5v.01M17.5 14.5v.01"/>',
  phone: '<path d="M5 4h3.5l1.8 4.3-2.2 1.4a11 11 0 0 0 6.2 6.2l1.4-2.2L20 15.5V19a1.5 1.5 0 0 1-1.6 1.5C10.6 20 4 13.4 3.5 5.6A1.5 1.5 0 0 1 5 4z"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3.5 7l8.5 6 8.5-6"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  dot: '<circle cx="12" cy="12" r="3"/>',
};

function icon(name, extraClass = "") {
  return `<svg class="ic${extraClass ? ` ${extraClass}` : ""}" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name] || ICON_PATHS.dot}</svg>`;
}

/** "SALES, MARKETING & OPERATIONS" -> "Sales, Marketing & Operations". */
function titleCase(value) {
  return String(value ?? "").toLowerCase().replace(/(^|[\s/(-])([a-z])/g, (match, lead, letter) => lead + letter.toUpperCase()).replace(/\bIct\b/g, "ICT");
}

/** Title-cases a stored enum for display. The badge CLASS keeps the raw key. */
function humanize(value) {
  const text = String(value ?? "").replace(/_/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

/**
 * A designed empty state: what is missing, why it matters, and - only when the
 * caller already holds the permission - the one action that fills it.
 */
function emptyState(title, text = "", { iconName = "inbox", action = "", compact = false } = {}) {
  return `<div class="empty-state${compact ? " empty-compact" : ""}"><div class="empty-icon">${icon(iconName)}</div><strong>${escapeHtml(title)}</strong>${text ? `<span>${escapeHtml(text)}</span>` : ""}${action ? `<div class="empty-actions">${action}</div>` : ""}</div>`;
}

/**
 * Secondary row actions collapsed behind one "More" button, so a register row
 * shows its main action instead of a wall of buttons. `items` are controls the
 * caller already rendered behind their own permission checks; blanks are
 * dropped, and a row with nothing left gets no menu at all.
 */
function rowMenu(items) {
  const entries = (items || []).filter((entry) => entry && String(entry).trim());
  if (!entries.length) return "";
  // Opens on click only: no hover tooltip (the aria-label names it for screen readers).
  return `<div class="row-menu"><button type="button" class="btn btn-ghost btn-small btn-icon" data-action="toggle-row-menu" aria-haspopup="menu" aria-expanded="false" aria-label="More actions">${icon("more")}</button><div class="row-menu-list" role="menu" hidden>${entries.join("")}</div></div>`;
}

function closeRowMenus(except = null) {
  document.querySelectorAll(".row-menu-list").forEach((list) => {
    if (list === except) return;
    list.hidden = true;
    list.parentElement?.querySelector('[data-action="toggle-row-menu"]')?.setAttribute("aria-expanded", "false");
  });
}

function formatDateTime(value, includeDate = true) {
  if (!value) return "—";
  const date = value.length === 10 ? new Date(`${value}T00:00:00`) : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const datePart = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(date);
  const timePart = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(date);
  return includeDate ? `${datePart} · ${timePart}` : timePart;
}

function reportTypeLabel(id) {
  const type = (state.reportTypes || []).find((entry) => entry.id === id);
  return type ? type.label : id;
}

function reportFormatLabel(format) {
  const map = { xlsx: "XLSX", pdf: "PDF", docx: "DOCX", pptx: "PPTX" };
  return map[String(format || "").toLowerCase()] || String(format || "—").toUpperCase();
}

function formatBytes(bytes) {
  const value = numberValue(bytes, 0);
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1048576).toFixed(1)} MB`;
}

function fileKindIcon(mimeType, filename) {
  const name = String(filename || "").toLowerCase();
  if (mimeType === "application/pdf" || name.endsWith(".pdf")) return " ¬";
  if (name.endsWith(".docx") || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return " ¬";
  if (name.endsWith(".xlsx") || mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return " ▦";
  if (name.endsWith(".pptx") || mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return " ▦";
  if (mimeType && mimeType.startsWith("image/")) return " ◎";
  return " ▱";
}

function reportKindBadge(format) {
  const key = `report-${String(format || "other").toLowerCase()}`;
  return `<span class="badge badge-${escapeHtml(key)}">${escapeHtml(reportFormatLabel(format))}</span>`;
}

function sourceBadge(source) {
  return source === "generated" ? badge("Generated", "active") : badge("Uploaded", "neutral");
}

function parseReportFilters(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function reportTypeDef(id) {
  return (state.reportTypes || []).find((entry) => entry.id === id) || null;
}

// Renders only the filters the selected report type declares.
function reportFilterFieldsHtml(typeId, values = {}) {
  const def = reportTypeDef(typeId);
  const allowed = new Set(def?.filters || []);
  const fields = [];
  if (allowed.has("project")) {
    fields.push(`<div class="field"><label for="field-filter-project">Project</label><select id="field-filter-project" name="project"><option value="">All projects</option>${projectOptions(values.project)}</select></div>`);
  }
  if (allowed.has("date_from")) {
    fields.push(`<div class="field"><label for="field-filter-from">From · ${escapeHtml(def?.date_field || "date")}</label><input id="field-filter-from" name="date_from" type="date" value="${escapeHtml(values.date_from || "")}"></div>`);
  }
  if (allowed.has("date_to")) {
    fields.push(`<div class="field"><label for="field-filter-to">To · ${escapeHtml(def?.date_field || "date")}</label><input id="field-filter-to" name="date_to" type="date" value="${escapeHtml(values.date_to || "")}"></div>`);
  }
  if (allowed.has("status") && Array.isArray(def?.status_values)) {
    const options = def.status_values.map((entry) => `<option value="${escapeHtml(entry.value)}" ${values.status === entry.value ? "selected" : ""}>${escapeHtml(entry.label)}</option>`).join("");
    fields.push(`<div class="field"><label for="field-filter-status">${escapeHtml(def.status_label || "Status")}</label><select id="field-filter-status" name="status"><option value="">All</option>${options}</select></div>`);
  }
  if (allowed.has("method")) {
    const options = (state.reportPaymentMethods || []).map((entry) => `<option value="${escapeHtml(entry.value)}" ${values.method === entry.value ? "selected" : ""}>${escapeHtml(entry.label)}</option>`).join("");
    fields.push(`<div class="field"><label for="field-filter-method">Payment method</label><select id="field-filter-method" name="method"><option value="">All methods</option>${options}</select></div>`);
  }
  if (allowed.has("client")) {
    fields.push(`<div class="field"><label for="field-filter-client">Client name contains</label><input id="field-filter-client" name="client" maxlength="80" value="${escapeHtml(values.client || "")}" placeholder="e.g. Amina"></div>`);
  }
  if (!fields.length) fields.push(`<div class="field full"><span class="muted">This report does not accept filters.</span></div>`);
  return `<div class="form-grid" id="report-filter-fields" style="grid-column:1/-1">${fields.join("")}</div>`;
}

function renderReportGenerateForm(report = null) {
  const types = state.reportTypes || [];
  if (!types.length) {
    return `<div class="card glass empty"><strong>Report catalogue unavailable</strong>Reload the workspace and try again.</div>`;
  }
  const saved = { ...parseReportFilters(report?.filters_json) };
  if (report?.project_id) saved.project = report.project_id;
  const selected = report?.report_type && types.some((entry) => entry.id === report.report_type) ? report.report_type : types[0].id;
  const typeOptions = types.map((entry) => `<option value="${escapeHtml(entry.id)}" ${entry.id === selected ? "selected" : ""}>${escapeHtml(entry.label)}</option>`).join("");
  const formatOptions = ["xlsx", "pdf", "docx", "pptx"].map((format) => `<option value="${format}" ${(report?.file_format || "xlsx") === format ? "selected" : ""}>${reportFormatLabel(format)}</option>`).join("");
  return `<div class="form-grid">
    <div class="field full"><label for="field-report-type">Report type</label><select id="field-report-type" name="report_type">${typeOptions}</select>${report ? `<div class="field-help">Re-exporting “${escapeHtml(report.title)}” with its saved filters.</div>` : ""}</div>
    <div class="field full"><label for="field-report-title">Title <span class="muted">(optional)</span></label><input id="field-report-title" name="title" maxlength="160" value="${escapeHtml(report?.title || "")}" placeholder="Defaults to the report name"></div>
    ${reportFilterFieldsHtml(selected, saved)}
    <div class="field"><label for="field-report-format">File format</label><select id="field-report-format" name="format">${formatOptions}</select></div>
    <div class="field"><span class="muted" style="align-self:end;font-size:11px">Preview shows the first rows before exporting.</span></div>
  </div>`;
}

function renderReportUploadForm() {
  const types = state.reportTypes || [];
  if (!types.length) {
    return `<div class="card glass empty"><strong>Report catalogue unavailable</strong>Reload the workspace and try again.</div>`;
  }
  const typeOptions = types.map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.label)}</option>`).join("");
  return `<div class="form-grid">
    <div class="field full"><label for="field-report-type">Report type</label><select id="field-report-type" name="report_type">${typeOptions}</select></div>
    <div class="field full"><label for="field-report-title">Title</label><input id="field-report-title" name="title" required maxlength="160" placeholder="e.g. Q3 income summary"></div>
    <div class="field full"><label for="field-report-file">Report file</label><input id="field-report-file" name="file" type="file" required accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"><div class="field-help">PDF, Word, Excel or PowerPoint · up to 15 MB.</div></div>
    <div class="field"><label for="field-report-project">Project <span class="muted">(optional)</span></label><select id="field-report-project" name="project_id"><option value="">No project</option>${projectOptions()}</select></div>
    <div class="field full"><label for="field-report-description">Description <span class="muted">(optional)</span></label><textarea id="field-report-description" name="description" maxlength="2000" placeholder="Where this report came from or what it covers"></textarea></div>
  </div>`;
}

function previewCell(value, kind) {
  if (value === null || value === undefined || value === "") return "—";
  if (kind === "money") return money(value);
  if (kind === "int") return String(numberValue(value));
  if (kind === "date") {
    const raw = String(value);
    const datePart = formatDate(raw.slice(0, 10));
    return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw) ? `${datePart} ${raw.slice(11, 16)}` : datePart;
  }
  return escapeHtml(value);
}

function renderReportPreview() {
  const preview = state.reportPreview;
  if (!preview) {
    return `<div class="card glass empty"><strong>No preview yet</strong>Open “Generate report” and choose Preview.</div>`;
  }
  const columns = preview.columns || [];
  const allRows = preview.rows || [];
  const rows = allRows.slice(0, 100);
  const head = columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("");
  const body = rows.map((row) => `<tr>${columns.map((column) => `<td class="${column.kind === "money" || column.kind === "int" ? "amount" : ""}">${previewCell(row[column.key], column.kind)}</td>`).join("")}</tr>`).join("");
  const totals = (preview.totals || []).map((total) => `${escapeHtml(total.label)}: ${total.kind === "money" ? money(total.value) : escapeHtml(String(total.value))}`).join(" · ");
  const rowNote = allRows.length > rows.length ? ` · showing first ${rows.length}` : "";
  return `<div class="section-note">${escapeHtml(preview.filters_text || "No filters applied")} · ${numberValue(preview.row_count)} row${numberValue(preview.row_count) === 1 ? "" : "s"}${rowNote}</div>
    <div class="table-wrap" style="margin-top:14px"><table><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${Math.max(columns.length, 1)}">No rows matched the filters.</td></tr>`}</tbody></table></div>
    ${totals ? `<div class="section-note" style="margin-top:12px">${totals}</div>` : ""}`;
}

// Only sends the filter keys the API accepts; empty values are omitted.
function reportRequestPayload(data) {
  const body = { report_type: data.report_type, format: data.format || "xlsx" };
  if (data.title) body.title = data.title;
  ["project", "date_from", "date_to", "status", "method", "client"].forEach((key) => {
    if (data[key] !== undefined && data[key] !== "") body[key] = data[key];
  });
  return body;
}

async function downloadFile(path, filename) {
  const response = await fetch(`${API_ROOT}${path}`, { headers: { ...CSRF_HEADERS }, credentials: "same-origin" });
  if (response.status === 401) { endSession("Your session has expired. Please sign in again."); throw new Error("session expired"); }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Download failed");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "download";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function openFileInTab(path) {
  const response = await fetch(`${API_ROOT}${path}`, { headers: { ...CSRF_HEADERS }, credentials: "same-origin" });
  if (response.status === 401) { endSession("Your session has expired. Please sign in again."); throw new Error("session expired"); }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Unable to open file");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener");
}

async function api(path, options = {}) {
  // `form: true` sends a FormData body untouched (browser sets the multipart boundary).
  const { form, headers: extraHeaders, ...rest } = options;
  const headers = { ...(extraHeaders || {}) };
  if (!form) headers["Content-Type"] = "application/json";
  Object.assign(headers, CSRF_HEADERS);
  // A plain object body is sent as JSON. Passing an object unserialized used
  // to send "[object Object]", which the server rejects (every task button did).
  if (!form && rest.body && typeof rest.body === "object") rest.body = JSON.stringify(rest.body);
  const response = await fetch(`${API_ROOT}${path}`, { ...rest, headers, credentials: "same-origin" });
  const payload = await response.json().catch(() => ({}));
  const isCredentialRequest = path.startsWith("/auth/login") || path.startsWith("/auth/setup");
  if (response.status === 401 && !isCredentialRequest) {
    const error = new Error(payload.error || "session expired");
    error.sessionExpired = true;
    endSession("Your session has expired. Please sign in again.");
    throw error;
  }
  if (!response.ok) {
    const error = new Error(payload.error || "Request failed");
    error.status = response.status;
    throw error;
  }
  return payload;
}

/* --------------------------------------------------------------------------
   Paginated list loading.

   The workspace ships the first page of each list. Everything after that -
   further pages, and SEARCH - is fetched here from the endpoints the API
   already exposes.

   Why search moved to the server: with only one page resident, filtering
   client-side would quietly search 50 of 12,000 rows and report the rest as
   "not found". That is worse than no search, because it looks like an answer.
   The term is therefore sent to the API, which applies it inside the same
   scoped, ordered query that produced the page - so a search can never reach a
   record the caller may not read, and can never miss one off the first page.
   -------------------------------------------------------------------------- */
const LIST_ENDPOINTS = {
  contracts: "/contracts",
  clients: "/clients",
  properties: "/properties",
  debts: "/debts",
  payments: "/payments",
  documents: "/documents",
  appointments: "/appointments",
  projects: "/projects",
  leads: "/org/leads",
  followUps: "/org/follow-ups",
};

const PAGE_SIZE = 50;

/** The filters that belong to a list, so a search request carries the view's own narrowing. */
function listQuery(kind, { page = 1, search = "" } = {}) {
  const query = new URLSearchParams();
  query.set("page", String(page));
  query.set("page_size", String(PAGE_SIZE));
  if (search) query.set("search", search);
  const filters = state.filters || {};
  // Only parameters the endpoint for this list actually understands. An
  // unsupported filter is a 400, which would render the register empty.
  if (kind === "contracts") {
    if (filters.project) query.set("project_id", filters.project);
    if (filters.type) query.set("type", filters.type);
    if (filters.status) query.set("status", filters.status);
  }
  if (kind === "clients") { if (filters.project) query.set("project_id", filters.project); if (filters.clientStatus) query.set("status", filters.clientStatus); }
  if (kind === "properties") { if (filters.project) query.set("project_id", filters.project); if (filters.propertyStatus) query.set("status", filters.propertyStatus); }
  if (kind === "debts" || kind === "payments") { if (filters.project) query.set("project_id", filters.project); }
  if (kind === "documents") { if (filters.project) query.set("project_id", filters.project); if (filters.documentStatus) query.set("status", filters.documentStatus); }
  if (kind === "appointments") { if (filters.project) query.set("project_id", filters.project); if (filters.appointmentStatus) query.set("status", filters.appointmentStatus); }
  for (const [key, value] of [...query.entries()]) if (value === "") query.delete(key);
  return query;
}

/** Where a loaded page is written, and which array it replaces. */
function listTarget(kind) {
  if (kind === "leads") return { set: (rows) => { state.organization.leads = rows; } };
  if (kind === "followUps") return { set: (rows) => { state.organization.followUps = rows; } };
  return { set: (rows) => { state[kind] = rows; } };
}

/**
 * Resolves a record for an edit modal, fetching it by id when it is not on the
 * current page.
 *
 * With whole collections in memory, `state.contracts.find(...)` always found the
 * row. Now that only one page is resident, `.find()` alone would return
 * undefined for a perfectly valid record on page 9, and the user would be told
 * the record does not exist. So a miss triggers a fetch from the SAME
 * authorized GET endpoint the detail view uses - never a second, wider query -
 * which means the server still decides whether this caller may open it. A 403 or
 * 404 is reported honestly instead of being masked as "missing".
 */
const recordCache = new Map();

async function findRecord(kind, id) {
  const rows = kind === "leads" ? state.organization.leads
    : kind === "followUps" ? state.organization.followUps
      : (state[kind] || []);
  const hit = (rows || []).find((item) => String(item.id) === String(id));
  if (hit) return hit;
  if (id === undefined || id === null || id === "") return null;
  const key = `${kind}:${id}`;
  if (recordCache.has(key)) return recordCache.get(key);
  const endpoint = LIST_ENDPOINTS[kind];
  if (!endpoint) return null;
  try {
    const record = await api(`${endpoint}/${id}`);
    recordCache.set(key, record);
    return record;
  } catch (error) {
    if (error?.sessionExpired) return null;
    // Not found, or not this caller's to open. Either way the modal must not
    // open an empty shell pretending the record is editable.
    showToast(error.message || `Could not open that ${kind.replace(/s$/, "")}`);
    return null;
  }
}

/** Opens a modal for a record that may not be on the current page. */
async function openModalFor(kind, id, modalName) {
  const record = await findRecord(kind, id);
  if (!record) return;
  openModal(modalName, record);
}

/** Drops a cached record after a write, so the next read reflects the change. */
function invalidateRecord(kind, id) {
  recordCache.delete(`${kind}:${id}`);
}

/**
 * Fetches one page of a list and installs it.
 *
 * `force` re-requests even when the page is already resident, which is what a
 * write (a new record, a filter change) needs. A request already in flight is
 * never duplicated, so a re-render mid-load cannot stack calls.
 */
async function loadList(kind, { page = 1, search = "", force = false } = {}) {
  const endpoint = LIST_ENDPOINTS[kind];
  if (!endpoint) return;
  const book = state.listState[kind] || (state.listState[kind] = { page: 1, loading: false, search: "", loaded: false });
  if (book.loading) return;
  if (!force && book.loaded && book.page === page && book.search === search) return;
  book.loading = true;
  book.search = search;
  try {
    const result = await api(`${endpoint}?${listQuery(kind, { page, search })}`);
    listTarget(kind).set(result.data || []);
    state.pages[kind] = result.pagination || null;
    book.page = page;
    book.loaded = true;
  } catch (error) {
    // A failed page must not blank the register. The previously loaded rows stay
    // on screen and the failure is reported, so the user is never left looking at
    // an empty table that actually has records.
    if (!error?.sessionExpired) showToast(`Could not load ${kind}: ${error.message}`);
  } finally {
    book.loading = false;
    render();
  }
}

/** Page controls for a register, or a plain record count when one page holds everything. */
function pager(kind) {
  const page = state.pages[kind];
  const book = state.listState[kind] || {};
  if (!page) return "";
  const total = Number(page.total || 0);
  const totalPages = Number(page.total_pages || 0);
  const size = Number(page.page_size || PAGE_SIZE);
  // One page: the toolbar already states the count, so no pager is drawn.
  if (totalPages <= 1) return "";
  const current = Number(page.page || 1);
  return `<div class="pager" data-list="${kind}">
    <span class="pager-note">Showing <strong>${((current - 1) * size) + 1}–${Math.min(current * size, total)}</strong> of <strong>${total}</strong></span>
    <div class="row-actions">
      <button class="btn btn-small" data-action="page-prev" data-list="${kind}" ${current <= 1 || book.loading ? "disabled" : ""}>Previous</button>
      <span class="pager-note">Page ${current} of ${totalPages}</span>
      <button class="btn btn-small" data-action="page-next" data-list="${kind}" ${current >= totalPages || book.loading ? "disabled" : ""}>Next</button>
    </div>
  </div>`;
}


async function refresh() {
  if (!state.authorized) return;
  state.loading = true;
  render();
  // One round trip for the whole workspace. The server returns only the modules
  // this caller holds, so the dashboard no longer fans out into a dozen
  // requests (and a sales officer never waits on data they may not see).
  let payload;
  try {
    payload = await api("/org/workspace");
  } catch (error) {
    state.loading = false;
    if (error?.sessionExpired) return;
    showToast("Unable to load your workspace. Please retry.");
    render();
    return;
  }
  applyWorkspace(payload);
  state.loading = false;
  // The attention badge is real backend state, so it is read from the server on
  // every workspace load rather than remembered. `applyWorkspace` has already
  // copied `me.attention`, which is authoritative, so the navigation is correct
  // even before this request returns.
  if (payload?.me?.attention) state.attention = payload.me.attention;
  updateNavigation();
  render();
  refreshAttention();
  // Payments falling due soon feed the Reminders badge and the bell.
  loadUpcomingReminders().then(() => { updateNavigation(); updateNotificationDot(); if (state.view === "reminders") render(); });
  // Keeps the Requests count in the navigation current.
  if (canModule("leads") && can("view")) reloadRequests().then(() => { updateNavigation(); if (state.view === "requests") render(); });
}

function applyWorkspace(payload) {
  const admin = payload.admin || {};
  state.projects = payload.projects || [];
  state.contracts = payload.contracts || [];
  state.contractPipeline = payload.contract_pipeline || null;
  state.clients = payload.clients || [];
  state.properties = payload.properties || [];
  state.appointments = payload.appointments || [];
  state.documents = payload.documents || [];
  state.debts = payload.debts || [];
  state.payments = payload.payments || [];
  state.reminders = payload.reminders || [];
  state.summary = payload.summary || null;
  state.projectReports = payload.projectReports || [];
  state.reportHistory = payload.reportHistory || [];
  state.reportTypes = payload.reportTypes?.types || [];
  state.reportPaymentMethods = payload.reportTypes?.payment_methods || [];
  if (payload.me) state.organization.me = payload.me;
  renderUserAvatar();
  // The navigation attention badge. Server-computed; never derived locally.
  if (payload.me?.attention) state.attention = payload.me.attention;
  state.organization.leads = payload.leads || [];
  state.organization.followUps = payload.followUps || [];
  state.organization.departments = admin.departments || [];
  state.organization.roles = admin.roles || [];
  state.organization.users = admin.users || [];
  state.organization.permissions = admin.permissions || [];
  state.organization.audit = admin.audit || [];
  state.organization.approvals = admin.approvals || [];
  state.organization.dashboard = admin.dashboard || null;
  state.organization.collections = admin.collections || null;
  // Scoped totals and page descriptors. `counts` is what the dashboard counts
  // from; `pages` tells each register how many pages exist. A workspace with
  // neither (an older server, or a caller holding no modules) leaves them empty
  // and the counts fall back to the loaded rows.
  state.counts = payload.counts || {};
  state.pages = payload.pages || {};
  // The workspace just delivered page 1 of every list, so record that as the
  // loaded page. Without this the first render would immediately re-request the
  // page the bootstrap already paid for.
  for (const [key, page] of Object.entries(state.pages)) {
    state.listState[key] = { page: page?.page || 1, loading: false, search: "", loaded: true };
  }
}

// The Administration screen needs two heavier aggregates (organization counters
// and collections). They are fetched the first time that screen is opened rather
// than on every workspace load.
let adminExtrasLoaded = false;
async function loadAdminExtras() {
  if (adminExtrasLoaded) return;
  const needsDashboard = can("view_reports") || can("manage_users") || can("manage_permissions");
  const needsCollections = can("view_financial");
  if (!needsDashboard && !needsCollections) return;
  const [dashboard, collections] = await Promise.all([
    needsDashboard ? api("/org/dashboard").catch(() => null) : null,
    needsCollections ? api("/org/collections").catch(() => null) : null,
  ]);
  if (dashboard) state.organization.dashboard = dashboard;
  if (collections) state.organization.collections = collections;
  adminExtrasLoaded = true;
}

function isAdmin() {
  return currentUser?.role === "admin";
}

// Mirrors BUSINESS_PERMISSIONS in backend/src/org/rbac.js: the System
// Administrator runs the system (staff, departments, roles), never the business.
const BUSINESS_PERMISSIONS = new Set([
  "submit_contract", "review_legal", "request_changes", "approve_legal", "validate_finance", "approve_management",
  "view_financial", "approve", "view_projects", "view_properties", "view_appointments",
]);

function can(permission) {
  if (isAdmin()) return !BUSINESS_PERMISSIONS.has(permission) && !String(permission).startsWith("access_");
  return (state.organization.me?.permissions || []).includes(permission);
}

function canModule(module) {
  // Every module is a business module, so the administrator holds none.
  return !isAdmin() && (state.organization.me?.modules || []).includes(module);
}

// Contracts are created by Sales, Legal or the MD (the server's
// `mayAuthorContracts`). Finance holds `create` for payments, not contracts.
function canAuthorContracts() {
  return canModule("contracts") && can("create") && ["submit_contract", "approve_legal", "approve_management"].some((permission) => can(permission));
}

// Mirrors the server's delete rule: the MD and Legal always, Sales only while
// the contract is still before approval.
const PRE_APPROVAL_CONTRACT_STATUSES = new Set(["draft", "submitted", "under_review", "changes_requested"]);
function canDeleteContract(contract) {
  if (!canModule("contracts")) return false;
  if (can("approve_legal") || can("approve_management")) return true;
  return can("submit_contract") && PRE_APPROVAL_CONTRACT_STATUSES.has(contract?.status);
}

// A module the caller may change: held in full, not just the read-only grant
// (Finance, Legal and Customer Service SEE projects/properties, never edit them).
function canChange(module, permission) {
  return canModule(module) && can(permission) && !(state.organization.me?.readonly_modules || []).includes(module);
}

function canSeeFinancial() {
  return !isAdmin() && state.organization.me?.financial === true;
}

/** An account whose whole job is administration: no business module at all. */
function isSystemAdminOnly() {
  if (isAdmin()) return true;
  return (can("manage_users") || can("manage_roles")) && !(state.organization.me?.modules || []).length;
}

/** Where a person lands: the Administration console for administrators, else the Dashboard. */
function homeView() {
  return isSystemAdminOnly() ? "organization" : "dashboard";
}

// The navigation catalogue. Each entry declares the view it opens and the
// authorization it needs; `updateNavigation` renders ONLY the entries the
// caller is entitled to, so an unauthorized item is absent from the DOM rather
// than merely hidden or disabled.
//
// `adminOnly` is deliberately separate from the module list: system
// administration is held by the `users.role = 'admin'` account only, which is
// why the Managing Director never sees Admin overview or Administration even
// though the MD holds plenty of business modules.
// Grouping and order are presentation only (Main / Business / Contracts &
// records / Finance / Organization). Every entry keeps exactly the module and
// permission it had before the redesign, so regrouping cannot widen access.
const NAV_ITEMS = [
  { view: "dashboard", label: "Dashboard", icon: "dashboard", group: "Main" },
  // Task assignments. Open to every signed-in member - a member may always
  // RECEIVE work - but the actions inside come from the server per task, so a
  // staff member sees Submit without ever seeing Approve.
  { view: "assignments", label: "Assignments", icon: "tasks", group: "Main" },
  { view: "admin-dashboard", label: "Admin overview", icon: "shield", adminOnly: true, group: "Main" },
  { view: "properties", label: "Properties", icon: "home", module: "properties", permission: "view", group: "Business" },
  { view: "projects", label: "Projects", icon: "building", module: "projects", permission: "view", group: "Business" },
  { view: "clients", label: "Clients", icon: "users", module: "clients", permission: "view", group: "Business" },
  // Website Buy/Rent requests, followed from arrival to client. Same module
  // and permission as Leads: it is a narrower view of the same records.
  { view: "requests", label: "Requests", icon: "inbox", module: "leads", permission: "view", group: "Business" },
  { view: "leads", label: "Leads", icon: "spark", module: "leads", permission: "view", group: "Business" },
  { view: "appointments", label: "Appointments", icon: "calendar", module: "appointments", permission: "view", group: "Business" },
  { view: "contracts", label: "Contracts", icon: "contract", module: "contracts", permission: "view", group: "Contracts & records" },
  { view: "documents", label: "Documents", icon: "folder", module: "documents", permission: "view", group: "Contracts & records" },
  // Reserved to the template maintainers (MD, ICT administration, Sales
  // Officer, Legal Officer); not tied to a module, so ICT sees it too.
  { view: "templates", label: "Contract templates", icon: "file", permission: "upload_contract_templates", group: "Contracts & records" },
  { view: "reports", label: "Reports", icon: "chart", module: "reports", permission: "view_reports", group: "Contracts & records" },
  { view: "debts", label: "Payments & debts", icon: "wallet", module: "debts", permission: "view_financial", group: "Finance" },
  // Installments falling due: Finance is reminded before the due date.
  { view: "reminders", label: "Reminders", icon: "bell", module: "reminders", permission: "view_financial", group: "Finance" },
  // Reference view, not a module: every signed-in member may read the duty
  // catalogue and the approval path. It exposes no record and no way to act.
  { view: "duties", label: "Duties & approvals", icon: "scale", group: "Organization" },
  // Staff administration is a duty, not an account type: the ICT Officer holds
  // manage_users / manage_roles and runs it day to day. The server still
  // refuses anything above their own rank.
  { view: "organization", label: "Staff", icon: "users", anyOf: ["manage_users", "manage_roles"], group: "Organization" },
  { view: "departments", label: "Departments", icon: "building", anyOf: ["manage_users", "manage_roles"], group: "Organization" },
  // Roles and what each may do: its own page, apart from the staff list.
  { view: "roles", label: "Roles & permissions", icon: "shield", anyOf: ["manage_roles", "manage_permissions"], group: "Organization" },
  // Activity log, record allocation and backups: the administrator account only.
  { view: "system", label: "System & backups", icon: "settings", adminOnly: true, group: "Organization" },
];

/** Whether the caller is entitled to a navigation entry at all. */
function canSeeNavItem(item) {
  // Administrators work from one place (Administration): no business dashboard,
  // no separate admin overview.
  if (isSystemAdminOnly() && (item.view === "dashboard" || item.view === "admin-dashboard")) return false;
  if (item.adminOnly) return isAdmin();
  if (item.anyOf) return item.anyOf.some((permission) => can(permission));
  if (!item.module) return item.permission ? can(item.permission) : true;
  return canModule(item.module) && can(item.permission);
}

// Navigation mirrors the server's module list, so a visible item is also a
// request the server would allow. Items the caller may not open are never
// written into the DOM, so they cannot be clicked, focused or inspected.
/* --------------------------------------------------------------------------
   "Seen" markers. A badge shows what is NEW since this person last looked, so
   it reacts to what they do: opening a page clears its number, opening the
   notifications marks them read, and a new item makes the number come back.
   Each source is a list of item keys (or a plain count) drawn from records the
   caller can already open. Stored per user in this browser only; the server's
   own counts (Needs your attention on the dashboard) are never changed by it.
   -------------------------------------------------------------------------- */
let seenCache = null;
function seenStore() {
  const key = `mkuyu.seen.${state.organization?.me?.user?.id || "anon"}`;
  if (seenCache?.key === key) return seenCache.data;
  let data = {};
  try { data = JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch { data = {}; }
  seenCache = { key, data };
  return data;
}
function saveSeen() {
  try { localStorage.setItem(seenCache.key, JSON.stringify(seenCache.data)); } catch { /* private mode: badges just stay */ }
}
/** How many of `current` (item keys or a count) this person has not seen yet. */
function unseenCount(key, current) {
  const store = seenStore();
  const seen = store[key];
  if (Array.isArray(current)) {
    if (!Array.isArray(seen)) return current.length;
    const live = new Set(current.map(String));
    // Forget items that are finished, so a finished-then-reopened item is new again.
    const kept = seen.filter((item) => live.has(String(item)));
    if (kept.length !== seen.length) { store[key] = kept; saveSeen(); }
    const known = new Set(kept.map(String));
    return current.filter((item) => !known.has(String(item))).length;
  }
  const count = Number(current) || 0;
  const was = Number(seen);
  if (!Number.isFinite(was)) return count;
  if (count < was) { store[key] = count; saveSeen(); return 0; }
  return count - was;
}
function markSeen(key, current) {
  const store = seenStore();
  const value = Array.isArray(current) ? current.map(String) : Number(current) || 0;
  if (JSON.stringify(store[key]) === JSON.stringify(value)) return;
  store[key] = value;
  saveSeen();
}

/**
 * What each navigation item counts. Attention, not inventory: a contract
 * counts only when the SERVER offers this caller a step on it, an installment
 * only when overdue, a request only when it is this person's turn.
 */
function navSources() {
  return {
    contracts: canModule("contracts") ? [...new Set([...contractsAwaitingCaller(), ...contractsNeedingPlan()].map((contract) => `${contract.id}:${contract.status}`))] : [],
    debts: canModule("debts") && canSeeFinancial() ? (state.debts || []).filter((debt) => debtState(debt) === "overdue").map((debt) => debt.id) : [],
    // Payment reminders due now or within the next days (see Reminders).
    reminders: canModule("reminders") && canSeeFinancial() ? [...(state.reminders || []), ...(state.upcomingReminders || [])].map((reminder) => reminder.id) : [],
    documents: canModule("documents") && can("edit") ? (state.documents || []).filter((doc) => doc.status === "pending").map((doc) => doc.id) : [],
    // New appointments: every upcoming scheduled appointment this person has
    // not seen yet (Sales, Legal and everyone else with Appointments).
    appointments: canModule("appointments") ? upcomingAppointments().map((apt) => `${apt.id}:${apt.starts_at}`) : [],
    // The SERVER's count of tasks that need this user (new, returned, to review).
    assignments: Number((state.attention || {}).total || 0),
    // New requests and reports waiting for this person; a request that moves to
    // a new stage counts again.
    requests: (state.requests || []).filter(requestNeedsMe).map((row) => `${row.id}:${requestStage(row)}`),
  };
}

/** Scheduled appointments from today on (the ones worth a badge). */
function upcomingAppointments() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return (state.appointments || []).filter((apt) => apt.status === "scheduled" && new Date(String(apt.starts_at).replace(" ", "T")) >= start);
}

// The administrator's menu, in this order, under one heading: the five agreed
// pages first, then the two pages that hold the rest of the administrator's
// job (roles, and the system itself).
const ADMIN_NAV_ORDER = ["organization", "departments", "assignments", "templates", "duties", "roles", "system"];

function updateNavigation() {
  const nav = document.getElementById("primary-nav");
  if (nav) {
    let allowed = NAV_ITEMS.filter(canSeeNavItem);
    // An administration account (no business modules) gets: Staff,
    // Departments, Assignments, Contract templates, Duties & approvals.
    if (isSystemAdminOnly()) {
      allowed = [
        ...ADMIN_NAV_ORDER.map((view) => allowed.find((item) => item.view === view)).filter(Boolean),
        ...allowed.filter((item) => !ADMIN_NAV_ORDER.includes(item.view)),
      ].map((item) => ({ ...item, group: "Administration" }));
    }
    const activeView = state.view;
    // The count is a hint drawn from records the caller can already open. It is
    // only ever attached to an item they are entitled to, so it cannot disclose
    // the existence of anything hidden from them. The page being looked at is
    // seen, so its own badge clears.
    // Assignments is the exception: it is the server's own count of work
    // waiting on this person, which already falls as they act, so it stays
    // until the work is done rather than clearing on sight.
    const sources = navSources();
    const live = new Set(["assignments"]);
    if (sources[activeView] !== undefined && !live.has(activeView)) markSeen(`nav:${activeView}`, sources[activeView]);
    let lastGroup = null;
    nav.innerHTML = allowed.map((item) => {
      const source = sources[item.view];
      const count = source === undefined ? 0 : live.has(item.view) ? Number(source) || 0 : unseenCount(`nav:${item.view}`, source);
      const heading = item.group && item.group !== lastGroup ? `<div class="nav-group-label">${escapeHtml(item.group)}</div>` : "";
      lastGroup = item.group || null;
      return `${heading}<button class="nav-item${item.view === activeView ? " active" : ""}" data-view="${item.view}"${item.view === activeView ? ' aria-current="page"' : ""}><span class="nav-ic">${icon(item.icon)}</span><span class="nav-label">${escapeHtml(item.label)}</span>${count > 0 ? `<span class="nav-count">${count > 99 ? "99+" : count}</span>` : ""}</button>`;
    }).join("");
  }
  // Administrator-only controls outside the nav are hidden for anyone else, but
  // the element is RESTORED rather than deleted. Removing it permanently meant a
  // staff session that ran this once left the button missing for the next
  // administrator who signed in on the same page.
  document.querySelectorAll("[data-admin-only]").forEach((element) => {
    element.hidden = !isAdmin();
  });
  if (!isAdmin() && state.view === "admin-dashboard") state.view = homeView();
  if (state.view === "organization" && !canSeeNavItem(NAV_ITEMS.find((item) => item.view === "organization"))) state.view = homeView();
  if (allowedViewFor(state.view) === false) state.view = homeView();
}

/** Withdrawing, sending back and rejecting are always on offer; they are not "your turn". */
const NON_FORWARD_STEPS = new Set(["cancel", "request_changes", "reject", "management_reject"]);
function isForwardContractStep(action) {
  return !NON_FORWARD_STEPS.has(action);
}

/** Contracts on which the server offers this caller a real workflow step. */
function contractsAwaitingCaller() {
  return (state.contracts || []).filter((contract) =>
    (contract.available_actions || []).some((entry) => entry && isForwardContractStep(entry.action)));
}

/**
 * Contracts past Sales that still have no installments. `installments_recorded`
 * is only sent to callers who may see money, so for anyone else this is empty.
 */
const PLAN_NOT_EXPECTED = new Set(["draft", "changes_requested", "rejected", "cancelled", "completed"]);
function contractNeedsPaymentPlan(contract) {
  return contract.installments_recorded === 0 && !PLAN_NOT_EXPECTED.has(contract.status);
}
function contractsNeedingPlan() {
  return canSeeFinancial() ? (state.contracts || []).filter(contractNeedsPaymentPlan) : [];
}

/** The authorized views, used both for navigation and to reject a forced view. */
function allowedViewFor(view) {
  const item = NAV_ITEMS.find((entry) => entry.view === view);
  if (!item) return true;
  return canSeeNavItem(item);
}

function renderAdminDashboard() {
  const org = state.organization;
  const metrics = org.dashboard || {};
  const roleCount = org.roles.length;
  const staffCount = org.users.filter((user) => user.active).length;
  const pendingApprovals = org.approvals.filter((approval) => approval.status === "pending").length;
  // Monetary organization metrics only exist for callers with view_financial.
  const financialMetrics = canSeeFinancial()
    ? `<div class="metric"><span>Income</span><strong>${money(metrics.payments)}</strong></div><div class="metric"><span>Outstanding</span><strong>${money(metrics.outstanding)}</strong></div><div class="metric"><span>Overdue</span><strong>${money(metrics.overdue)}</strong></div>`
    : "";
  content.innerHTML = `<div class="hero-strip"><div class="hero-copy"><div class="eyebrow">Administrator workspace</div><h2>Control the office with confidence.</h2><p>Configure staff, departments, ranks, and explicit privileges from one protected administration area.</p></div><div class="hero-actions"><button class="btn" data-action="open-administration">Open administration</button><button class="btn" data-action="backup-now">Create backup</button></div></div><div class="metric-grid"><div class="metric"><span>Active staff</span><strong>${staffCount}</strong></div><div class="metric"><span>Roles</span><strong>${roleCount}</strong></div><div class="metric"><span>Pending approvals</span><strong>${pendingApprovals}</strong></div><div class="metric"><span>Projects</span><strong>${metrics.projects ?? 0}</strong></div><div class="metric"><span>Properties</span><strong>${metrics.properties ?? 0}</strong></div><div class="metric"><span>Contracts</span><strong>${metrics.contracts ?? 0}</strong></div>${financialMetrics}</div><div class="section-grid" style="margin-top:18px"><section class="card glass"><div class="section-head"><div><h2 class="section-title">Administration controls</h2><div class="section-note">Only administrators can open these controls.</div></div></div><div class="grid grid-2"><button class="btn btn-soft" data-action="open-administration">Staff and roles</button><button class="btn btn-soft" data-action="backup-now">Workspace backup</button></div></section><section class="card glass"><div class="section-head"><div><h2 class="section-title">Pending decisions</h2><div class="section-note">Review approvals requiring administrator attention.</div></div></div><div class="section-note">${pendingApprovals} pending approval${pendingApprovals === 1 ? "" : "s"}</div></section></div>`;
}

// Record allocation and sharing (administrators only). The API endpoints already
// exist; this makes them reachable from the Administration screen so records
// created before ownership existed can be moved to an owner and a department.
function renderAllocation(entityKey = "client") {
  const data = state.allocation || { entities: [] };
  const entities = data.entities || [];
  const active = entities.find((entry) => entry.entity === entityKey) || entities[0];
  if (!active) return `<div class="card glass empty"><strong>No records to allocate</strong></div>`;
  const ownerOptions = (state.organization.users || []).map((user) => `<option value="${user.id}" ${Number(active.records?.[0]?.owner_id) === Number(user.id) ? "selected" : ""}>${escapeHtml(user.display_name)}</option>`).join("");
  const departmentOptions = (state.organization.departments || []).map((department) => `<option value="${department.id}">${escapeHtml(department.name)}</option>`).join("");
  const rows = (active.records || []).map((record) => `<tr>
    <td><span class="cell-main">${escapeHtml(String(record.label ?? `#${record.id}`).slice(0, 60))}</span><span class="cell-sub">#${record.id} · ${escapeHtml(record.visibility || "—")}</span></td>
    <td>${record.owner_id ? escapeHtml((state.organization.users.find((user) => Number(user.id) === Number(record.owner_id)) || {}).display_name || `#${record.owner_id}`) : `<span class="muted">Unassigned</span>`}</td>
    <td>${record.department_id ? escapeHtml((state.organization.departments.find((department) => Number(department.id) === Number(record.department_id)) || {}).name || `#${record.department_id}`) : `<span class="muted">—</span>`}</td>
    <td>${record.share_count || 0}</td>
    <td class="align-right"><div class="row-actions">
      <select class="filter-input" data-allocation-owner="${active.entity}:${record.id}" aria-label="Owner">${ownerOptions}</select>
      <select class="filter-input" data-allocation-department="${active.entity}:${record.id}" aria-label="Department"><option value="">No department</option>${departmentOptions}</select>
      <select class="filter-input" data-allocation-visibility="${active.entity}:${record.id}" aria-label="Visibility">
        ${["own", "department", "organization"].map((value) => `<option value="${value}" ${record.visibility === value ? "selected" : ""}>${value}</option>`).join("")}
      </select>
      <button class="btn btn-small" data-action="save-allocation" data-entity="${active.entity}" data-id="${record.id}">Save</button>
    </div></td>
  </tr>`).join("");
  const tabs = entities.filter((entry) => entry.unassigned > 0 || entry.total > 0).map((entry) => `<button class="btn btn-small ${entry.entity === active.entity ? "btn-primary" : "btn-soft"}" data-action="select-allocation" data-entity="${entry.entity}">${escapeHtml(entry.entity)} (${entry.unassigned})</button>`).join(" ");
  return `<div class="row-actions" style="margin-bottom:12px">${tabs}</div>
    ${rows ? `<div class="table-wrap"><table><thead><tr><th>Record</th><th>Owner</th><th>Department</th><th>Shares</th><th class="align-right">Assign</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="empty"><strong>Nothing to allocate</strong>Every ${escapeHtml(active.entity)} record already has an owner.</div>`}`;
}

async function loadAllocation() {
  if (!isAdmin()) return;
  // Mark the attempt up front. render() only kicks off a load when this flag is
  // unset; without it a failed request left `state.allocation` empty and every
  // render retried, flooding the console and pinning the browser in a loop.
  state.allocationRequested = true;
  try {
    state.allocation = await api(`/org/records/allocation${state.allocationUnassigned === false ? "?unassigned=0" : ""}`);
  } catch (error) {
    // Record the failure as state so the panel can say so instead of looking
    // empty, and so the render guard above stops retrying.
    state.allocation = { entities: [], error: error.message || "Unable to load record allocation." };
    showToast(state.allocation.error);
  }
}

/** Share manager for a single record: who else can see it, and add/revoke. */
async function openShares(entity, recordId) {
  let shares = [];
  try {
    shares = await api(`/org/records/${entity}/${recordId}/shares`);
  } catch (error) {
    showToast(error.message || "Unable to load shares.");
    return;
  }
  state.shares = { entity, recordId };
  const rows = shares.map((share) => `<tr><td>${escapeHtml(share.user_name || share.department_name || "—")}</td><td>${share.user_id ? badge("User", "neutral") : badge("Department", "approved")}</td><td>${formatDateTime(share.created_at, true)}</td><td class="align-right"><button class="btn btn-danger btn-small" data-action="revoke-share" data-id="${share.id}">Revoke</button></td></tr>`).join("");
  const users = (state.organization.users || []).map((user) => `<option value="${user.id}">${escapeHtml(user.display_name)}</option>`).join("");
  const departments = (state.organization.departments || []).map((department) => `<option value="${department.id}">${escapeHtml(department.name)}</option>`).join("");
  modal.dataset.type = "shares";
  modal.innerHTML = `<div class="modal-head"><div><h2>Sharing</h2><p>${escapeHtml(entity)} #${recordId}</p></div><button class="close-btn" data-action="close-modal" aria-label="Close">${closeIcon()}</button></div>
    <div class="form-grid">
      <div class="field"><label for="share-user">Share with a person</label><select id="share-user"><option value="">Select staff</option>${users}</select></div>
      <div class="field"><label for="share-department">Or a department</label><select id="share-department"><option value="">Select department</option>${departments}</select></div>
      <button class="btn btn-primary" data-action="share-record">Share record</button>
    </div>
    ${rows ? `<div class="table-wrap" style="margin-top:16px"><table><thead><tr><th>Shared with</th><th>Type</th><th>Since</th><th class="align-right">Action</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty" style="margin-top:16px">Not shared with anyone yet.</div>`}`;
  modalBackdrop.hidden = false;
}

// ---------------------------------------------------------------------------
// Task assignments
//
// Every button below is rendered from the task's server-computed
// `available_actions`. Nothing here decides what a person may do: a staff
// member is shown Submit and never Approve, and a reviewer is shown neither
// Submit nor the ability to approve their own work. Hiding a control is
// presentation only - the endpoint re-checks everything.
// ---------------------------------------------------------------------------

const TASK_PRIORITIES = ["urgent", "high", "medium", "low"];
const TASK_STATUSES = ["assigned", "in_progress", "submitted", "under_review", "approved", "changes_requested", "completed", "cancelled"];
// Priority carries a WORD as well as a colour, so rank is never colour alone.
const TASK_PRIORITY_LABELS = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };
const TASK_STATUS_LABELS = {
  assigned: "Assigned", in_progress: "In Progress", submitted: "Submitted",
  under_review: "Under Review", approved: "Approved", changes_requested: "Changes Requested",
  completed: "Completed", cancelled: "Cancelled",
};
const TASK_BOXES = [
  // Every assignment this person may see: all of them for the MD/ICT,
  // their department's for a department head, their own work otherwise.
  { key: "all", label: "All assignments" },
  { key: "mine", label: "My tasks" },
  { key: "assigned_by_me", label: "Tasks I assigned" },
  { key: "needs_review", label: "Needs my review" },
];
const TASK_ACTION_LABELS = {
  start: "Start work", submit: "Submit", begin_review: "Begin review",
  approve: "Approve", request_changes: "Request changes", complete: "Mark complete", mark_done: "Mark as done", cancel: "Cancel",
};

function priorityBadge(value) {
  const key = String(value || "low");
  return `<span class="task-priority task-priority-${key}">${escapeHtml(TASK_PRIORITY_LABELS[key] || key)}</span>`;
}

function taskStatusBadge(value) {
  // One colour per lifecycle stage (see .badge-task-* in app.css); the label is
  // always the word, so status never depends on colour alone.
  return badge(TASK_STATUS_LABELS[value] || value || "assigned", `task-${String(value || "assigned").replace(/_/g, "-")}`);
}

function shortDate(value) {
  if (!value) return "—";
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

const REQUEST_OUTCOMES = {
  appointment: "Appointment arranged",
  interested: "Interested - needs follow-up",
  declined: "Customer declined",
  unreachable: "Could not reach the customer",
};

/**
 * The written part of a task: the assignee's report (sent with Submit) and
 * notes anyone on the task can add. Shown while the task is still open.
 */
function taskNoteBox(task) {
  if (["completed", "cancelled"].includes(task.status)) return "";
  const me = Number(state.organization.me?.user?.id);
  const party = [task.assigned_to, task.assigned_by, task.reviewer_id, task.created_by].map(Number).includes(me);
  if (!party) return "";
  // A Contact-page message is answered with a written report, like ordinary work.
  const reporting = (task.available_actions || []).includes("submit") && (!task.request_id || task.request_source === "website-contact");
  return `<div class="field" style="margin-top:12px"><label for="task-note">${reporting ? "Your report <span class=\"req\">*</span>" : "Note"}</label><textarea id="task-note" rows="3" maxlength="2000" placeholder="${reporting ? "What was done, what you found, what happens next" : "Add a note for the others on this task"}"></textarea>${reporting ? `<p class="muted" style="margin:.3rem 0 0">Sent with Submit to ${escapeHtml(task.reviewer_name || task.assigned_by_name || "the reviewer")}.</p>` : ""}</div>`;
}

/**
 * What the person who did the work reported, shown FIRST on the task, so the
 * reviewer (Sales) reads Customer Service's note before deciding. Covers a
 * request's outcome (with its note) and any written report sent with Submit.
 */
function taskReportPanel(task) {
  const outcome = task.request_outcome ? outcomeText(task.request_outcome, task.request_outcome_note, task.request_appointment_at, task.request_appointment_type) : "";
  // A request's report is its outcome + note (already shown by `outcome`);
  // any other written report is shown in full.
  const report = task.report && !(task.request_outcome && /^Outcome:/.test(task.report)) ? `<p class="task-report-text">${escapeHtml(task.report)}</p>` : "";
  if (!outcome && !report) {
    return ["submitted", "under_review"].includes(task.status) ? `<div class="task-report task-report-empty">No report was written with this submission.</div>` : "";
  }
  const when = task.report_at ? ` · ${formatDateTime(task.report_at, true)}` : "";
  const booking = task.request_outcome === "appointment" && !task.request_appointment_id ? `<p class="muted task-report-hint">Approving books this appointment and registers the customer as a client.</p>` : "";
  return `<section class="task-report" aria-label="Report">
      <div class="task-report-head">${icon("file")}<strong>Report from ${escapeHtml(task.assigned_to_name || "the assignee")}</strong><span class="muted">${escapeHtml(when.replace(/^ · /, ""))}</span></div>
      ${outcome ? `<div class="task-report-outcome">${outcome}</div>` : ""}
      ${report}
      ${booking}
    </section>`;
}

/** One line describing what Customer Service reported on a request. */
function outcomeText(outcome, note, when, type) {
  if (!outcome) return "";
  const at = when ? ` · ${escapeHtml(humanize(type || "viewing"))} on ${formatDateTime(when, true)}` : "";
  return `<strong>${escapeHtml(REQUEST_OUTCOMES[outcome] || outcome)}</strong>${at}${note ? `<span class="cell-sub">${escapeHtml(note)}</span>` : ""}`;
}

function taskActionButtons(task) {
  // A customer request handed to Customer Service is closed with an outcome
  // report (appointment / interested / declined / unreachable), not a bare
  // Submit: the one button starts and submits the task with that report.
  const mine = Number(task.assigned_to) === Number(state.organization.me?.user?.id);
  if (task.request_id && task.request_source !== "website-contact" && mine && (task.available_actions || []).some((a) => a === "start" || a === "submit")) {
    const rest = (task.available_actions || []).filter((a) => a !== "start" && a !== "submit");
    return `<button class="btn btn-primary btn-small" data-action="request-outcome" data-id="${task.id}">Report outcome to Sales</button>` + taskActionButtons({ ...task, request_id: null, available_actions: rest });
  }
  return (task.available_actions || []).map((action) => `<button class="btn btn-${action === "request_changes" || action === "cancel" ? "soft" : "primary"} btn-small" data-action="task-action" data-id="${task.id}" data-task-action="${action}">${escapeHtml(TASK_ACTION_LABELS[action] || action)}</button>`).join("");
}

function taskRow(task) {
  const link = task.linked_entity ? `<span class="cell-sub">Linked: ${escapeHtml(humanize(task.linked_entity))} #${task.linked_record_id}</span>` : "";
  // The server's `available_actions` decide every button. The first forward
  // step is the row's main action; the rest (and Cancel) sit in the row menu,
  // so a reviewer's Approve and Request changes are both still one click away.
  const actions = task.available_actions || [];
  const forward = actions.filter((action) => action !== "cancel");
  const buttons = (list) => taskActionButtons({ ...task, available_actions: list });
  const primary = forward[0] ? buttons([forward[0]]) : "";
  const secondary = [...forward.slice(1), ...actions.filter((action) => action === "cancel")];
  const overdue = task.due_date && String(task.due_date).slice(0, 10) < today() && !["approved", "completed", "cancelled"].includes(task.status);
  return `<tr>
    <td><button class="cell-link" data-action="open-task" data-id="${task.id}"><span class="cell-main">${escapeHtml(task.title)}</span></button>${task.report && ["submitted", "under_review", "approved", "completed"].includes(task.status) ? `<span class="cell-sub request-report"><strong>Report from ${escapeHtml(task.assigned_to_name || "the assignee")}:</strong> ${escapeHtml(String(task.report).slice(0, 180))}</span>` : task.description ? `<span class="cell-sub">${escapeHtml(String(task.description).slice(0, 140))}</span>` : ""}${link}</td>
    <td>${escapeHtml(task.assigned_by_name || "—")}</td>
    <td>${escapeHtml(task.assigned_to_name || "—")}</td>
    <td>${priorityBadge(task.priority)}</td>
    <td class="${overdue ? "danger-text" : ""}">${shortDate(task.due_date)}${overdue ? `<span class="cell-sub danger-text">Overdue</span>` : ""}</td>
    <td>${taskStatusBadge(task.status)}</td>
    <td class="align-right"><div class="row-actions">${primary || `<button class="btn btn-soft btn-small" data-action="open-task" data-id="${task.id}">Open</button>`}${rowMenu([secondary.length ? buttons(secondary) : "", primary ? `<button class="btn btn-small" data-action="open-task" data-id="${task.id}">Open details</button>` : ""])}</div></td>
  </tr>`;
}

function renderAssignments() {
  const mayAssign = can("assign_tasks");
  const attention = state.attention || { total: 0, mine: 0, review: 0 };
  const tabs = TASK_BOXES.map((box) => `<button class="seg-btn${state.taskBox === box.key ? " active" : ""}" data-action="task-box" data-box="${box.key}" aria-pressed="${state.taskBox === box.key}">${escapeHtml(box.label)}</button>`).join("");
  const priorityFilter = `<select id="task-priority" class="filter-input" data-action="task-priority-filter" aria-label="Filter by priority"><option value="">All priorities</option>${TASK_PRIORITIES.map((value) => `<option value="${value}" ${state.taskPriority === value ? "selected" : ""}>${escapeHtml(TASK_PRIORITY_LABELS[value])}</option>`).join("")}</select>`;
  const statusFilter = `<select id="task-status" class="filter-input" data-action="task-status-filter" aria-label="Filter by status"><option value="">All statuses</option>${TASK_STATUSES.map((value) => `<option value="${value}" ${state.taskStatus === value ? "selected" : ""}>${escapeHtml(TASK_STATUS_LABELS[value])}</option>`).join("")}</select>`;
  const tasks = state.tasks || [];
  const rows = tasks.map(taskRow).join("");
  const table = rows
    ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Task</th><th>Assigned by</th><th>Assigned to</th><th>Priority</th><th>Due</th><th>Status</th><th class="align-right">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`
    // An empty section says so plainly rather than inventing filler content.
    : `<div class="panel">${emptyState("No tasks in this section", "Nothing is waiting on you here right now.", { iconName: "tasks", compact: true })}</div>`;
  const tile = (label, value, iconName, tone) => `<article class="stat-tile${Number(value) ? "" : " is-quiet"}"><div class="stat-icon ${Number(value) ? tone : ""}">${icon(iconName)}</div><div class="stat-copy"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${Number(value) || 0}</div></div></article>`;
  return `<div class="stat-grid stat-grid-compact">
      ${tile("Needs your attention", attention.total, "bell", "gold")}
      ${tile("Assigned to you", attention.mine, "tasks", "green")}
      ${tile("Awaiting your review", attention.review, "check", "amber")}
    </div>
    <div class="toolbar">
      <div class="toolbar-filters"><div class="segmented" role="group" aria-label="Task sections">${tabs}</div>${priorityFilter}${statusFilter}</div>
      <div class="toolbar-end">${mayAssign ? `<button class="btn btn-primary" data-action="new-task">${icon("plus")}New Task</button>` : ""}</div>
    </div>
    <div class="section-head section-head-tight"><div><h2 class="section-title">Assignments · ${escapeHtml((TASK_BOXES.find((box) => box.key === state.taskBox) || TASK_BOXES[0]).label)}</h2><div class="section-note">${tasks.length} task${tasks.length === 1 ? "" : "s"} in this section</div></div></div>
    ${table}`;
}

async function loadTasks() {
  state.tasksRequested = true;
  const params = new URLSearchParams();
  if (state.taskBox) params.set("box", state.taskBox);
  if (state.taskPriority) params.set("priority", state.taskPriority);
  if (state.taskStatus) params.set("status", state.taskStatus);
  try {
    state.tasks = await api(`/org/tasks?${params.toString()}`);
  } catch (error) {
    state.tasks = [];
    showToast(error.message || "Unable to load assignments.");
  }
}

/**
 * Refreshes the backend attention count and repaints the navigation. Called on
 * bootstrap and after every task action, so the badge always matches real state.
 */
async function refreshAttention() {
  try {
    state.attention = await api("/org/tasks/attention");
  } catch (error) {
    state.attention = { total: 0, mine: 0, review: 0 };
  }
  if (state.organization.me) state.organization.me.attention = state.attention;
  updateNavigation();
  updateNotificationDot();
}

// New assignments reach a signed-in person without a page reload: the badge
// and the bell are refreshed every minute while the tab is visible.
const attentionTimer = setInterval(() => {
  if (document.visibilityState === "visible" && state.organization?.me) refreshAttention();
}, 60000);
attentionTimer?.unref?.();

async function openTask(id) {
  let task;
  try {
    task = await api(`/org/tasks/${id}`);
  } catch (error) {
    showToast(error.message || "Unable to open this task.");
    return;
  }
  const history = (task.history || []).map((entry) => `<tr><td>${formatDateTime(entry.created_at, true)}</td><td>${escapeHtml(entry.actor_name || "System")}</td><td>${escapeHtml(String(entry.action || "").replace(/^task_/, "").replace(/_/g, " "))}${["task_assigned", "task_reassigned"].includes(entry.action) && entry.assignee_name ? ` → ${escapeHtml(entry.assignee_name)}` : ""}</td><td>${escapeHtml(entry.details_json?.from || "—")} → ${escapeHtml(entry.details_json?.to || "—")}</td></tr>`).join("");
  const comments = (task.comments || []).map((comment) => `<tr><td>${escapeHtml(comment.author_name || "—")}</td><td>${escapeHtml(comment.body)}</td><td>${formatDateTime(comment.created_at, true)}</td></tr>`).join("");
  modal.dataset.type = "task";
  modal.innerHTML = `<div class="modal-head"><div><h2>${escapeHtml(task.title)}</h2><p>${escapeHtml(TASK_STATUS_LABELS[task.status] || task.status)} · ${escapeHtml(TASK_PRIORITY_LABELS[task.priority] || task.priority)}</p></div><button class="close-btn" data-action="close-modal" aria-label="Close">${closeIcon()}</button></div>
    <div class="task-detail">
      <div><span>Assigned by</span><strong>${escapeHtml(task.assigned_by_name || "—")}</strong></div>
      <div><span>Assigned to</span><strong>${escapeHtml(task.assigned_to_name || "—")}</strong></div>
      <div><span>Reviewer</span><strong>${escapeHtml(task.reviewer_name || "Unassigned")}</strong></div>
      <div><span>Due</span><strong>${shortDate(task.due_date)}</strong></div>
      ${task.linked_entity ? `<div><span>Linked record</span><strong>${escapeHtml(task.linked_entity)} #${task.linked_record_id}</strong></div>` : ""}
    </div>
    ${taskReportPanel(task)}
    ${task.description ? `<details class="task-brief"${task.report ? "" : " open"}><summary>Instructions from ${escapeHtml(task.assigned_by_name || "the assigner")}</summary><p class="task-instructions">${escapeHtml(task.description)}</p></details>` : ""}
    ${taskNoteBox(task)}
    <div class="row-actions" style="margin:14px 24px">${taskActionButtons(task)}${taskNoteBox(task) ? `<button class="btn btn-soft btn-small" data-action="add-task-note" data-id="${task.id}">Save note only</button>` : ""}</div>
    ${(task.available_actions || []).includes("request_changes") ? `<div class="field"><label for="task-review-comment">Review comment (required to request changes)</label><textarea id="task-review-comment" name="comment" rows="2" placeholder="What must change?"></textarea></div>` : ""}
    ${comments ? `<div class="table-wrap" style="margin-top:14px"><table><thead><tr><th>Author</th><th>Comment</th><th>When</th></tr></thead><tbody>${comments}</tbody></table></div>` : ""}
    ${history ? `<div class="table-wrap" style="margin-top:14px"><table><thead><tr><th>When</th><th>Who</th><th>Event</th><th>State change</th></tr></thead><tbody>${history}</tbody></table></div>` : ""}`;
  modalBackdrop.hidden = false;
}

// The linked-record field is a POINTER, not a copy. The list is the same set the
// backend accepts; the server verifies the target exists and refuses anything
// else, so an invalid choice is reported rather than silently dropped.
const TASK_LINK_CHOICES = [
  ["", "None"], ["client", "Client"], ["property", "Property"], ["contract", "Contract"],
  ["payment", "Payment"], ["debt", "Debt / installment"], ["project", "Project"],
  ["report", "Report"], ["document", "Document"], ["appointment", "Appointment"],
];

/**
 * Builds the "Assign work" modal.
 *
 * The assignee list and the reviewer list are fetched INDEPENDENTLY. They used to
 * share one `Promise.all`, which meant a failure in either one left an authorized
 * caller with no way to create a task at all - a real defect, because holding
 * `assign_tasks` is what authorizes the entry point, and a caller may legitimately
 * hold it without `review_tasks`. A reviewer list that cannot be read now simply
 * means no reviewer is offered; the assignee list is the one that must succeed.
 */
/** The departments the caller may assign into, from the server's assignee list. */
function taskDepartments(assignees) {
  const byId = new Map();
  for (const person of assignees) for (const dept of person.departments || []) byId.set(dept.id, dept);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Officers follow the chosen department; nobody from another department is offered. */
function wireTaskDepartment(assignees, lockTo = null, departmentList = null) {
  const form = document.getElementById("task-form");
  const deptSelect = form?.querySelector('[data-role="task-department"]');
  const people = form?.querySelector('[name="assigned_to"]');
  if (!deptSelect || !people) return;
  const fill = () => {
    const deptId = Number(deptSelect.value);
    const members = deptId ? assignees.filter((p) => (p.departments || []).some((d) => Number(d.id) === deptId)) : [];
    people.innerHTML = `<option value="">${deptId ? (members.length ? "Choose an officer" : "No active officer in this department") : "Choose a department first"}</option>${members.map((p) => `<option value="${p.id}">${escapeHtml(p.display_name)}</option>`).join("")}`;
    people.disabled = !members.length;
    if (members.length === 1) people.value = String(members[0].id);
    // Reviewer: only reviewers from the chosen department, plus the person
    // assigning (who normally checks the work they hand out). Never a mix of
    // other departments.
    const reviewer = form.querySelector('[name="reviewer_id"]');
    if (reviewer) {
      const me = state.organization.me?.user?.id;
      const pool = state.taskReviewers || [];
      const inDept = deptId ? pool.filter((p) => (p.departments || []).some((d) => Number(d.id) === deptId) && Number(p.id) !== Number(me)) : [];
      const self = pool.find((p) => Number(p.id) === Number(me));
      const keep = reviewer.value;
      reviewer.innerHTML = `<option value="">None</option>${self ? `<option value="${self.id}">Me (${escapeHtml(self.display_name)})</option>` : ""}${inDept.map((p) => `<option value="${p.id}">${escapeHtml(p.display_name)}</option>`).join("")}`;
      if ([...reviewer.options].some((o) => o.value === keep)) reviewer.value = keep;
      else if (self) reviewer.value = String(self.id);
    }
  };
  if (lockTo) {
    const match = (departmentList || taskDepartments(assignees)).find((d) => d.name.toUpperCase() === lockTo.toUpperCase());
    if (match) { deptSelect.value = String(match.id); deptSelect.disabled = true; }
  }
  deptSelect.addEventListener("change", fill);
  fill();
}

// Every contract is a Buy, a Rent or a Sell. Required on every new contract.
const DEAL_TYPES = [["buy", "Buy"], ["rent", "Rent"], ["sell", "Sell"]];
function dealTypeLabel(value) {
  return (DEAL_TYPES.find(([key]) => key === value) || [null, ""])[1];
}
function dealTypeField(id, selected = "", { required = true } = {}) {
  return `<div class="field"><label for="${id}">Contract type${required ? ' <span class="req">*</span>' : ""}</label><select id="${id}" name="deal_type"${required ? " required" : ""}><option value="">Choose Buy, Rent or Sell</option>${DEAL_TYPES.map(([value, label]) => `<option value="${value}"${selected === value ? " selected" : ""}>${label}</option>`).join("")}</select></div>`;
}

async function openTaskModal(prefill = {}) {
  // A hand-off remembers its request, so the new task is tied to it on save.
  state.pendingHandOff = prefill.requestId || null;
  // Only people the SERVER considers assignable may be offered. A failed or
  // malformed list is treated as "nobody", never as "everybody".
  const loadList = async (path) => {
    try {
      const result = await api(path);
      return Array.isArray(result) ? result : [];
    } catch {
      return null; // null means "not readable for this caller"
    }
  };
  // A hand-off lists only its department (a request goes to Customer Service).
  const assigneePath = prefill.department ? `/org/tasks/assignees?department=${encodeURIComponent(prefill.department)}` : "/org/tasks/assignees";
  const [assignees, reviewers, departmentList] = await Promise.all([loadList(assigneePath), loadList("/org/tasks/reviewers"), loadList("/org/tasks/departments")]);
  if (assignees === null) {
    showToast("You are not allowed to assign work.");
    return;
  }
  if (!assignees.length) {
    showToast(prefill.department ? "There is no active Customer Service officer yet. Ask ICT to add one under Administration." : "No staff member is inside your assignment scope.");
    return;
  }
  state.taskAssignees = assignees;
  state.taskReviewers = reviewers || [];
  const people = assignees.map((person) => `<option value="${person.id}">${escapeHtml(person.display_name)}</option>`).join("");
  // A caller who may not read the reviewer list gets no reviewer field at all,
  // rather than a field the server would reject.
  const reviewerField = reviewers === null ? "" : `<div class="field"><label for="task-reviewer">Reviewer / approver</label><select id="task-reviewer" name="reviewer_id"><option value="">None</option>${reviewers.map((person) => `<option value="${person.id}">${escapeHtml(person.display_name)}</option>`).join("")}</select></div>`;
  const priorities = TASK_PRIORITIES.map((value) => `<option value="${value}" ${value === "medium" ? "selected" : ""}>${escapeHtml(TASK_PRIORITY_LABELS[value])}</option>`).join("");
  const links = TASK_LINK_CHOICES.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("");
  modal.dataset.type = "task";
  modal.innerHTML = `<div class="modal-head"><div><h2>New Task</h2><p>Assigning as yourself · only people inside your authorized scope are listed</p></div><button class="close-btn" data-action="close-modal" aria-label="Close">${closeIcon()}</button></div>
    <form id="task-form" class="form-grid">
      <div class="field"><label for="task-title">Task title <span class="req">*</span></label><input id="task-title" name="title" required maxlength="160" placeholder="Prepare Monthly Sales Report"></div>
      <div class="field full"><label for="task-description">Description / instructions</label><textarea id="task-description" name="description" rows="3" placeholder="What exactly must be produced?"></textarea></div>
      <div class="field"><label for="task-department">Department <span class="req">*</span></label><select id="task-department" data-role="task-department" required><option value="">Choose a department</option>${(departmentList || taskDepartments(assignees)).map((d) => `<option value="${d.id}">${escapeHtml(titleCase(d.name))}${d.active_members === 0 ? " (no staff yet)" : ""}</option>`).join("")}</select></div>
      <div class="field"><label for="task-assignee">Assign to <span class="req">*</span></label><select id="task-assignee" name="assigned_to" required><option value="">Select authorized staff</option>${people}</select></div>
      ${reviewerField}
      <div class="field"><label for="task-priority-input">Priority</label><select id="task-priority-input" name="priority">${priorities}</select></div>
      <div class="field"><label for="task-due">Due date</label><input id="task-due" name="due_date" type="date"></div>
      <div class="field"><label for="task-link-entity">Linked record (optional)</label><select id="task-link-entity" name="linked_entity">${links}</select></div>
      <div class="field"><label for="task-link-id">Linked record id</label><input id="task-link-id" name="linked_record_id" type="number" min="1" step="1" placeholder="e.g. 21"></div>
      <div class="form-actions full"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">Assign work</button></div>
    </form>`;
  wireTaskDepartment(assignees, prefill.department || null, departmentList);
  // Hand-offs (e.g. a website lead to Customer Service) arrive pre-filled.
  if (prefill.title || prefill.description) {
    const form = document.getElementById("task-form");
    const set = (name, value) => { const el = form?.querySelector(`[name="${name}"]`); if (el && value) el.value = value; };
    set("title", prefill.title);
    set("description", prefill.description);
    set("priority", prefill.priority);
    const reviewer = form?.querySelector('[name="reviewer_id"]');
    if (prefill.reviewerId && reviewer && [...reviewer.options].some((o) => o.value === String(prefill.reviewerId))) reviewer.value = String(prefill.reviewerId);
    const heading = modal.querySelector(".modal-head h2");
    if (prefill.heading && heading) heading.textContent = prefill.heading;
    if (prefill.department) {
      const label = form?.querySelector('label[for="task-assignee"]');
      if (label) label.firstChild.textContent = "Customer Service officer ";
      const note = modal.querySelector(".modal-head p");
      if (note) note.textContent = "Only Customer Service staff are listed.";
      // The request is already in the description; no linked-record fields.
      for (const name of ["linked_entity", "linked_record_id"]) form?.querySelector(`[name="${name}"]`)?.closest(".field")?.remove();
    }
  }
  modalBackdrop.hidden = false;
}

const SERVICE_LABELS = { rent: "Rent", buy: "Buy", sell: "Sell" };
const SELL_TYPE_LABELS = { house: "House", apartment: "Apartment", villa: "Villa", land: "Land / plot", commercial: "Commercial", other: "Other" };
/** The seller's property, as submitted on the website's Sell form. */
function sellSummary(details) {
  const d = details || {};
  return [SELL_TYPE_LABELS[d.property_type] || "Property", d.location, d.area ? `${Number(d.area).toLocaleString("en-US")} m²` : null, d.bedrooms ? `${d.bedrooms} bedroom${Number(d.bedrooms) === 1 ? "" : "s"}` : null, d.title_deed ? `Title deed: ${{ yes: "yes", no: "no", in_progress: "in progress" }[d.title_deed] || d.title_deed}` : null].filter(Boolean).join(" · ");
}

/** A website lead handed to Customer Service to contact the customer. */
function handOffLead(leadId) {
  const lead = [...(state.requests || []), ...(state.organization.leads || [])].find((row) => String(row.id) === String(leadId));
  if (!lead) return;
  const means = { phone: "Phone call", whatsapp: "WhatsApp", email: "Email" }[lead.preferred_contact] || "Phone call";
  const lines = [
    lead.service === "sell" ? `Website SELL submission: ${sellSummary(lead.sell_details)}.` : lead.service ? `Website request to ${lead.service === "rent" ? "RENT" : "BUY"}.` : "Website enquiry.",
    "",
    `Customer: ${lead.name}`,
    `Phone: ${lead.phone || "—"}`,
    `Email: ${lead.email || "—"}`,
    lead.budget ? `${lead.service === "sell" ? "Asking price" : "Budget"}: TZS ${Number(lead.budget).toLocaleString("en-US")}` : null,
    `Contact by: ${means}`,
    "",
    lead.notes || "",
    "",
    lead.service === "sell"
      ? `Please contact the owner by ${means.toLowerCase()}, explain how selling with MKUYU works and arrange a visit if they wish, then report back. (Lead W-${lead.id})`
      : `Please contact the customer by ${means.toLowerCase()} and report back. (Lead W-${lead.id})`,
  ].filter((line) => line !== null);
  openTaskModal({
    // Buy/Rent/Sell requests and Contact-page messages are both followed under
    // Requests, so both are tied to the task and its report comes back there.
    requestId: ["website", "website-contact"].includes(lead.source) ? lead.id : null,
    department: "CUSTOMER SERVICE",
    heading: "Hand to Customer Service",
    title: `Contact ${lead.name}${lead.service ? ` (${SERVICE_LABELS[lead.service]?.toLowerCase() || lead.service} request)` : ""}`,
    description: lines.join("\n"),
    priority: "high",
    reviewerId: state.organization.me?.user?.id,
  });
}

/**
 * Sales arranges the agreed appointment for a request after approving
 * Customer Service's report (or moves an existing one). It is booked straight
 * into Appointments.
 */
function mayArrangeAppointments() {
  return can("assign_tasks") && inSales() && canChange("appointments", "create") && canModule("leads");
}
function openArrangeAppointment(leadId) {
  const request = (state.requests || []).find((row) => String(row.id) === String(leadId));
  if (!request) { showToast("Open Requests and try again."); return; }
  const local = (value) => {
    if (!value) return { date: "", time: "" };
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return { date: "", time: "" };
    const pad = (n) => String(n).padStart(2, "0");
    return { date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, time: `${pad(date.getHours())}:${pad(date.getMinutes())}` };
  };
  const at = local(request.appointment_at);
  const report = request.task_report && !/^Outcome:/.test(request.task_report) ? request.task_report : request.outcome_note || "";
  const moving = Boolean(request.appointment_id);
  const types = [["viewing", "Site visit / viewing"], ["meeting", "Meeting at the office"], ["call", "Phone call"]];
  openSmallForm(moving ? `Change appointment · ${request.name}` : `Arrange appointment · ${request.name}`,
    moving ? "Move the booked appointment. Appointments shows the new time." : "Book the time agreed with the customer. It goes straight into Appointments.",
    `${report ? `<div class="field full"><span class="toolbar-label">What Customer Service reported</span><p class="task-report-text" style="margin:.3rem 0 0">${escapeHtml(report)}</p></div>` : ""}
     <div class="field"><label for="arrange-date">Date <span class="req">*</span></label><input id="arrange-date" name="date" type="date" required min="${today()}" value="${escapeHtml(at.date)}"></div>
     <div class="field"><label for="arrange-time">Time <span class="req">*</span></label><input id="arrange-time" name="time" type="time" required step="900" value="${escapeHtml(at.time)}"><div class="field-help">Choose the time agreed with the customer, e.g. 2:00 PM.</div></div>
     <div class="field"><label for="arrange-type">Type</label><select id="arrange-type" name="appointment_type">${types.map(([value, label]) => `<option value="${value}"${(request.appointment_type || "viewing") === value ? " selected" : ""}>${label}</option>`).join("")}</select></div>
     <div class="field full"><label for="arrange-note">Note for the appointment</label><textarea id="arrange-note" name="note" rows="2" maxlength="2000" placeholder="e.g. Meet at the site office; discuss price and the contract"></textarea></div>`,
    moving ? "Save new time" : "Book appointment",
    async (data) => {
      if (!data.date) throw new Error("Choose the appointment date.");
      if (!data.time) throw new Error("Choose the appointment time agreed with the customer.");
      const startsAt = new Date(`${data.date}T${data.time}`);
      if (Number.isNaN(startsAt.getTime())) throw new Error("The date or time is not valid.");
      await api(`/org/requests/${leadId}/appointment`, { method: "POST", body: JSON.stringify({ starts_at: startsAt.toISOString(), appointment_type: data.appointment_type || "viewing", note: data.note || "" }) });
      await reloadRequests();
      refresh();
      const when = startsAt.toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true });
      return `${moving ? "Appointment moved to" : "Appointment booked for"} ${when}. It is in Appointments.`;
    });
}

async function submitTaskAction(taskId, action) {
  const body = { action };
  if (action === "submit") {
    const field = document.getElementById("task-note");
    if (!field || modalBackdrop.hidden) { await openTask(taskId); showToast("Write your report, then press Submit."); return; }
    const report = field.value.trim();
    if (!report) { showToast("Write your report before submitting."); field.focus({ preventScroll: true }); return; }
    body.comment = report;
  }
  if (action === "request_changes") {
    const field = document.getElementById("task-review-comment");
    const comment = field ? field.value.trim() : "";
    if (!comment) { showToast("A review comment is required to request changes."); return; }
    body.comment = comment;
  }
  try {
    await api(`/org/tasks/${taskId}/actions`, { method: "POST", body: JSON.stringify(body) });
    modalBackdrop.hidden = true;
    showToast(`Task ${action.replace(/_/g, " ")}.`);
  } catch (error) {
    showToast(error.message || "That action is not allowed.");
    return;
  }
  // State changed, so the badge, the lists and the open task are all re-read.
  await refreshAttention();
  await loadTasks();
  if (state.view === "assignments") render();
  // Approving a request's report can create a client and an appointment, so
  // the workspace lists are re-read; a request's stage follows its task too.
  if (action === "approve") await refresh();
  if (state.requests || action === "approve") { await reloadRequests(); if (state.view === "requests") render(); }
  // Report approved: Sales now arranges the agreed appointment (unless the
  // customer's appointment is already booked from Customer Service's report).
  if (action === "approve" && mayArrangeAppointments()) {
    const request = (state.requests || []).find((row) => String(row.task_id) === String(taskId));
    if (request && !request.appointment_id && !["declined", "unreachable"].includes(request.outcome)) openArrangeAppointment(request.id);
  }
  // Beginning a review leads straight to the decision: reopen the task with
  // Approve / Request changes instead of making the reviewer find it again.
  if (action === "begin_review") openTask(taskId);
}

// ---------------------------------------------------------------------------
// Generate Contract overlay.
//
// The first click OPENS this; nothing is generated until the operator confirms
// on the review step. It reuses the existing modal component, form fields and
// buttons - only the width changes, so the complete form has room without
// introducing a new UI system.
//
// Everything typed here is INPUT. The discount amount, the final price, the
// contract number and the assigner are decided by the server; the two derived
// amounts are shown read-only for convenience only.
// ---------------------------------------------------------------------------

const CONTRACT_FREQUENCIES = ["monthly", "quarterly", "semi-annual", "annual"];
const CONTRACT_DURATION_UNITS = ["months", "years", "weeks", "days"];

/** Properties belonging to the chosen project, from records already loaded. */
function propertyOptionsForProject(projectId, selected = "") {
  const pool = (state.properties || []).filter((property) => !projectId || String(property.project_id) === String(projectId));
  if (!pool.length) return `<option value="">No property in this project</option>`;
  return pool.map((property) => `<option value="${property.id}" ${String(property.id) === String(selected) ? "selected" : ""}>${escapeHtml(property.name)} · ${escapeHtml(property.location || "")}</option>`).join("");
}

/** Every property, those offered for rent first: a lease names no project. */
function rentalPropertyOptions(selected = "") {
  const pool = [...(state.properties || [])].sort((a, b) => Number(Boolean(b.offer_rent)) - Number(Boolean(a.offer_rent)));
  if (!pool.length) return `<option value="">No property yet</option>`;
  return pool.map((property) => `<option value="${property.id}" ${String(property.id) === String(selected) ? "selected" : ""}>${escapeHtml(property.name)} · ${escapeHtml(property.location || "")}${property.offer_rent ? " · for rent" : ""}</option>`).join("");
}

function contractTemplateOptions(selected = "", dealType = "") {
  // Only templates that fit this kind of contract: letterheads (any type) and
  // templates written for this type. Nothing chosen yet: the same automatic
  // choice the server makes - a template for this type, else the default.
  // "builtin" is an explicit choice of the built-in MKUYU letterhead, so going
  // back from the review step never silently swaps the template.
  const fits = (state.contractTemplates || []).filter((template) => !template.deal_type || template.deal_type === dealType);
  const fallback = fits.find((template) => template.deal_type === dealType && template.is_default) || fits.find((template) => template.deal_type === dealType) || fits.find((template) => template.is_default);
  const chosen = selected && (selected === "builtin" || fits.some((template) => String(template.id) === String(selected))) ? selected : (fallback ? String(fallback.id) : "builtin");
  const agreement = contractKind(dealType)?.agreement || "Agreement";
  const built = `<option value="builtin" ${chosen === "builtin" ? "selected" : ""}>Built-in MKUYU letterhead · ${escapeHtml(agreement)}</option>`;
  return built + fits.map((template) => `<option value="${template.id}" ${String(template.id) === String(chosen) ? "selected" : ""}>${escapeHtml(template.title)}${template.letterhead ? " · letterhead" : ""}${template.is_default ? " (default)" : ""}</option>`).join("");
}

/** Reads the overlay's own inputs. The form is the only thing that changes. */
function generateContractFormData() {
  const saved = state.contractGen?.data || {};
  const value = (id, key, fallback = "") => document.getElementById(id)?.value ?? saved[key] ?? fallback;
  return {
    client_id: value("gc-client", "client_id") || null,
    client_name: value("gc-client-name", "client_name").trim(),
    client_phone: value("gc-client-phone", "client_phone").trim(),
    client_email: value("gc-client-email", "client_email").trim(),
    project_id: value("gc-project", "project_id"),
    property_id: value("gc-property", "property_id") || null,
    start_date: value("gc-start", "start_date") || null,
    end_date: value("gc-end", "end_date") || null,
    agreement_duration: value("gc-duration", "agreement_duration") || null,
    agreement_duration_unit: value("gc-duration-unit", "agreement_duration_unit", "months") || null,
    contract_date: value("gc-date", "contract_date") || null,
    contract_type: value("gc-type", "contract_type", "new"),
    deal_type: value("gc-deal", "deal_type", ""),
    original_price: value("gc-original", "original_price"),
    discount_pct: value("gc-discount", "discount_pct", "0") || "0",
    payment_mode: value("gc-payment-mode", "payment_mode", "installments") || "installments",
    deposit: value("gc-deposit", "deposit"),
    installments: value("gc-installments", "installments"),
    frequency: value("gc-frequency", "frequency", "monthly"),
    first_due_date: value("gc-first-due", "first_due_date") || null,
    title_deed_number: value("gc-title-deed", "title_deed_number").trim(),
    template_choice: value("gc-template", "template_choice") || "",
    template_document_id: (() => { const raw = value("gc-template", "template_choice"); return raw && raw !== "builtin" ? raw : null; })(),
    notes: value("gc-notes", "notes").trim(),
  };
}

/** YYYY-MM-DD, adding whole months (the mirror of the server's own helper). */
function addMonthsToDate(dateString, months, unit) {
  const match = String(dateString).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match || !Number.isFinite(months)) return dateString;
  const [, year, month, day] = match.map(Number);
  if (unit === "days" || unit === "weeks") {
    const days = unit === "weeks" ? months * 7 : months;
    const target = new Date(Date.UTC(year, month - 1, day + days));
    return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(target.getUTCDate()).padStart(2, "0")}`;
  }
  const targetMonth = month - 1 + (unit === "years" ? months * 12 : months);
  const anchor = new Date(Date.UTC(year, targetMonth, 1));
  const last = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0)).getUTCDate();
  return `${anchor.getUTCFullYear()}-${String(anchor.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/**
 * Repaints the derived, read-only figures as the operator types.
 *
 * CONVENIENCE ONLY. The identical arithmetic runs on the server in
 * contracts/pricing.js and the server's numbers are what gets stored - neither
 * derived amount is ever sent, so a tampered field cannot change a price.
 */
function updateGenerateContractPreview() {
  const data = generateContractFormData();
  const priced = pricingPreview(null, data.original_price, data.discount_pct);
  const discount = document.getElementById("gc-discount-amount");
  const final = document.getElementById("gc-final-price");
  if (discount) discount.value = money(priced.discount_amount);
  if (final) final.value = money(priced.final_price);

  // Property number and location are READ from the selected property rather
  // than retyped, so the document can never disagree with the register.
  const property = (state.properties || []).find((entry) => String(entry.id) === String(data.property_id));
  const number = document.getElementById("gc-property-number");
  const location = document.getElementById("gc-property-location");
  if (number) number.value = property ? `P-${String(property.id).padStart(4, "0")}` : "";
  if (location) location.value = property?.location || "";
  // The property's own list price is offered as a starting point only, and
  // never overwrites something the operator has already typed.
  const original = document.getElementById("gc-original");
  if (original && property && !original.dataset.touched && (data.original_price === "" || original.dataset.auto === "1")) {
    // A lease is priced from the rent: rent per month x the months agreed.
    if (data.deal_type === "rent" && Number(property.rent_price) > 0) {
      const unit = data.agreement_duration_unit || "months";
      const duration = Number(data.agreement_duration) || 0;
      const months = unit === "years" ? duration * 12 : unit === "weeks" ? Math.max(1, Math.ceil((duration * 7) / 30)) : unit === "days" ? Math.max(1, Math.ceil(duration / 30)) : duration;
      const monthly = property.rent_period === "year" ? Number(property.rent_price) / 12 : Number(property.rent_price);
      if (months > 0) { original.value = Math.round(monthly * months); original.dataset.auto = "1"; }
    } else if (data.deal_type !== "rent") {
      original.value = property.price ?? ""; original.dataset.auto = "1";
    }
  }
  // Cash pays everything at signing: the installment fields are not needed.
  const planFields = document.querySelector(".gen-plan-fields");
  if (planFields) planFields.hidden = data.payment_mode === "cash";
  const cashNote = document.getElementById("gc-cash-note");
  if (cashNote) cashNote.hidden = data.payment_mode !== "cash";

  // Duration -> end date, using the same month arithmetic as the server.
  const end = document.getElementById("gc-end");
  if (end && data.start_date && data.agreement_duration) {
    end.value = addMonthsToDate(data.start_date, Number(data.agreement_duration), data.agreement_duration_unit || "months");
  }
}

/** A labelled field in the overlay. Keeps the two forms readable. */
function genField(id, label, control) {
  return `<div class="field"><label for="${id}">${label}</label>${control}</div>`;
}

function generateContractFormBody() {
  const data = generateContractFormData();
  const priced = pricingPreview(null, data.original_price, data.discount_pct);
  const property = (state.properties || []).find((entry) => String(entry.id) === String(data.property_id));
  const clients = (state.clients || []).map((client) => `<option value="${client.id}" data-name="${escapeHtml(client.name)}" data-phone="${escapeHtml(client.phone || "")}" data-email="${escapeHtml(client.email || "")}" ${String(client.id) === String(data.client_id) ? "selected" : ""}>${escapeHtml(client.name)}</option>`).join("");
  const units = CONTRACT_DURATION_UNITS.map((unit) => `<option value="${unit}" ${data.agreement_duration_unit === unit ? "selected" : ""}>${unit[0].toUpperCase()}${unit.slice(1)}</option>`).join("");
  const frequencies = CONTRACT_FREQUENCIES.map((value) => `<option value="${value}" ${data.frequency === value ? "selected" : ""}>${escapeHtml(value)}</option>`).join("");
  const text = (id, name, value, extra = "") => genField(id, name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), `<input id="${id}" name="${name}" value="${escapeHtml(value)}" ${extra}>`);
  const number = (id, name, value, extra = "") => genField(id, name, `<input id="${id}" name="${name}" type="number" step="0.01" min="0" value="${escapeHtml(value)}" ${extra}>`);
  return `<form id="contract-generate-form" class="form-grid">
    <fieldset class="gen-section"><legend>Client information</legend>
      <div class="field full"><label for="gc-client">Client from register (optional)</label><select id="gc-client" name="client_id"><option value="">Type a new name below</option>${clients}</select></div>
      ${text("gc-client-name", `${contractKind(data.deal_type)?.client || "Client"} name`, data.client_name, 'required maxlength="120" placeholder="Full name"')}
      ${text("gc-client-phone", "Client phone", data.client_phone, 'maxlength="40" placeholder="+255 ..."')}
      ${text("gc-client-email", "Client email", data.client_email, 'type="email" maxlength="120" placeholder="client@example.com"')}
      <div class="field full"><label for="gc-company">Company</label><input id="gc-company" type="text" value="${escapeHtml(state.organization?.me?.organization_name || "MKUYU")}" readonly aria-readonly="true" tabindex="-1" title="Taken from the organization record"></div>
    </fieldset>

    <fieldset class="gen-section"><legend>Property information</legend>
      ${data.deal_type === "rent"
        // A lease is about a property only: no project to choose.
        ? `<input type="hidden" id="gc-project" name="project_id" value="">
      <div class="field"><label for="gc-property">Property to rent <span class="req">*</span></label><select id="gc-property" name="property_id" required><option value="">Select property</option>${rentalPropertyOptions(data.property_id)}</select></div>`
        : `<div class="field"><label for="gc-project">Project <span class="req">*</span></label><select id="gc-project" name="project_id" required><option value="">Select project</option>${projectOptions(data.project_id)}</select></div>
      <div class="field"><label for="gc-property">Property <span class="req">*</span></label><select id="gc-property" name="property_id" required><option value="">Select property</option>${propertyOptionsForProject(data.project_id, data.property_id)}</select></div>`}
      <div class="field"><label for="gc-property-number">Property number</label><input id="gc-property-number" type="text" readonly aria-readonly="true" tabindex="-1" value="${property ? escapeHtml(`P-${String(property.id).padStart(4, "0")}`) : ""}" title="Read from the property record"></div>
      ${genField("gc-title-deed", "Title deed / certificate no.", `<input id="gc-title-deed" name="title_deed_number" maxlength="80" value="${escapeHtml(data.title_deed_number || "")}" placeholder="e.g. CT-45821 (printed on the agreement)">`)}
      <div class="field"><label for="gc-property-location">Location</label><input id="gc-property-location" type="text" readonly aria-readonly="true" tabindex="-1" value="${escapeHtml(property?.location || "")}" title="Read from the property record"></div>
    </fieldset>

    <fieldset class="gen-section"><legend>Agreement</legend>
      ${text("gc-start", "Agreement start date", data.start_date, 'type="date" required')}
      ${genField("gc-duration", "Agreement duration", `<input id="gc-duration" name="agreement_duration" type="number" min="1" max="1200" step="1" value="${escapeHtml(data.agreement_duration || "")}" placeholder="24" required>`)}
      <div class="field"><label for="gc-duration-unit">Duration unit</label><select id="gc-duration-unit" name="agreement_duration_unit">${units}</select></div>
      ${text("gc-end", "Agreement end date", data.end_date, 'type="date"')}
      ${text("gc-date", "Contract date", data.contract_date || today(), 'type="date"')}
      <div class="field"><label>Contract type</label><div class="gen-kind-chosen"><input type="hidden" id="gc-deal" name="deal_type" value="${escapeHtml(data.deal_type || "")}"><strong>${escapeHtml(contractKind(data.deal_type)?.title || "Not chosen")}</strong><span class="muted">${escapeHtml(contractKind(data.deal_type)?.agreement || "")}</span><button type="button" class="btn btn-small btn-ghost" data-action="contract-change-kind">Change</button></div></div>
      <div class="field"><label for="gc-type">Agreement (new / terminal)</label><select id="gc-type" name="contract_type"><option value="new" ${data.contract_type !== "terminal" ? "selected" : ""}>New</option><option value="terminal" ${data.contract_type === "terminal" ? "selected" : ""}>Terminal</option></select></div>
      <div class="field full"><div class="field-help">The end date is derived from the duration; the server refuses a stated end date that disagrees with it.</div></div>
    </fieldset>

    <fieldset class="gen-section"><legend>Pricing</legend>
      ${number("gc-original", "Original price", data.original_price, 'required placeholder="0"')}
      ${number("gc-discount", "Discount %", data.discount_pct, 'max="100" placeholder="0"')}
      <div class="field"><label for="gc-discount-amount">Discount amount</label><input id="gc-discount-amount" type="text" value="${escapeHtml(money(priced.discount_amount))}" readonly aria-readonly="true" tabindex="-1" title="Calculated by the server"></div>
      <div class="field"><label for="gc-final-price">Final price</label><input id="gc-final-price" type="text" value="${escapeHtml(money(priced.final_price))}" readonly aria-readonly="true" tabindex="-1" title="Calculated by the server. The payment plan is built from this amount."></div>
    </fieldset>

    <fieldset class="gen-section"><legend>Payment plan</legend>
      <div class="field full"><label for="gc-payment-mode">How will the customer pay?</label><select id="gc-payment-mode" name="payment_mode"><option value="installments" ${data.payment_mode !== "cash" ? "selected" : ""}>Installments: a deposit at signing, then equal installments</option><option value="cash" ${data.payment_mode === "cash" ? "selected" : ""}>Cash: the whole ${data.deal_type === "rent" ? "lease" : "price"} at signing</option></select><div class="field-help" id="gc-cash-note"${data.payment_mode === "cash" ? "" : " hidden"}>The whole final price is due on the start date. The contract becomes active once Finance confirms the payment.</div></div>
      <div class="gen-plan-fields"${data.payment_mode === "cash" ? " hidden" : ""}>
      ${number("gc-deposit", "Deposit", data.deposit, 'placeholder="0"')}
      ${number("gc-installments", "Number of installments", data.installments, 'step="1" min="1" max="120" placeholder="6"')}
      <div class="field"><label for="gc-frequency">Payment frequency</label><select id="gc-frequency" name="frequency">${frequencies}</select></div>
      ${text("gc-first-due", "First due date", data.first_due_date, 'type="date"')}
      <div class="field full"><div class="field-help">Provide the deposit, the number of installments and the first due date. Installments split the FINAL PRICE above. The plan is printed in the agreement, and Finance turns it into the installment schedule when they validate the contract.</div></div>
      </div>
    </fieldset>

    <fieldset class="gen-section"><legend>Contract</legend>
      <div class="field full"><label for="gc-template">Contract template</label><select id="gc-template" name="template_document_id">${contractTemplateOptions(data.template_choice, data.deal_type)}</select></div>
      <div class="field full"><div class="field-help">The ${escapeHtml(contractKind(data.deal_type)?.agreement || "agreement")} is placed on this template; its header and footer repeat on every page.${can("upload_contract_templates") ? " To add or change templates, open <strong>Contract templates</strong> in the sidebar." : " Templates are maintained by the MD, ICT, sales officers and Legal Officers."}</div></div>
      ${canModule("documents") && can("create") ? `<div class="field full"><label for="gc-attachment">Supporting document (optional)</label><input id="gc-attachment" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp,.bmp">${state.contractGen?.attachment ? `<div class="field-help">Selected: ${escapeHtml(state.contractGen.attachment.name)}</div>` : `<div class="field-help">The uploaded file will be linked to this contract in Documents.</div>`}</div>` : ""}
      <div class="field full"><label for="gc-contract-number">Contract number</label><input id="gc-contract-number" value="${escapeHtml(data.contract_number || "")}" placeholder="Issued automatically when generated" readonly aria-readonly="true" tabindex="-1"></div>
      ${genField("gc-notes", "Notes", `<textarea id="gc-notes" name="notes" maxlength="2000" placeholder="Internal notes">${escapeHtml(data.notes)}</textarea>`)}
      <div class="field full"><div class="field-help">The contract number is issued by the system when the contract is created.</div></div>
    </fieldset>

    <div class="form-actions full">
      <button class="btn" type="button" data-action="close-modal">Cancel</button>
      <button class="btn btn-primary" type="button" data-action="contract-preview">Review contract${icon("arrow")}</button>
    </div>
  </form>`;
}

/**
 * The review step. It renders the SAME values the form holds and the server
 * will use - it is a second view of one source of truth, not a copy, and
 * nothing is stored until Generate is pressed.
 */
function generateContractReviewBody(data) {
  const priced = pricingPreview(null, data.original_price, data.discount_pct);
  const project = (state.projects || []).find((entry) => String(entry.id) === String(data.project_id));
  const property = (state.properties || []).find((entry) => String(entry.id) === String(data.property_id));
  const template = (state.contractTemplates || []).find((entry) => String(entry.id) === String(data.template_document_id));
  const row = (label, value) => `<div class="task-detail"><div><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value ?? "") || "—")}</strong></div></div>`;
  return `<div class="gen-review">
      <p class="field-help">Check these details. The server recalculates the price, issues the contract number and creates the document when you generate.</p>
      <h3 class="review-heading">Client</h3>
      ${row("Client", data.client_name)}
      ${row("Client phone", data.client_phone)}
      ${row("Client email", data.client_email)}
      <h3 class="review-heading">Property & agreement</h3>
      ${row("Contract type", contractKind(data.deal_type) ? `${contractKind(data.deal_type).title} · ${contractKind(data.deal_type).agreement}` : "—")}
      ${row("Title deed / certificate", data.title_deed_number || "To be confirmed")}
      ${data.deal_type === "rent" ? "" : row("Project", project?.name)}
      ${row("Property", property ? `${property.name} · ${property.location || ""}` : "—")}
      ${row("Agreement", `${data.start_date ? formatDate(data.start_date) : "—"} → ${data.end_date ? formatDate(data.end_date) : "—"}`)}
      ${row("Duration", data.agreement_duration ? `${data.agreement_duration} ${data.agreement_duration_unit || "months"}` : "—")}
      ${row("Contract date", formatDate(data.contract_date || today()))}
      <h3 class="review-heading">Pricing & payment plan</h3>
      ${row("Original price", money(data.original_price))}
      ${row("Discount", `${numberValue(data.discount_pct)}% = ${money(priced.discount_amount)}`)}
      ${row("Final price", money(priced.final_price))}
      ${row("Deposit", data.deposit ? money(data.deposit) : "—")}
      ${row("Installments", data.installments || "—")}
      ${row("Frequency", data.frequency || "—")}
      ${row("First due date", data.first_due_date ? formatDate(data.first_due_date) : "—")}
      <h3 class="review-heading">Document</h3>
      ${row("Template", template ? `${template.title}${template.letterhead ? " (letterhead)" : ""}` : `Built-in MKUYU letterhead · ${contractKind(data.deal_type)?.agreement || "Agreement"}`)}
      ${state.contractGen?.attachment ? row("Supporting document", state.contractGen.attachment.name) : ""}
      ${row("Contract number", "Issued automatically when generated")}
    </div>
    <div class="form-actions">
      <button class="btn" type="button" data-action="contract-back">Back to edit</button>
      <button class="btn btn-primary" type="button" data-action="contract-confirm">${icon("contract")}Generate contract</button>
    </div>`;
}

/** The success state: the real contract and the real generated document. */
function generateContractSuccessBody(result) {
  const contract = result.contract || {};
  const file = result.document || {};
  // A contract with no stored file gets NO Open button. A dead link is worse
  // than an honest absence - this mirrors the document system's own rule.
  const actions = file.has_file && canModule("documents")
     ? `<button class="btn btn-primary" type="button" data-action="view-generated-contract" data-id="${contract.id}">${icon("file")}Open contract</button>
       <button class="btn" type="button" data-action="download-generated-document" data-id="${file.id}" data-filename="${escapeHtml(file.original_filename || file.file_name || "contract.docx")}">Download DOCX</button>
       ${allowedViewFor("documents") !== false ? `<button class="btn btn-ghost" type="button" data-action="open-alert-view" data-view="documents">Go to Documents${icon("arrow")}</button>` : ""}`
    : `<div class="field-help">${file.has_file ? "The document is saved; your account does not have Documents access." : "The contract was created but no document file was stored."}</div>`;
  return `<div class="gen-success">
      <div class="gen-success-mark">${icon("check")}</div>
      <h2>Contract Generated Successfully</h2>
      <p class="gen-success-number">Contract number <strong>${escapeHtml(contract.contract_number || "—")}</strong></p>
      <div class="summary-grid">
        <div><span>Client</span><strong>${escapeHtml(contract.client_name || "—")}</strong></div>
        <div><span>Final price</span><strong>${escapeHtml(money(result.pricing?.final_price))}</strong></div>
        <div><span>Generated document</span><strong>${escapeHtml(file.original_filename || file.file_name || "—")}</strong></div>
        ${result.schedule?.created ? `<div><span>Payment plan</span><strong>${result.schedule.created} installment(s) from the final price</strong></div>` : ""}
      </div>
      ${result.schedule?.skipped ? `<div class="field-help">${escapeHtml(result.schedule.skipped)}</div>` : ""}
      <div class="gen-success-actions">${actions}
        <button class="btn btn-ghost" type="button" data-action="close-modal">Done</button>
      </div>
    </div>`;
}

/** Details -> Review -> Done, shown at the top of the overlay. */
function generateContractSteps(step) {
  const order = ["type", "form", "review", "success"];
  const labels = { type: "Contract type", form: "Contract details", review: "Review", success: "Generated" };
  const current = order.indexOf(step);
  return `<ol class="stepper" aria-label="Contract generation progress">${order.map((key, index) => `<li class="${index < current ? "done" : index === current ? "current" : ""}"${index === current ? ' aria-current="step"' : ""}><span class="stepper-dot">${index < current ? icon("check") : index + 1}</span><span>${labels[key]}</span></li>`).join("")}</ol>`;
}

// The three agreements (the server's contracts/agreements.js). Choosing one is
// the first step: it decides the wording that is placed on the template.
const CONTRACT_KINDS = [
  { type: "buy", title: "Buying", agreement: "Sale Agreement", note: "MKUYU sells a property to a buyer.", client: "Buyer", icon: "home" },
  { type: "rent", title: "Renting", agreement: "Lease Agreement", note: "MKUYU lets a property to a tenant.", client: "Tenant", icon: "calendar" },
  { type: "sell", title: "Company and seller", agreement: "Property Sale Mandate", note: "A property owner sells through MKUYU.", client: "Seller", icon: "users" },
];
function contractKind(type) {
  return CONTRACT_KINDS.find((kind) => kind.type === type) || null;
}

function generateContractTypeBody(selected = "") {
  return `<div class="gen-type">
      <p class="field-help">What is this contract for? The system writes the matching agreement (introduction, the property and its title deed, price and payment, obligations, termination and signatures) and places it on the company's contract template. Longer agreements continue onto more pages, each carrying the template.</p>
      <div class="gen-type-grid" role="radiogroup" aria-label="Contract type">
        ${CONTRACT_KINDS.map((kind) => `<button type="button" class="gen-type-card${selected === kind.type ? " selected" : ""}" role="radio" aria-checked="${selected === kind.type}" data-action="contract-kind" data-kind="${kind.type}">
          <span class="gen-type-icon">${icon(kind.icon)}</span>
          <strong>${escapeHtml(kind.title)}</strong>
          <span class="gen-type-agreement">${escapeHtml(kind.agreement)}</span>
          <span class="gen-type-note">${escapeHtml(kind.note)}</span>
        </button>`).join("")}
      </div>
    </div>
    <div class="form-actions">
      <button class="btn" type="button" data-action="close-modal">Cancel</button>
    </div>`;
}

function renderGenerateContractModal() {
  const step = state.contractGen.step;
  const close = `<button class="close-btn" data-action="close-modal" aria-label="Close">${closeIcon()}</button>`;
  if (step === "type") {
    modal.innerHTML = `<div class="modal-head"><div><h2 class="modal-title">Generate contract</h2><p class="modal-sub">Choose the kind of agreement first.</p></div>${close}</div>${generateContractSteps("type")}<div class="modal-body">${generateContractTypeBody(state.contractGen.data?.deal_type || "")}</div>`;
    modal.dataset.type = "contract-generate";
    return;
  }
  if (step === "success") {
    modal.innerHTML = `<div class="modal-head"><div><h2 class="modal-title">Contract generated</h2><p class="modal-sub">The contract and its document are saved.</p></div>${close}</div>${generateContractSteps("success")}<div class="modal-body">${generateContractSuccessBody(state.contractGen.result || {})}</div>`;
    return;
  }
  const data = generateContractFormData();
  const body = step === "review" ? generateContractReviewBody(data) : generateContractFormBody();
  modal.innerHTML = `<div class="modal-head"><div><h2 class="modal-title">${step === "review" ? "Review contract" : "Generate contract"}</h2><p class="modal-sub">${step === "review" ? "Check everything before the document is created." : "Client, property, pricing and payment plan. The server calculates the final price."}</p></div>${close}</div>${generateContractSteps(step)}<div class="modal-body">${body}</div>`;
  modal.dataset.type = "contract-generate";
  if (step !== "review") markRequiredFields(modal);
}

/** Opens the overlay. Loading the template list is all that happens here. */
async function openGenerateContractModal(prefill = {}) {
  // The wizard starts by asking what the contract is for. A Sell request opens
  // it already set to Sell for that seller, straight on the details.
  state.contractGen = { step: prefill.deal_type ? "form" : "type", result: null, error: null, data: { ...prefill }, attachment: null };
  if (!state.contractTemplates) {
    // A caller without document access still gets the built-in template, so a
    // refusal here must not block contract generation.
    state.contractTemplates = await api("/contract-templates").catch(() => []);
  }
  modal.classList.add("modal-wide");
  renderGenerateContractModal();
  modalBackdrop.hidden = false;
  if (state.contractGen.step === "form") updateGenerateContractPreview();
}

/**
 * Hands the collected information to the server, which owns the whole flow:
 * pricing, the contract row, the template render, the document, the link and
 * the payment plan. `final_price` and `discount_amount` are deliberately NOT
 * sent - this form cannot dictate a price.
 */
async function submitGenerateContract() {
  const data = generateContractFormData();
  const hasPaymentPlan = data.payment_mode === "cash" || Boolean(data.deposit || data.installments || data.first_due_date);
  const payload = {
    client_id: data.client_id,
    client_name: data.client_name,
    project_id: data.deal_type === "rent" ? null : data.project_id,
    property_id: data.property_id,
    contract_type: data.contract_type,
    deal_type: data.deal_type,
    title_deed_number: data.title_deed_number,
    start_date: data.start_date,
    end_date: data.end_date,
    agreement_duration: data.agreement_duration,
    agreement_duration_unit: data.agreement_duration_unit,
    contract_date: data.contract_date,
    original_price: data.original_price,
    discount_pct: data.discount_pct,
    client_phone: data.client_phone,
    client_email: data.client_email,
    template_document_id: data.template_document_id,
    notes: data.notes,
  };
  if (hasPaymentPlan) {
    payload.payment_mode = data.payment_mode;
    payload.deposit = data.deposit;
    payload.installments = data.installments;
    payload.frequency = data.frequency;
    payload.first_due_date = data.first_due_date;
  }
  try {
    const result = await api("/contracts/generate", { method: "POST", body: JSON.stringify(payload) });
    let attachmentError = null;
    if (state.contractGen.attachment) {
      const file = state.contractGen.attachment;
      const attachment = new FormData();
      attachment.append("file", file);
      attachment.append("title", `Contract attachment - ${file.name}`.slice(0, 120));
      attachment.append("category", "other");
      attachment.append("status", "pending");
      attachment.append("contract_id", String(result.contract.id));
      try { await api("/documents/upload", { method: "POST", form: true, body: attachment }); }
      catch (error) { attachmentError = error.message || "The contract was generated, but its attachment could not be uploaded."; }
    }
    state.contractGen = { step: "success", result, error: null };
    renderGenerateContractModal();
    // The register must show the new contract without a manual refresh.
    state.listState.contracts = null;
    refresh();
    if (attachmentError) showToast(attachmentError);
  } catch (error) {
    showToast(error.message || "The contract could not be generated.");
    state.contractGen.step = "form";
    renderGenerateContractModal();
  }
}

function renderOrganization(section = "staff") {
  const org = state.organization;
  const permissions = org.me?.permissions || [];
  const canManage = permissions.includes("manage_permissions") || permissions.includes("manage_roles");
  const metrics = org.dashboard || {};
  const leadRows = org.leads.map((lead) => `<tr><td><strong>${escapeHtml(lead.name)}</strong><div class="table-sub">${escapeHtml(lead.email || lead.phone || "No contact")}</div></td><td>${badge(lead.status)}</td><td>${escapeHtml(lead.source || "Direct")}</td><td>${lead.client_id ? "Converted" : mayApproveClients() ? `<button class="btn btn-soft" data-action="convert-lead" data-id="${lead.id}">Become a client</button>` : ""}</td></tr>`).join("");
  // The staff register is grouped by DEPARTMENT, in the organization's declared
  // order, because that is the structure MKUYU actually runs on. A person's role
  // is shown inside their department as a badge - a role is never used as a
  // heading, so "Legal Officer" can never be mistaken for a department. Grouping
  // is derived from each user's real `departments`, so the display can never
  // disagree with the access model.
  // The six founding departments lead in this order; any department added later
  // follows alphabetically, so a new one shows up without a code change.
  const DEPARTMENT_ORDER = [
    "MANAGEMENT",
    "FINANCE & ACCOUNTS",
    "SALES, MARKETING & OPERATIONS",
    "ICT & ADMINISTRATION",
    "LEGAL",
    "CUSTOMER SERVICE",
  ];
  for (const department of [...org.departments].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    if (!DEPARTMENT_ORDER.includes(department.name)) DEPARTMENT_ORDER.push(department.name);
  }
  // Display names, so a demo does not read as a shouty constant.
  const DEPARTMENT_LABELS = {
    "MANAGEMENT": "Management",
    "FINANCE & ACCOUNTS": "Finance & Accounts",
    "SALES, MARKETING & OPERATIONS": "Sales, Marketing & Operations",
    "ICT & ADMINISTRATION": "ICT & Administration",
    "LEGAL": "Legal",
    "CUSTOMER SERVICE": "Customer Service",
  };

  // Mirrors the server's account guard: a staff administrator never manages the
  // administrator account, their own account, or anyone ranked above them.
  // Nobody resets or deactivates their own account from here (the server refuses it).
  const canManageAccount = (user) => (isAdmin() && user.id !== org.me?.user?.id) || (user.role !== "admin" && user.id !== org.me?.user?.id
    && Math.max(0, ...(user.roles || []).map((role) => Number(role.rank || 0))) <= Number(org.me?.rank || 0));
  const meId = org.me?.user?.id;
  const userRow = (user) => `<tr><td><strong>${escapeHtml(user.display_name)}</strong>${user.id === meId ? ` ${badge("You", "open")}` : ""}<div class="table-sub">${escapeHtml(user.email)}${(user.departments || []).length ? ` · ${escapeHtml((user.departments || []).map((d) => titleCase(d.name)).join(", "))}` : ""}</div></td><td>${user.roles?.map((role) => badge(role.name)).join(" ") || "No role"}</td><td>${user.active ? badge("Active", "approved") : badge("Inactive", "archived")}${user.password_reset_pending ? `<div class="table-sub">Password reset: waiting for them to choose a new one</div>` : ""}</td><td><div class="row-actions">${user.id === meId && isAdmin() ? `<button class="btn btn-gold btn-small" data-action="change-my-password" title="Change the administrator's own sign-in password">Change my password</button>` : ""}${canManageAccount(user) ? `<button class="btn btn-soft btn-small" data-action="reset-password" data-id="${user.id}" title="Set a new sign-in password without changing the account">Reset password</button>` : ""}${canManageAccount(user) || user.id === meId ? `<button class="btn btn-soft btn-small" data-action="change-staff-department" data-id="${user.id}" title="Move to another department">Move department</button><button class="btn btn-soft btn-small" data-action="change-staff-role" data-id="${user.id}" title="Give a different role">Change role</button>` : ""}${canManageAccount(user) ? `<button class="btn btn-soft btn-small" data-action="toggle-user" data-id="${user.id}" data-active="${user.active ? 0 : 1}">${user.active ? "Deactivate" : "Activate"}</button>` : ""}</div></td></tr>`;

  const usersByDepartment = new Map(DEPARTMENT_ORDER.map((name) => [name, []]));
  const unassigned = [];
  for (const user of org.users) {
    const names = (user.departments || []).map((department) => department.name);
    // A person in more than one department appears under each, which is what
    // "multiple roles and departments per person" means.
    const matched = names.filter((name) => usersByDepartment.has(name));
    if (!matched.length) { unassigned.push(user); continue; }
    for (const name of matched) usersByDepartment.get(name).push(user);
  }
  // Highest rank first so the department manager reads before the officers.
  const byRank = (a, b) => Math.max(...(a.roles || []).map((r) => Number(r.rank || 0)), 0) - Math.max(...(b.roles || []).map((r) => Number(r.rank || 0)), 0)
    || String(a.display_name).localeCompare(String(b.display_name));

  const activeDepartmentNames = new Set(org.departments.filter((d) => d.active !== false).map((d) => d.name));
  const departmentGroups = DEPARTMENT_ORDER.filter((name) => usersByDepartment.get(name).length || activeDepartmentNames.has(name))
    .map((name) => {
      const members = usersByDepartment.get(name).slice().sort(byRank);
      if (!members.length) return `<div class="dept-group" data-department="${escapeHtml(name)}">
        <div class="dept-group-head"><span class="dept-group-name">${escapeHtml(DEPARTMENT_LABELS[name] || titleCase(name))}</span><span class="dept-group-count">No staff yet</span></div>
        <p class="muted" style="margin:.4rem 0 0">Add a staff member above and choose this department.</p>
      </div>`;
      return `<div class="dept-group" data-department="${escapeHtml(name)}">
        <div class="dept-group-head"><span class="dept-group-name">${escapeHtml(DEPARTMENT_LABELS[name] || titleCase(name))}</span><span class="dept-group-count">${members.length} ${members.length === 1 ? "person" : "people"}</span></div>
        <div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>${members.map(userRow).join("")}</tbody></table></div>
      </div>`;
    }).join("");

  // Anyone outside the six departments is still shown, so nothing is hidden.
  const unassignedBlock = unassigned.length
    ? `<div class="dept-group" data-department="UNASSIGNED"><div class="dept-group-head"><span class="dept-group-name">No department</span><span class="dept-group-count">${unassigned.length} ${unassigned.length === 1 ? "person" : "people"}</span></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>${unassigned.map(userRow).join("")}</tbody></table></div></div>`
    : "";

  const userRows = departmentGroups + unassignedBlock;
  const activityRows = (metrics.activity || org.audit).slice(0, 8).map((entry) => `<tr><td>${escapeHtml(entry.user_name || "System")}</td><td>${escapeHtml(entry.action)}</td><td>${escapeHtml(entry.module)}</td><td>${formatDate(entry.created_at, true)}</td></tr>`).join("");
  const followUpRows = org.followUps.slice(0, 6).map((item) => `<tr><td>${escapeHtml(item.follow_up_type || "Follow-up")}</td><td>${formatDate(item.due_at)}</td><td>${badge(item.status)}</td><td>${escapeHtml(item.outcome || "Pending")}</td></tr>`).join("");
  const approvalRows = org.approvals.slice(0, 8).map((item) => `<tr><td><strong>${escapeHtml(item.module)}</strong><div class="table-sub">Requested by ${escapeHtml(item.requested_by_name || "System")}</div></td><td>#${item.record_id}</td><td>${badge(item.status)}</td><td>${item.decided_at ? `${escapeHtml(item.decided_by_name || "Reviewer")} · ${formatDate(item.decided_at, true)}` : "Awaiting decision"}</td><td>${item.status === "pending" && permissions.includes("approve") ? `<div class="row-actions"><button class="btn btn-soft btn-small" data-action="decide-approval" data-id="${item.id}" data-status="approved">Approve</button><button class="btn btn-danger btn-small" data-action="decide-approval" data-id="${item.id}" data-status="rejected">Reject</button></div>` : ""}</td></tr>`).join("");
  const SCOPE_LABELS = { own: "Own records", department: "Department", organization: "Whole organization" };
  // Offer only what the server would accept from this caller. The administrator
  // account may do anything; a staff administrator (ICT) works at or below their
  // own rank, on custom roles only, and never hands out the reserved keys.
  const myRank = Number(org.me?.rank || 0);
  const assignable = (role) => role.active !== false && role.name !== "System Administrator" && (isAdmin() || Number(role.rank || 0) <= myRank);
  const editableRole = (role) => isAdmin() || (!role.system_role && Number(role.rank || 0) <= myRank);
  const RESERVED_KEYS = new Set(["manage_users", "manage_roles", "manage_permissions", "manage_settings", "view_audit", "approve_management", "approve_legal", "validate_finance"]);
  const roleOptions = org.roles.filter(editableRole).map((role) => `<option value="${role.id}" data-rank="${Number(role.rank || 0)}" data-permissions="${escapeHtml(JSON.stringify(role.permissions || []))}">${escapeHtml(role.name)} · rank ${Number(role.rank || 0)} · ${role.permission_count || 0} privileges</option>`).join("");
  const staffRoleOptions = org.roles.filter(assignable).map((role) => `<option value="${role.id}">${escapeHtml(role.name)} · rank ${Number(role.rank || 0)}</option>`).join("");
  const departmentOptions = org.departments.filter((department) => department.active !== false).map((department) => `<option value="${department.id}">${escapeHtml(titleCase(department.name))}</option>`).join("");
  const permissionOptions = org.permissions.filter((permission) => isAdmin() || !RESERVED_KEYS.has(permission.permission_key)).map((permission) => `<label class="check-field"><input type="checkbox" name="permissions" value="${escapeHtml(permission.permission_key)}">${escapeHtml(permission.permission_key)}</label>`).join("");
  const staffForm = `<form id="staff-form" class="form-grid"><div class="field"><label for="staff-name">Display name</label><input id="staff-name" name="display_name" required placeholder="Staff member"></div><div class="field"><label for="staff-email">Email</label><input id="staff-email" name="email" type="email" required placeholder="staff@company.com"></div><div class="field"><label for="staff-password">Temporary password</label><input id="staff-password" name="password" type="password" minlength="8" required placeholder="At least 8 characters"></div><div class="field"><label for="staff-role">Role and privilege rank</label><select id="staff-role" name="role_ids" required><option value="">Select role</option>${staffRoleOptions}</select></div><div class="field"><label for="staff-department">Department</label><select id="staff-department" name="department_ids"><option value="">The role's own department</option>${departmentOptions}</select></div><button class="btn btn-primary" type="submit">Create staff</button></form>`;
  const mayAdminister = canManage || permissions.includes("manage_users");

  // Departments page: every department (A-Z) with its staff behind "Show staff".
  if (section === "departments") {
    return `<div class="section-grid org-grid admin-pages">
      ${mayAdminister ? renderAdminConsole(org, { canManage, canAddStaff: false, canAddToDepartment: permissions.includes("manage_users"), userRow }) : `<section class="card glass">${emptyState("No access", "Departments are managed by the administrator.", { iconName: "settings", compact: true })}</section>`}
    </div>`;
  }

  // Staff page: everyone A-Z, with department, role and the account actions.
  const staffAlphabetical = org.users.slice().sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
  const staffRegister = mayAdminister ? `<section class="card glass"><div class="section-head"><div><h2 class="section-title">Staff</h2><div class="section-note">${org.users.filter((u) => u.active).length} active · ${org.users.length} in total · A to Z</div></div></div>
      ${permissions.includes("manage_users") ? `<details class="panel add-panel"><summary>${icon("plus")}Add a staff member</summary>${staffForm}</details>` : ""}
      <div class="table-wrap" style="margin-top:14px"><table><thead><tr><th>Name · department</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>${staffAlphabetical.map(userRow).join("")}</tbody></table></div>
    </section>` : "";
  const accessMapSection = `<section class="card glass"><div class="section-head"><div><h2 class="section-title">Roles</h2><div class="section-note">${org.roles.length} roles · highest rank first · a person's access is the sum of their role's permissions, limited to its data scope</div></div></div>
      <div class="table-wrap"><table><thead><tr><th>Role</th><th>Rank</th><th>Scope</th><th>Permissions</th></tr></thead><tbody>${org.roles.map((role) => `<tr><td><strong>${escapeHtml(role.name)}</strong>${role.system_role ? `<div class="table-sub">System role</div>` : ""}</td><td>${badge(`Rank ${Number(role.rank || 0)}`, "neutral")}</td><td>${escapeHtml(SCOPE_LABELS[role.scope] || role.scope || "—")}</td><td>${(role.permissions || []).length} · <span class="table-sub">${escapeHtml((role.permissions || []).join(", "))}</span></td></tr>`).join("") || `<tr><td colspan="4" class="empty">No roles</td></tr>`}</tbody></table></div>
      ${canManage ? `<details class="panel add-panel" style="margin-top:14px"><summary>${icon("plus")}Add a role</summary><div class="form-grid"><div class="field"><label for="org-role">New role</label><input id="org-role" data-org-field="role" placeholder="Role name"></div><div class="field"><label for="org-role-rank">Role rank</label><input id="org-role-rank" data-org-field="role-rank" type="number" min="0" max="100" value="20" placeholder="20"></div><div class="field"><label for="org-role-scope">Data scope</label><select id="org-role-scope" data-org-field="role-scope"><option value="own">Own records only</option><option value="department">Department records</option><option value="organization">Whole organization</option></select></div><button class="btn btn-primary" data-action="create-role">Add role</button></div></details>
      <details class="panel add-panel" style="margin-top:10px"><summary>${icon("settings")}Change a role's permissions, rank or scope</summary><div class="form-grid"><div class="field"><label for="org-role-select">Role</label><select id="org-role-select" data-org-field="role-id"><option value="">Select role</option>${roleOptions}</select></div><div class="field"><label for="org-role-rank-edit">Rank</label><input id="org-role-rank-edit" data-org-field="role-rank-edit" type="number" min="0" max="100" value="0" placeholder="20"></div><div class="field"><label for="org-role-scope-edit">Data scope</label><select id="org-role-scope-edit" data-org-field="role-scope-edit"><option value="">Keep current</option><option value="own">Own records only</option><option value="department">Department records</option><option value="organization">Whole organization</option></select></div><div class="field full check-grid">${permissionOptions}</div><button class="btn btn-gold" data-action="save-role-permissions">Save role permissions</button><button class="btn btn-soft" data-action="save-role-rank">Save role rank</button></div></details>` : ""}
    </section>`;

  // Roles & permissions page.
  if (section === "roles") {
    return `<div class="section-grid org-grid admin-pages">${accessMapSection}</div>`;
  }

  // System & backups page (administrator account only): who did what, who owns
  // which record, and copies of the whole workspace.
  if (section === "system") {
    const backups = state.backups;
    const backupRows = (backups?.list || []).slice(0, 10).map((entry) => `<tr><td><strong>${escapeHtml(entry.name)}</strong>${entry.automatic ? ` ${badge("Automatic", "neutral")}` : ""}</td><td>${escapeHtml(entry.format === "json" ? "JSON snapshot" : "PostgreSQL dump")}</td><td>${(Number(entry.size || 0) / 1048576).toFixed(1)} MB</td><td>${formatDateTime(entry.created_at, true)}</td><td class="align-right"><div class="row-actions"><button class="btn btn-soft btn-small" data-action="download-backup" data-name="${escapeHtml(entry.name)}">Download</button><button class="btn btn-danger btn-small" data-action="delete-backup" data-name="${escapeHtml(entry.name)}">Delete</button></div></td></tr>`).join("");
    const fullActivity = (org.audit || []).slice(0, 50).map((entry) => `<tr><td>${escapeHtml(entry.user_name || "System")}</td><td>${escapeHtml(entry.action)}</td><td>${escapeHtml(entry.module)}${entry.record_id ? ` #${escapeHtml(String(entry.record_id))}` : ""}</td><td>${formatDate(entry.created_at, true)}</td></tr>`).join("");
    return `<div class="section-grid org-grid admin-pages">
      <section class="card glass"><div class="section-head"><div><h2 class="section-title">Backups</h2><div class="section-note">${backups?.error ? escapeHtml(backups.error) : `${(backups?.list || []).length} backup${(backups?.list || []).length === 1 ? "" : "s"} kept on the server${(backups?.list || []).length > 10 ? " · the 10 newest are listed" : ""} · make one before any big change`}</div></div><button class="btn btn-primary btn-small" data-action="backup-now">Create backup</button></div>
        ${autoBackupNote(backups?.status)}
        ${backupRows ? `<div class="table-wrap"><table><thead><tr><th>File</th><th>Type</th><th>Size</th><th>Made</th><th class="align-right">Actions</th></tr></thead><tbody>${backupRows}</tbody></table></div>` : `<div class="empty">${backups ? "No backup yet." : "Loading…"}</div>`}
      </section>
      <section class="card glass"><div class="section-head"><div><h2 class="section-title">Activity log</h2><div class="section-note">The latest 50 recorded actions, newest first · read-only</div></div></div><div class="table-wrap"><table><thead><tr><th>User</th><th>Action</th><th>Module</th><th>When</th></tr></thead><tbody>${fullActivity || `<tr><td colspan="4" class="empty">No activity recorded</td></tr>`}</tbody></table></div></section>
      <section class="card glass"><div class="section-head"><div><h2 class="section-title">Record ownership</h2><div class="section-note">Records from before ownership existed: give each an owner and a department so the right people see it</div></div><button class="btn btn-soft btn-small" data-action="reload-allocation">${state.allocationUnassigned === false ? "Unassigned only" : "Show all"}</button></div>${renderAllocation(state.allocationEntity || "client")}</section>
    </div>`;
  }

  // What the administrator should look at first: people who cannot work yet.
  const noDepartment = org.users.filter((u) => u.active && !(u.departments || []).length);
  const noRole = org.users.filter((u) => u.active && u.role !== "admin" && !(u.roles || []).length);
  const todo = [
    noDepartment.length ? `<li><strong>${noDepartment.length}</strong> active ${noDepartment.length === 1 ? "person has" : "people have"} no department: ${escapeHtml(noDepartment.map((u) => u.display_name).slice(0, 4).join(", "))}${noDepartment.length > 4 ? "…" : ""} <button class="btn btn-soft btn-small" data-action="open-alert-view" data-view="departments">Place them</button></li>` : "",
    noRole.length ? `<li><strong>${noRole.length}</strong> active ${noRole.length === 1 ? "person has" : "people have"} no role, so they can open nothing: ${escapeHtml(noRole.map((u) => u.display_name).slice(0, 4).join(", "))}${noRole.length > 4 ? "…" : ""}. Use Change role below.</li>` : "",
  ].filter(Boolean);
  const intro = `<section class="card glass org-intro"><div><div class="eyebrow">${isSystemAdminOnly() ? "System administration" : "Staff administration"}</div><h2>Staff</h2><p>${isSystemAdminOnly()
    ? "Your job: staff accounts (this page), departments, roles & permissions, contract templates, and the system itself (backups, activity, record ownership). Business work - contracts, clients, money - stays with the departments."
    : "Staff accounts, roles and access. Departments have their own page."}</p>
    ${todo.length ? `<ul class="admin-todo">${todo.join("")}</ul>` : `<p class="muted" style="margin:.4rem 0 0">Everyone active has a role and a department.</p>`}</div>
    <div class="org-intro-stats"><span><strong>${org.users.filter((user) => user.active).length}</strong> active staff</span><span><strong>${(org.departments || []).filter((d) => d.active !== false).length}</strong> departments</span><span><strong>${org.roles.length}</strong> roles</span></div></section>`;
  return `<div class="section-grid org-grid admin-pages">
    ${intro}
    ${staffRegister}
    ${canSeeFinancial() && canModule("reports") ? `<section class="card glass"><div class="section-head"><div><h2 class="section-title">Management overview</h2><div class="section-note">Live organization records and financial position</div></div></div><div class="metric-grid"><div class="metric"><span>Projects</span><strong>${metrics.projects ?? 0}</strong></div><div class="metric"><span>Properties</span><strong>${metrics.properties ?? 0}</strong></div><div class="metric"><span>Available</span><strong>${metrics.available_properties ?? 0}</strong></div><div class="metric"><span>Clients</span><strong>${metrics.clients ?? 0}</strong></div><div class="metric"><span>Leads</span><strong>${metrics.leads ?? 0}</strong></div><div class="metric"><span>Contracts</span><strong>${metrics.contracts ?? 0}</strong></div><div class="metric"><span>Income</span><strong>${money(metrics.payments)}</strong></div><div class="metric"><span>Outstanding</span><strong>${money(metrics.outstanding)}</strong></div><div class="metric"><span>Overdue</span><strong>${money(metrics.overdue)}</strong></div></div></section>` : ""}
    ${canModule("leads") ? `<section class="card glass"><div class="section-head"><div><h2 class="section-title">Lead intake</h2><div class="section-note">Sales and marketing queue</div></div></div><form id="lead-form" class="form-grid"><div class="field"><label for="lead-name">Name</label><input id="lead-name" name="name" required placeholder="Customer inquiry"></div><div class="field"><label for="lead-contact">Email</label><input id="lead-contact" name="email" type="email" placeholder="customer@example.com"></div><div class="field"><label for="lead-source">Source</label><input id="lead-source" name="source" placeholder="Public website"></div><button class="btn btn-primary" type="submit">Add lead</button></form><div class="table-wrap" style="margin-top:18px"><table><thead><tr><th>Lead</th><th>Status</th><th>Source</th><th>Next</th></tr></thead><tbody>${leadRows || `<tr><td colspan="4" class="empty">No leads yet</td></tr>`}</tbody></table></div></section>` : ""}
    ${canModule("follow_ups") ? `<section class="card glass"><div class="section-head"><div><h2 class="section-title">Follow-up desk</h2><div class="section-note">Sales, service, and collections activity</div></div></div><form id="follow-up-form" class="form-grid"><div class="field"><label for="follow-up-date">Due date</label><input id="follow-up-date" name="due_at" type="datetime-local" required></div><div class="field"><label for="follow-up-type">Type</label><select id="follow-up-type" name="follow_up_type"><option value="call">Call</option><option value="meeting">Meeting</option><option value="visit">Visit</option><option value="message">Message</option></select></div><div class="field"><label for="follow-up-notes">Notes</label><input id="follow-up-notes" name="notes" placeholder="Next action"></div><button class="btn btn-primary" type="submit">Schedule follow-up</button></form><div class="table-wrap" style="margin-top:16px"><table><thead><tr><th>Type</th><th>Due</th><th>Status</th><th>Outcome</th></tr></thead><tbody>${followUpRows || `<tr><td colspan="4" class="empty">No follow-ups yet</td></tr>`}</tbody></table></div></section>` : ""}
    ${permissions.includes("view_financial") ? `<section class="card glass"><div class="section-head"><div><h2 class="section-title">Collections pulse</h2><div class="section-note">Outstanding and due soon</div></div></div><div class="metric-grid"><div class="metric"><span>Outstanding</span><strong>${org.collections?.outstanding?.length || 0}</strong></div><div class="metric"><span>Overdue</span><strong>${org.collections?.overdue?.length || 0}</strong></div><div class="metric"><span>Due soon</span><strong>${org.collections?.due_soon?.length || 0}</strong></div><div class="metric"><span>Open follow-ups</span><strong>${org.collections?.follow_ups?.length || 0}</strong></div></div></section>` : ""}
    ${isAdmin() ? "" : `<section class="card glass"><div class="section-head"><div><h2 class="section-title">Activity</h2><div class="section-note">Recorded organization actions</div></div></div><div class="table-wrap"><table><thead><tr><th>User</th><th>Action</th><th>Module</th><th>When</th></tr></thead><tbody>${activityRows || `<tr><td colspan="4" class="empty">No activity recorded</td></tr>`}</tbody></table></div></section>`}
    ${permissions.includes("approve") ? `<section class="card glass"><div class="section-head"><div><h2 class="section-title">Approvals</h2><div class="section-note">Contracts, documents, and financial decisions</div></div></div><div class="table-wrap"><table><thead><tr><th>Module</th><th>Record</th><th>Status</th><th>Decision</th><th>Action</th></tr></thead><tbody>${approvalRows || `<tr><td colspan="5" class="empty">No approval requests</td></tr>`}</tbody></table></div></section>` : ""}
  </div>`;
}

/**
 * The administration console: every department, its staff (behind "Show
 * staff") and its client count, with the actions an administrator has -
 * reset password, activate/deactivate, change role, move department - and the
 * department's own rename / deactivate / delete. Core departments are fixed.
 */
function renderAdminConsole(org, { canManage, canAddStaff, canAddToDepartment = false, userRow, staffForm = "" }) {
  const open = state.openDepartments || (state.openDepartments = new Set());
  const members = (dept) => org.users.filter((u) => (u.departments || []).some((d) => Number(d.id) === Number(dept.id)));
  // A to Z: staff by name, departments by name.
  const byName = (a, b) => String(a.display_name).localeCompare(String(b.display_name));
  const staffTable = (list) => `<div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>${list.slice().sort(byName).map(userRow).join("")}</tbody></table></div>`;
  const blocks = (org.departments || []).slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((d) => {
      const people = members(d);
      const active = people.filter((u) => u.active).length;
      const isOpen = open.has(Number(d.id));
      const deptActions = !canManage || d.core ? "" : [
        `<button class="btn btn-soft btn-small" data-action="rename-department" data-id="${d.id}">Rename</button>`,
        d.active === false
          ? `<button class="btn btn-soft btn-small" data-action="toggle-department" data-id="${d.id}" data-active="1">Activate</button>`
          : `<button class="btn btn-soft btn-small" data-action="toggle-department" data-id="${d.id}" data-active="0"${active ? ` disabled title="Move its staff to another department first"` : ""}>Deactivate</button>`,
        Number(d.all_members || 0) ? "" : `<button class="btn btn-danger btn-small" data-action="delete-department" data-id="${d.id}">Delete</button>`,
      ].join("");
      // Add staff: only where the department has a default role (not Management) and is active.
      const addStaff = canAddToDepartment && d.active !== false && d.default_role
        ? `<button class="btn btn-gold btn-small" data-action="add-department-staff" data-id="${d.id}" title="New account for this department · role: ${escapeHtml(d.default_role)}">${icon("plus")}Add staff</button>` : "";
      return `<div class="dept-group" data-department="${escapeHtml(d.name)}">
        <div class="dept-group-head" style="flex-wrap:wrap;gap:.6rem">
          <span class="dept-group-name">${escapeHtml(titleCase(d.name))}</span>
          ${d.core ? badge("Core", "neutral") : ""}${d.active === false ? badge("Inactive", "archived") : ""}
          <span class="dept-group-count">${active} staff · ${Number(d.client_count || 0)} client${Number(d.client_count || 0) === 1 ? "" : "s"}</span>
          <span class="row-actions" style="margin-left:auto">${addStaff}${deptActions}<button class="btn btn-small${isOpen ? "" : " btn-primary"}" data-action="toggle-dept-staff" data-id="${d.id}" aria-expanded="${isOpen}">${isOpen ? "Hide staff" : `Show staff (${people.length})`}</button></span>
        </div>
        ${isOpen ? (people.length ? staffTable(people) : `<p class="muted" style="margin:.5rem 0 0">No staff yet. ${d.default_role ? "Press Add staff above." : "Add one on the Staff page and choose this department."}</p>`) : ""}
      </div>`;
    }).join("");
  const loose = org.users.filter((u) => !(u.departments || []).length);
  const looseBlock = loose.length ? `<div class="dept-group"><div class="dept-group-head"><span class="dept-group-name">No department</span><span class="dept-group-count">${loose.length} to place</span></div>${staffTable(loose)}</div>` : "";
  return `<section class="card glass"><div class="section-head"><div><h2 class="section-title">Departments</h2><div class="section-note">${(org.departments || []).filter((d) => d.active !== false).length} departments · ${org.users.filter((u) => u.active).length} active staff · A to Z · press Show staff to see who is in each</div></div></div>
    <div class="form-grid">
      ${canManage ? `<div class="field"><label for="dept-new-name">New department</label><input id="dept-new-name" data-org-field="department" maxlength="80" placeholder="e.g. Property Management"></div><button class="btn btn-primary" data-action="create-department">Create department</button>` : ""}
    </div>
    ${canAddStaff ? `<details class="panel add-panel" style="margin-top:14px"><summary>${icon("plus")}Add a staff member</summary>${staffForm}</details>` : ""}
    <div style="margin-top:16px">${blocks}${looseBlock}</div>
  </section>`;
}

function openStaffRole(userId) {
  const org = state.organization;
  const user = (org.users || []).find((row) => String(row.id) === String(userId));
  if (!user) return;
  const self = user.id === org.me?.user?.id;
  const myRank = Number(org.me?.rank || 0);
  const current = new Set((user.roles || []).map((r) => Number(r.id)));
  const options = (org.roles || [])
    .filter((role) => role.active !== false && role.name !== "System Administrator" && (isAdmin() || Number(role.rank || 0) <= myRank))
    .map((role) => `<option value="${role.id}"${current.has(Number(role.id)) ? " selected" : ""}>${escapeHtml(role.name)} · rank ${Number(role.rank || 0)}</option>`).join("");
  openSmallForm(self ? "Change your role" : `Role for ${user.display_name}`,
    self ? "You can move yourself between system-administration roles; a business role must be given by another administrator." : "Their access changes at once. One role per person.",
    `<div class="field full"><label for="staff-role-select">Role <span class="req">*</span></label><select id="staff-role-select" name="role_id" required>${options}</select></div>`,
    "Save role",
    async (data) => {
      await api(`/org/users/${user.id}/roles`, { method: "PUT", body: { role_ids: [Number(data.role_id)] } });
      return "Role updated.";
    });
}

/** Small modal with one form; `onSubmit` receives the form data. */
function openSmallForm(heading, note, fieldsHtml, submitLabel, onSubmit) {
  modal.dataset.type = "small-form";
  modal.innerHTML = `<div class="modal-head"><div><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(note)}</p></div><button class="close-btn" data-action="close-modal" aria-label="Close">${closeIcon()}</button></div>
    <form id="small-form" class="form-grid">${fieldsHtml}<div class="form-actions full"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">${escapeHtml(submitLabel)}</button></div></form>`;
  state.smallFormSubmit = onSubmit;
  modalBackdrop.hidden = false;
}

function openStaffDepartment(userId) {
  const user = (state.organization.users || []).find((row) => String(row.id) === String(userId));
  if (!user) return;
  const current = new Set((user.departments || []).map((d) => Number(d.id)));
  const options = (state.organization.departments || []).filter((d) => d.active !== false)
    .map((d) => `<option value="${d.id}"${current.has(Number(d.id)) ? " selected" : ""}>${escapeHtml(titleCase(d.name))}</option>`).join("");
  openSmallForm(`Department for ${user.display_name}`, "They will appear under this department everywhere: staff lists, assignments and hand-offs.",
    `<div class="field full"><label for="staff-dept-select">Department <span class="req">*</span></label><select id="staff-dept-select" name="department_id" required>${options}</select></div>`,
    "Save department",
    async (data) => {
      await api(`/org/users/${user.id}/departments`, { method: "PUT", body: JSON.stringify({ department_ids: [Number(data.department_id)] }) });
      return "Department updated.";
    });
}

/** The administrator's own password: current one first, the new one twice. */
function openChangeMyPassword() {
  openSmallForm("Change my password", "Your other signed-in devices are signed out. This browser stays signed in.",
    `<div class="field full"><label for="my-current-password">Current password <span class="req">*</span></label><input id="my-current-password" name="current_password" type="password" required autocomplete="current-password"></div>
     <div class="field full"><label for="my-new-password">New password <span class="req">*</span></label><input id="my-new-password" name="new_password" type="password" minlength="8" maxlength="128" required autocomplete="new-password" placeholder="At least 8 characters"></div>
     <div class="field full"><label for="my-new-password-again">New password again <span class="req">*</span></label><input id="my-new-password-again" name="new_password_again" type="password" minlength="8" maxlength="128" required autocomplete="new-password"></div>`,
    "Change password",
    async (data) => {
      if (data.new_password !== data.new_password_again) throw new Error("The two new passwords do not match.");
      await api("/org/me/password", { method: "PUT", body: JSON.stringify({ current_password: data.current_password, new_password: data.new_password }) });
      return "Password changed. Use the new one next time you sign in.";
    });
}

/** New account straight into one department: name, email and password only. */
function openAddDepartmentStaff(deptId) {
  const dept = (state.organization.departments || []).find((d) => String(d.id) === String(deptId));
  if (!dept) return;
  openSmallForm(`Add staff to ${titleCase(dept.name)}`, `They sign in straight into ${titleCase(dept.name)} as ${dept.default_role}. You can change the role later on the Staff page.`,
    `<div class="field full"><label for="dept-staff-name">Name</label><input id="dept-staff-name" name="display_name" maxlength="80" placeholder="e.g. Amina Sanga"></div>
     <div class="field full"><label for="dept-staff-email">Email (they sign in with it) <span class="req">*</span></label><input id="dept-staff-email" name="email" type="email" required maxlength="160" autocomplete="off" placeholder="name@gmail.com"></div>
     <div class="field full"><label for="dept-staff-password">Password <span class="req">*</span></label><input id="dept-staff-password" name="password" type="password" minlength="8" maxlength="128" required autocomplete="new-password" placeholder="At least 8 characters"></div>`,
    "Add staff",
    async (data) => {
      await api(`/org/departments/${dept.id}/staff`, { method: "POST", body: JSON.stringify(data) });
      state.openDepartments = state.openDepartments || new Set();
      state.openDepartments.add(Number(dept.id));
      return `Staff added to ${titleCase(dept.name)}.`;
    });
}

function openRenameDepartment(deptId) {
  const dept = (state.organization.departments || []).find((d) => String(d.id) === String(deptId));
  if (!dept) return;
  openSmallForm("Rename department", "The staff in it stay where they are.",
    `<div class="field full"><label for="dept-rename">Name <span class="req">*</span></label><input id="dept-rename" name="name" required maxlength="80" value="${escapeHtml(titleCase(dept.name))}"></div>`,
    "Save name",
    async (data) => {
      await api(`/org/departments/${dept.id}`, { method: "PUT", body: JSON.stringify({ name: data.name }) });
      return "Department renamed.";
    });
}

async function openRequestOutcome(taskId) {
  let task = (state.tasks || []).find((row) => String(row.id) === String(taskId));
  if (!task) { try { task = await api(`/org/tasks/${taskId}`); } catch (error) { showToast(error.message || "Unable to open this task."); return; } }
  const choices = Object.entries(REQUEST_OUTCOMES).map(([value, label]) => `<label class="check-field"><input type="radio" name="outcome" value="${value}" required> ${escapeHtml(label)}</label>`).join("");
  openSmallForm(`Outcome for ${task.request_customer || "the customer"}`, "Sales is notified at once and approves your report.",
    `<div class="field full"><span class="toolbar-label">What happened? <span class="req">*</span></span>${choices}</div>
     <div class="field" data-appointment hidden><label for="outcome-date">Appointment date <span class="req">*</span></label><input id="outcome-date" name="appointment_date" type="date" min="${today()}"></div>
     <div class="field" data-appointment hidden><label for="outcome-time">Appointment time <span class="req">*</span></label><input id="outcome-time" name="appointment_time" type="time" step="900"></div>
     <div class="field" data-appointment hidden><label for="outcome-type">Type</label><select id="outcome-type" name="appointment_type"><option value="viewing">Viewing</option><option value="meeting">Meeting</option><option value="call">Call</option></select></div>
     <div class="field full"><label for="outcome-note">Note for Sales <span class="req">*</span> <span class="muted" data-note-hint></span></label><textarea id="outcome-note" name="note" rows="3" maxlength="2000" required placeholder="What did the customer say? What happens next?"></textarea><p class="muted" style="margin:.3rem 0 0">Sales reads this note before approving your report.</p></div>`,
    "Send to Sales",
    async (data) => {
      const body = { outcome: data.outcome, note: data.note || null };
      if (data.outcome === "appointment") {
        if (!data.appointment_date) throw new Error("Choose the appointment date.");
        if (!data.appointment_time) throw new Error("Choose the appointment time agreed with the customer.");
        body.appointment_at = new Date(`${data.appointment_date}T${data.appointment_time}`).toISOString();
        body.appointment_type = data.appointment_type || "viewing";
      }
      if (data.outcome === "declined" && !data.note) throw new Error("Say why the customer declined.");
      if (!String(data.note || "").trim()) throw new Error("Write a note for Sales: what did the customer say?");
      await api(`/org/tasks/${taskId}/outcome`, { method: "POST", body: JSON.stringify(body) });
      state.tasks = null;
      state.tasksRequested = false;
      await refreshAttention();
      return "Outcome sent to Sales.";
    });
  const form = document.getElementById("small-form");
  form?.addEventListener("change", (event) => {
    if (event.target.name !== "outcome") return;
    const appointment = event.target.value === "appointment";
    form.querySelectorAll("[data-appointment]").forEach((el) => { el.hidden = !appointment; });
    form.querySelectorAll('[name="appointment_date"], [name="appointment_time"]').forEach((field) => { field.required = appointment; });
    const hint = form.querySelector("[data-note-hint]");
    if (hint) hint.textContent = event.target.value === "declined" ? "(required: why?)" : "";
    const note = form.querySelector('[name="note"]');
    if (note) note.required = event.target.value === "declined";
  });
}

/** One card per department: its roles, and every duty declared against each. */
function renderDepartmentCards(departments) {
  return (departments || []).map((department) => {
    const roles = department.roles.map((entry) => {
      const duties = entry.duties.map((duty) => `
        <li class="duty${duty.approvalDuty ? " duty-approval" : ""}">
          <div class="duty-head">
            <span class="duty-label">${escapeHtml(duty.label)}</span>
            ${duty.approvalDuty ? `<span class="duty-tag">Approval</span>` : ""}
            ${duty.yours ? `<span class="duty-tag duty-tag-yours">Yours</span>` : ""}
          </div>
          <p class="duty-note">${escapeHtml(duty.description || "")}</p>
          <div class="duty-perms">${duty.permissionLabels.map((permission) => `<code>${escapeHtml(permission.label)}</code>`).join("")}</div>
        </li>`).join("");
      return `
        <div class="role">
          <div class="role-head">
            <h3 class="role-name">${escapeHtml(entry.role)}</h3>
            <span class="role-count">${entry.dutyCount} ${entry.dutyCount === 1 ? "duty" : "duties"}</span>
          </div>
          <ul class="duty-list">${duties || `<li class="duty-note">No duties recorded for this role.</li>`}</ul>
        </div>`;
    }).join("");
    return `
      <section class="card glass dept">
        <div class="section-head">
          <div>
            <h2 class="section-title">${escapeHtml(department.name)}</h2>
            <div class="section-note">${department.roles.length} ${department.roles.length === 1 ? "role" : "roles"} · ${department.dutyCount} duties</div>
          </div>
        </div>
        <div class="role-list">${roles}</div>
      </section>`;
  }).join("");
}

/**
 * The approval path and the duty catalogue.
 *
 * The stage rail shows the order a contract moves through and which department
 * decides each step. A step the signed-in caller personally holds is marked
 * "Your decision" - that highlight comes from the caller's own permissions, and
 * the buttons to act still come from each contract's server-computed
 * `available_actions`, so nothing here can be used to approve anything.
 */
function renderDuties() {
  const data = state.duties;
  if (!data) {
    return `<div class="card glass empty"><strong>Loading the organization handbook…</strong>Fetching duties and the approval path.</div>`;
  }
  if (data.error) {
    return `<div class="card glass empty"><strong>Duties could not be loaded</strong>${escapeHtml(data.error)}</div>`;
  }

  const { workflow, departments, totals } = data;
  const yourStages = (workflow.stages || []).filter((stage) => stage.yours);
  const approvalOwners = new Map(Object.entries(workflow.ownership || {}).map(([key, owners]) => [key, owners.join(" · ")]));

  const stageRail = (workflow.stages || []).map((stage) => `
    <li class="flow-step${stage.yours ? " is-yours" : ""}">
      <div class="flow-step-head">
        <span class="flow-step-index">${stage.stage}</span>
        <span class="flow-step-title">${escapeHtml(stage.label)}</span>
        ${stage.yours ? `<span class="flow-yours">Your decision</span>` : ""}
      </div>
      <p class="flow-step-note">${escapeHtml(stage.note)}</p>
      <div class="flow-step-meta">
        <span class="flow-owner" title="Owns this step">Held by ${escapeHtml(stage.owner || "")}</span>
        ${stage.actor && stage.actor !== stage.owner ? `<span class="flow-actor">Moved by ${escapeHtml(stage.actor)}</span>` : ""}
        <code class="flow-perm">${escapeHtml(stage.permission || "")}</code>
      </div>
    </li>`).join("");

  const exceptionList = (workflow.exceptions || []).map((entry) => `
    <li class="flow-exception">
      <span class="flow-exception-name">${escapeHtml(entry.label)}</span>
      <span class="flow-exception-note">${escapeHtml(entry.note)}</span>
    </li>`).join("");

  const yourApprovalCards = (data.yourApprovals || []).map((key) => `
    <div class="chip-row-item">
      <strong>${escapeHtml(key)}</strong>
      <span>${escapeHtml(approvalOwners.get(key) || "")}</span>
    </div>`).join("");

  return `
    <div class="hero-strip">
      <div class="hero-copy">
        <div class="eyebrow">Organization handbook</div>
        <h2>Every duty, every department, one approval path.</h2>
        <p>${totals.departments} departments · ${totals.roles} roles · ${totals.duties} duties. The steps below are the same state machine the server enforces on every contract.</p>
      </div>
      <div class="hero-actions"><button class="btn" data-action="reload-duties">Refresh</button></div>
    </div>

    <section class="card glass">
      <div class="section-head">
        <div>
          <h2 class="section-title">Approval workflow</h2>
          <div class="section-note">Sales initiates, Legal owns the record, Finance validates the money, Management approves. Nobody approves their own step.</div>
        </div>
        ${yourStages.length ? `<span class="chip chip-gold">${yourStages.length} ${yourStages.length === 1 ? "step is" : "steps are"} yours to decide</span>` : `<span class="chip">You do not hold an approval step</span>`}
      </div>
      <ol class="flow-rail">${stageRail}</ol>
      <div class="section-head" style="margin-top:22px">
        <div>
          <h2 class="section-title">Off-pipeline states</h2>
          <div class="section-note">Rework and terminal states, reachable from several steps.</div>
        </div>
      </div>
      <ul class="flow-exceptions">${exceptionList}</ul>
      ${yourApprovalCards ? `<div class="section-head" style="margin-top:22px"><div><h2 class="section-title">Your approval authority</h2><div class="section-note">Lifecycle permissions you personally hold, and the department that owns each.</div></div></div><div class="chip-row">${yourApprovalCards}</div>` : ""}
    </section>

    <div class="section-head" style="margin-top:22px">
      <div>
        <h2 class="section-title">Duties by department</h2>
        <div class="section-note">The declared responsibilities behind each role, and the permissions each one is granted.</div>
      </div>
    </div>
    <div class="dept-grid">${renderDepartmentCards(departments)}</div>`;
}

/** Loads the duty catalogue once per session, like the other on-demand extras. */
async function loadDuties() {
  state.dutiesRequested = true;
  try {
    state.duties = await api("/org/duties");
  } catch (error) {
    // Stored as state so the view can explain itself and the render guard stops
    // retrying on every repaint.
    state.duties = { error: error.message || "Unable to load duties." };
    showToast(state.duties.error);
  }
}

// Reloads report history from the server using the history filter bar.
async function loadReportHistory() {
  const filters = state.reportFilters;
  const query = new URLSearchParams();
  if (filters.source) query.set("source", filters.source);
  if (filters.reportType) query.set("report_type", filters.reportType);
  if (filters.projectId) query.set("project_id", filters.projectId);
  if (filters.search) query.set("search", filters.search);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  const activeFilter = document.activeElement?.dataset?.filter || null;
  try {
    state.reportHistory = await api(`/reports/history${query.toString() ? `?${query}` : ""}`);
  } catch (error) {
    showToast(error.message || "Unable to load report history.");
  }
  render();
  if (activeFilter) {
    const next = content.querySelector(`[data-filter="${activeFilter}"]`);
    if (next) {
      next.focus();
      if (typeof next.setSelectionRange === "function" && next.value) next.setSelectionRange(next.value.length, next.value.length);
    }
  }
}

function projectOptions(selected = "") {
  return state.projects.map((project) => `<option value="${project.id}" ${String(project.id) === String(selected) ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
}

function contractOptions(selected = "") {
  return state.contracts.map((contract) => `<option value="${contract.id}" ${String(contract.id) === String(selected) ? "selected" : ""}>${escapeHtml(contract.client_name)} · ${escapeHtml(contract.project_name)}</option>`).join("");
}

// Payments are taken only on approved or active contracts (the server enforces
// the same list), so the payment form offers only those.
const PAYABLE_CONTRACT_STATUSES = new Set(["approved", "customer_pending", "active"]);
function payableContractOptions(selected = "") {
  return state.contracts
    .filter((contract) => PAYABLE_CONTRACT_STATUSES.has(contract.status) || String(contract.id) === String(selected))
    .map((contract) => `<option value="${contract.id}" ${String(contract.id) === String(selected) ? "selected" : ""}>${escapeHtml(contract.client_name)}${contract.contract_number ? ` · ${escapeHtml(contract.contract_number)}` : ""}${contract.project_name ? ` · ${escapeHtml(contract.project_name)}` : ""}</option>`).join("");
}

function clientOptions(selected = "") {
  if (!state.clients?.length) return `<option value="">No clients available</option>`;
  return `<option value="">Select client</option>${state.clients.map((c) => `<option value="${c.id}" ${String(c.id) === String(selected) ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}`;
}

// Contract modal: picking a registered client fills the client name field;
// leaving it on the first option keeps manual name entry.
function linkedClientOptions(selected = "") {
  const manual = `<option value="">Type client name manually</option>`;
  if (!state.clients?.length) return manual;
  return `${manual}${state.clients.map((c) => `<option value="${c.id}" ${String(c.id) === String(selected) ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}`;
}

/**
 * "Public website" section of the property form. The Sales Officer chooses
 * Rent, Buy or both, sets the prices, and publishes directly (no management
 * approval). The server refuses to publish a listing with no service or a
 * service without a price.
 */
function websiteListingFields(record) {
  const checked = (value) => (value ? "checked" : "");
  return `${formSection("Public website")}
    <div class="field full"><span class="field-label">Offered for</span>
      <div class="inline-checks">
        <label class="checkbox-field"><input type="checkbox" name="offer_buy" ${checked(record?.offer_buy)}><span>Buy (for sale)</span></label>
        <label class="checkbox-field"><input type="checkbox" name="offer_rent" ${checked(record?.offer_rent)}><span>Rent</span></label>
      </div>
      <div class="field-help">Choose where this property appears on the public website: under Buy, Rent, or both.</div>
    </div>
    <div class="field"><label for="field-rent-price">Rent price (TZS)</label><input id="field-rent-price" name="rent_price" type="number" min="0" step="0.01" value="${escapeHtml(record?.rent_price ?? "")}" placeholder="Only if offered to rent"></div>
    <div class="field"><label for="field-rent-period">Rent is per</label><select id="field-rent-period" name="rent_period"><option value="month" ${record?.rent_period !== "year" ? "selected" : ""}>Month</option><option value="year" ${record?.rent_period === "year" ? "selected" : ""}>Year</option></select></div>
    <div class="field full"><label for="field-summary">Short summary for the website</label><input id="field-summary" name="summary" maxlength="200" value="${escapeHtml(record?.summary || "")}" placeholder="One line shown on the listing card"></div>
    <div class="field full"><label for="field-features">Features</label><textarea id="field-features" name="features" maxlength="2000" placeholder="One feature per line, e.g.&#10;Private garden&#10;Backup power">${escapeHtml(record?.features || "")}</textarea></div>
    <div class="field full"><label class="checkbox-field"><input type="checkbox" name="public_listing" ${checked(record?.public_listing)}><span><strong>Show on the public website</strong></span></label>
      <div class="field-help">Publishes straight away. A sold or leased property leaves the website listings by itself.</div>
    </div>`;
}

/** Listing fields from a submitted property form, as the API expects them. */
function readListingFields(data) {
  data.offer_buy = data.offer_buy ? 1 : 0;
  data.offer_rent = data.offer_rent ? 1 : 0;
  data.public_listing = data.public_listing ? 1 : 0;
  data.rent_price = data.rent_price === "" || data.rent_price === undefined ? null : numberValue(data.rent_price);
  return data;
}


// Photos are loaded per property on demand (kept in state.propertyPhotos).
function renderPhotoStrip(property) {
  const photos = (state.propertyPhotos && state.propertyPhotos[property.id]) || null;
  if (photos === null) return `<span class="muted">Loading photos…</span>`;
  // The server marks each picture `available` after checking the file is really
  // on disk. Only those are rendered, so a record whose file is gone never
  // produces a request that can only 404.
  const renderable = photos.filter((photo) => photo.available !== false);
  const missing = photos.length - renderable.length;
  const chips = renderable.map((photo, index) => `<span class="photo-chip"><img data-src="${photo.file_url}" alt="${escapeHtml(photo.original_filename || "Photo")}" loading="lazy">${index === 0 ? `<span class="photo-cover-tag">Cover</span>` : ""}<button type="button" class="photo-remove" data-action="remove-photo" data-property="${property.id}" data-image="${photo.id}" title="Remove photo">×</button></span>`).join("");
  // The records still exist and are still removable; saying so beats showing a
  // broken image or pretending the pictures were never attached.
  const missingNote = missing > 0 ? `<span class="muted">${missing} picture${missing === 1 ? "" : "s"} recorded but the file is missing.</span>` : "";
  if (!renderable.length && !missingNote) return `<span class="muted">No photos yet.</span>`;
  return `${chips}${missingNote}`;
}

// File endpoints require the Bearer token, which <img src> cannot send —
// fetch each pending image as a blob and swap it in.
//
// Each object URL is tracked and revoked when its image leaves the document.
// A blob URL is held by the browser until it is explicitly revoked, so
// re-rendering the property grid repeatedly (every filter change, every save)
// would otherwise leak a full image per card per render for the life of the
// session. The cache also stops the same file being re-fetched on every render.
const imageBlobCache = new Map();
// URLs handed out during the current hydration pass. A plain Set: blob URLs are
// strings, and a WeakSet rejects strings - which used to throw inside
// hydrateImages and make EVERY authenticated picture (property photos
// included) fall back to "Photo unavailable".
const liveImageUrls = new Set();

function revokeImageBlob(url) {
  if (!url || !url.startsWith("blob:")) return;
  try { URL.revokeObjectURL(url); } catch (_) { /* already revoked */ }
}

// Called after each render: release any blob whose <img> is no longer on screen.
function releaseDetachedImageBlobs(root = document) {
  for (const [src, url] of imageBlobCache) {
    if (liveImageUrls.has(url)) continue;
    // Checked against the whole page, not just the re-rendered region, so a
    // picture still shown elsewhere (the sidebar avatar, an open dialog) keeps
    // its blob.
    const stillUsed = Array.from(document.querySelectorAll("img")).some((img) => img.src === url);
    if (!stillUsed) {
      revokeImageBlob(url);
      imageBlobCache.delete(src);
    }
  }
}

async function hydrateImages(root = document) {
  const images = Array.from(root.querySelectorAll("img[data-src]"));
  await Promise.all(images.map(async (img) => {
    const src = img.getAttribute("data-src");
    img.removeAttribute("data-src");
    const cached = imageBlobCache.get(src);
    if (cached) {
      liveImageUrls.add(cached);
      img.src = cached;
      return;
    }
    try {
      const response = await fetch(src, { headers: { ...CSRF_HEADERS }, credentials: "same-origin" });
      if (!response.ok) throw new Error(`image load failed (${response.status})`);
      const url = URL.createObjectURL(await response.blob());
      imageBlobCache.set(src, url);
      liveImageUrls.add(url);
      img.src = url;
    } catch (_) {
      // Pictures are optional: a missing image never breaks the view.
      if (img.closest(".photo-chip")) img.closest(".photo-chip").remove();
      else {
        const fallback = img.closest(".property-cover")?.querySelector(".property-cover-fallback");
        if (fallback) fallback.hidden = false;
        else img.remove();
      }
    }
  }));
  releaseDetachedImageBlobs(root);
  liveImageUrls.clear();
}

/** Drops every cached picture, e.g. after a property's gallery is edited. */
function clearImageBlobCache() {
  for (const url of imageBlobCache.values()) revokeImageBlob(url);
  imageBlobCache.clear();
}

async function loadPropertyPhotos(propertyId) {
  try {
    const photos = await api(`/properties/${propertyId}/images`);
    if (!state.propertyPhotos) state.propertyPhotos = {};
    state.propertyPhotos[propertyId] = photos;
    const strip = document.getElementById("photo-strip");
    if (strip && String(strip.dataset.propertyId) === String(propertyId)) {
      strip.innerHTML = renderPhotoStrip(state.properties.find((p) => String(p.id) === String(propertyId)) || { id: propertyId });
      hydrateImages(strip);
    }
  } catch (_) {
    // Photos are optional — a failed load never blocks the property form.
    if (!state.propertyPhotos) state.propertyPhotos = {};
    state.propertyPhotos[propertyId] = [];
  }
}

function propertyOptions(selected = "") {
  if (!state.properties?.length) return `<option value="">No properties available</option>`;
  return `<option value="">Select property</option>${state.properties.map((p) => `<option value="${p.id}" ${String(p.id) === String(selected) ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}`;
}

function projectSelect(selected = "") {
  return `<select class="filter-input" data-filter="project" aria-label="Filter by project"><option value="">All projects</option>${projectOptions(selected)}</select>`;
}

function card(label, value, foot, iconName = "dot", tone = "") {
  return `<article class="stat-tile"><div class="stat-icon ${tone}">${icon(iconName)}</div><div class="stat-copy"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${value}</div>${foot ? `<div class="stat-foot">${foot}</div>` : ""}</div></article>`;
}

function renderLoading() {
  content.innerHTML = `<div class="loading" role="status" aria-live="polite"><div class="spinner" aria-hidden="true"></div><span>Loading workspace…</span></div>`;
}

/** A dashboard panel: a titled surface with an optional header action. */
function dashPanel(title, note, body, action = "", extraClass = "") {
  return `<article class="panel${extraClass ? ` ${extraClass}` : ""}"><div class="panel-head"><div><h2 class="panel-title">${escapeHtml(title)}</h2>${note ? `<div class="panel-note">${escapeHtml(note)}</div>` : ""}</div>${action}</div><div class="panel-body">${body}</div></article>`;
}

// Command-centre dashboard. Three rules shape it:
//   1. Attention first - only things the caller can act on, only when there is
//      something to act on.
//   2. No meaningless numbers - the statistics strip appears once the workspace
//      holds records; an empty workspace gets a getting-started path instead of
//      a wall of zeros.
//   3. Every card, panel and quick action is gated exactly as before: modules
//      via canModule(), money via view_financial, actions via can().
/**
 * Which simplified "Your work today" home this person gets. The Managing
 * Director, the Finance desk and Sales each see their own short list of jobs;
 * everyone else keeps the standard dashboard. Nothing here grants anything:
 * every button opens a screen the person could already open.
 */
function workspaceRole() {
  if (isAdmin()) return null;
  if (can("approve_management")) return "md";
  if (can("validate_finance") && canSeeFinancial()) return "finance";
  if (can("submit_contract") && !can("approve_legal") && canModule("contracts")) return "sales";
  if ((can("approve_legal") || can("review_legal")) && canModule("contracts")) return "legal";
  const roleNames = (state.organization.me?.user?.roles || []).map((role) => String(role.name || ""));
  if (roleNames.some((name) => /customer service/i.test(name))) return "cs";
  return null;
}

/** The ordered steps of this person's part of the work, shown as a strip. */
/** One plain-language line at the top of the pages each role uses most. */
const PAGE_TIPS = {
  finance: {
    debts: "To record money: press “Record payment”, choose the contract, type the reference and attach the receipt or paste the SMS. Then approve it. The installment is marked paid by itself.",
    contracts: "Your step: open a contract marked “Under Finance review”, check the price and plan, then press “Validate financial terms”. The payment plan is created for you.",
  },
  sales: {
    contracts: "Your step: press “Generate contract”, pick the property and customer, then press “Submit to Legal”. Anything Legal sends back shows as “Under Sales review · changes requested”.",
    requests: "Your step: give each new request to Customer Service. When they report back, accept it and the customer becomes a client.",
  },
  legal: {
    contracts: "Your step: press the button on each contract. Submitted → Start legal review → Legal approval. After Finance validates, send it to the MD; after the MD approves, send it to the customer and record the signature.",
  },
  cs: {
    assignments: "Your step: open each task, contact the customer the way they asked (phone, WhatsApp or email), write what was agreed and press Submit.",
  },
  md: {
    contracts: "Your step: open a contract marked “Under MD review”, read it, then press “Management approval” or reject it with a reason.",
  },
};
function addPageTip() {
  const tip = PAGE_TIPS[workspaceRole()]?.[state.view];
  if (!tip || content.querySelector(".page-tip")) return;
  content.insertAdjacentHTML("afterbegin", `<div class="page-tip">${icon("spark")}<span>${escapeHtml(tip)}</span></div>`);
}

const WORK_FLOW = {
  finance: ["Customer pays", "You record it (reference + proof)", "Approve it", "Give the MKUYU receipt", "Follow up the next due date"],
  sales: ["Website request arrives", "Customer Service calls the customer", "You prepare the contract", "Legal → Finance → MD", "Customer signs"],
  md: ["Sales prepares", "Legal reviews", "Finance checks the money", "You approve", "Legal releases to the customer"],
  legal: ["Sales submits", "You review and approve", "Finance checks the money", "You send it to the MD", "You release it and record the signature"],
  cs: ["Sales hands you a request", "You contact the customer", "You write a short report", "Sales accepts it", "The customer becomes a client"],
};

function workTodayPanel(role) {
  const summary = state.summary || {};
  const work = summary.work || {};
  const n = (value) => Number(value || 0);
  const jobs = [];
  // job: count (null = always available), title, what to do, button, where it goes.
  const job = (count, title, help, label, go, tone = "") => jobs.push({ count, title, help, label, go, tone });
  const toView = (view, filters = {}, scroll = "") => ({ view, filters, scroll });
  if (role === "finance") {
    job(n(state.organization.me?.sole_finance_approver ? summary.payments_pending?.count : summary.payments_to_approve), "Payments waiting for your approval", "Check the reference and the proof, then approve. Only approved money counts.", "Approve payments", toView("debts", { paymentStatus: "pending" }, "#payments-section"), "gold");
    job(n(work.contracts_finance_review), "Contracts to check", "Marked Under Finance review. Check the price and payment plan, then press “Validate financial terms”.", "Check contracts", toView("contracts", { status: "legal_approved" }));
    job(null, "Money received?", "Record it with the transaction reference and the receipt or SMS.", "Record a payment", { action: "new-payment" });
    job(n(summary.debts_due_week?.count), "Due in the next 7 days", "Call these customers before the due date.", "See who to call", toView("debts", { debtStatus: "upcoming" }), "amber");
    job(n(summary.debts_overdue?.count), "Overdue installments", "Follow these up today.", "See overdue", toView("debts", { debtStatus: "overdue" }), "red");
  }
  if (role === "sales") {
    if (canModule("leads")) {
      job(n(work.requests_new), "New website requests", "Give each one to Customer Service to call the customer.", "Open requests", toView("requests"), "gold");
      job(n(work.requests_reported), "Customer Service reported back", "Read what the customer said, then accept or send back.", "Read reports", toView("requests"));
    }
    job(n(work.contracts_changes), "Contracts sent back to you", "Fix what Legal asked for, then submit again.", "Fix contracts", toView("contracts", { status: "changes_requested" }), "amber");
    job(n(work.contracts_draft), "Drafts not yet sent to Legal", "Check the draft and press “Submit to Legal”.", "Submit drafts", toView("contracts", { status: "draft" }));
    job(null, "Customer ready to buy or rent?", "The system fills the contract, price and payment plan for you.", "Prepare a contract", { action: "generate-contract" });
  }
  if (role === "md") {
    job(n(work.contracts_management), "Contracts waiting for your approval", "Open each one, read it, then approve or reject.", "Review contracts", toView("contracts", { status: "pending_management_approval" }), "gold");
    job(n(work.contracts_customer), "With the customer to sign", "No action needed. Legal records the signature.", "See them", toView("contracts", { status: "customer_pending" }));
    if (canSeeFinancial()) {
      job(n(summary.payments_pending?.count), "Payments Finance has not approved yet", "For your information. Finance approves them.", "See payments", toView("debts", { paymentStatus: "pending" }, "#payments-section"));
      job(n(summary.debts_overdue?.count), "Overdue installments", summary.debts_overdue?.total ? `${money(summary.debts_overdue.total)} past due. Finance follows up.` : "Finance follows these up.", "See overdue", toView("debts", { debtStatus: "overdue" }), "red");
    }
    if (canModule("reports")) job(null, "How is the business doing?", "Sales, money received and contracts, for any period.", "Open reports", toView("reports"));
  }
  if (role === "legal") {
    job(n(work.contracts_submitted), "New contracts from Sales", "Open each one and press “Start legal review”.", "Start reviews", toView("contracts", { status: "submitted" }), "gold");
    job(n(work.contracts_under_review), "Contracts you are reviewing", "Check the clauses and the parties, then press “Legal approval” or send it back with a reason.", "Finish reviews", toView("contracts", { status: "under_review" }));
    job(n(work.contracts_to_md), "Finance has checked the money", "Press “Send for management approval”.", "Send to the MD", toView("contracts", { status: "legal_approved" }));
    job(n(work.contracts_release), "The MD approved", "Press “Send to customer” so the customer can sign.", "Send to customers", toView("contracts", { status: "approved" }));
    job(n(work.contracts_customer), "With the customer for signature", "When the customer has signed and the deposit is paid, attach the signed contract (“Replace with signed contract”) and press “Record customer signature”.", "Record signatures", toView("contracts", { status: "customer_pending" }), "amber");
  }
  if (role === "cs") {
    const attention = state.attention || {};
    job(n(attention.mine), "Customers to contact", "Sales gave you these. Call or message each customer the way they asked.", "Open my tasks", toView("assignments", { taskBox: "mine" }), "gold");
    if (n(attention.review)) job(n(attention.review), "Reports to review", "Your team submitted these. Approve them or ask for changes.", "Review reports", toView("assignments", { taskBox: "needs_review" }));
    if (canModule("appointments")) job(n(summary.appointments_scheduled), "Booked appointments", "Site visits and calls. Remind the customer the day before.", "See appointments", toView("appointments"));
    if (canModule("clients")) job(null, "Customer details changed?", "Keep the phone number and email correct in the client register.", "Open clients", toView("clients"));
  }
  if (!jobs.length) return "";
  const waiting = jobs.filter((entry) => entry.count > 0).length;
  const cards = jobs.map((entry, index) => {
    const idle = entry.count === 0;
    const attrs = entry.go.action
      ? `data-action="${entry.go.action}"`
      : `data-action="work-go" data-view="${escapeHtml(entry.go.view)}" data-filters="${escapeHtml(JSON.stringify(entry.go.filters || {}))}" data-scroll="${escapeHtml(entry.go.scroll || "")}"`;
    const badgeHtml = entry.count === null
      ? `<span class="work-count work-count-plus">${icon("plus")}</span>`
      : idle ? `<span class="work-count work-count-done">${icon("check")}</span>` : `<span class="work-count ${entry.tone ? `work-${entry.tone}` : ""}">${entry.count > 99 ? "99+" : entry.count}</span>`;
    return `<li class="work-card${idle ? " work-card-idle" : ""}"><span class="work-num">${index + 1}</span>${badgeHtml}<div class="work-copy"><strong>${escapeHtml(entry.title)}</strong><span>${escapeHtml(idle ? "Nothing waiting. Well done." : entry.help)}</span></div><button class="btn ${idle ? "btn-soft" : "btn-primary"} btn-small" ${attrs}>${escapeHtml(entry.label)}${icon("arrow")}</button></li>`;
  }).join("");
  const flow = (WORK_FLOW[role] || []).map((step, index) => `<li class="work-step"><span>${index + 1}</span>${escapeHtml(step)}</li>`).join("");
  return `<article class="panel work-panel">
    <div class="panel-head"><div><h2 class="panel-title">Your work today</h2><div class="panel-note">${waiting ? `${waiting} thing${waiting === 1 ? "" : "s"} waiting for you. Start at number 1.` : "Nothing is waiting for you right now."}</div></div></div>
    <div class="panel-body">
    <ol class="work-list">${cards}</ol>
    ${flow ? `<div class="work-flow"><span class="work-flow-label">How your work moves</span><ol>${flow}</ol></div>` : ""}
    </div>
  </article>`;
}

function renderDashboard() {
  const summary = state.summary || {};
  const financial = canSeeFinancial() && summary.financial !== false;
  const newContracts = summary.contracts_new || { count: 0, total: 0 };
  const terminal = summary.contracts_terminal || { count: 0, total: 0 };
  const pending = summary.debts_pending || { count: 0, total: 0 };
  const overdue = summary.debts_overdue || { count: 0, total: 0 };
  const income30 = summary.income_30d || { count: 0, total: 0 };
  const upcomingDebts = state.debts.filter((debt) => debtState(debt) === "upcoming").slice(0, 5);
  const upcoming = state.reminders.length ? state.reminders : upcomingDebts;
  const recent = [...state.contracts].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 5);
  const leads = state.organization.leads || [];
  const followUps = state.organization.followUps || [];
  const attentionCount = Number(state.attention?.total || 0);
  const visibleRecordCount = [state.projects, state.properties, state.clients, state.contracts, state.debts, state.appointments, state.documents, state.payments, state.reports, leads, followUps].reduce((total, rows) => total + (rows || []).length, 0);
  const hasRecords = visibleRecordCount > 0;

  const quickActions = [];
  if (canAuthorContracts()) quickActions.push(`<button class="btn btn-primary" data-action="generate-contract">${icon("contract")}Generate contract</button>`);
  if (canChange("properties", "create")) quickActions.push(`<button class="btn" data-action="new-property">${icon("plus")}Property</button>`);
  if (canModule("clients") && can("create")) quickActions.push(`<button class="btn" data-action="new-client">${icon("plus")}Client</button>`);
  if (canChange("projects", "create")) quickActions.push(`<button class="btn" data-action="new-project">${icon("plus")}Project</button>`);

  // ---- 1. Needs your attention ---------------------------------------------
  const attentionItems = [];
  const attentionRow = (count, label, note, view, iconName, tone = "") => attentionItems.push(
    `<button class="attention-item" data-action="open-alert-view" data-view="${view}"><span class="attention-icon ${tone}">${icon(iconName)}</span><span class="attention-copy"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(note)}</span></span><span class="attention-count">${count > 99 ? "99+" : count}</span>${icon("arrow", "attention-go")}</button>`);
  if (attentionCount) attentionRow(attentionCount, `${attentionCount === 1 ? "Assignment needs" : "Assignments need"} you`, "New, returned or awaiting your review", "assignments", "tasks", "gold");
  if (canModule("contracts")) {
    const awaiting = contractsAwaitingCaller().length;
    if (awaiting) attentionRow(awaiting, `${awaiting === 1 ? "Contract awaits" : "Contracts await"} your step`, "Workflow actions are available to you", "contracts", "contract");
    const unplanned = contractsNeedingPlan().length;
    if (unplanned) attentionRow(unplanned, `${unplanned === 1 ? "Contract needs" : "Contracts need"} a payment plan`, "Create the deposit and installments from the final price", "contracts", "wallet", "amber");
  }
  if (financial && canModule("debts") && Number(overdue.count || 0) > 0) attentionRow(Number(overdue.count), `Overdue ${Number(overdue.count) === 1 ? "installment" : "installments"}`, `${money(overdue.total || 0)} past due`, "debts", "alert", "red");
  // Reminders are derived from installments, so they only count once the
  // caller can see installments at all.
  if (financial && canModule("reminders") && canModule("debts") && hasRecords && upcoming.length) attentionRow(upcoming.length, "Payments due soon", "Due now or within the next 7 days", "debts", "clock", "amber");
  if (canModule("documents") && can("edit") && Number(summary.documents_pending || 0) > 0) attentionRow(Number(summary.documents_pending), `${Number(summary.documents_pending) === 1 ? "Document awaits" : "Documents await"} approval`, "Pending review in the document register", "documents", "folder", "amber");
  const attentionPanel = dashPanel(
    "Needs your attention",
    attentionItems.length ? "Only work you can act on appears here" : "",
    attentionItems.length
      ? `<div class="attention-list">${attentionItems.join("")}</div>`
      : emptyState("No pending tasks", "You're all caught up. New assignments, reviews and approvals will appear here.", { iconName: "check", compact: true }),
    "",
    "attention-panel",
  );

  // ---- 2. Key figures (only once there is something to count) -------------
  const cards = [];
  if (hasRecords) {
    if (canModule("properties")) cards.push(card("Available properties", summary.properties_available || 0, "Ready to sell or lease", "home"));
    if (canModule("projects")) cards.push(card("Active projects", summary.active_projects || 0, "Developments in progress", "building"));
    if (canModule("clients")) cards.push(card("Active clients", summary.clients_active || 0, "Relationships on record", "users"));
    if (canModule("contracts")) cards.push(card("New contracts", newContracts.count || 0, newContracts.total === null || newContracts.total === undefined ? "Signed and active" : `${money(newContracts.total || 0)} contract value`, "contract"));
    if (canModule("leads")) cards.push(card("Open leads", leads.filter((lead) => lead.status !== "converted").length, `${leads.filter((lead) => lead.status === "new").length} new enquiries`, "spark"));
    if (canModule("appointments")) cards.push(card("Scheduled appointments", summary.appointments_scheduled || 0, "Viewings, calls and meetings", "calendar"));
    if (financial && canModule("debts")) cards.push(card("Outstanding", money(pending.total || 0), `${pending.count || 0} open installment${Number(pending.count) === 1 ? "" : "s"}`, "wallet", "amber"));
    if (financial && canModule("payments")) cards.push(card("Collected · 30 days", money(income30.total || 0), `${income30.count || 0} payment${income30.count === 1 ? "" : "s"} recorded`, "money", "green"));
  }

  // ---- 3. Getting started (empty workspace only) --------------------------
  const startSteps = [];
  const startStep = (n, title, text, action) => startSteps.push(`<li class="start-step"><span class="start-num">${n}</span><div class="start-copy"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span></div>${action}</li>`);
  if (!hasRecords) {
    let n = 1;
    if (canChange("projects", "create")) startStep(n++, "Create a project", "Group properties by development.", `<button class="btn btn-small" data-action="new-project">Create project</button>`);
    if (canChange("properties", "create")) startStep(n++, "Add your first property", "Price, location, status and photos.", `<button class="btn btn-small" data-action="new-property">Add property</button>`);
    if (canModule("clients") && can("create")) startStep(n++, "Register a client", "A client can exist before any contract.", `<button class="btn btn-small" data-action="new-client">Add client</button>`);
    if (canAuthorContracts()) startStep(n++, "Generate a contract", "Pricing, payment plan and the full document.", `<button class="btn btn-small btn-primary" data-action="generate-contract">Generate</button>`);
  }

  // ---- 4. Module panels ---------------------------------------------------
  const panels = [];
  if (canModule("contracts")) {
    // The contract value is deliberately shown to every caller holding the
    // contracts module, financial or not: Sales negotiates the price and Legal
    // reviews the commercial terms, so the server returns `contracts.value` to
    // them and the UI must agree. What is withheld from a non-financial caller
    // is the FINANCIAL aggregate set - outstanding, overdue, income, the debt
    // and payment registers - and those are gated on `financial` above.
    const hasContracts = recent.length > 0 || Number(newContracts.count || 0) + Number(terminal.count || 0) > 0;
    const list = recent.map((contract) => `<li class="list-row" data-searchable><div class="list-main"><strong>${escapeHtml(contract.client_name)}</strong><span>${escapeHtml(contract.contract_number || contract.project_name || "")}${contract.contract_number && contract.project_name ? ` · ${escapeHtml(contract.project_name)}` : ""}</span></div><div class="list-side">${contractStatusBadge(contract)}<span class="amount">${money(contract.value)}</span></div></li>`).join("");
    // Where contracts are: one line per desk, for the Managing Director (and
    // anyone who signs off contracts) to see at a glance who is holding what.
    const pipeline = (state.contractPipeline || []).filter((entry) => entry.step && entry.key !== "completed" && entry.key !== "active");
    if (pipeline.length && (can("approve_management") || can("approve_legal"))) {
      const total = pipeline.reduce((sum, entry) => sum + Number(entry.count || 0), 0);
      const pipelineRows = pipeline.map((entry) => `<li class="list-row" data-searchable><div class="list-main"><strong>${escapeHtml(entry.label)}</strong><span>With ${escapeHtml(entry.desk || "—")} · step ${entry.step}</span></div><div class="list-side"><span class="badge badge-position-${escapeHtml(entry.key)}">${Number(entry.count || 0)}</span></div></li>`).join("");
      panels.push(dashPanel(
        "Where contracts are",
        `${total} contract${total === 1 ? "" : "s"} in progress`,
        `<ul class="list">${pipelineRows}</ul>`,
        `<button class="btn btn-ghost btn-small" data-action="open-alert-view" data-view="contracts">Open register${icon("arrow")}</button>`,
      ));
    }
    panels.push(dashPanel(
      "Recent contracts",
      hasContracts ? `${newContracts.count || 0} new · ${terminal.count || 0} terminal` : "",
      hasContracts && list ? `<ul class="list">${list}</ul>` : emptyState("No active contracts", "Contracts will appear here once created.", { iconName: "contract", compact: true, action: canAuthorContracts() ? `<button class="btn btn-small btn-primary" data-action="generate-contract">Generate contract</button>` : "" }),
      hasContracts ? `<button class="btn btn-ghost btn-small" data-action="open-alert-view" data-view="contracts">View all${icon("arrow")}</button>` : "",
    ));
  }
  // Reminders are their own module with their own access key, so the panel is
  // gated on `reminders` rather than on `debts`. Anything the panel links to is
  // gated separately, so a caller without the debts module still gets the list.
  if (financial && canModule("reminders") && hasRecords) {
    const rows = upcoming.map((debt) => `<li class="list-row reminder" data-searchable><div class="list-main"><strong>${escapeHtml(debt.client_name)}</strong><span>${escapeHtml(debt.project_name || "")}${debt.project_name ? " · " : ""}due ${formatDate(debt.due_date)}</span></div><div class="list-side"><span class="amount">${money(debt.amount)}</span>${debt.remind_at && can("edit") ? `<button class="btn btn-ghost btn-small" data-action="dismiss-reminder" data-id="${debt.id}" title="Mark reminder as handled">Dismiss</button>` : ""}${can("edit") ? `<button class="btn btn-small" data-action="edit-debt" data-id="${debt.debt_id || debt.id}">Review</button>` : ""}</div></li>`).join("");
    panels.push(dashPanel(
      "Payment reminders",
      "Due now or within the next 7 days",
      rows ? `<ul class="list">${rows}</ul>` : emptyState("All clear", "No payments are due in the next 7 days.", { iconName: "check", compact: true }),
      canModule("debts") ? `<button class="btn btn-ghost btn-small" data-action="view-debts">View debts${icon("arrow")}</button>` : "",
    ));
  }
  if (canModule("appointments") && hasRecords) {
    const rows = [...state.appointments].filter((entry) => entry.status !== "cancelled").sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at))).slice(0, 5).map((entry) => `<li class="list-row" data-searchable><div class="date-chip">${appointmentDateChip(entry.starts_at)}</div><div class="list-main"><strong>${escapeHtml(entry.title)}</strong><span>${escapeHtml(entry.client_name || "")}${entry.project_name ? ` · ${escapeHtml(entry.project_name)}` : ""}</span></div><div class="list-side">${badge(entry.appointment_type, "neutral")}</div></li>`).join("");
    panels.push(dashPanel("Next appointments", "Viewings, calls and inspections", rows ? `<ul class="list">${rows}</ul>` : emptyState("Nothing booked", "Scheduled viewings and calls will appear here.", { iconName: "calendar", compact: true })));
  }
  if (canModule("leads") && leads.length) {
    const rows = leads.slice(0, 5).map((lead) => `<li class="list-row" data-searchable><div class="list-main"><strong>${escapeHtml(lead.name)}</strong><span>${escapeHtml(lead.source || "—")}</span></div><div class="list-side">${badge(lead.status, "neutral")}<span class="muted">${formatDate(lead.created_at)}</span></div></li>`).join("");
    panels.push(dashPanel("Latest leads", "Enquiries assigned to your sector", `<ul class="list">${rows}</ul>`));
  }
  if (canModule("follow_ups") && followUps.some((entry) => entry.status === "open")) {
    const rows = followUps.filter((entry) => entry.status === "open").slice(0, 5).map((entry) => `<li class="list-row" data-searchable><div class="list-main"><strong>${escapeHtml(humanize(entry.follow_up_type))}</strong><span>Due ${formatDateTime(entry.due_at)}</span></div><div class="list-side">${badge(entry.status, "neutral")}</div></li>`).join("");
    panels.push(dashPanel("Open follow-ups", "Outstanding tasks in your sector", `<ul class="list">${rows}</ul>`));
  }
  // A chart of zeros says nothing, so the portfolio chart only appears once at
  // least one project actually carries contract value.
  const valued = (state.projectReports || []).filter((project) => numberValue(project.contract_value) > 0);
  if ((canModule("projects") || canModule("contracts")) && valued.length) {
    const maxProjectValue = Math.max(1, ...valued.map((project) => numberValue(project.contract_value)));
    const bars = valued.slice(0, 8).map((project) => {
      const width = Math.max(3, Math.round(numberValue(project.contract_value) / maxProjectValue * 100));
      return `<li class="bar-row" title="${escapeHtml(project.name)}: ${money(project.contract_value)}"><span class="bar-label">${escapeHtml(project.name)}</span><span class="bar-track"><span class="bar-fill" style="width:${width}%"></span></span><span class="bar-value">${money(project.contract_value)}</span></li>`;
    }).join("");
    panels.push(dashPanel("Portfolio value", "Contract value by project", `<ul class="bar-list">${bars}</ul>`));
  }

  const scope = state.organization.me?.scope || "own";
  const scopeNote = {
    own: "Your records and anything shared with you",
    department: "Your department's records",
    organization: "Every record in the organization",
  }[scope];
  const roleName = state.organization.me?.user?.roles?.[0]?.name || "Workspace";
  const firstName = String(currentUser?.display_name || "").split(" ")[0] || "team";
  content.innerHTML = `
    <section class="dash-head">
      <div class="dash-intro">
        <div class="dash-meta"><span class="chip chip-brand">${escapeHtml(roleName)}</span><span class="chip" title="Data scope">${icon("shield")}${escapeHtml(scopeNote || "")}</span></div>
        <h2>${hasRecords ? `Welcome back, ${escapeHtml(firstName)}` : "Your workspace is ready"}</h2>
        <p>${hasRecords ? "Here is what needs you today, and where the portfolio stands." : "No business records are visible in your workspace yet. Start with the steps below."}</p>
      </div>
      ${quickActions.length ? `<div class="dash-actions">${quickActions.join("")}</div>` : ""}
    </section>
    <div class="dash-top${startSteps.length ? " has-start" : ""}">
      ${workTodayPanel(workspaceRole()) || attentionPanel}
      ${startSteps.length ? dashPanel("Get started", "Set up the workspace in a few steps", `<ol class="start-list">${startSteps.join("")}</ol>`, "", "start-panel") : ""}
    </div>
    ${cards.length ? `<div class="stat-grid">${cards.join("")}</div>` : ""}
    ${panels.length ? `<div class="panel-grid">${panels.join("")}</div>` : ""}
    ${!hasRecords && !startSteps.length && !panels.length ? `<div class="panel">${emptyState("Nothing to show yet", "Records you are allowed to see will appear here as the team adds them.", { iconName: "inbox" })}</div>` : ""}`;
}

/** Two-line date chip (day over month) for schedule lists. */
function appointmentDateChip(value) {
  if (!value) return `<span class="date-chip-day">—</span>`;
  const date = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return `<span class="date-chip-day">—</span>`;
  const month = new Intl.DateTimeFormat("en-GB", { month: "short" }).format(date);
  return `<span class="date-chip-month">${escapeHtml(month)}</span><span class="date-chip-day">${date.getDate()}</span>`;
}

function renderProjects() {
  // The contract count and value per project come from `projectReports`, the
  // server's per-project rollup. They used to be derived by filtering the whole
  // `state.contracts` array, which is now only one page - so a filter would have
  // reported "2 contracts, TZS 0" for a project that actually holds 40. The
  // rollup is computed with the same scope predicate as everything else, so the
  // figures are the caller's own and are correct for the whole set.
  const rollup = new Map((state.projectReports || []).map((entry) => [String(entry.id), entry]));
  const mayCreate = canChange("projects", "create");
  const cards = state.projects.map((project) => {
    const report = rollup.get(String(project.id));
    const contracts = report ? Number(report.new_contracts || 0) + Number(report.terminal_contracts || 0) : 0;
    const value = report ? numberValue(report.contract_value) : 0;
    const properties = report ? Number(report.properties || 0) : 0;
    const clients = report ? Number(report.clients || 0) : 0;
    const edit = canChange("projects", "edit") ? `<button class="btn btn-small" data-action="edit-project" data-id="${project.id}">Edit</button>` : "";
    const remove = canChange("projects", "delete") ? `<button class="btn btn-small btn-danger-ghost" data-action="delete-project" data-id="${project.id}" title="Delete project">Delete project</button>` : "";
    return `<article class="project-card" data-searchable>
      <div class="project-card-head"><span class="project-icon">${icon("building")}</span><div class="project-title"><strong>${escapeHtml(project.name)}</strong><span>Created ${formatDate(project.created_at)}</span></div>${badge(project.status)}</div>
      <dl class="project-stats">
        <div><dt>Properties</dt><dd>${properties}</dd></div>
        <div><dt>Clients</dt><dd>${clients}</dd></div>
        <div><dt>Contracts</dt><dd>${contracts}</dd></div>
        <div><dt>Contract value</dt><dd class="amount">${money(value)}</dd></div>
      </dl>
      ${edit || remove ? `<div class="card-actions">${canModule("properties") ? `<button class="btn btn-ghost btn-small" data-action="project-properties" data-id="${project.id}">View properties</button>` : ""}<span class="spacer"></span>${edit}${rowMenu([remove])}</div>` : (canModule("properties") ? `<div class="card-actions"><button class="btn btn-ghost btn-small" data-action="project-properties" data-id="${project.id}">View properties</button></div>` : "")}
    </article>`;
  }).join("");
  // `projects` is still delivered complete, so `.length` is a true count here.
  content.innerHTML = `<div class="toolbar"><div class="toolbar-filters"><span class="toolbar-title">All projects</span></div><div class="toolbar-end"><span class="toolbar-count">${state.projects.length} project${state.projects.length === 1 ? "" : "s"}</span>${pageActions()}</div></div>${state.projects.length
    ? `<div class="project-grid">${cards}</div>`
    : `<div class="panel">${emptyState("No projects yet", "Projects group properties by development. Create one before adding properties and contracts.", { iconName: "building", action: mayCreate ? `<button class="btn btn-primary" data-action="new-project">${icon("plus")}Create your first project</button>` : "" })}</div>`}`;
}

/**
 * Where a contract sits in the pipeline, as the SERVER describes it: the stage
 * number and the department holding it come from GET /org/duties (derived from
 * the enforced state machine), so the register can never disagree with the
 * workflow. Until that reference data arrives the status badge stands alone.
 */
function contractStageInfo(status) {
  const stages = state.duties?.workflow?.stages || [];
  const stage = stages.find((entry) => entry.status === status);
  if (!stage) return null;
  return { number: stage.stage, total: stages.length, owner: stage.owner || "" };
}

function renderContracts() {
  const filters = state.filters;
  // The pipeline reference data is loaded once, on demand, like the Duties view.
  if (!state.duties && !state.dutiesRequested) loadDuties().then(() => { if (state.view === "contracts") render(); });
  // Generating a payment schedule creates financial records, so the action is
  // only offered to callers allowed to see money. Built per row: the contract id
  // is only in scope inside the map callback.
  const scheduleAction = (id) => canSeeFinancial() ? `<button class="btn btn-soft btn-small" data-action="generate-schedule" data-id="${id}" title="Generate a payment schedule">Payment schedule</button>` : "";
  // The workflow steps the API said this caller may take. Nothing here decides
  // what is allowed: the first step the server offers becomes the row's main
  // button and the rest go in the row menu, so Legal, Finance, Sales and the MD
  // each see only their own steps.
  const workflowButton = (contract, entry, primary) => `<button class="btn ${primary ? "btn-primary" : "btn-soft"} btn-small" data-action="contract-transition" data-id="${contract.id}" data-transition="${escapeHtml(entry.action)}" title="${escapeHtml(entry.label)}">${escapeHtml(entry.label)}</button>`;
  const generatedDocumentAction = (contract) => contract.generated_document_id && canModule("documents")
    ? `<button class="btn btn-soft btn-small" data-action="view-generated-contract" data-id="${contract.id}">${contract.signed_document_id ? "Open system version" : "Open contract"}</button>` : "";
  const rows = state.contracts.filter((contract) => (!filters.project || String(contract.project_id) === filters.project) && (!filters.type || contract.contract_type === filters.type) && (!filters.status || contract.status === filters.status)).map((contract) => {
    const actions = (contract.available_actions || []).filter(Boolean);
    const forward = actions.filter((entry) => isForwardContractStep(entry.action));
    const needsPlan = contractNeedsPaymentPlan(contract);
    // With no workflow step of its own, a financial caller's main job on an
    // unplanned contract is the payment schedule, so that becomes the button.
    const primary = forward[0] ? workflowButton(contract, forward[0], true) : (needsPlan ? `<button class="btn btn-primary btn-small" data-action="generate-schedule" data-id="${contract.id}">Create payment plan</button>` : "");
    const secondary = [...forward.slice(1), ...actions.filter((entry) => !isForwardContractStep(entry.action))].map((entry) => workflowButton(contract, entry, false));
    const stage = contractStageInfo(contract.status);
    const menu = rowMenu([
      ...secondary,
      contract.signed_document_id ? `<button class="btn btn-soft btn-small" data-action="open-signed-contract" data-id="${contract.id}">Open signed contract</button>` : "",
      generatedDocumentAction(contract),
      maySignedCopy(contract) ? `<button class="btn btn-small" data-action="signed-copy" data-id="${contract.id}">${contract.signed_document_id ? "Replace signed contract" : "Replace with signed contract"}</button>` : "",
      canModule("documents") && can("create") ? `<button class="btn btn-small" data-action="upload-contract-document" data-id="${contract.id}">Upload document</button>` : "",
      `<button class="btn btn-small" data-action="contract-history" data-id="${contract.id}">History</button>`,
      can("edit") && canAuthorContracts() ? `<button class="btn btn-small" data-action="edit-contract" data-id="${contract.id}">Edit details</button>` : "",
      scheduleAction(contract.id),
      canDeleteContract(contract) ? `<button class="btn btn-danger-ghost btn-small" data-action="delete-contract" data-id="${contract.id}" title="Delete contract">Delete contract</button>` : "",
    ]);
    return `<tr data-searchable>
      <td><button class="cell-link" data-action="view-contract" data-id="${contract.id}"><span class="cell-main">${escapeHtml(contract.client_name)}</span></button><span class="cell-sub">${escapeHtml(contract.contract_number || "No number yet")}${contract.project_name ? ` · ${escapeHtml(contract.project_name)}` : ""}</span></td>
      <td>${contractStatusBadge(contract)}${contract.signed_document_id ? `<span class="cell-sub signed-note">${icon("check")}Signed copy attached</span>` : ""}${contract.position ? contractPositionNote(contract) : (stage ? `<span class="cell-sub stage-note" title="Department currently holding the contract">Stage ${stage.number} of ${stage.total} · Held by ${escapeHtml(titleCase(stage.owner))}</span>` : "")}${needsPlan ? `<span class="cell-sub plan-missing">No payment plan yet</span>` : ""}${contract.legal_signed_by ? `<span class="cell-sub signed-note">${icon("check")}Signed by Legal</span>` : ""}</td>
      <td>${contract.deal_type ? badge(dealTypeLabel(contract.deal_type), "open") : `<span class="muted cell-plain">Not recorded</span>`}<span class="cell-sub">${escapeHtml(humanize(contract.contract_type || ""))}</span></td>
      <td><span class="cell-main cell-plain">${formatDate(contract.start_date)}</span><span class="cell-sub">to ${formatDate(contract.end_date)}</span></td>
      <td class="amount">${money(contract.value)}${Number(contract.discount_pct || 0) > 0 ? `<span class="cell-sub">${numberValue(contract.discount_pct)}% discount</span>` : ""}</td>
      <td><div class="row-actions">${primary}${menu}</div></td>
    </tr>`;
  }).join("");
  const statusOptions = Object.entries(CONTRACT_STATUS_LABELS)
    .map(([value, label]) => `<option value="${value}" ${filters.status === value ? "selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
  // The visible count is the SERVER's total for the current filter and search,
  // not a count of the loaded rows. The filters above are applied server-side
  // when a page is fetched, so re-filtering the resident page here would both
  // duplicate the work and understate the result.
  const total = Number(state.pages?.contracts?.total ?? state.contracts.length);
  const visibleLabel = `${total} ${total === 1 ? "contract" : "contracts"}`;
  const filtered = Boolean(filters.project || filters.type || filters.status);
  const awaiting = contractsAwaitingCaller().length;
  content.innerHTML = `<div class="toolbar"><div class="toolbar-filters"><span class="toolbar-label">${icon("search")}Filter</span>${projectSelect(filters.project)}<select class="filter-input" data-filter="type" aria-label="Filter by contract type"><option value="">All types</option><option value="new" ${filters.type === "new" ? "selected" : ""}>New</option><option value="terminal" ${filters.type === "terminal" ? "selected" : ""}>Terminal</option></select><select class="filter-input" data-filter="status" aria-label="Filter by contract status"><option value="">All statuses</option>${statusOptions}</select></div><div class="toolbar-end"><span class="toolbar-count">${visibleLabel}${awaiting ? ` · <strong class="count-attention">${awaiting} awaiting you</strong>` : ""}</span>${pageActions()}</div></div>${rows ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Contract</th><th>Status</th><th>Type</th><th>Term</th><th>Value</th><th class="align-right">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>${pager("contracts")}` : `<div class="panel">${filtered
    ? emptyState("No contracts match these filters", "Try a different project, type or status.", { iconName: "search" })
    : emptyState("No contracts yet", "Generate a contract to price the deal, build the payment plan and produce the full document.", { iconName: "contract", action: canAuthorContracts() ? `<button class="btn btn-primary" data-action="generate-contract">${icon("contract")}Generate contract</button>` : "" })}</div>`}`;
}

function renderDebts() {
  const filters = state.filters;
  // "View contract" is offered only when the caller already holds the contracts
  // module. The contract itself is resolved from `state.contracts`, which the
  // server already scoped, so this reveals nothing that a direct request for the
  // same contract would not return.
  const canSeeContract = canModule("contracts");
  // Every action is gated on the permission the API enforces. The Finance Officer
  // holds create + edit but NOT delete, so rendering an unconditional Delete
  // button offered an action the server always refuses - a dead control that
  // reads as a permission bug to the person using it.
  const mayCreate = can("create");
  const mayEdit = can("edit");
  const mayDelete = can("delete");
  const summary = state.summary || {};
  const rows = state.debts.filter((debt) => (!filters.project || String(debt.project_id) === filters.project) && (!filters.debtStatus || debtState(debt) === filters.debtStatus)).map((debt) => {
    const debtStateValue = debtState(debt);
    const viewContract = canSeeContract && state.contracts.some((c) => String(c.id) === String(debt.contract_id))
      ? `<button class="btn btn-small" data-action="view-contract" data-id="${debt.contract_id}" title="Open the contract this installment belongs to">View contract</button>` : "";
    const open = debt.status !== "paid";
    const record = open && mayCreate ? `<button class="btn btn-primary btn-small" data-action="record-payment" data-id="${debt.id}" title="Record a payment with its reference and proof">Record payment</button>` : "";
    const edit = mayEdit ? `<button class="btn btn-small" data-action="edit-debt" data-id="${debt.id}">Edit</button>` : "";
    const remove = mayDelete ? `<button class="btn btn-danger-ghost btn-small" data-action="delete-debt" data-id="${debt.id}" title="Delete debt">Delete installment</button>` : "";
    return `<tr data-searchable class="${debtStateValue === "overdue" ? "row-overdue" : ""}"><td><span class="cell-main">${escapeHtml(debt.client_name)}</span><span class="cell-sub">${escapeHtml(debt.project_name || "")}${debt.contract_number ? ` · ${escapeHtml(debt.contract_number)}` : ""}</span></td><td>${debtBadge(debt)}</td><td>${formatDate(debt.due_date)}</td><td class="amount ${debtStateValue === "overdue" ? "danger-text" : ""}">${money(debt.amount)}</td><td class="cell-note">${debt.status === "paid" ? "—" : escapeHtml(debt.notes || "")}</td><td><div class="row-actions">${record}${rowMenu([viewContract, edit, remove])}</div></td></tr>`;
  }).join("");
  const pendingSummary = summary.debts_pending || { count: 0, total: 0 };
  const overdueSummary = summary.debts_overdue || { count: 0, total: 0 };
  const incomeSummary = summary.income_30d || { count: 0, total: 0 };
  const anyMoney = state.debts.length || (state.payments || []).length || Number(pendingSummary.count || 0) || Number(incomeSummary.count || 0);
  const filtered = Boolean(filters.project || filters.debtStatus);
  const stateOption = (value, label) => `<option value="${value}" ${filters.debtStatus === value ? "selected" : ""}>${label}</option>`;
  content.innerHTML = `${anyMoney ? `<div class="stat-grid stat-grid-compact">
      ${card("Outstanding", money(pendingSummary.total || 0), `${pendingSummary.count || 0} open installment${Number(pendingSummary.count) === 1 ? "" : "s"}`, "wallet", "amber")}
      ${card("Overdue", money(overdueSummary.total || 0), `${overdueSummary.count || 0} installment${Number(overdueSummary.count) === 1 ? "" : "s"} past due`, "alert", Number(overdueSummary.count || 0) ? "red" : "")}
      ${card("Collected · 30 days", money(incomeSummary.total || 0), `${incomeSummary.count || 0} payment${Number(incomeSummary.count) === 1 ? "" : "s"} recorded`, "money", "green")}
    </div>` : ""}
    <div class="section">
      <div class="section-head"><div><h2 class="section-title">Installments &amp; debts</h2><div class="section-note">Client balances linked to contracts</div></div></div>
      <div class="toolbar"><div class="toolbar-filters"><span class="toolbar-label">${icon("search")}Filter</span>${projectSelect(filters.project)}<select class="filter-input" data-filter="debtStatus" aria-label="Filter by debt state"><option value="">All states</option>${stateOption("pending", "Pending")}${stateOption("upcoming", "Due soon")}${stateOption("overdue", "Overdue")}${stateOption("partial", "Partial")}${stateOption("paid", "Paid")}</select></div><div class="toolbar-end"><span class="toolbar-count">${state.debts.length} on this page</span>${mayCreate ? `<button class="btn" data-action="new-debt">${icon("plus")}New debt</button>` : ""}</div></div>
      ${rows ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Client / project</th><th>State</th><th>Due date</th><th>Amount</th><th>Note</th><th class="align-right">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>${pager("debts")}` : `<div class="panel">${filtered
        ? emptyState("No installments match these filters", "Try a different project or state.", { iconName: "search", compact: true })
        : emptyState("No installments yet", "Payment plans created with a contract appear here as installments.", { iconName: "wallet", compact: true, action: mayCreate ? `<button class="btn btn-primary btn-small" data-action="new-debt">${icon("plus")}Add a debt</button>` : "" })}</div>`}
    </div>
    <div class="section">
      <div class="section-head" id="payments-section"><div><h2 class="section-title">Recorded payments</h2><div class="section-note">Money actually received, with receipts</div></div><div class="row-actions"><select class="filter-input" data-filter="paymentStatus" aria-label="Filter payments by approval"><option value="">All payments</option><option value="pending" ${filters.paymentStatus === "pending" ? "selected" : ""}>Waiting for approval</option><option value="approved" ${filters.paymentStatus === "approved" ? "selected" : ""}>Approved</option><option value="reversed" ${filters.paymentStatus === "reversed" ? "selected" : ""}>Reversed</option></select>${mayCreate ? `<button class="btn btn-soft btn-small" data-action="new-payment">${icon("plus")}Record payment</button>` : ""}</div></div>
      ${renderPaymentsTable(mayEdit, mayDelete)}
    </div>
    ${canModule("reminders") ? `<div class="section">
      <div class="section-head"><div><h2 class="section-title">Reminders</h2><div class="section-note">Installments due for follow-up</div></div></div>
      ${renderRemindersTable()}
    </div>` : ""}`;
}

// Reminders due now, in the finance view next to the money they relate to.
// Gated on the `reminders` module so a caller without it never sees the block.
function renderRemindersTable() {
  const reminders = state.reminders || [];
  if (!reminders.length) return `<div class="panel">${emptyState("No reminders due", "Nothing needs a payment reminder right now.", { iconName: "bell", compact: true })}</div>`;
  // Acknowledging a reminder and opening the debt are both writes the API gates,
  // so both buttons follow the caller's own edit permission.
  const mayEdit = can("edit");
  const rows = reminders.map((reminder) => `<tr data-searchable>
    <td><span class="cell-main">${escapeHtml(reminder.client_name)}</span><span class="cell-sub">${escapeHtml(reminder.project_name || "")}</span></td>
    <td>${formatDate(reminder.due_date)}</td>
    <td class="amount">${money(reminder.amount)}</td>
    <td>${formatDate(reminder.remind_at, true)}</td>
    <td class="align-right"><div class="row-actions">${mayEdit ? `<button class="btn btn-soft btn-small" data-action="dismiss-reminder" data-id="${reminder.id}">Mark handled</button>` : ""}${mayEdit ? `<button class="btn btn-small" data-action="edit-debt" data-id="${reminder.debt_id}">Review debt</button>` : ""}</div></td>
  </tr>`).join("");
  return `<div class="table-wrap"><table><thead><tr><th>Client / project</th><th>Due date</th><th>Amount</th><th>Reminder at</th><th class="align-right">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// The Reminders page: installments whose reminder is due now, and those whose
// due date is coming up, so Finance is warned BEFORE the date, not after.
const UPCOMING_REMINDER_DAYS = 14;
async function loadUpcomingReminders() {
  if (!(canModule("reminders") && canSeeFinancial())) { state.upcomingReminders = []; return; }
  try { state.upcomingReminders = await api(`/reminders/upcoming?days=${UPCOMING_REMINDER_DAYS}`); }
  catch { state.upcomingReminders = state.upcomingReminders || []; }
}
function daysUntil(date) {
  const match = String(date || "").slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const due = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - start) / 86400000);
}
function dueWording(date) {
  const days = daysUntil(date);
  if (days === null) return "";
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} overdue`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days} days`;
}
function renderReminders() {
  if (state.upcomingReminders === undefined) {
    state.upcomingReminders = null;
    loadUpcomingReminders().then(() => { updateNavigation(); if (state.view === "reminders") render(); });
  }
  const due = state.reminders || [];
  const upcoming = state.upcomingReminders || [];
  const mayEdit = can("edit");
  const row = (reminder, isDue) => {
    const days = daysUntil(reminder.due_date);
    const late = days !== null && days < 0;
    const tone = late ? "danger-text" : "";
    const rowClass = late ? "row-overdue" : "";
    return `<tr data-searchable class="${rowClass}">
      <td><span class="cell-main">${escapeHtml(reminder.client_name)}</span><span class="cell-sub">${escapeHtml(reminder.project_name || "")}${reminder.notes ? ` · ${escapeHtml(reminder.notes)}` : ""}</span></td>
      <td>${formatDate(reminder.due_date)}<span class="cell-sub ${tone}">${escapeHtml(dueWording(reminder.due_date))}</span></td>
      <td class="amount">${money(reminder.amount)}</td>
      <td>${isDue ? badge("Remind now", "pending") : `<span class="muted cell-plain">From ${formatDate(reminder.remind_at, true)}</span>`}</td>
      <td class="align-right"><div class="row-actions">${mayEdit && isDue ? `<button class="btn btn-primary btn-small" data-action="dismiss-reminder" data-id="${reminder.id}" title="The client has been reminded">Mark handled</button>` : ""}${can("create") ? `<button class="btn btn-small" data-action="record-payment" data-id="${reminder.debt_id}">Record payment</button>` : ""}</div></td>
    </tr>`;
  };
  const table = (list, isDue) => `<div class="table-wrap"><table class="data-table"><thead><tr><th>Client / project</th><th>Due date</th><th>Amount</th><th>Reminder</th><th class="align-right">Actions</th></tr></thead><tbody>${list.map((reminder) => row(reminder, isDue)).join("")}</tbody></table></div>`;
  content.innerHTML = `
    <div class="section">
      <div class="section-head"><div><h2 class="section-title">Remind now</h2><div class="section-note">The due date is 3 days away or less. Contact the client, then mark it handled.</div></div></div>
      ${due.length ? table(due, true) : `<div class="panel">${emptyState("Nothing to remind today", "Installments appear here 3 days before they fall due.", { iconName: "bell", compact: true })}</div>`}
    </div>
    <div class="section">
      <div class="section-head"><div><h2 class="section-title">Coming up</h2><div class="section-note">Installments falling due in the next ${UPCOMING_REMINDER_DAYS} days</div></div></div>
      ${state.upcomingReminders === null ? `<div class="panel"><p class="muted">Loading…</p></div>` : upcoming.length ? table(upcoming, false) : `<div class="panel">${emptyState("Nothing due soon", `No installment falls due in the next ${UPCOMING_REMINDER_DAYS} days.`, { iconName: "calendar", compact: true })}</div>`}
    </div>`;
}

// Payments history under the debts view; receipts open in a new tab.
// The permissions are passed in by the caller so the row actions match exactly
// the set the debts register offers on the same screen.
function renderPaymentsTable(mayEdit = can("edit"), mayDelete = can("delete")) {
  const mayApprove = can("validate_finance") && canSeeFinancial();
  const paymentStatus = state.filters?.paymentStatus || "";
  const payments = [...(state.payments || [])].filter((payment) => !paymentStatus || payment.status === paymentStatus).sort((a, b) => String(b.paid_at).localeCompare(String(a.paid_at)));
  if (!payments.length && paymentStatus) return `<div class="panel">${emptyState(paymentStatus === "pending" ? "No payment is waiting for approval" : "No payments match", paymentStatus === "pending" ? "Everything recorded has been approved." : "Choose “All payments” to see the rest.", { iconName: "check", compact: true })}</div>`;
  if (!payments.length) return `<div class="panel">${emptyState("No payments recorded", "Use “Record payment” on an installment to log money received, with its transaction reference and proof.", { iconName: "money", compact: true })}</div>`;
  const rows = payments.map((payment) => {
    // Only a pending payment (not yet counted) is corrected or deleted; an
    // approved one is reversed with a reason so the ledger keeps it.
    const pending = payment.status === "pending";
    const mayDeleteThis = mayDelete && pending;
    const remove = mayDeleteThis ? `<button class="btn btn-danger-ghost btn-small" data-action="delete-payment" data-id="${payment.id}" title="Delete payment">Delete payment</button>` : "";
    const edit = mayEdit && pending ? `<button class="btn btn-small" data-action="edit-payment" data-id="${payment.id}" title="Correct this payment">Edit payment</button>` : "";
    const reverse = mayApprove && payment.status === "approved" ? `<button class="btn btn-danger-ghost btn-small" data-action="reverse-payment" data-id="${payment.id}" title="Reverse this approved payment">Reverse payment</button>` : "";
    // Finance approves a pending payment; the server re-checks authority, scope
    // and that the approver is not the person who recorded it.
    // While MKUYU has a single Finance person the server lets them approve their
    // own entries (marked self-approved); otherwise a second person must.
    const ownEntry = Number(payment.created_by) === Number(state.organization.me?.user?.id);
    const approve = mayApprove && payment.status === "pending" && (!ownEntry || state.organization.me?.sole_finance_approver)
      ? `<button class="btn btn-primary btn-small" data-action="approve-payment" data-id="${payment.id}">Approve Payment</button>`
      : "";
    const receipt = payment.has_receipt
      ? `<button class="btn btn-small" data-action="open-receipt" data-id="${payment.id}">${icon("receipt")}Receipt</button>`
      : payment.evidence_text ? `<span class="muted cell-plain" title="${escapeHtml(payment.evidence_text)}">Message attached</span>` : `<span class="muted cell-plain">No proof</span>`;
    const approval = payment.status === "pending"
      ? badge("Pending approval", "pending")
      : payment.status === "reversed"
        ? `${badge("Reversed", "rejected")}<span class="cell-sub">${payment.reversed_by_name ? `by ${escapeHtml(payment.reversed_by_name)}` : ""}${payment.reversal_reason ? ` · ${escapeHtml(payment.reversal_reason)}` : ""}</span>`
        : `${badge("Approved", "approved")}${payment.approved_by_name ? `<span class="cell-sub">by ${escapeHtml(payment.approved_by_name)}${payment.self_approved ? " · self-approved (single Finance)" : ""}</span>` : ""}`;
    const mkuyuReceipt = payment.status === "approved" && payment.receipt_number
      ? `<button class="btn btn-small" data-action="mkuyu-receipt" data-id="${payment.id}" data-filename="${escapeHtml(payment.receipt_number)}.pdf" title="Download the MKUYU receipt for the customer">${icon("receipt")}${escapeHtml(payment.receipt_number)}</button>`
      : "";
    return `<tr data-searchable><td><span class="cell-main">${escapeHtml(payment.client_name)}</span><span class="cell-sub">${escapeHtml(payment.project_name || "")}</span></td><td>${formatDate(payment.paid_at, String(payment.paid_at).length > 10)}</td><td>${badge(humanize(payment.method), "neutral")}</td><td class="amount amount-positive">${money(payment.amount)}</td><td><span class="mono">${escapeHtml(payment.reference || "—")}</span></td><td>${approval}</td><td><div class="row-actions">${approve}${mkuyuReceipt}${receipt}${rowMenu([edit, reverse, remove])}</div></td></tr>`;
  }).join("");
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Client / project</th><th>Paid on</th><th>Method</th><th>Amount</th><th>Reference</th><th>Approval</th><th class="align-right">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>${pager("payments")}`;
}

function renderReports() {
  const filters = state.reportFilters;
  const types = state.reportTypes || [];
  const history = state.reportHistory || [];
  const typeOptions = types.map((type) => `<option value="${escapeHtml(type.id)}" ${filters.reportType === type.id ? "selected" : ""}>${escapeHtml(type.label)}</option>`).join("");
  const sourceOptions = `<option value="">All sources</option><option value="generated" ${filters.source === "generated" ? "selected" : ""}>Generated</option><option value="uploaded" ${filters.source === "uploaded" ? "selected" : ""}>Uploaded</option>`;
  const projectHistoryOptions = `<option value="">All projects</option>${projectOptions(filters.projectId)}`;
  const rows = history.map((report) => {
    const date = formatDateTime(report.created_at, true);
    // DELETE on /reports is gated by the method permission like every module
    // route, so the control follows can("delete") rather than always rendering.
    const remove = can("delete") ? `<button class="btn btn-danger-ghost btn-small" data-action="delete-report" data-id="${report.id}" title="Delete report">Delete report</button>` : "";
    const reexport = report.source === "generated" ? `<button class="btn btn-small" data-action="reexport-report" data-id="${report.id}" title="Re-generate this report">Re-export</button>` : "";
    return `<tr>
      <td><span class="cell-main">${escapeHtml(report.title)}</span><span class="cell-sub">${escapeHtml(reportTypeLabel(report.report_type))}</span></td>
      <td>${sourceBadge(report.source)}</td>
      <td>${reportKindBadge(report.file_format)}</td>
      <td><span class="cell-sub cell-plain">${escapeHtml(report.project_name || "—")}</span></td>
      <td>${escapeHtml(date)}</td>
      <td class="align-right">
        <div class="row-actions">
          <button class="btn btn-small" data-action="download-report" data-id="${report.id}" data-format="${escapeHtml(report.file_format || "xlsx")}" data-source="${escapeHtml(report.source)}">Download</button>
          ${rowMenu([reexport, remove])}
        </div>
      </td>
    </tr>`;
  }).join("");
  const filtered = Boolean(filters.source || filters.reportType || filters.projectId || filters.search || filters.from || filters.to);
  const emptyActions = `${can("view_reports") ? `<button class="btn btn-primary" data-action="open-report-generate">${icon("chart")}Generate a report</button>` : ""}${can("export") ? `<button class="btn" data-action="open-report-upload">Upload a report</button>` : ""}`;
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-filters">
        <label class="toolbar-search">${icon("search")}<input class="filter-input" data-filter="search" type="search" value="${escapeHtml(filters.search)}" placeholder="Search title or filename" aria-label="Search reports"></label>
        <select class="filter-input" data-filter="source" aria-label="Filter by source">${sourceOptions}</select>
        <select class="filter-input" data-filter="reportType" aria-label="Filter by report type"><option value="">All types</option>${typeOptions}</select>
        <select class="filter-input" data-filter="projectId" aria-label="Filter by project">${projectHistoryOptions}</select>
        <span class="toolbar-range"><input class="filter-input" data-filter="from" type="date" value="${escapeHtml(filters.from || "")}" aria-label="From date"><span class="muted">to</span><input class="filter-input" data-filter="to" type="date" value="${escapeHtml(filters.to || "")}" aria-label="To date"></span>
      </div>
      <div class="toolbar-end"><span class="toolbar-count">${history.length} report${history.length === 1 ? "" : "s"}</span>${pageActions()}</div>
    </div>
    ${rows ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Report</th><th>Source</th><th>Format</th><th>Project</th><th>Created</th><th class="align-right">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="panel">${filtered
      ? emptyState("No reports match these filters", "Try a wider date range or clear the filters.", { iconName: "search" })
      : emptyState("No reports yet", "Generate a report from live records, or upload an existing report file to keep it in the history.", { iconName: "chart", action: emptyActions })}</div>`}`;
}

// A property's state per category. A property for sale has a sale state
// (available / reserved / sold); one for rent a rent state (available /
// reserved / rented). Offered for both, each closes on its own, or both at
// once. Mirrors models/propertyStatus.js on the server.
const STATE_WORD = { available: "Available", reserved: "Reserved", sold: "Sold", rented: "Rented" };
const STATE_BADGE = { available: "available", reserved: "reserved", sold: "sold", rented: "leased" };
function propertyCategories(property) {
  const list = [];
  if (property.offer_buy) list.push({ key: "sale", field: "sale_status", label: "For sale", closed: "sold", state: property.sale_status || "available" });
  if (property.offer_rent) list.push({ key: "rent", field: "rent_status", label: "For rent", closed: "rented", state: property.rent_status || "available" });
  return list;
}
/** Badges for the card: one per category ("For sale · Sold"), else the overall status. */
function propertyStateBadges(property) {
  const categories = propertyCategories(property);
  if (!categories.length) return badge(property.status);
  return categories.map((category) => badgeVariant(`${category.label} · ${STATE_WORD[category.state]}`, STATE_BADGE[category.state])).join("");
}
/** The "⋯" menu's status choices, according to how the property is offered. */
function propertyStatusActions(property) {
  const categories = propertyCategories(property);
  const item = (label, change, confirm = "") => ({ label, change, confirm });
  if (!categories.length) {
    // Not offered for sale or rent: the overall status, as before.
    return [["available", "Mark as available"], ["reserved", "Mark as reserved"], ["sold", "Mark as sold"], ["leased", "Mark as rented"]]
      .filter(([status]) => status !== property.status)
      .map(([status, label]) => item(label, { status }, status === "sold" || status === "leased" ? (status === "sold" ? "sold" : "rented") : ""));
  }
  const both = categories.length === 2;
  const actions = [];
  if (both && categories.some((category) => category.state !== category.closed)) {
    actions.push(item("Mark as sold and rented (both)", { sale_status: "sold", rent_status: "rented" }, "sold and rented"));
  }
  for (const category of categories) {
    const word = category.closed === "sold" ? "sold" : "rented";
    const which = both ? (category.key === "sale" ? " for sale" : " for rent") : "";
    if (category.state !== category.closed) actions.push(item(`Mark as ${word}`, { [category.field]: category.closed }, word));
    if (category.state === "available") actions.push(item(`Mark as reserved${which}`, { [category.field]: "reserved" }));
    if (category.state !== "available") actions.push(item(category.key === "sale" ? "Open for sale again" : "Open for rent again", { [category.field]: "available" }));
  }
  return actions;
}
async function changePropertyStatus(id, change, name, closing) {
  // Closing a category is confirmed: the website will show it as sold/rented.
  if (closing) {
    const ok = await confirmDialog({ title: `Mark as ${closing}`, message: `${name || "This property"} will be marked ${closing}. The public website shows it as ${closing.toUpperCase()} on that page and stops taking requests there.`, confirmLabel: `Mark as ${closing}`, tone: "primary" });
    if (!ok) return;
  }
  try {
    await api(`/properties/${id}`, { method: "PUT", body: JSON.stringify(change) });
    invalidateRecord("properties", id);
    showToast(`${name || "Property"} updated.`);
    await refresh();
  } catch (error) {
    showToast(error.message || "Unable to change the status.");
  }
}

function renderProperties() {
  const filters = state.filters;
  const rows = (state.properties || []).filter((property) =>
    (!filters.project || String(property.project_id) === filters.project) &&
    (!filters.propertyStatus || property.status === filters.propertyStatus) &&
    (!filters.type || property.property_type === filters.type)
  );
  const list = rows.map((property) => {
    const price = money(property.price);
    const number = `P-${String(property.id).padStart(4, "0")}`;
    // `cover_image_id` is only set by the server when the file really exists, so
    // no cover markup is emitted for a picture that would 404. A picture that
    // still fails to load swaps to the same designed fallback, never a broken
    // image icon.
    const cover = property.cover_image_id
      ? `<div class="property-cover"><img data-src="${API_ROOT}/properties/${property.id}/images/${property.cover_image_id}/file" alt="${escapeHtml(property.name)}" loading="lazy"><div class="property-cover-fallback" aria-hidden="true" hidden>${icon("image")}<span>Photo unavailable</span></div></div>`
      : `<div class="property-cover property-cover-empty">${icon("image")}<span>No photo yet</span></div>`;
    const facts = [
      property.area ? `${numberValue(property.area).toLocaleString()} m²` : "",
      property.bedrooms ? `${property.bedrooms} bed` : "",
      property.bathrooms ? `${property.bathrooms} bath` : "",
      property.image_count ? `${property.image_count} photo${Number(property.image_count) === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    const edit = canChange("properties", "edit") ? `<button class="btn btn-small" data-action="edit-property" data-id="${property.id}">Edit</button>` : "";
    // Delete: holders of `delete`, or Sales (the server refuses a property a
    // contract names, and says to mark it sold or rented instead).
    const mayDeleteProperty = canChange("properties", "delete") || (canChange("properties", "edit") && can("submit_contract"));
    const remove = mayDeleteProperty ? `<button class="btn btn-small btn-danger-ghost" data-action="delete-property" data-id="${property.id}" title="Delete property">Delete property</button>` : "";
    // The "⋯" menu: change the property's status in one click.
    const statusItems = canChange("properties", "edit")
      ? propertyStatusActions(property).map((action) => `<button class="btn btn-small" data-action="property-status" data-id="${property.id}" data-change="${escapeHtml(JSON.stringify(action.change))}" data-closing="${escapeHtml(action.confirm)}" data-name="${escapeHtml(property.name)}">${escapeHtml(action.label)}</button>`)
      : [];
    return `<article class="property-card" data-searchable>
      <div class="property-media">${cover}<div class="property-badges">${propertyStateBadges(property)}${property.featured ? `<span class="badge badge-featured">Featured</span>` : ""}</div></div>
      <div class="property-body">
        <div class="property-head">
          <div class="property-name" title="${escapeHtml(property.name)}">${escapeHtml(property.name)}</div>
          <span class="property-number">${number}</span>
        </div>
        <div class="property-sub">${escapeHtml(property.project_name || "No project")} · ${escapeHtml(humanize(property.property_type))}</div>
        ${property.location ? `<div class="property-location">${icon("pin")}<span>${escapeHtml(property.location)}</span></div>` : ""}
        ${facts.length ? `<div class="property-facts">${facts.map((fact) => `<span>${escapeHtml(fact)}</span>`).join("")}</div>` : ""}
      </div>
      <div class="property-foot">
        <div class="property-price"><span>Price</span><strong>${price}</strong></div>
        <div class="row-actions">${edit}${rowMenu([...statusItems, remove])}</div>
      </div>
    </article>`;
  }).join("");
  const mayCreate = canChange("properties", "create");
  const filtered = Boolean(filters.project || filters.propertyStatus || filters.type);
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-filters">
        <span class="toolbar-label">${icon("search")}Filter</span>
        <select class="filter-input" data-filter="project" aria-label="Filter by project">
          <option value="">All projects</option>
          ${(state.projects || []).map((p) => `<option value="${p.id}" ${filters.project === String(p.id) ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
        </select>
        <select class="filter-input" data-filter="propertyStatus" aria-label="Filter by property status">
          <option value="">All statuses</option>
          <option value="available" ${filters.propertyStatus === "available" ? "selected" : ""}>Available</option>
          <option value="reserved" ${filters.propertyStatus === "reserved" ? "selected" : ""}>Reserved</option>
          <option value="sold" ${filters.propertyStatus === "sold" ? "selected" : ""}>Sold</option>
          <option value="leased" ${filters.propertyStatus === "leased" ? "selected" : ""}>Leased</option>
        </select>
        <select class="filter-input" data-filter="type" aria-label="Filter by property type">
          <option value="">All types</option>
          <option value="land" ${filters.type === "land" ? "selected" : ""}>Land</option>
          <option value="house" ${filters.type === "house" ? "selected" : ""}>House</option>
          <option value="apartment" ${filters.type === "apartment" ? "selected" : ""}>Apartment</option>
          <option value="villa" ${filters.type === "villa" ? "selected" : ""}>Villa</option>
          <option value="commercial" ${filters.type === "commercial" ? "selected" : ""}>Commercial</option>
          <option value="penthouse" ${filters.type === "penthouse" ? "selected" : ""}>Penthouse</option>
        </select>
      </div>
      <div class="toolbar-end"><span class="toolbar-count">${rows.length} propert${rows.length === 1 ? "y" : "ies"}</span>${pageActions()}</div>
    </div>
    ${rows.length
      ? `<div class="property-grid">${list}</div>${pager("properties")}`
      : `<div class="panel">${filtered
        ? emptyState("No properties match these filters", "Try a different project, status or type.", { iconName: "search" })
        : emptyState("No properties yet", "Properties are the core of the portfolio: price, location, status and photos.", { iconName: "home", action: mayCreate ? `<button class="btn btn-primary" data-action="new-property">${icon("plus")}Create your first property</button>` : "" })}</div>`}`;
}

function renderClients() {
  const filters = state.filters;
  const rows = (state.clients || []).filter((client) =>
    (!filters.project || String(client.project_id) === filters.project) &&
    (!filters.clientStatus || client.status === filters.clientStatus)
  );
  const list = rows.map((client) => {
    const initials = String(client.name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
    const edit = can("edit") ? `<button class="btn btn-small" data-action="edit-client" data-id="${client.id}">Edit</button>` : "";
    const remove = can("delete") ? `<button class="btn btn-small btn-danger-ghost" data-action="delete-client" data-id="${client.id}" title="Delete client">Delete client</button>` : "";
    return `<article class="client-card" data-searchable>
      <div class="client-head">
        <span class="avatar" aria-hidden="true">${escapeHtml(initials || "?")}</span>
        <div class="client-title"><div class="client-name">${escapeHtml(client.name)}</div><div class="client-type">${escapeHtml(humanize(client.client_type))}${client.project_name ? ` · ${escapeHtml(client.project_name)}` : ""}</div></div>
        ${badge(client.status === "lead" ? "Lead / prospect" : client.status, client.status)}
      </div>
      <div class="client-meta">
        ${client.email ? `<a class="contact-line" href="mailto:${escapeHtml(client.email)}">${icon("mail")}<span>${escapeHtml(client.email)}</span></a>` : ""}
        ${client.phone ? `<a class="contact-line" href="tel:${escapeHtml(String(client.phone).replace(/\s+/g, ""))}">${icon("phone")}<span>${escapeHtml(client.phone)}</span></a>` : ""}
        ${!client.email && !client.phone ? `<span class="contact-line muted">${icon("user")}<span>No contact details yet</span></span>` : ""}
        ${client.notes ? `<p class="client-notes">${escapeHtml(client.notes)}</p>` : ""}
      </div>
      <div class="client-foot">
        <span class="muted">Added ${formatDate(client.created_at)}</span>
        <div class="row-actions">${edit}${rowMenu([remove])}</div>
      </div>
    </article>`;
  }).join("");
  const mayCreate = canModule("clients") && can("create");
  const filtered = Boolean(filters.project || filters.clientStatus);
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-filters">
        <span class="toolbar-label">${icon("search")}Filter</span>
        <select class="filter-input" data-filter="project" aria-label="Filter by project">
          <option value="">All projects</option>
          ${(state.projects || []).map((p) => `<option value="${p.id}" ${filters.project === String(p.id) ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
        </select>
        <select class="filter-input" data-filter="clientStatus" aria-label="Filter by client status">
          <option value="">All statuses</option>
          <option value="lead" ${filters.clientStatus === "lead" ? "selected" : ""}>Lead / prospect</option>
          <option value="active" ${filters.clientStatus === "active" ? "selected" : ""}>Active</option>
          <option value="inactive" ${filters.clientStatus === "inactive" ? "selected" : ""}>Inactive</option>
        </select>
      </div>
      <div class="toolbar-end"><span class="toolbar-count">${rows.length} client${rows.length === 1 ? "" : "s"}</span>${pageActions()}</div>
    </div>
    ${rows.length
      ? `<div class="client-grid">${list}</div>${pager("clients")}`
      : `<div class="panel">${filtered
        ? emptyState("No clients match these filters", "Try a different project or status.", { iconName: "search" })
        : emptyState("No clients yet", "A client can be registered as a lead or prospect before any contract exists.", { iconName: "users", action: mayCreate ? `<button class="btn btn-primary" data-action="new-client">${icon("plus")}Add your first client</button>` : "" })}</div>`}`;
}

// Leads: the enquiry queue. Uses the existing /org/leads endpoints and the
// existing #lead-form submit and convert-lead handlers, so nothing new is
// authorized here - the view is only offered to holders of the leads module.
function renderLeads() {
  // Website Buy/Rent requests have their own view (Requests).
  const leads = (state.organization.leads || []).filter((lead) => lead.source !== "website");
  const status = state.filters.status || "";
  const statuses = [...new Set(leads.map((lead) => lead.status).filter(Boolean))].sort();
  const rows = leads.filter((lead) => !status || lead.status === status);
  const mayCreate = can("create");
  // Only Sales hands requests to Customer Service; the MD follows, read only.
  const mayHandOff = mayHandOffRequests();
  const means = { phone: "Phone", whatsapp: "WhatsApp", email: "Email" };
  const list = rows.map((lead) => {
    const website = String(lead.source || "").startsWith("website");
    const interest = [
      lead.service ? badge(SERVICE_LABELS[lead.service] || lead.service, "open") : "",
      lead.budget ? `<span class="cell-sub">Budget TZS ${escapeHtml(Number(lead.budget).toLocaleString("en-US"))}</span>` : "",
      lead.preferred_contact ? `<span class="cell-sub">Contact by ${escapeHtml(means[lead.preferred_contact] || lead.preferred_contact)}</span>` : "",
    ].join("");
    return `<tr data-searchable>
      <td><span class="cell-main">${escapeHtml(lead.name)}</span><span class="cell-sub">${escapeHtml([lead.email, lead.phone].filter(Boolean).join(" · ") || "No contact details")}</span></td>
      <td>${website ? badge(lead.source === "website" ? "Website request" : "Website enquiry", "open") : escapeHtml(lead.source || "Direct")}</td>
      <td>${lead.client_id ? badge("Converted", "converted") : badge(lead.status || "new", lead.status === "new" ? "open" : lead.status)}</td>
      <td>${formatDate(lead.created_at)}</td>
      <td class="cell-note">${interest}${escapeHtml(lead.notes || "")}</td>
      <td><div class="row-actions">${mayHandOff && !lead.client_id ? `<button class="btn btn-small" data-action="hand-off-lead" data-id="${lead.id}" title="Assign Customer Service to contact this customer">Hand to Customer Service</button>` : ""}${lead.client_id ? `<span class="muted cell-plain">Now a client</span>` : (mayApproveClients() ? `<button class="btn btn-small btn-primary" data-action="convert-lead" data-id="${lead.id}" title="Register this person as a client (prospect)">Convert to client</button>` : "")}</div></td>
    </tr>`;
  }).join("");
  const form = mayCreate ? `<details class="panel add-panel"${leads.length ? "" : " open"}><summary>${icon("plus")}Add a lead</summary>
      <form id="lead-form" class="form-grid">
        <div class="field"><label for="lead-name">Name</label><input id="lead-name" name="name" required maxlength="120" placeholder="Person or company"></div>
        <div class="field"><label for="lead-source">Source</label><input id="lead-source" name="source" maxlength="120" placeholder="Website, referral, walk-in…"></div>
        <div class="field"><label for="lead-contact">Email</label><input id="lead-contact" name="email" type="email" maxlength="120" placeholder="customer@example.com"></div>
        <div class="field"><label for="lead-phone">Phone</label><input id="lead-phone" name="phone" maxlength="40" placeholder="+255 700 000 000"></div>
        <div class="field full"><label for="lead-notes">Interest / notes</label><textarea id="lead-notes" name="notes" maxlength="2000" placeholder="What are they looking for?"></textarea></div>
        <div class="full row-actions"><button class="btn btn-primary" type="submit">Save lead</button></div>
      </form></details>` : "";
  content.innerHTML = `
    <div class="toolbar"><div class="toolbar-filters"><span class="toolbar-label">${icon("search")}Filter</span><select class="filter-input" data-filter="status" aria-label="Filter by lead status"><option value="">All statuses</option>${statuses.map((value) => `<option value="${escapeHtml(value)}" ${status === value ? "selected" : ""}>${escapeHtml(humanize(value))}</option>`).join("")}</select></div><div class="toolbar-end"><span class="toolbar-count">${rows.length} lead${rows.length === 1 ? "" : "s"}</span></div></div>
    ${form}
    ${rows.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Lead</th><th>Source</th><th>Status</th><th>Received</th><th>Interest</th><th class="align-right">Next step</th></tr></thead><tbody>${list}</tbody></table></div>` : `<div class="panel">${emptyState(status ? "No leads with this status" : "No leads yet", status ? "Try another status." : "Enquiries from the website, referrals and walk-ins are recorded here, then converted into clients.", { iconName: "spark" })}</div>`}`;
  const lead = document.getElementById("lead-form");
  if (lead) markRequiredFields(lead);
}

// Requests: every Buy/Rent request from the website. Its stage follows the
// Customer Service task it was handed to, so the list shows at a glance what
// is new, who is contacting the customer, and which reports wait for Sales.
const REQUEST_STAGES = [
  ["new", "New", "open"],
  ["existing", "Existing client", "open"],
  ["with_cs", "With Customer Service", "task-in-progress"],
  ["reported", "Report waiting for you", "submitted"],
  ["appointment", "Appointment booked", "approved"],
  ["contacted", "Interested - follow up", "approved"],
  ["unreachable", "Not reached", "pending"],
  ["closed", "Declined", "archived"],
  ["client", "Became a client", "converted"],
  // Contact-page messages: Customer Service answers them directly.
  ["message", "Message for Customer Service", "open"],
  ["answered", "Answered", "approved"],
];

/** A question sent from the website's Contact page (not a Buy/Rent/Sell request). */
function isContactMessage(row) {
  return row.source === "website-contact";
}
function inCustomerService() {
  return (state.organization.me?.user?.departments || []).some((department) => String(department.name).toUpperCase() === "CUSTOMER SERVICE");
}
/** Sales owns website requests end to end; the MD follows them, read only. */
function inSales() {
  return (state.organization.me?.user?.departments || []).some((department) => String(department.name).toUpperCase() === "SALES, MARKETING & OPERATIONS");
}
function mayHandOffRequests() {
  return can("assign_tasks") && inSales();
}

function requestStage(row) {
  if (isContactMessage(row)) {
    if (row.appointment_id) return "appointment";
    if (row.outcome === "answered") return "answered";
    // Handed to Customer Service as a task: it follows that task.
    if (row.task_id && row.task_status !== "cancelled") {
      if (["submitted", "under_review"].includes(row.task_status)) return "reported";
      if (["approved", "completed"].includes(row.task_status)) return "answered";
      return "with_cs";
    }
    return "message";
  }
  if (row.appointment_id) return "appointment";
  if (row.client_id) return "client";
  if (!row.task_id || row.task_status === "cancelled") return row.existing_client_id ? "existing" : "new";
  if (["submitted", "under_review"].includes(row.task_status)) return "reported";
  if (["approved", "completed"].includes(row.task_status)) {
    // An "appointment" outcome whose appointment was since deleted goes back to
    // Sales to arrange again, instead of claiming a booking that no longer exists.
    return { declined: "closed", unreachable: "unreachable" }[row.outcome] || "contacted";
  }
  return "with_cs";
}

/** Whether this request is waiting on the person looking at it. */
function requestNeedsMe(row) {
  const stage = requestStage(row);
  if (isContactMessage(row) && stage === "message") return inCustomerService();
  const mine = row.task_id && Number(row.task_assignee_id) === Number(state.organization.me?.user?.id);
  if (mine) return stage === "with_cs";
  if (!mayHandOffRequests()) return false;
  return ["new", "existing", "reported"].includes(stage);
}

async function loadRequests() {
  state.requestsRequested = true;
  try { state.requests = await api("/org/requests"); }
  catch (error) { state.requests = []; if (state.view === "requests") showToast(error.message || "Unable to load requests."); }
}

function reloadRequests() {
  state.requests = null;
  state.requestsRequested = false;
  return loadRequests();
}

/**
 * "Become a client": only Sales and the MD approve it, and the approver is
 * recorded. When the customer matches an existing client (same phone or
 * email) the approver says whether it is the same person or a new client, so
 * the contract made later belongs to the right client.
 */
function mayApproveClients() {
  return canModule("leads") && (inSales() || can("approve_management"));
}
async function openBecomeClient(leadId) {
  const row = [...(state.requests || []), ...(state.organization.leads || [])].find((entry) => String(entry.id) === String(leadId));
  const name = row?.name || "This customer";
  const done = async (mode) => {
    const client = await api(`/org/leads/${leadId}/convert`, { method: "POST", body: JSON.stringify({ mode }) });
    await refresh();
    if (state.requests) { await reloadRequests(); if (state.view === "requests") render(); }
    return `${name} is now a client${client?.name && client.name !== name ? ` (${client.name})` : ""}.`;
  };
  if (row?.existing_client_id) {
    openSmallForm(`Become a client · ${name}`, "This customer has the same phone or email as a client already on record. Is it the same person?",
      `<div class="field full">
        <label class="check-field"><input type="radio" name="mode" value="existing" required checked> Same person as client <strong>${escapeHtml(row.existing_client_name || "")}</strong> (link this request to that client)</label>
        <label class="check-field"><input type="radio" name="mode" value="new"> A different person: create a new client <strong>${escapeHtml(name)}</strong></label>
      </div>`,
      "Approve as client",
      async (data) => done(data.mode === "new" ? "new" : "existing"));
    return;
  }
  const ok = await confirmDialog({ title: "Become a client", message: `${name} will be registered as a client. Contracts for this customer will be made on this client.`, confirmLabel: "Approve as client", tone: "primary" });
  if (!ok) return;
  try { showToast(await done("new")); } catch (error) { showToast(error.message || "Unable to approve the client."); }
}

/**
 * Where a request stands, in words, from the request and its Customer Service
 * task: what happened last (and who did it) and who acts next. It changes at
 * every step, so anyone following the request (the MD) sees the real moment.
 */
function requestProgress(row, key) {
  const cs = row.task_assignee || "Customer Service";
  const sales = row.task_reviewer || row.task_assigned_by || "Sales";
  const when = (value) => (value ? ` · ${formatDateTime(value, true)}` : "");
  switch (key) {
    case "new":
    case "existing":
      return { done: row.task_status === "cancelled" ? "The last hand-off was cancelled" : "", next: "Waiting for Sales to hand it to Customer Service" };
    case "message":
      return { done: "Message from the Contact page", next: "Waiting for Customer Service to answer" };
    case "with_cs":
      if (row.task_status === "in_progress") return { done: `${cs} is contacting the customer`, next: "Waiting for Customer Service to report back" };
      if (row.task_status === "changes_requested") return { done: `${sales} asked ${cs} for more detail`, next: "Waiting for Customer Service to respond" };
      return { done: `Handed to ${cs} by ${row.task_assigned_by || "Sales"}${when(row.handed_off_at)}`, next: "Waiting for Customer Service to respond" };
    case "reported":
      return { done: `${cs} reported back${when(row.task_submitted_at)}`, next: `Waiting for ${sales} (Sales) to approve the report` };
    case "contacted":
      return { done: `Report approved by ${row.task_approved_by || sales}${when(row.task_approved_at)}`, next: "Waiting for Sales to arrange the appointment" };
    case "answered":
      return { done: row.task_id ? `Report approved by ${row.task_approved_by || sales}` : "Answered by Customer Service", next: row.task_id ? "Waiting for Sales to arrange the appointment" : "Done" };
    case "appointment":
      return { done: `Appointment booked${row.appointment_starts_at ? ` for ${formatDateTime(row.appointment_starts_at, true)}` : ""}`, next: "Sales meets the customer" };
    case "unreachable":
      return { done: `${cs} could not reach the customer`, next: "Waiting for Sales to decide" };
    case "closed":
      return { done: "The customer declined", next: "Closed" };
    case "client":
      return { done: `Became a client${row.client_name ? `: ${row.client_name}` : ""}${row.converted_by_name ? ` · approved by ${row.converted_by_name}` : ""}${when(row.converted_at)}`, next: "Continue under Clients" };
    default:
      return { done: "", next: "" };
  }
}

function renderRequests() {
  if (!state.requests) { content.innerHTML = `<div class="panel">${emptyState("Loading requests", "", { iconName: "inbox", compact: true })}</div>`; return; }
  const all = state.requests;
  const stage = state.requestStage || "";
  const rows = all.filter((row) => !stage || requestStage(row) === stage);
  // Only Sales hands requests to Customer Service; the MD follows, read only.
  const mayHandOff = mayHandOffRequests();
  // Converting a request into a client is Sales's step too.
  const mayCreate = can("create") && (inSales() || inCustomerService());
  const means = { phone: "Phone", whatsapp: "WhatsApp", email: "Email" };
  const count = (key) => all.filter((row) => requestStage(row) === key).length;
  // Only stages that hold requests (plus All and the one chosen), so the row
  // of tabs fits the page instead of running off it.
  const tabs = [["", "All", all.length], ...REQUEST_STAGES.map(([key, label]) => [key, label, count(key)]).filter(([key, , n]) => n > 0 || key === stage)]
    .map(([key, label, n]) => `<button class="seg-btn${stage === key ? " active" : ""}" data-action="request-stage" data-stage="${key}" aria-pressed="${stage === key}">${escapeHtml(label)} (${n})</button>`).join("");
  const me = Number(state.organization.me?.user?.id);
  const note = (text) => `<span class="muted cell-plain">${escapeHtml(text)}</span>`;
  const list = rows.map((row) => {
    const key = requestStage(row);
    let [, label, tone] = REQUEST_STAGES.find(([k]) => k === key);
    // The Customer Service officer holding the task sees their own step, not
    // Sales's: "Report outcome" while it is theirs, "Report sent" afterwards.
    const mineToReport = row.task_id && Number(row.task_assignee_id) === me;
    if (mineToReport && key === "reported") label = "Report sent to Sales";
    const progress = requestProgress(row, key);
    const who = progress.done ? `<span class="cell-sub request-progress">${escapeHtml(progress.done)}</span>` : "";
    const nextLine = progress.next ? `<span class="cell-sub request-next"><strong>Next:</strong> ${escapeHtml(progress.next)}</span>` : "";
    const known = row.existing_client_id && !row.client_id ? `<span class="cell-sub">Same phone/email as client <strong>${escapeHtml(row.existing_client_name || "")}</strong>: when approving, choose same person or new client</span>` : "";
    const reported = row.outcome && key !== "new" ? `<span class="cell-sub">${outcomeText(row.outcome, row.outcome_note, row.appointment_at, row.appointment_type)}</span>` : "";
    const cancelled = !row.client_id && row.task_status === "cancelled" ? `<span class="cell-sub">The last hand-off was cancelled</span>` : "";
    const openTaskBtn = (primary) => row.task_id ? `<button class="btn btn-small${primary ? " btn-primary" : ""}" data-action="open-task" data-id="${row.task_id}">${primary ? (mayHandOff ? "Review report" : "View report") : (mayHandOff ? "Open assignment" : "View")}</button>` : "";
    // Only Sales (assign_tasks) hands requests over; everyone else is told who acts next.
    const handOff = mayHandOff ? `<button class="btn btn-small btn-primary" data-action="hand-off-lead" data-id="${row.id}">Hand to Customer Service</button>` : note("Waiting for Sales to hand it to Customer Service");
    const convert = (primary) => mayApproveClients() && !row.client_id ? `<button class="btn btn-small${primary ? " btn-primary" : ""}" data-action="convert-lead" data-id="${row.id}" title="${row.service === "sell" ? "MKUYU accepts this owner as a Seller Client" : "Approve this customer as a client (only Sales and the MD can)"}">${row.service === "sell" ? "Accept as seller client" : "Become a client"}</button>` : "";
    // An accepted seller (a Seller Client) goes on to a Sell contract.
    const sellContractBtn = row.service === "sell" && row.client_id && canAuthorContracts()
      ? `<button class="btn btn-small btn-primary" data-action="generate-contract" data-deal="sell" data-client-id="${row.client_id}" data-client-name="${escapeHtml(row.name)}" data-client-phone="${escapeHtml(row.phone || "")}" data-client-email="${escapeHtml(row.email || "")}" title="Create the Sell contract for this seller">Create Sell contract</button>`
      : "";
    // After Customer Service's report is approved, Sales arranges the appointment.
    const arrangeBtn = (primary) => mayArrangeAppointments() && row.task_id && ["approved", "completed"].includes(row.task_status)
      ? `<button class="btn btn-small${primary ? " btn-primary" : ""}" data-action="arrange-appointment" data-id="${row.id}">${row.appointment_id ? "Change appointment" : "Arrange appointment"}</button>` : "";
    let next = {
      new: handOff,
      existing: handOff + convert(false),
      with_cs: mineToReport ? `<button class="btn btn-small btn-primary" data-action="request-outcome" data-id="${row.task_id}">Report outcome to Sales</button>` : openTaskBtn(false),
      reported: mineToReport ? note("Waiting for Sales to approve") + openTaskBtn(false) : openTaskBtn(true),
      contacted: arrangeBtn(true) + convert(!arrangeBtn(true)) + openTaskBtn(false),
      appointment: `${sellContractBtn}${arrangeBtn(false)}<button class="btn btn-small" data-action="open-alert-view" data-view="appointments">Open Appointments</button>`,
      unreachable: (mayHandOff ? handOff.replace("Hand to Customer Service", "Hand off again") : note("Waiting for Sales to decide")) + openTaskBtn(false),
      closed: openTaskBtn(false),
      client: sellContractBtn || arrangeBtn(true) || `<span class="muted cell-plain">Continue under Clients</span>`,
      message: inCustomerService() && can("edit")
        ? `<button class="btn btn-small btn-primary" data-action="answer-message" data-id="${row.id}">Mark answered</button>`
        : mayHandOff ? handOff : note("Customer Service answers this message"),
      answered: row.task_id ? arrangeBtn(true) + convert(false) + openTaskBtn(false) : note("Answered by Customer Service"),
    }[key];
    // A message handed to Customer Service is answered with a written report.
    if (isContactMessage(row) && key === "with_cs") {
      next = mineToReport ? `<button class="btn btn-small btn-primary" data-action="open-task" data-id="${row.task_id}">Write report to Sales</button>` : openTaskBtn(false);
    }
    // Someone who follows requests without acting on them (the MD) sees where
    // it stands and can open what was done; never a button to act.
    if (!mayHandOff && !inCustomerService()) {
      const views = `${row.task_id ? openTaskBtn(false) : ""}${key === "appointment" ? `<button class="btn btn-small" data-action="open-alert-view" data-view="appointments">Open Appointments</button>` : ""}`;
      // The MD approves "Become a client" too (one of the two who may).
      const approve = ["existing", "contacted", "answered", "unreachable"].includes(key) ? convert(false) : "";
      next = `${approve}${views}` || note(progress.next);
    }
    // What Customer Service wrote back, on the request itself.
    const reportLine = row.task_report && !/^Outcome:/.test(row.task_report) && key !== "answered" && row.task_report !== row.outcome_note
      ? `<span class="cell-sub request-report"><strong>Report:</strong> ${escapeHtml(row.task_report)}</span>` : "";
    const wants = isContactMessage(row)
      ? `${badge("Message", "neutral")}<span class="cell-sub">${escapeHtml((String(row.notes || "").match(/^Website enquiry · ([^\n]*)/) || [])[1] || "General question")}</span>`
      : `${row.service ? badge(SERVICE_LABELS[row.service] || row.service, "open") : ""}<span class="cell-sub">${escapeHtml(row.service === "sell" ? `Their property: ${sellSummary(row.sell_details)}` : (row.property_name || "Property no longer listed"))}</span>`;
    const answeredNote = isContactMessage(row) && row.outcome_note ? `<span class="cell-sub">Reply: ${escapeHtml(row.outcome_note)}</span>` : "";
    return `<tr data-searchable>
      <td><span class="cell-main">${escapeHtml(row.name)}</span><span class="cell-sub">${escapeHtml([row.phone, row.email].filter(Boolean).join(" · ") || "No contact details")}</span><span class="cell-sub">W-${row.id}</span></td>
      <td>${wants}</td>
      <td>${row.budget ? `${row.service === "sell" ? "Asking " : ""}TZS ${escapeHtml(Number(row.budget).toLocaleString("en-US"))}` : (row.service === "sell" ? "No asking price" : "—")}<span class="cell-sub">Contact by ${escapeHtml(means[row.preferred_contact] || "Phone")}</span></td>
      <td>${formatDate(row.created_at)}</td>
      <td>${badge(label, tone)}${isContactMessage(row) ? `${who}${nextLine}${answeredNote}${reportLine}` : `${known}${who}${nextLine}${reported}${reportLine}`}</td>
      <td class="cell-note">${escapeHtml(String(row.notes || "").replace(/^Website request to [^\n]*\n*/, "").replace(/^Website enquiry · [^\n]*\n*/, "") || "—")}</td>
      <td class="align-right"><div class="row-actions">${next}</div></td>
    </tr>`;
  }).join("");
  content.innerHTML = `
    <div class="toolbar"><div class="toolbar-filters"><div class="segmented" role="group" aria-label="Request stages">${tabs}</div></div><div class="toolbar-end"><span class="toolbar-count">${rows.length} request${rows.length === 1 ? "" : "s"}</span></div></div>
    ${rows.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Customer</th><th>Wants</th><th>Budget</th><th>Received</th><th>Stage</th><th>Message</th><th class="align-right">Next step</th></tr></thead><tbody>${list}</tbody></table></div>`
      : `<div class="panel">${emptyState(stage ? "No requests at this stage" : "No requests yet", stage ? "Try another stage." : "When a visitor asks to buy, rent or sell on the website, or writes on the Contact page, it arrives here.", { iconName: "inbox" })}</div>`}`;
}

/** The MD (management approval) and Sales (contract submission) close held meetings. */
function mayCompleteAppointments() {
  return canChange("appointments", "edit") && (can("approve_management") || can("submit_contract"));
}

function openCompleteAppointment(aptId) {
  const apt = (state.appointments || []).find((row) => String(row.id) === String(aptId));
  if (!apt) return;
  openSmallForm(`Mark as done · ${apt.title}`, "Confirms this meeting took place. It moves to Completed with your name on it.",
    `<div class="field full"><label for="apt-outcome">Outcome (optional)</label><textarea id="apt-outcome" name="note" rows="3" maxlength="2000" placeholder="e.g. Client viewed the plot and will pay the deposit on Friday"></textarea></div>`,
    "Mark as done",
    async (data) => {
      await api(`/appointments/${apt.id}/complete`, { method: "PUT", body: JSON.stringify({ note: data.note || "" }) });
      return "Appointment marked as done.";
    });
}

function renderAppointments() {
  const filters = state.filters;
  const rows = (state.appointments || []).filter((apt) =>
    (!filters.project || String(apt.project_id) === filters.project) &&
    (!filters.appointmentStatus || apt.status === filters.appointmentStatus) &&
    (!filters.type || apt.appointment_type === filters.type)
  ).sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
  const timeOf = (value) => {
    if (!value) return "";
    const date = new Date(String(value).replace(" ", "T"));
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(date);
  };
  const list = rows.map((apt) => {
    const start = timeOf(apt.starts_at);
    const end = timeOf(apt.ends_at);
    // Everyone sees the whole calendar; the server marks which rows this person may change.
    const mine = apt.can_edit !== false;
    const edit = mine && canChange("appointments", "edit") ? `<button class="btn btn-small" data-action="edit-appointment" data-id="${apt.id}">Edit</button>` : "";
    const remove = mine && canChange("appointments", "delete") ? `<button class="btn btn-small btn-danger-ghost" data-action="delete-appointment" data-id="${apt.id}" title="Delete appointment">Delete appointment</button>` : "";
    // The MD and Sales confirm a meeting took place (server re-checks both).
    const done = mine && apt.status === "scheduled" && mayCompleteAppointments() ? `<button class="btn btn-small btn-primary" data-action="complete-appointment" data-id="${apt.id}" title="Confirm this meeting took place">${icon("check")}Mark as done</button>` : "";
    const doneBy = apt.status === "completed" && apt.completed_by_name ? `<span>${icon("check")}Done · ${escapeHtml(apt.completed_by_name)}${apt.completed_at ? ` · ${formatDateTime(apt.completed_at, true)}` : ""}</span>` : "";
    return `<article class="apt-row${apt.status === "cancelled" ? " is-muted" : ""}" data-searchable>
      <div class="date-chip date-chip-lg">${appointmentDateChip(apt.starts_at)}</div>
      <div class="apt-body">
        <div class="apt-title-line"><div class="apt-title">${escapeHtml(apt.title)}</div>${badge(apt.status)}</div>
        <div class="apt-meta">
          <span>${icon("clock")}${start ? `${escapeHtml(start)}${end ? ` – ${escapeHtml(end)}` : ""}` : "Time not set"}</span>
          <span>${icon("user")}${escapeHtml(apt.client_name || "—")}</span>
          ${apt.property_name ? `<span>${icon("home")}${escapeHtml(apt.property_name)}</span>` : ""}
          ${apt.project_name ? `<span>${icon("building")}${escapeHtml(apt.project_name)}</span>` : ""}
          <span class="apt-type">${badge(apt.appointment_type, "neutral")}</span>
          ${doneBy}
        </div>
        ${apt.notes ? `<p class="apt-notes">${escapeHtml(apt.notes)}</p>` : ""}
      </div>
      <div class="apt-actions">${done || edit || remove ? `${done}${edit}${rowMenu([remove])}` : `<span class="muted" title="You can see this appointment but not change it">View only</span>`}</div>
    </article>`;
  }).join("");
  const mayCreate = canChange("appointments", "create");
  const filtered = Boolean(filters.project || filters.appointmentStatus || filters.type);
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-filters">
        <span class="toolbar-label">${icon("search")}Filter</span>
        <select class="filter-input" data-filter="project" aria-label="Filter by project">
          <option value="">All projects</option>
          ${(state.projects || []).map((p) => `<option value="${p.id}" ${filters.project === String(p.id) ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
        </select>
        <select class="filter-input" data-filter="appointmentStatus" aria-label="Filter by appointment status">
          <option value="">All statuses</option>
          <option value="scheduled" ${filters.appointmentStatus === "scheduled" ? "selected" : ""}>Scheduled</option>
          <option value="completed" ${filters.appointmentStatus === "completed" ? "selected" : ""}>Completed</option>
          <option value="cancelled" ${filters.appointmentStatus === "cancelled" ? "selected" : ""}>Cancelled</option>
        </select>
        <select class="filter-input" data-filter="type" aria-label="Filter by appointment type">
          <option value="">All types</option>
          <option value="viewing" ${filters.type === "viewing" ? "selected" : ""}>Viewing</option>
          <option value="call" ${filters.type === "call" ? "selected" : ""}>Call</option>
          <option value="meeting" ${filters.type === "meeting" ? "selected" : ""}>Meeting</option>
          <option value="inspection" ${filters.type === "inspection" ? "selected" : ""}>Inspection</option>
        </select>
      </div>
      <div class="toolbar-end"><span class="toolbar-count">${rows.length} appointment${rows.length === 1 ? "" : "s"}</span>${pageActions()}</div>
    </div>
    ${rows.length
      ? `<div class="apt-list">${list}</div>${pager("appointments")}`
      : `<div class="panel">${filtered
        ? emptyState("No appointments match these filters", "Try a different project, status or type.", { iconName: "search" })
        : emptyState("No appointments scheduled", "Book viewings, calls, meetings and inspections with clients.", { iconName: "calendar", action: mayCreate ? `<button class="btn btn-primary" data-action="new-appointment">${icon("plus")}Schedule an appointment</button>` : "" })}</div>`}`;
}

// Contract templates: the Word files contracts are generated on. Uploading a
// template, choosing the default and removing unused ones are reserved to the
// `upload_contract_templates` permission, which the server enforces.
function renderTemplatesPage() {
  content.innerHTML = renderTemplates();
  const form = document.getElementById("template-upload-form");
  if (form) markRequiredFields(form);
}

function renderTemplates() {
  if (!state.templatesLoaded && !state.templatesRequested) {
    state.templatesRequested = true;
    Promise.all([
      api("/contract-templates").catch(() => []),
      state.placeholders ? Promise.resolve(state.placeholders) : api("/contract-placeholders").catch(() => []),
    ]).then(([templates, placeholders]) => {
      state.contractTemplates = templates;
      state.placeholders = placeholders;
      state.templatesLoaded = true;
      if (state.view === "templates") render();
    });
  }
  const templates = state.contractTemplates || [];
  const mayCreate = can("upload_contract_templates");
  const rows = templates.map((template) => {
    const download = template.has_file ? `<button class="btn btn-small" data-action="template-download" data-id="${template.id}" data-filename="${escapeHtml(template.original_filename || `${template.title}.docx`)}">Download</button>` : "";
    const makeDefault = !template.is_default && mayCreate ? `<button class="btn btn-small" data-action="template-default" data-id="${template.id}">Make default</button>` : "";
    const remove = mayCreate && !template.used_by ? `<button class="btn btn-small btn-danger-ghost" data-action="template-delete" data-id="${template.id}">Delete template</button>` : "";
    return `<tr>
      <td><span class="cell-main">${escapeHtml(template.title)}</span><span class="cell-sub">${escapeHtml(template.original_filename || "Typed template")}</span></td>
      <td>${template.letterhead ? badge("Letterhead", "open") : badge("Full wording", "neutral")}<span class="cell-sub">${escapeHtml(template.deal_type ? `${contractKind(template.deal_type)?.title || template.deal_type} contracts only` : "Any contract type")}</span></td>
      <td>${template.is_default ? badge("Default", "approved") : `<span class="muted cell-plain">—</span>`}</td>
      <td>${escapeHtml(template.uploaded_by_name || "—")}</td>
      <td>${formatDate(template.uploaded_at || template.created_at)}</td>
      <td>${Number(template.used_by || 0)} contract${Number(template.used_by) === 1 ? "" : "s"}</td>
      <td><div class="row-actions">${download}${rowMenu([makeDefault, remove])}</div></td>
    </tr>`;
  }).join("");
  const placeholders = (state.placeholders || []).map((entry) => `<li><code>{{${escapeHtml(entry.token)}}}</code><span>${escapeHtml(entry.label || "")}</span></li>`).join("");
  return `
    <div class="template-guide panel">
      <div class="panel-head"><div><h2 class="panel-title">How contract templates work</h2><div class="panel-note">When a contract is generated, the system asks whether it is for Buying, Renting or Company and seller, writes that agreement, and places it on the default template.</div></div><a class="btn btn-small" href="#" data-action="template-starter">${icon("file")}Download starter letterhead</a></div>
      <div class="panel-body">
        <ol class="guide-steps">
          <li><strong>Letterhead template (recommended).</strong> Put the company's logo, name and address in the Word <em>header</em> and <em>footer</em> (Insert → Header), and type <code>{{CONTRACT_BODY}}</code> on the page where the agreement text goes. One letterhead serves all three contract types. The starter letterhead is ready to use.</li>
          <li><strong>Longer contracts keep the template.</strong> The agreement (introduction, property and title deed, price, payment, obligations, termination, signatures) continues onto as many pages as it needs, and the header and footer repeat on every page. A picture placed <em>Behind text</em> (a page border or background) is repeated on every page too.</li>
          <li><strong>Full-wording template (optional).</strong> Your own agreement text for one type, with placeholders such as <code>{{CLIENT_NAME}}</code>, <code>{{TITLE_DEED_NUMBER}}</code>, <code>{{FINAL_PRICE}}</code>. Choose the type it is for when uploading.</li>
          <li>Put <code>{{LAWYER_SIGNATURE}}</code> where the lawyer signs; at Legal approval the lawyer's signature is placed there.</li>
        </ol>
        ${placeholders ? `<details class="placeholder-list"><summary>Placeholders you can use (${(state.placeholders || []).length})</summary><ul>${placeholders}</ul></details>` : ""}
      </div>
    </div>
    ${mayCreate ? `<form id="template-upload-form" class="panel template-upload">
      <div class="panel-head"><div><h2 class="panel-title">Upload a template</h2><div class="panel-note">Word .docx only. Your layout is kept exactly: letterhead, logo, fonts, tables, headers and footers. Only the <code>{{PLACEHOLDERS}}</code> are filled in.</div></div></div>
      <div class="panel-body form-grid">
        <div class="field full"><label for="template-file">Template file (.docx)</label><input id="template-file" name="file" type="file" accept=".docx" required></div>
        <div class="field"><label for="template-title">Template name</label><input id="template-title" name="title" maxlength="160" placeholder="e.g. MKUYU Letterhead 2026"></div>
        <div class="field"><label for="template-deal-type">Used for</label><select id="template-deal-type" name="deal_type"><option value="">Any contract type (letterhead)</option>${CONTRACT_KINDS.map((kind) => `<option value="${kind.type}">${escapeHtml(kind.title)} only · ${escapeHtml(kind.agreement)}</option>`).join("")}</select></div>
        <div class="field"><label class="checkbox-field"><input type="checkbox" name="is_default" value="true" ${templates.length ? "" : "checked"}><span>Use as default for new contracts</span></label></div>
        <div class="full row-actions"><button class="btn btn-primary" type="submit">${icon("plus")}Upload template</button></div>
      </div>
    </form>` : ""}
    ${!state.templatesLoaded ? `<div class="loading"><div class="spinner" aria-hidden="true"></div><span>Loading templates…</span></div>`
      : rows ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Template</th><th>Kind</th><th>Default</th><th>Uploaded by</th><th>Date</th><th>Used by</th><th class="align-right">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="panel">${emptyState("No templates yet", "Contracts use the built-in MKUYU letterhead (logo, header and page numbers on every page) until you upload your own.", { iconName: "file", compact: true })}</div>`}`;
}

function renderDocuments() {
  const filters = state.filters;
  const rows = (state.documents || []).filter((doc) =>
    (!filters.project || String(doc.project_id) === filters.project) &&
    (!filters.documentStatus || doc.status === filters.documentStatus) &&
    (!filters.type || doc.category === filters.type) &&
    (!filters.documentSearch || String(doc.title || "").toLowerCase().includes(filters.documentSearch.toLowerCase()))
  ).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const list = rows.map((doc) => {
    const hasFile = doc.has_file;
    const related = [
      doc.contract_client ? `Contract · ${doc.contract_client}` : "",
      doc.client_name ? `Client · ${doc.client_name}` : "",
      doc.project_name ? `Project · ${doc.project_name}` : "",
    ].filter(Boolean);
    const fileName = doc.original_filename || doc.file_name || "";
    // Open and Download exist only for a document whose file is really stored;
    // a record without a file gets neither, never a dead link.
    const view = doc.category === "agreement" && doc.contract_id && canModule("contracts") ? `<button class="btn btn-small" data-action="view-generated-contract" data-id="${doc.contract_id}">View</button>` : "";
    const open = hasFile ? `<button class="btn btn-small" data-action="open-document" data-id="${doc.id}">Open</button>` : "";
    const download = hasFile ? `<button class="btn btn-small btn-ghost" data-action="download-generated-document" data-id="${doc.id}" data-filename="${escapeHtml(fileName || "document")}">Download</button>` : "";
    const edit = can("edit") ? `<button class="btn btn-small" data-action="edit-document" data-id="${doc.id}">Edit details</button>` : "";
    const remove = can("delete") ? `<button class="btn btn-small btn-danger-ghost" data-action="delete-document" data-id="${doc.id}" title="Delete document">Delete document</button>` : "";
    return `<article class="doc-row" data-searchable>
      <div class="doc-icon">${documentIcon(doc.category)}</div>
      <div class="doc-body">
        <div class="doc-title">${escapeHtml(doc.title)}</div>
        <div class="doc-meta">
          <span>${escapeHtml(humanize(doc.category))}</span>
          ${related.map((entry) => `<span>${escapeHtml(entry)}</span>`).join("")}
          ${hasFile ? `<span>${escapeHtml(fileName)}${doc.file_size ? ` · ${formatBytes(doc.file_size)}` : ""}</span>` : `<span class="muted">No file attached</span>`}
          ${doc.file_reference ? `<span>Ref · ${escapeHtml(doc.file_reference)}</span>` : ""}
          ${doc.uploaded_by_name ? `<span>By ${escapeHtml(doc.uploaded_by_name)}</span>` : ""}
        </div>
        ${doc.notes ? `<p class="doc-notes">${escapeHtml(doc.notes)}</p>` : ""}
      </div>
      <div class="doc-date">${formatDate(doc.uploaded_at || doc.created_at)}</div>
      <div class="doc-status">${badge(doc.status)}</div>
      <div class="doc-actions">${view}${open}${rowMenu([download, edit, remove])}</div>
    </article>`;
  }).join("");
  const mayCreate = canModule("documents") && can("create");
  const filtered = Boolean(filters.project || filters.documentStatus || filters.type || filters.documentSearch);
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-filters">
        <label class="toolbar-search">${icon("search")}<input class="filter-input" data-filter="documentSearch" type="search" value="${escapeHtml(filters.documentSearch || "")}" placeholder="Search document titles" aria-label="Search documents"></label>
        <select class="filter-input" data-filter="project" aria-label="Filter by project">
          <option value="">All projects</option>
          ${(state.projects || []).map((p) => `<option value="${p.id}" ${filters.project === String(p.id) ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
        </select>
        <select class="filter-input" data-filter="type" aria-label="Filter by document category">
          <option value="">All categories</option>
          <option value="agreement" ${filters.type === "agreement" ? "selected" : ""}>Agreement</option>
          <option value="title" ${filters.type === "title" ? "selected" : ""}>Title</option>
          <option value="invoice" ${filters.type === "invoice" ? "selected" : ""}>Invoice</option>
          <option value="receipt" ${filters.type === "receipt" ? "selected" : ""}>Receipt</option>
          <option value="report" ${filters.type === "report" ? "selected" : ""}>Report</option>
          <option value="permit" ${filters.type === "permit" ? "selected" : ""}>Permit</option>
          <option value="other" ${filters.type === "other" ? "selected" : ""}>Other</option>
        </select>
        <select class="filter-input" data-filter="documentStatus" aria-label="Filter by document status">
          <option value="">All statuses</option>
          <option value="pending" ${filters.documentStatus === "pending" ? "selected" : ""}>Pending</option>
          <option value="approved" ${filters.documentStatus === "approved" ? "selected" : ""}>Approved</option>
          <option value="archived" ${filters.documentStatus === "archived" ? "selected" : ""}>Archived</option>
        </select>
      </div>
      <div class="toolbar-end"><span class="toolbar-count">${rows.length} document${rows.length === 1 ? "" : "s"}</span>${pageActions()}</div>
    </div>
    ${rows.length
      ? `<div class="doc-table"><div class="doc-table-head" aria-hidden="true"><span></span><span>Document</span><span>Date</span><span>Status</span><span class="align-right">Actions</span></div><div class="document-list">${list}</div></div>${pager("documents")}`
      : `<div class="panel">${filtered
        ? emptyState("No documents match these filters", "Try a different search, project, category or status.", { iconName: "search" })
        : emptyState("No documents yet", "Generated contracts, receipts, title deeds and permits are stored here.", { iconName: "folder", action: mayCreate ? `<button class="btn btn-primary" data-action="new-document">${icon("plus")}Upload a document</button>` : "" })}</div>`}`;
}

/**
 * The page's primary create action, gated exactly as the topbar gated it before
 * the redesign. It now sits at the end of each register's toolbar - next to the
 * filters it relates to - instead of being repeated in the topbar AND the page.
 */
function pageActions() {
  const view = (name, permission) => state.view === name && canChange(name, permission);
  const plus = icon("plus");
  return (
    view("projects", "create") ? `<button class="btn btn-primary" data-action="new-project">${plus}New project</button>` :
    view("properties", "create") ? `<button class="btn btn-primary" data-action="new-property">${plus}New property</button>` :
    view("clients", "create") ? `<button class="btn btn-primary" data-action="new-client">${plus}New client</button>` :
    view("contracts", "create") && canAuthorContracts() ? `<button class="btn btn-primary" data-action="generate-contract">${icon("contract")}Generate contract</button>` :
    view("appointments", "create") ? `<button class="btn btn-primary" data-action="new-appointment">${plus}New appointment</button>` :
    view("documents", "create") ? `<button class="btn btn-primary" data-action="new-document">${plus}New document</button>` :
    state.view === "reports" && canModule("reports") && can("view_reports") ? `${can("export") ? `<button class="btn" data-action="open-report-upload">Upload report</button>` : ""}<button class="btn btn-primary" data-action="open-report-generate">${icon("chart")}Generate report</button>` :
    "");
}

function render() {
  const [title, sub] = viewMeta[state.view] || ["Workspace", ""];
  pageTitle.textContent = title;
  pageSub.textContent = sub;
  // The topbar carries the title, search and notifications only; each page
  // renders its own primary action beside its filters (see pageActions()).
  topbarActions.innerHTML = "";
  if (state.loading) { renderLoading(); return; }
  // The admin overview needs the organization counters, which load lazily.
  if (state.view === "admin-dashboard" && !adminExtrasLoaded) {
    loadAdminExtras().then(() => { if (state.view === "admin-dashboard") render(); });
  }
  if (state.view === "dashboard") renderDashboard();
  if (state.view === "admin-dashboard") renderAdminDashboard();
  if (state.view === "projects") renderProjects();
  if (state.view === "properties") renderProperties();
  if (state.view === "clients") renderClients();
  if (state.view === "contracts") renderContracts();
  if (state.view === "debts") renderDebts();
  if (state.view === "reminders") renderReminders();
  if (state.view === "appointments") renderAppointments();
  if (state.view === "leads") renderLeads();
  addPageTip();
  if (state.view === "requests") {
    renderRequests();
    addPageTip();
    if (!state.requests && !state.requestsRequested) loadRequests().then(() => { updateNavigation(); if (state.view === "requests") render(); });
  }
  if (state.view === "documents") renderDocuments();
  if (state.view === "templates") renderTemplatesPage();
  if (state.view === "reports") renderReports();
  if (state.view === "organization") content.innerHTML = renderOrganization("staff");
  if (state.view === "departments") content.innerHTML = renderOrganization("departments");
  if (state.view === "roles") content.innerHTML = renderOrganization("roles");
  if (state.view === "system") {
    content.innerHTML = renderOrganization("system");
    if (!state.backups && !state.backupsRequested) loadBackups().then(() => { if (state.view === "system") render(); });
  }
  if (state.view === "assignments") {
    content.innerHTML = renderAssignments();
    addPageTip();
    // Loaded on demand, like the duty catalogue. The guard stops a failed
    // request from retrying on every repaint.
    if (!state.tasks && !state.tasksRequested) loadTasks().then(() => { if (state.view === "assignments") render(); });
  }
  if (state.view === "duties") {
    content.innerHTML = renderDuties();
    // Reference data, fetched the first time this view is opened rather than on
    // every workspace load. The guard stops a failed request retrying forever.
    if (!state.duties && !state.dutiesRequested) loadDuties().then(() => { if (state.view === "duties") render(); });
  }
  // The record-allocation panel is administrator-only and loads on demand. The
  // `allocationRequested` guard means a failed load is not retried on every
  // render, which previously produced an unbounded request loop.
  if (state.view === "system" && isAdmin() && !state.allocation && !state.allocationRequested) loadAllocation().then(() => { if (state.view === "system") render(); });
  // Authenticated image blobs for property covers, etc.
  hydrateImages(content);
  applySearch();
  updateNotificationDot();
}

/* --------------------------------------------------------------------------
   Topbar search

   Searching moved to the SERVER. Only one page of each list is resident in the
   browser, so filtering the loaded rows would search 50 of 12,000 and report the
   rest as "not found" - which is worse than no search, because it looks like an
   answer. The term now goes to the API, which applies it inside the same scoped,
   ordered query that produced the page.

   Two views have no server-side search: the dashboard and the Administration
   screen, which are built from aggregates rather than a single list. For those
   the previous in-page behaviour is kept - and it is still correct, because
   both views render rows the workspace loaded in full.
   -------------------------------------------------------------------------- */
const SEARCHABLE_VIEWS = {
  contracts: "contracts",
  clients: "clients",
  properties: "properties",
  debts: "debts",
  documents: "documents",
  appointments: "appointments",
  projects: "projects",
};

let searchTimer = null;
// The term the server was last asked to apply, per list. Without this the
// render -> applySearch -> loadList -> render cycle never settles: every render
// re-issues the same search, and with a synchronous timer (as in the test
// sandbox) that recurses until the stack is exhausted. In a browser it is merely
// a request storm, re-fetching on every unrelated repaint.
const appliedSearch = new Map();

function applySearch() {
  const raw = (globalSearch?.value || "").trim();
  const term = raw.toLowerCase();
  const kind = SEARCHABLE_VIEWS[state.view];
  if (kind) {
    // A register: ask the server, but only when the term has actually changed.
    if ((appliedSearch.get(kind) || "") === raw) return;
    appliedSearch.set(kind, raw);
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      loadList(kind, { page: 1, search: raw, force: true });
    }, 250);
    return;
  }
  // Dashboard / Administration: hide non-matching rows in place. Everything on
  // screen here came from a scoped aggregate, so this still only ever narrows.
  for (const node of content.querySelectorAll("[data-searchable]")) {
    // `hidden` is authoritative over any component display rule, so a filtered
    // row cannot be resurrected by a `display: flex` rule further down the sheet.
    node.hidden = Boolean(term) && !node.textContent.toLowerCase().includes(term);
  }
}

/* --------------------------------------------------------------------------
   Notifications
   The dot summarises work the caller can already open. Every count is derived
   from the same workspace payload the screens render, so nothing extra is
   fetched and nothing the caller cannot open is implied.
   -------------------------------------------------------------------------- */
function alertSummary() {
  const alerts = [];
  // Counts come from the server's SCOPED rollup, never from `state.X.length`.
  // With only one page resident, a `.length` here would report "12 overdue" when
  // the caller may actually have 400 - confidently wrong rather than obviously
  // broken, which is the worst failure mode for an alert. `summary` already
  // computes the overdue and pending figures with the same scope predicate.
  // Every alert carries `key` and `source` (item keys or a count), so the bell
  // can tell what is new since the person last opened it.
  const summary = state.summary || {};
  const attention = state.attention || {};
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const add = (key, count, label, view, source = count) => { if (count) alerts.push({ key, count, label, view, source }); };
  add("tasks-mine", Number(attention.mine || 0), `${plural(Number(attention.mine || 0), "new task")} assigned to you`, "assignments");
  add("tasks-review", Number(attention.review || 0), `${plural(Number(attention.review || 0), "task")} waiting for your review`, "assignments");
  const sources = navSources();
  add("requests", sources.requests.length, `${plural(sources.requests.length, "request")} from the website waiting for you`, "requests", sources.requests);
  add("contracts", sources.contracts.length, `${plural(sources.contracts.length, "contract")} waiting for your step`, "contracts", sources.contracts);
  if (canModule("debts") && canSeeFinancial()) {
    const overdue = Number(summary.debts_overdue?.count || 0);
    add("overdue", overdue, `${plural(overdue, "overdue installment")}`, "debts");
  }
  if (canModule("reminders") && canSeeFinancial()) {
    const due = state.reminders || [];
    add("reminders-due", due.length, `${plural(due.length, "payment")} due within 3 days: remind the client`, "reminders", due.map((reminder) => reminder.id));
    const soon = state.upcomingReminders || [];
    add("reminders-soon", soon.length, `${plural(soon.length, "installment")} falling due in the next ${UPCOMING_REMINDER_DAYS} days`, "reminders", soon.map((reminder) => reminder.id));
  }
  if (canModule("appointments")) {
    const upcoming = sources.appointments;
    add("appointments", upcoming.length, `${plural(upcoming.length, "upcoming appointment")}`, "appointments", upcoming);
  }
  if (canModule("documents") && can("edit")) {
    const pending = Number(summary.documents_pending || 0);
    add("documents", pending, `${plural(pending, "document")} awaiting approval`, "documents");
  }
  return alerts.map((alert) => ({ ...alert, fresh: unseenCount(`alert:${alert.key}`, alert.source) > 0 }));
}

function updateNotificationDot() {
  // The bell counts only notifications that are NEW since it was last opened.
  const count = alertSummary().filter((alert) => alert.fresh).length;
  if (bellDot) bellDot.hidden = count === 0;
  const sideCount = document.getElementById("side-alert-count");
  if (sideCount) {
    sideCount.hidden = count === 0;
    sideCount.textContent = String(count);
  }
}

/** Opening the notifications reads them. */
function markAlertsSeen(alerts = alertSummary()) {
  for (const alert of alerts) markSeen(`alert:${alert.key}`, alert.source);
  updateNotificationDot();
}

/**
 * Keeps badges and the bell current while the app stays open: every minute
 * (while the tab is visible) the workspace is re-read quietly - no loading
 * screen, no redraw of the page being worked on - and the badges repaint.
 */
async function refreshLive() {
  if (!state.authorized || state.loading) return;
  // A hidden tab catches up the moment it is shown again.
  if (document.visibilityState !== "visible") { state.livePending = true; return; }
  state.livePending = false;
  // The workspace carries page 1 of every register. It is only re-read while
  // every register IS on page 1 with no search, so a person paging through a
  // list never has their page swapped underneath them.
  const onFirstPages = Object.values(state.listState || {}).every((entry) => !entry || ((entry.page || 1) === 1 && !entry.search));
  if (onFirstPages) {
    try { applyWorkspace(await api("/org/workspace")); } catch { return; }
  }
  await Promise.all([
    refreshAttention(),
    loadUpcomingReminders(),
    canModule("leads") && can("view") ? loadRequests() : null,
    state.view === "assignments" || state.tasks ? loadTasks() : null,
    state.view === "templates" ? (state.templatesLoaded = false, state.templatesRequested = false, null) : null,
  ]);
  updateNavigation();
  updateNotificationDot();
  // The page is redrawn in place (same scroll position) - but never under an
  // open dialog or while the person is typing: then it waits, and catches up
  // as soon as the dialog closes.
  const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && content.contains(document.activeElement);
  // Pages that hold a form of their own (template upload, staff administration)
  // are not redrawn under the person; their badges still update.
  const formPage = ["templates", "organization", "departments"].includes(state.view);
  if (!modalBackdrop.hidden || typing || formPage) { state.livePending = !formPage; return; }
  const scrollY = window.scrollY;
  render();
  window.scrollTo(0, scrollY);
}
setInterval(() => { refreshLive(); }, 60 * 1000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.livePending) refreshLive(); });

/* --------------------------------------------------------------------------
   Live updates. The server announces every change (a website request, a task
   report, a contract step, a payment, a property status) over one open
   connection; this screen then re-reads what it shows and redraws. Several
   changes in a burst cause one refresh. The once-a-minute check above stays
   as a safety net if the connection drops (it reconnects by itself).
   -------------------------------------------------------------------------- */
let liveSource = null;
let liveTimer = null;
function startLive() {
  stopLive();
  if (typeof EventSource === "undefined") return;
  try {
    liveSource = new EventSource(`${API_ROOT}/live`, { withCredentials: true });
    liveSource.addEventListener("change", () => {
      clearTimeout(liveTimer);
      liveTimer = setTimeout(() => { refreshLive(); }, 700);
    });
  } catch { liveSource = null; }
}
function stopLive() {
  clearTimeout(liveTimer);
  if (liveSource) { try { liveSource.close(); } catch { /* already closed */ } }
  liveSource = null;
}
// A change that arrived while a dialog was open is shown once it closes.
if (typeof MutationObserver !== "undefined" && modalBackdrop) {
  new MutationObserver(() => {
    if (modalBackdrop.hidden && state.livePending) setTimeout(() => { refreshLive(); }, 300);
  }).observe(modalBackdrop, { attributes: true, attributeFilter: ["hidden"] });
}

/**
 * The caller's own details, as the server reported them. Read-only: role,
 * department and scope come from /org/me and are not editable here, because a
 * user must not be able to promote themselves from the profile screen.
 */
function showProfile() {
  const me = state.organization.me || {};
  const user = me.user || {};
  const roles = (user.roles || []).map((role) => role.name).join(", ") || "No role";
  const departments = (user.departments || []).map((department) => department.name).join(", ") || "No department";
  const rows = [
    ["Name", user.display_name || "—"],
    ["Work email", user.email || "—"],
    ["Role", roles],
    ["Department", departments],
    ["Data scope", me.scope || "own"],
    ["Modules", (me.modules || []).length ? me.modules.join(", ") : "None"],
  ].map(([label, value]) => `<tr><td><span class="muted">${escapeHtml(label)}</span></td><td>${escapeHtml(String(value))}</td></tr>`).join("");
  openModal("profile", {});
  const table = modal.querySelector("table tbody");
  if (table) table.innerHTML = rows;
  const initial = escapeHtml(String(user.display_name || "?").charAt(0).toUpperCase());
  const head = document.getElementById("profile-head");
  if (head) {
    head.innerHTML = `<div class="profile-photo">${user.has_photo ? `<span>${initial}</span><img data-src="${API_ROOT}/org/users/${user.id}/photo?v=${photoVersion}" alt="Your profile photo">` : `<span>${initial}</span>`}</div>
      <div class="profile-photo-copy"><strong>${escapeHtml(user.display_name || "")}</strong><span>Profile photo · PNG or JPG, up to 15 MB</span>
        <div class="row-actions"><label class="btn btn-small btn-primary">${icon("image")}${user.has_photo ? "Change photo" : "Upload photo"}<input type="file" accept=".png,.jpg,.jpeg" data-profile-upload="photo" hidden></label>${user.has_photo ? `<button type="button" class="btn btn-small btn-ghost" data-action="remove-profile-image" data-kind="photo">Remove</button>` : ""}</div></div>`;
  }
  // Only the administrator changes their own password; staff ask the administrator.
  if (isAdmin() && head) head.insertAdjacentHTML("beforeend", `<div class="row-actions" style="margin-left:auto"><button type="button" class="btn btn-small btn-gold" data-action="change-my-password">Change my password</button></div>`);
  // Only members of Legal who approve contracts keep a signature.
  const signature = document.getElementById("profile-signature");
  if (signature && can("approve_legal")) {
    signature.innerHTML = `<div class="form-section"><h3>Contract signature</h3><p>Added automatically to a contract's document when you give Legal approval.</p></div>
      <div class="signature-box">${user.has_signature ? `<img data-src="${API_ROOT}/org/me/signature?v=${photoVersion}" alt="Your signature">` : `<span class="muted">No signature uploaded yet</span>`}</div>
      <div class="field"><label for="signature-title">Title shown under your signature</label><input id="signature-title" maxlength="120" value="${escapeHtml(user.signature_title || "")}" placeholder="e.g. Advocate · Legal Manager"></div>
      <div class="row-actions"><label class="btn btn-small btn-primary">${icon("image")}${user.has_signature ? "Replace signature" : "Upload signature"}<input type="file" accept=".png,.jpg,.jpeg" data-profile-upload="signature" hidden></label><button type="button" class="btn btn-small" data-action="save-signature-title">Save title</button>${user.has_signature ? `<button type="button" class="btn btn-small btn-ghost" data-action="remove-profile-image" data-kind="signature">Remove</button>` : ""}</div>
      <p class="field-help">Tip: sign on white paper, photograph or scan it, and crop close to the signature. A PNG with a transparent background looks best.</p>`;
  }
  hydrateImages(modal);
}

/** Re-reads the caller's profile after a photo or signature change. */
async function reloadProfile() {
  photoVersion = Date.now();
  clearImageBlobCache();
  try { state.organization.me = await api("/org/me"); } catch (_) { /* keep the old profile */ }
  renderUserAvatar();
  showProfile();
}

async function uploadProfileImage(kind, file) {
  if (!file) return;
  const payload = new FormData();
  payload.append("file", file);
  if (kind === "signature") payload.append("signature_title", document.getElementById("signature-title")?.value || "");
  try {
    await api(`/org/me/${kind}`, { method: "POST", form: true, body: payload });
    showToast(kind === "photo" ? "Profile photo updated." : "Signature saved. It will be added to contracts you approve.");
    await reloadProfile();
  } catch (error) {
    showToast(error.message || "Upload failed.");
  }
}

function showAlertsPanel() {
  const alerts = alertSummary();
  if (!alerts.length) {
    showToast("Nothing needs your attention right now.");
    return;
  }
  openModal("alerts", { alerts });
  markAlertsSeen(alerts);
}

/**
 * Live pricing preview for the contract form.
 *
 * DISPLAY ONLY. The server recomputes and persists the authoritative figures in
 * `validateContract`; a value shown here is never trusted. The arithmetic mirrors
 * `backend/src/contracts/pricing.js` exactly - integer minor units (cents), with
 * the percentage scaled to hundredths of a percent - so the figure on screen is
 * the figure that will be stored, to the cent. Rounding the raw product instead
 * would drift from the stored value on some inputs.
 */
function pricingPreview(record, originalPrice, discountPct) {
  const original = originalPrice !== undefined
    ? Number(originalPrice)
    : Number(record?.original_price ?? record?.value ?? 0);
  const percent = discountPct !== undefined ? Number(discountPct) : Number(record?.discount_pct ?? 0);
  const safeOriginal = Number.isFinite(original) && original > 0 ? original : 0;
  const safePercent = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  // original_cents * percent_hundredths / 10000 == original * percent / 100.
  const discountCents = Math.round((Math.round(safeOriginal * 100) * Math.round(safePercent * 100)) / 10000);
  const finalCents = Math.max(0, Math.round(safeOriginal * 100) - discountCents);
  return { discount_amount: discountCents / 100, final_price: finalCents / 100 };
}

function updateContractPricingPreview() {
  const original = document.getElementById("field-original-price")?.value;
  const percent = document.getElementById("field-discount-pct")?.value;
  if (original === undefined && percent === undefined) return;
  const preview = pricingPreview(null, original, percent);
  const amount = document.getElementById("field-discount-amount");
  const final = document.getElementById("field-final-price");
  if (amount) amount.value = money(preview.discount_amount);
  if (final) final.value = money(preview.final_price);
}

/**
 * The guided New Client -> Property -> Contract -> Complete step.
 *
 * A completed client needs a contract, so the form says so up front and offers
 * the contract fields alongside the client fields. Leaving Status as
 * "Lead / prospect" is always valid: the person is recorded, and the contract is
 * attached later.
 *
 * This is guidance only. The server enforces the same rule and would refuse a
 * completed client with no contract regardless of what is selected here.
 */
function clientWorkflowHelp(record) {
  if (record?.status === "active") {
    return "This client is already active. Editing the details does not change the contract that is already attached.";
  }
  return "A client can be saved as a Lead / prospect at any time. To complete the client record, create the contract in the step below - a completed client cannot be saved without one.";
}

function clientContractStep(record) {
  // Contracts are a separate module: a caller who may register a client but not
  // open the contract register gets the explanation without the form.
  if (!canModule("contracts") || !can("create")) return "";
  return `<div class="field full"><div class="section-head"><div><h2 class="section-title">Contract (required to complete this client)</h2><div class="section-note">Client + project + pricing. Leave the status as a lead to save without one.</div></div></div>
    <div class="form-grid">
      <div class="field"><label for="field-client-contract-project">Contract project</label><select id="field-client-contract-project" name="contract_project_id">${projectOptions(record?.project_id)}</select></div>
      ${dealTypeField("field-client-deal-type", "", { required: false })}<div class="field"><label for="field-client-contract-type">Agreement (new / terminal)</label><select id="field-client-contract-type" name="contract_type"><option value="new">New</option><option value="terminal">Terminal</option></select></div>
      <div class="field"><label for="field-client-original-price">Original price</label><input id="field-client-original-price" name="original_price" type="number" min="0" step="0.01" placeholder="0"></div>
      <div class="field"><label for="field-client-discount-pct">Discount %</label><input id="field-client-discount-pct" name="discount_pct" type="number" min="0" max="100" step="0.01" value="0" placeholder="0"></div>
      <div class="field"><label for="field-client-discount-amount">Discount amount</label><input id="field-client-discount-amount" type="text" value="${escapeHtml(money(0))}" readonly aria-readonly="true" tabindex="-1" title="Calculated by the system"></div>
      <div class="field"><label for="field-client-final-price">Final price</label><input id="field-client-final-price" type="text" value="${escapeHtml(money(0))}" readonly aria-readonly="true" tabindex="-1" title="Calculated by the system. The payment plan is built from this amount."></div>
    </div></div>`;
}

/** Live pricing preview for the contract step inside the client form. */
function updateClientContractPreview() {
  const original = document.getElementById("field-client-original-price")?.value;
  const percent = document.getElementById("field-client-discount-pct")?.value;
  if (original === undefined && percent === undefined) return;
  const preview = pricingPreview(null, original, percent);
  const amount = document.getElementById("field-client-discount-amount");
  const final = document.getElementById("field-client-final-price");
  if (amount) amount.value = money(preview.discount_amount);
  if (final) final.value = money(preview.final_price);
}

/** A titled group inside a form grid. Layout only: it adds no field. */
function formSection(title, note = "") {
  return `<div class="form-section full"><h3>${escapeHtml(title)}</h3>${note ? `<p>${escapeHtml(note)}</p>` : ""}</div>`;
}

/**
 * Marks every required control's label with an asterisk, so the indicator can
 * never disagree with the `required` attribute the browser actually enforces.
 */
function markRequiredFields(root) {
  root.querySelectorAll("input[required], select[required], textarea[required]").forEach((control) => {
    if (!control.id) return;
    const label = root.querySelector(`label[for="${control.id}"]`);
    if (label && !label.querySelector(".req")) label.insertAdjacentHTML("beforeend", ' <span class="req" aria-hidden="true">*</span>');
  });
}

// Property types and what each one has. Land and commercial property are
// priced and measured only; homes also have bedrooms and bathrooms (both
// optional). Mirrors PROPERTY_TYPE_ROOMS on the server.
const PROPERTY_TYPES = [["land", "Land / plot"], ["house", "House"], ["apartment", "Apartment"], ["villa", "Villa"], ["penthouse", "Penthouse"], ["commercial", "Commercial"]];
const PROPERTY_TYPE_INFO = {
  land: { rooms: false, help: "A plot of land: enter the sale price and the size in square metres." },
  house: { rooms: true, help: "A house: sale price, size in square metres, and bedrooms and bathrooms if you know them." },
  apartment: { rooms: true, help: "A flat in a building: sale price, size, bedrooms and bathrooms." },
  villa: { rooms: true, help: "A large stand-alone house, usually with a garden: sale price, size, bedrooms and bathrooms." },
  penthouse: { rooms: true, help: "A luxury flat on the top floor of a building: sale price, size, bedrooms and bathrooms." },
  commercial: { rooms: false, help: "Offices, shops or warehouses: enter the sale price and the size in square metres." },
};
function propertyTypeInfo(type) {
  return PROPERTY_TYPE_INFO[type] || PROPERTY_TYPE_INFO.house;
}
/** Shows bedrooms/bathrooms only for property types that have them. */
function wirePropertyTypeFields(container) {
  const select = container.querySelector("#field-property-type");
  if (!select) return;
  select.addEventListener("change", () => {
    const info = propertyTypeInfo(select.value);
    container.querySelectorAll("[data-rooms]").forEach((field) => {
      field.hidden = !info.rooms;
      if (!info.rooms) field.querySelector("input").value = "";
    });
    const help = container.querySelector("[data-type-help]");
    if (help) help.textContent = info.help;
  });
}

function openModal(type, record = null) {
  modal.dataset.type = type;
  let title = "Create record";
  let subtitle = "Add a new entry to the workspace";
  let body = "";
  let submitLabel = "Save record";
  if (type === "project") {
    title = record ? "Edit project" : "New project";
    subtitle = record ? "Update this development." : "Create a development portfolio.";
    body = `<div class="form-grid"><div class="field full"><label for="field-name">Project name</label><input id="field-name" name="name" required maxlength="120" value="${escapeHtml(record?.name || "")}" placeholder="e.g. Riverside Heights"></div><div class="field"><label for="field-status">Status</label><select id="field-status" name="status"><option value="active" ${record?.status !== "archived" ? "selected" : ""}>Active</option><option value="archived" ${record?.status === "archived" ? "selected" : ""}>Archived</option></select></div></div>`;
  }
  if (type === "contract") {
    title = record ? "Edit contract" : "New contract";
    subtitle = record ? "Update contract details." : "Link a client agreement to a project.";
    body = `<div class="form-grid">${formSection(record?.deal_type === "rent" ? "Client" : "Client & project")}${record?.deal_type === "rent" ? `<input type="hidden" name="project_id" value="">` : `<div class="field full"><label for="field-project">Project</label><select id="field-project" name="project_id" required><option value="">Select project</option>${projectOptions(record?.project_id)}</select></div>`}<div class="field full"><label for="field-linked-client">Client from register (optional)</label><select id="field-linked-client" name="client_id">${linkedClientOptions(record?.client_id)}</select></div><div class="field"><label for="field-client">Client name</label><input id="field-client" name="client_name" required maxlength="120" value="${escapeHtml(record?.client_name || "")}" placeholder="Client full name"></div>${dealTypeField("field-deal-type", record?.deal_type || "", { required: !record?.id })}<div class="field"><label for="field-type">Agreement (new / terminal)</label><select id="field-type" name="contract_type" required><option value="new" ${record?.contract_type === "new" ? "selected" : ""}>New</option><option value="terminal" ${record?.contract_type === "terminal" ? "selected" : ""}>Terminal</option></select></div><div class="field"><label for="field-contract-status">Status</label><select id="field-contract-status" name="status"><option value="active" ${record?.status !== "closed" && record?.status !== "cancelled" ? "selected" : ""}>Active</option><option value="closed" ${record?.status === "closed" ? "selected" : ""}>Closed</option><option value="cancelled" ${record?.status === "cancelled" ? "selected" : ""}>Cancelled</option></select></div>${formSection("Pricing", "Discount amount and final price are calculated by the system.")}<div class="field"><label for="field-original-price">Original price</label><input id="field-original-price" name="original_price" type="number" min="0" step="0.01" required value="${escapeHtml(record?.original_price ?? record?.value ?? "")}" placeholder="0"></div><div class="field"><label for="field-discount-pct">Discount %</label><input id="field-discount-pct" name="discount_pct" type="number" min="0" max="100" step="0.01" value="${escapeHtml(record?.discount_pct ?? 0)}" placeholder="0"></div><div class="field"><label for="field-discount-amount">Discount amount</label><input id="field-discount-amount" type="text" value="${escapeHtml(money(pricingPreview(record).discount_amount))}" readonly aria-readonly="true" tabindex="-1" title="Calculated by the system from the original price and discount"></div><div class="field"><label for="field-final-price">Final price</label><input id="field-final-price" type="text" value="${escapeHtml(money(pricingPreview(record).final_price))}" readonly aria-readonly="true" tabindex="-1" title="Calculated by the system. This is the amount the payment plan is built from."></div>${formSection("Agreement term")}<div class="field"><label for="field-start">Start date</label><input id="field-start" name="start_date" type="date" value="${escapeHtml(record?.start_date || "")}"></div><div class="field"><label for="field-end">End date</label><input id="field-end" name="end_date" type="date" value="${escapeHtml(record?.end_date || "")}"></div><div class="field full"><label for="field-notes">Notes</label><textarea id="field-notes" name="notes" placeholder="Property, unit, payment terms, or reference">${escapeHtml(record?.notes || "")}</textarea></div></div>`;
  }
  if (type === "schedule") {
    title = "Generate payment schedule";
    subtitle = record ? `Deposit + installments for ${escapeHtml(record.client_name)} · ${money(record.value)}` : "Deposit + equal monthly installments.";
    submitLabel = "Generate schedule";
    const hasDebts = (state.debts || []).some((debt) => String(debt.contract_id) === String(record?.id));
    const cashMode = record?.payment_mode === "cash";
    const plan = {
      deposit: Number(record?.deposit_amount ?? 0),
      installments: cashMode ? 1 : (record?.installment_count || 6),
      firstDue: String(record?.first_due_date || record?.start_date || today()).slice(0, 10),
      frequency: CONTRACT_FREQUENCIES.includes(record?.payment_frequency) ? record.payment_frequency : "monthly",
    };
    body = `<div class="form-grid">
      <div class="field"><label for="field-deposit">Deposit (first payment)</label><input id="field-deposit" name="deposit" type="number" min="0" step="0.01" value="${escapeHtml(plan.deposit)}" placeholder="0"></div>
      <div class="field"><label for="field-installments">Installments</label><input id="field-installments" name="installments" type="number" min="1" max="120" required value="${escapeHtml(plan.installments)}"></div>
      <div class="field"><label for="field-first-due">First installment due</label><input id="field-first-due" name="first_due_date" type="date" required value="${escapeHtml(plan.firstDue)}"></div>
      <div class="field"><label for="field-frequency">Frequency</label><select id="field-frequency" name="frequency">${CONTRACT_FREQUENCIES.map((value) => `<option value="${value}" ${plan.frequency === value ? "selected" : ""}>${escapeHtml(value)}</option>`).join("")}</select></div>
      ${hasDebts ? `<div class="field full"><label class="checkbox-field"><input type="checkbox" name="replace" value="yes"><span>This contract already has installments — replace them</span></label></div>` : ""}
      <div class="field full"><div class="field-help">Prefilled from the terms in the contract. The deposit is due first; the rest (${money(Math.max(0, numberValue(record?.value) - numberValue(plan.deposit, 0)))}) is split equally across the installments. The final installment absorbs rounding. Reminders are created automatically.</div></div>
    </div>`;
  }
  if (type === "payment" && !record?.id) {
    // The simple way: find the customer, paste the message, check, save.
    title = "Record payment";
    subtitle = "Find the customer, paste the bank or mobile-money message, check and save.";
    submitLabel = state.organization.me?.sole_finance_approver ? "Save only" : "Save payment";
    const methods = paymentMethodChoices();
    const prefill = record || {};
    body = `<div class="form-grid">
      <div class="field full"><label for="pay-search">Customer <span class="req">*</span></label><input id="pay-search" type="search" autocomplete="off" placeholder="Type a name, phone number or contract number"><input type="hidden" name="contract_id" id="pay-contract" value="${escapeHtml(prefill.contract_id || "")}"><div id="pay-results" class="pay-results"></div><div id="pay-selected"></div></div>
      <div class="field full"><label for="pay-message">Bank or mobile-money message</label><textarea id="pay-message" name="evidence_text" rows="3" maxlength="4000" placeholder="Paste the SMS or bank alert here. The amount, reference and date fill in by themselves."></textarea><div id="pay-message-note" class="field-help"></div></div>
      <div class="field"><label for="pay-debt">Installment</label><select id="pay-debt" name="debt_id"><option value="">Choose the customer first</option></select></div>
      <div class="field"><label for="pay-amount">Amount (TSh) <span class="req">*</span></label><input id="pay-amount" name="amount" type="number" min="0" step="0.01" required value="${escapeHtml(prefill.amount ?? "")}"></div>
      <div class="field"><label for="pay-reference">Reference <span class="req">*</span></label><input id="pay-reference" name="reference" maxlength="120" required placeholder="From the message or slip"></div>
      <div class="field"><label for="pay-date">Paid on</label><input id="pay-date" name="paid_at" type="date" required value="${today()}"></div>
      <div class="field"><label for="pay-method">Method</label><select id="pay-method" name="method">${methods.map((m) => `<option value="${escapeHtml(m.value)}"${m.value === "bank" ? " selected" : ""}>${escapeHtml(m.label)}</option>`).join("")}</select></div>
      <div class="field full" id="pay-short" hidden><div class="pay-warning" id="pay-short-text"></div><label for="pay-notes">Short reason <span class="req">*</span></label><input id="pay-notes" name="notes" maxlength="300" placeholder="e.g. will pay the rest on the 20th"></div>
      <div class="field full"><label for="pay-file">Receipt or bank slip</label><input id="pay-file" name="file" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp"><div class="field-help">Only needed when there is no message to paste.</div></div>
      <input type="hidden" name="payer_name" id="pay-payer-name"><input type="hidden" name="payer_phone" id="pay-payer-phone">
    </div>`;
  }
  if (type === "payment" && record?.id) {
    // The same form records a new payment and corrects an existing one. A
    // corrected payment goes back to "pending" so a second Finance person
    // confirms it again (the server resets the approval).
    const editing = Boolean(record?.id);
    title = editing ? "Edit payment" : "Record payment";
    subtitle = editing ? "Correct the payment details. It returns to pending approval." : "Log money received with its transaction reference and proof. It counts once a second Finance person approves it.";
    submitLabel = editing ? "Save payment" : "Record payment";
    const methods = (state.reportPaymentMethods || []).length
      ? state.reportPaymentMethods
      : [{ value: "cash", label: "Cash" }, { value: "bank", label: "Bank transfer" }, { value: "mobile", label: "Mobile money" }, { value: "card", label: "Card" }, { value: "other", label: "Other" }];
    const prefill = record || {};
    body = `<div class="form-grid">
      ${formSection("Payment")}
      <div class="field full"><label for="field-payment-contract">Contract</label><select id="field-payment-contract" name="contract_id" required><option value="">Select contract</option>${payableContractOptions(prefill.contract_id)}</select><div class="field-help">Only approved or active contracts take payments.</div></div>
      <div class="field"><label for="field-payment-debt">Installment (optional)</label><select id="field-payment-debt" name="debt_id"><option value="">None — general payment</option>${(state.debts || []).filter((debt) => !prefill.contract_id || String(debt.contract_id) === String(prefill.contract_id)).map((debt) => `<option value="${debt.id}" ${String(debt.id) === String(prefill.debt_id || "") ? "selected" : ""}>${escapeHtml(debt.client_name)} · ${money(debt.amount)} · ${formatDate(debt.due_date)}</option>`).join("")}</select></div>
      <div class="field"><label for="field-payment-amount">Amount</label><input id="field-payment-amount" name="amount" type="number" min="0" step="0.01" required value="${escapeHtml(prefill.amount ?? "")}" placeholder="0"></div>
      <div class="field"><label for="field-payment-date">Paid at</label><input id="field-payment-date" name="paid_at" type="date" required value="${escapeHtml(String(prefill.paid_at || today()).slice(0, 10))}"></div>
      <div class="field"><label for="field-payment-method">Method</label><select id="field-payment-method" name="method">${methods.map((m) => `<option value="${escapeHtml(m.value)}"${prefill.method === m.value ? " selected" : ""}>${escapeHtml(m.label)}</option>`).join("")}</select></div>
      <div class="field"><label for="field-payment-reference">Transaction reference</label><input id="field-payment-reference" name="reference" maxlength="120" required value="${escapeHtml(prefill.reference || "")}" placeholder="e.g. QJ47XK2P9A or bank ref."><div class="field-help">Required. A reference can be used only once.</div></div>
      ${formSection("Proof", "Attach the receipt or paste the message. At least one is required.")}
      <div class="field full"><label for="field-payment-receipt">${editing && prefill.has_receipt ? "Replace receipt file" : "Receipt file"}</label><input id="field-payment-receipt" name="file" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp,.bmp"><div class="field-help">Screenshot, photo or PDF of the receipt or bank slip.</div></div>
      <div class="field full"><label for="field-payment-evidence">Or paste the message</label><textarea id="field-payment-evidence" name="evidence_text" maxlength="4000" rows="3" placeholder="Paste the M-Pesa, Mixx, Airtel or bank SMS here">${escapeHtml(prefill.evidence_text || "")}</textarea></div>
      <div class="field full"><label for="field-payment-notes">Notes</label><textarea id="field-payment-notes" name="notes" maxlength="2000" placeholder="Purpose or follow-up note">${escapeHtml(prefill.notes || "")}</textarea></div>
    </div>`;
  }
  if (type === "debt") {
    title = record ? "Edit debt" : "New debt";
    subtitle = record ? "Update this client balance." : "Record an amount due from a contract.";
    body = `<div class="form-grid"><div class="field full"><label for="field-contract">Contract</label><select id="field-contract" name="contract_id" required><option value="">Select contract</option>${contractOptions(record?.contract_id)}</select></div><div class="field"><label for="field-debt-client">Client name</label><input id="field-debt-client" name="client_name" required maxlength="120" value="${escapeHtml(record?.client_name || "")}" placeholder="Client full name"></div><div class="field"><label for="field-amount">Amount due</label><input id="field-amount" name="amount" type="number" min="0" step="0.01" required value="${escapeHtml(record?.amount ?? "")}" placeholder="0"></div><div class="field"><label for="field-due">Due date</label><input id="field-due" name="due_date" type="date" value="${escapeHtml(record?.due_date || "")}"></div><div class="field"><span class="muted">Status</span><div>${record ? debtBadge(record) : badge("Pending", "pending")}</div><div class="field-help">Set by approved payments, never by hand.</div></div><div class="field full"><label for="field-debt-notes">Notes</label><textarea id="field-debt-notes" name="notes" placeholder="Installment or follow-up note">${escapeHtml(record?.notes || "")}</textarea></div></div>`;
  }
  if (type === "property") {
    title = record ? "Edit property" : "New property";
    subtitle = record ? "Update this estate listing." : "Register a new estate asset.";
    body = `<div class="form-grid">
      ${formSection("Property details")}
      <div class="field full"><label for="field-name">Property name</label><input id="field-name" name="name" required maxlength="120" value="${escapeHtml(record?.name || "")}" placeholder="e.g. Signature Residence · Phase 1"></div>
      <div class="field full"><label for="field-project">Project</label><select id="field-project" name="project_id"><option value="">Select project</option>${projectOptions(record?.project_id)}</select></div>
      <div class="field"><label for="field-location">Location</label><input id="field-location" name="location" required maxlength="120" value="${escapeHtml(record?.location || "")}" placeholder="City or area"></div>
      <div class="field"><label for="field-property-type">Type</label><select id="field-property-type" name="property_type">${PROPERTY_TYPES.map(([value, label]) => `<option value="${value}" ${(record?.property_type || "land") === value ? "selected" : ""}>${label}</option>`).join("")}</select><div class="field-help" data-type-help>${escapeHtml(propertyTypeInfo(record?.property_type || "land").help)}</div></div>
      <div class="field"><label for="field-property-status">Status</label><select id="field-property-status" name="status"><option value="available" ${record?.status === "available" ? "selected" : ""}>Available</option><option value="reserved" ${record?.status === "reserved" ? "selected" : ""}>Reserved</option><option value="sold" ${record?.status === "sold" ? "selected" : ""}>Sold</option><option value="leased" ${record?.status === "leased" ? "selected" : ""}>Leased</option></select></div>
      ${formSection("Price & size")}
      <div class="field"><label for="field-price">Sale price (TZS)</label><input id="field-price" name="price" type="number" min="0" step="0.01" value="${escapeHtml(record?.price ?? "")}" placeholder="0"></div>
      <div class="field"><label for="field-area">Size (square metres, m²)</label><input id="field-area" name="area" type="number" min="0" step="0.01" value="${escapeHtml(record?.area ?? "")}" placeholder="e.g. 600"></div>
      <div class="field" data-rooms${propertyTypeInfo(record?.property_type || "land").rooms ? "" : " hidden"}><label for="field-bedrooms">Bedrooms <span class="muted">(optional)</span></label><input id="field-bedrooms" name="bedrooms" type="number" min="0" value="${escapeHtml(record?.bedrooms || "")}" placeholder="e.g. 3"></div>
      <div class="field" data-rooms${propertyTypeInfo(record?.property_type || "land").rooms ? "" : " hidden"}><label for="field-bathrooms">Bathrooms <span class="muted">(optional)</span></label><input id="field-bathrooms" name="bathrooms" type="number" min="0" value="${escapeHtml(record?.bathrooms || "")}" placeholder="e.g. 2"></div>
      ${formSection("Listing & photos")}
      <div class="field full"><label for="field-description">Description</label><textarea id="field-description" name="description" maxlength="2000" placeholder="Property summary">${escapeHtml(record?.description || "")}</textarea></div>
      <div class="field"><label class="checkbox-field"><input type="checkbox" name="featured" ${record?.featured ? "checked" : ""}><span>Featured listing</span></label></div>
      ${record ? `<div class="field full"><label>Photos (optional)</label><div class="photo-strip" id="photo-strip" data-property-id="${record.id}">${renderPhotoStrip(record)}</div></div>` : ""}
      <div class="field full"><label for="field-photo">${record ? "Add photos" : "Photos"} (optional)</label><input id="field-photo" name="photo" type="file" multiple accept=".png,.jpg,.jpeg,.gif,.webp,.bmp" data-photo-upload><div class="field-help">Choose one photo or several at once (up to 12 per property). The first photo is the cover on the website; visitors can click through all of them.</div></div>
      ${websiteListingFields(record)}
    </div>`;
  }
  if (type === "client") {
    title = record ? "Edit client" : "New client";
    subtitle = record ? "Update this contact." : "Add a new person or organization.";
    body = `<div class="form-grid">
      ${formSection("Client details", "A client can be saved as a lead or prospect without a contract.")}
      <div class="field full"><label for="field-client-name">Full name</label><input id="field-client-name" name="name" required maxlength="120" value="${escapeHtml(record?.name || "")}" placeholder="Client full name"></div>
      <div class="field full"><label for="field-project">Project</label><select id="field-project" name="project_id"><option value="">Select project</option>${projectOptions(record?.project_id)}</select></div>
      ${formSection("Contact")}
      <div class="field"><label for="field-email">Email</label><input id="field-email" name="email" type="email" maxlength="120" value="${escapeHtml(record?.email || "")}" placeholder="contact@example.com"></div>
      <div class="field"><label for="field-phone">Phone</label><input id="field-phone" name="phone" maxlength="120" value="${escapeHtml(record?.phone || "")}" placeholder="+255 700 000 000"></div>
      ${formSection("Classification")}
      <div class="field"><label for="field-client-type">Type</label><select id="field-client-type" name="client_type"><option value="buyer" ${record?.client_type === "buyer" ? "selected" : ""}>Buyer</option><option value="seller" ${record?.client_type === "seller" ? "selected" : ""}>Seller</option><option value="landlord" ${record?.client_type === "landlord" ? "selected" : ""}>Landlord</option><option value="tenant" ${record?.client_type === "tenant" ? "selected" : ""}>Tenant</option></select></div>
      <div class="field"><label for="field-client-status">Status</label><select id="field-client-status" name="status"><option value="lead" ${record?.status === "lead" ? "selected" : ""}>Lead / prospect</option><option value="active" ${record?.status === "active" ? "selected" : ""}>Active client</option><option value="inactive" ${record?.status === "inactive" ? "selected" : ""}>Inactive</option></select></div>
      <div class="field full"><label for="field-notes">Notes</label><textarea id="field-notes" name="notes" maxlength="2000" placeholder="Relationship or preference note">${escapeHtml(record?.notes || "")}</textarea></div>
      <div class="field full"><div class="field-help">${escapeHtml(clientWorkflowHelp(record))}</div></div>
      ${clientContractStep(record)}
    </div>`;
  }
  if (type === "appointment") {
    title = record ? "Edit appointment" : "New appointment";
    subtitle = record ? "Update this schedule entry." : "Book a new viewing, call, meeting, or inspection.";
    body = `<div class="form-grid">
      ${formSection("Appointment")}
      <div class="field full"><label for="field-client">Client</label><select id="field-client" name="client_id" required><option value="">Select client</option>${clientOptions(record?.client_id)}</select></div>
      <div class="field full"><label for="field-title">Title</label><input id="field-title" name="title" required maxlength="120" value="${escapeHtml(record?.title || "")}" placeholder="e.g. Premium residence tour"></div>
      ${formSection("Where")}
      <div class="field"><label for="field-property">Property</label><select id="field-property" name="property_id"><option value="">None</option>${propertyOptions(record?.property_id)}</select></div>
      <div class="field"><label for="field-project">Project</label><select id="field-project" name="project_id"><option value="">None</option>${projectOptions(record?.project_id)}</select></div>
      <div class="field"><label for="field-type">Type</label><select id="field-type" name="appointment_type"><option value="viewing" ${record?.appointment_type === "viewing" ? "selected" : ""}>Viewing</option><option value="call" ${record?.appointment_type === "call" ? "selected" : ""}>Call</option><option value="meeting" ${record?.appointment_type === "meeting" ? "selected" : ""}>Meeting</option><option value="inspection" ${record?.appointment_type === "inspection" ? "selected" : ""}>Inspection</option></select></div>
      <div class="field"><label for="field-status">Status</label><select id="field-status" name="status"><option value="scheduled" ${record?.status === "scheduled" ? "selected" : ""}>Scheduled</option><option value="completed" ${record?.status === "completed" ? "selected" : ""}>Completed</option><option value="cancelled" ${record?.status === "cancelled" ? "selected" : ""}>Cancelled</option></select></div>
      ${formSection("When")}
      <div class="field"><label for="field-start">Start</label><input id="field-start" name="starts_at" type="datetime-local" value="${escapeHtml(record?.starts_at ? record.starts_at.replace(" ", "T") : "")}"></div>
      <div class="field"><label for="field-end">End</label><input id="field-end" name="ends_at" type="datetime-local" value="${escapeHtml(record?.ends_at ? record.ends_at.replace(" ", "T") : "")}"></div>
      <div class="field full"><label for="field-notes">Notes</label><textarea id="field-notes" name="notes" maxlength="2000" placeholder="Agenda or preparation note">${escapeHtml(record?.notes || "")}</textarea></div>
    </div>`;
  }
  if (type === "document") {
    // A prefilled record (e.g. "Upload document" on a contract) is still new.
    const editing = Boolean(record?.id);
    title = editing ? "Edit document" : record?.contract_id ? "Upload contract document" : "New document";
    subtitle = editing ? "Update this document record." : record?.contract_id ? "Attach a file to this contract, e.g. the signed copy, ID or title deed." : "Upload a file and register the document.";
    const hasFile = record?.has_file;
    body = `<div class="form-grid">
      ${formSection("Related records", "Optional links to the project, contract or client this document belongs to.")}
      <div class="field full"><label for="field-project">Project</label><select id="field-project" name="project_id"><option value="">Select project</option>${projectOptions(record?.project_id)}</select></div>
      <div class="field"><label for="field-contract">Contract</label><select id="field-contract" name="contract_id"><option value="">Select contract</option>${contractOptions(record?.contract_id)}</select></div>
      <div class="field"><label for="field-client">Client</label><select id="field-client" name="client_id"><option value="">Select client</option>${clientOptions(record?.client_id)}</select></div>
      ${formSection("Document")}
      <div class="field full"><label for="field-title">Title</label><input id="field-title" name="title" required maxlength="120" value="${escapeHtml(record?.title || "")}" placeholder="Document title"></div>
      <div class="field"><label for="field-category">Category</label><select id="field-category" name="category"><option value="agreement" ${record?.category === "agreement" ? "selected" : ""}>Agreement</option><option value="title" ${record?.category === "title" ? "selected" : ""}>Title</option><option value="invoice" ${record?.category === "invoice" ? "selected" : ""}>Invoice</option><option value="receipt" ${record?.category === "receipt" ? "selected" : ""}>Receipt</option><option value="report" ${record?.category === "report" ? "selected" : ""}>Report</option><option value="permit" ${record?.category === "permit" ? "selected" : ""}>Permit</option><option value="other" ${record?.category === "other" ? "selected" : ""}>Other</option></select></div>
      <div class="field"><label for="field-status">Status</label><select id="field-status" name="status"><option value="pending" ${record?.status === "pending" ? "selected" : ""}>Pending</option><option value="approved" ${record?.status === "approved" ? "selected" : ""}>Approved</option><option value="archived" ${record?.status === "archived" ? "selected" : ""}>Archived</option></select></div>
      ${formSection("File")}
      <div class="field full"><label for="field-file">File</label><input id="field-file" name="file" type="file" ${editing ? "disabled" : ""}>${hasFile ? `<div class="field-help">Current file: <strong>${escapeHtml(record.original_filename || record.file_name || "attached")}</strong></div>` : editing ? `<div class="field-help">Files can only be attached while creating a document.</div>` : ""}</div>
      <div class="field full"><label for="field-file-reference">File reference</label><input id="field-file-reference" name="file_reference" maxlength="120" value="${escapeHtml(record?.file_reference || "")}" placeholder="documents/onboarding-checklist.pdf"></div>
      <div class="field full"><label for="field-notes">Notes</label><textarea id="field-notes" name="notes" maxlength="2000" placeholder="Purpose or follow-up note">${escapeHtml(record?.notes || "")}</textarea></div>
    </div>`;
  }
  if (type === "report-generate") {
    title = "Generate report";
    subtitle = "Pick a report type and the filters it declares.";
    submitLabel = "Generate report";
    body = renderReportGenerateForm(record && record.report_type ? record : null);
  }
  if (type === "reset-password") {
    title = "Reset password";
    subtitle = record ? `Set a new sign-in password for ${record.display_name}.` : "Set a new sign-in password.";
    submitLabel = "Reset password";
    // The copy states the guarantee explicitly, because this is the screen where
    // an administrator is asked to reassure a member of staff that resetting does
    // not cost them their account or their history.
    body = `<div class="form-grid">
      <div class="field full"><div class="field-help">This changes the sign-in password only. The account keeps its ID, role, department, permissions, contracts, payments, documents, reports and audit history. The reset is recorded in the audit trail, and any active sessions are signed out.</div></div>
      <div class="field full"><label for="field-password">New password</label><input id="field-password" name="password" type="password" minlength="8" required autocomplete="new-password" placeholder="At least 8 characters"></div>
      <div class="field full"><label for="field-password-confirm">Confirm new password</label><input id="field-password-confirm" name="password_confirm" type="password" minlength="8" required autocomplete="new-password" placeholder="Repeat the new password"></div>
    </div>`;
  }
  if (type === "report-upload") {
    title = "Upload report";
    subtitle = "Attach an existing report file and record it in the history.";
    submitLabel = "Upload report";
    body = renderReportUploadForm();
  }
  if (type === "report-preview") {
    title = "Preview report";
    subtitle = "Generated on the fly from the current filters.";
    body = renderReportPreview();
  }
  if (type === "profile") {
    // Rows are filled in by showProfile() straight after the dialog opens, so the
    // markup here only supplies the frame.
    title = "My profile";
    subtitle = "Your photo, account, role and data scope.";
    body = `<div class="profile-head" id="profile-head"></div>
      <div class="table-wrap"><table><tbody></tbody></table></div>
      <div id="profile-signature"></div>
      <p class="field-help" style="margin-top:14px">Role, department and permissions are managed by an administrator in Administration → Users.</p>`;
  }
  if (type === "alerts") {
    // Read-only summary. Each row is derived from records the caller is already
    // authorized to see, so this reveals nothing the screens do not.
    title = "Notifications";
    subtitle = "Work waiting on you across the workspace.";
    const rows = (record?.alerts || []).map((alert) =>
      `<tr class="${alert.fresh ? "alert-fresh" : ""}"><td>${alert.fresh ? `<span class="badge badge-pending">New</span> ` : ""}${escapeHtml(alert.label)}</td><td class="align-right"><button class="btn btn-small${alert.fresh ? " btn-primary" : ""}" data-action="open-alert-view" data-view="${escapeHtml(alert.view)}">Open</button></td></tr>`
    ).join("");
    body = `<div class="table-wrap"><table><thead><tr><th>Item</th><th class="align-right">Action</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  // Read-only dialogs render outside a <form>: there is nothing to submit, and a
  // stray submit button inside a form would post an empty record on Enter.
  const isReadOnly = type === "report-preview" || type === "alerts" || type === "profile";
  const actions = `<div class="form-actions">
    <button type="button" class="btn" data-action="close-modal">${isReadOnly ? "Close" : "Cancel"}</button>
    ${type === "report-generate" ? `<button type="button" class="btn btn-soft" data-action="preview-report">Preview</button>` : ""}
    ${isReadOnly ? "" : `<button type="submit" class="btn ${type === "payment" && !record?.id && state.organization.me?.sole_finance_approver ? "btn-soft" : "btn-primary"}">${submitLabel}</button>`}
    ${type === "payment" && !record?.id && state.organization.me?.sole_finance_approver ? `<button type="submit" name="approve_now" value="1" class="btn btn-primary" title="You are the only Finance person, so you approve it now (marked self-approved)">Save &amp; approve</button>` : ""}
  </div>`;
  const head = `<div class="modal-head"><div><h2 class="modal-title" id="modal-title">${title}</h2><p class="modal-sub">${subtitle}</p></div><button class="close-btn" data-action="close-modal" aria-label="Close">${closeIcon()}</button></div>`;
  modal.innerHTML = isReadOnly
    ? `${head}<div class="modal-body">${body}</div>${actions}`
    : `${head}<form id="record-form" data-id="${escapeHtml(record?.id || "")}"><div class="modal-body">${body}</div>${actions}</form>`;
  markRequiredFields(modal);
  modalBackdrop.hidden = false;
  hydrateImages(modal);
  if (type === "payment" && !record?.id) initPaymentForm(record || {});
  if (type === "property") wirePropertyTypeFields(modal);
  const contractSelect = document.getElementById("field-contract");
  const clientInput = document.getElementById("field-debt-client");
  if (contractSelect && clientInput) {
    const syncClient = () => { const contract = state.contracts.find((item) => String(item.id) === contractSelect.value); if (contract && !record) clientInput.value = contract.client_name; };
    contractSelect.addEventListener("change", syncClient);
    syncClient();
  }
  // Contract modal: selecting a registered client fills the name field.
  const linkedClientSelect = document.getElementById("field-linked-client");
  const contractClientInput = document.getElementById("field-client");
  if (linkedClientSelect && contractClientInput) {
    linkedClientSelect.addEventListener("change", () => {
      const client = (state.clients || []).find((item) => String(item.id) === linkedClientSelect.value);
      if (client) contractClientInput.value = client.name;
    });
  }
  // Contract modal: the discount amount and final price are read-only previews
  // that refresh as Sales types. The server still recalculates on save.
  if (type === "contract") {
    for (const id of ["field-original-price", "field-discount-pct"]) {
      document.getElementById(id)?.addEventListener("input", updateContractPricingPreview);
    }
  }
  // Client modal: the embedded contract step previews its own pricing.
  if (type === "client") {
    for (const id of ["field-client-original-price", "field-client-discount-pct"]) {
      document.getElementById(id)?.addEventListener("input", updateClientContractPreview);
    }
  }
  // Payment modal: changing the contract refilters installments and default client.
  const paymentContractSelect = document.getElementById("field-payment-contract");
  const paymentDebtSelect = document.getElementById("field-payment-debt");
  if (paymentContractSelect && paymentDebtSelect) {
    paymentContractSelect.addEventListener("change", () => {
      const contractId = paymentContractSelect.value;
      const contract = state.contracts.find((item) => String(item.id) === contractId);
      const options = (state.debts || []).filter((debt) => !contractId || String(debt.contract_id) === contractId)
        .map((debt) => `<option value="${debt.id}">${escapeHtml(debt.client_name)} · ${money(debt.amount)} · ${formatDate(debt.due_date)}</option>`).join("");
      paymentDebtSelect.innerHTML = `<option value="">None — general payment</option>${options}`;
      const amountInput = document.getElementById("field-payment-amount");
      if (contract && amountInput && !amountInput.value) amountInput.placeholder = String(contract.value ?? "0");
    });
  }
  // Property modal: load the optional gallery after render.
  if (type === "property" && record?.id) loadPropertyPhotos(record.id);
  const reportTypeSelect = document.getElementById("field-report-type");
  if (reportTypeSelect && document.getElementById("report-filter-fields")) {
    // The filter set follows the selected report type.
    reportTypeSelect.addEventListener("change", () => {
      const container = document.getElementById("report-filter-fields");
      if (container) container.outerHTML = reportFilterFieldsHtml(reportTypeSelect.value);
    });
  }
  setTimeout(() => modal.querySelector("input, select, button")?.focus(), 0);
  return;
}

function closeIcon() {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
}

function closeModal() {
  // A pending confirm dialog resolves as "no" so awaiting callers never hang.
  if (typeof state.confirmResolve === "function") {
    const resolve = state.confirmResolve;
    state.confirmResolve = null;
    resolve(false);
  }
  modalBackdrop.hidden = true;
  modal.innerHTML = "";
  modal.classList.remove("modal-wide", "modal-document");
}

/**
 * Application confirm dialog. Uses the same modal as every other form, so the
 * workspace never falls back to the browser's native confirm() (which cannot be
 * styled and is blocked outright in some embedded browsers).
 * Resolves true when the primary action is taken, false when dismissed.
 */
function confirmDialog({ title, message, confirmLabel = "Confirm", tone = "danger", noteLabel = null }) {
  return new Promise((resolve) => {
    modal.dataset.type = "confirm";
    const head = `<div class="modal-head"><div><h2 class="modal-title">${escapeHtml(title)}</h2><p class="modal-sub">${escapeHtml(message)}</p></div><button class="close-btn" data-action="close-modal" aria-label="Close">${closeIcon()}</button></div>`;
    // Optional note field: the confirm dialog doubles as the reason prompt for
    // workflow steps that must explain themselves.
    const noteField = noteLabel
      ? `<div class="field full"><label for="confirm-note">${escapeHtml(noteLabel)}</label><textarea id="confirm-note" rows="3" maxlength="2000" placeholder="Recorded in the contract history"></textarea></div>`
      : "";
    const actions = `<div class="form-actions">
      <button type="button" class="btn" data-action="close-modal">Cancel</button>
      <button type="button" class="btn ${tone === "danger" ? "btn-danger" : "btn-primary"}" data-action="confirm-dialog-accept">${escapeHtml(confirmLabel)}</button>
    </div>`;
    modal.innerHTML = `${head}${noteField ? `<form id="confirm-form" class="form-grid">${noteField}</form>` : ""}${actions}`;
    modalBackdrop.hidden = false;
    state.confirmResolve = resolve;
    state.confirmNoteField = Boolean(noteField);
    setTimeout(() => (noteField ? document.getElementById("confirm-note") : modal.querySelector('[data-action="confirm-dialog-accept"]'))?.focus(), 0);
  });
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { toast.hidden = true; }, 2800);
}

async function handleFormSubmit(event) {
  event.preventDefault();
  const form = event.target;
  // Forms with their own submit handler (the signed contract upload).
  if (form.id === "signed-copy-form") return;
  const data = Object.fromEntries(new FormData(form));
  const type = modal.dataset.type;
  const id = form.dataset.id;
  if (type === "small-form" && form.id === "small-form" && state.smallFormSubmit) {
    try {
      const message = await state.smallFormSubmit(data);
      modalBackdrop.hidden = true;
      state.smallFormSubmit = null;
      await refresh();
      showToast(message || "Saved.");
    } catch (error) { showToast(error.message || "Unable to save."); }
    return;
  }
  if (type === "task" && form.id === "task-form") {
    // The server decides who may be assigned, who may review, and it stamps
    // assigned_by, priority, due date and the initial status itself. Only the
    // authorized person list the server returned is submittable, and no
    // `assigned_by` is ever sent - the session decides who assigned it.
    const payload = {
      title: data.title,
      description: data.description || null,
      assigned_to: Number(data.assigned_to),
      reviewer_id: data.reviewer_id ? Number(data.reviewer_id) : null,
      priority: data.priority,
      due_date: data.due_date || null,
    };
    // The linked record is optional. A half-filled link (entity without an id, or
    // an id without an entity) is not sent: the server refuses it, and sending a
    // broken pointer would be worse than sending none.
    if (data.linked_entity && data.linked_record_id) {
      payload.linked_entity = data.linked_entity;
      payload.linked_record_id = Number(data.linked_record_id);
    }
    try {
      const created = await api("/org/tasks", { method: "POST", body: JSON.stringify(payload) });
      modalBackdrop.hidden = true;
      const requestId = state.pendingHandOff;
      state.pendingHandOff = null;
      if (requestId && created?.id) {
        try { await api(`/org/requests/${requestId}/handed-off`, { method: "POST", body: JSON.stringify({ task_id: created.id }) }); }
        catch (error) { showToast(error.message || "Assigned, but the request could not be updated."); }
        await reloadRequests();
        if (state.view === "requests") render();
      }
      showToast(requestId ? "Handed to Customer Service." : "Work assigned.");
    } catch (error) {
      showToast(error.message || "Unable to assign that work.");
      return;
    }
    await refreshAttention();
    state.taskBox = "assigned_by_me";
    state.tasks = null;
    state.tasksRequested = false;
    await loadTasks();
    if (state.view === "assignments") render();
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    if (type === "project") {
      if (id) await api(`/projects/${id}`, { method: "PUT", body: JSON.stringify(data) });
      else await api("/projects", { method: "POST", body: JSON.stringify(data) });
      showToast(id ? "Project updated." : "Project created.");
    } else if (type === "contract") {
      data.project_id = Number(data.project_id);
      // Only the two pricing inputs are sent. The discount amount and final price
      // are deliberately absent: the server derives them and will ignore anything
      // posted here, so a tampered client cannot set what a contract is worth.
      data.original_price = numberValue(data.original_price);
      data.discount_pct = numberValue(data.discount_pct);
      delete data.discount_amount;
      delete data.final_price;
      delete data.value;
      // Empty string (not null) so the API can unlink an existing client.
      data.client_id = data.client_id ? Number(data.client_id) : "";
      if (id) await api(`/contracts/${id}`, { method: "PUT", body: JSON.stringify(data) });
      else await api("/contracts", { method: "POST", body: JSON.stringify(data) });
      showToast(id ? "Contract updated." : "Contract created.");
    } else if (type === "schedule") {
      const payload = {
        deposit: numberValue(data.deposit, 0),
        installments: Number(data.installments),
        first_due_date: data.first_due_date,
        frequency: data.frequency || "monthly",
        replace: data.replace === "yes",
      };
      const result = await api(`/contracts/${id}/schedule`, { method: "POST", body: JSON.stringify(payload) });
      showToast(`Schedule created: ${result.created} installment${result.created === 1 ? "" : "s"}.`);
    } else if (type === "payment") {
      if (!data.contract_id) { showToast("Choose the customer first."); return; }
      if (event.submitter?.name === "approve_now") data.approve_now = "true";
      const shortField = form.querySelector("#pay-short");
      if (shortField && !shortField.hidden && !String(data.notes || "").trim()) { showToast("Write a short reason why the amount is less than agreed."); form.querySelector("#pay-notes")?.focus(); return; }
      if (!data.payer_name) delete data.payer_name;
      if (!data.payer_phone) delete data.payer_phone;
      data.contract_id = Number(data.contract_id);
      data.debt_id = data.debt_id ? Number(data.debt_id) : null;
      data.amount = numberValue(data.amount);
      const receiptFile = form.querySelector('input[type="file"][name="file"]')?.files?.[0] || null;
      delete data.file;
      data.reference = String(data.reference || "").trim();
      data.evidence_text = String(data.evidence_text || "").trim();
      if (!data.reference) { showToast("Enter the transaction reference from the receipt or message."); return; }
      const existing = id ? (state.payments || []).find((entry) => String(entry.id) === String(id)) : null;
      if (!receiptFile && !data.evidence_text && !existing?.has_receipt) { showToast("Attach the receipt or paste the payment message as proof."); return; }
      if (!data.evidence_text) delete data.evidence_text;
      if (id) {
        // Correcting a recorded payment; a new receipt replaces the old one.
        await api(`/payments/${id}`, { method: "PUT", body: JSON.stringify(data) });
        if (receiptFile) {
          const payload = new FormData();
          payload.append("file", receiptFile);
          await api(`/payments/${id}/receipt`, { method: "POST", form: true, body: payload });
        }
        invalidateRecord("payments", id);
        showToast("Payment updated. It is back in pending approval.");
      } else if (receiptFile) {
        // Multipart path stores the receipt alongside the payment record.
        const payload = new FormData();
        payload.append("file", receiptFile);
        ["contract_id", "debt_id", "amount", "paid_at", "method", "reference", "notes", "evidence_text", "payer_name", "payer_phone", "approve_now"].forEach((key) => {
          if (data[key] !== undefined && data[key] !== null && data[key] !== "") payload.append(key, data[key]);
        });
        const saved = await api("/payments/upload", { method: "POST", form: true, body: payload });
        showToast(saved.status === "approved" ? `Payment saved and approved. Receipt ${saved.receipt_number || ""} is ready.` : "Payment recorded. It counts once it is approved.");
      } else {
        const saved = await api("/payments", { method: "POST", body: JSON.stringify(data) });
        showToast(saved.status === "approved" ? `Payment saved and approved. Receipt ${saved.receipt_number || ""} is ready.` : "Payment recorded. It counts once it is approved.");
      }
    } else if (type === "debt") {
      data.contract_id = Number(data.contract_id);
      data.amount = numberValue(data.amount);
      if (id) await api(`/debts/${id}`, { method: "PUT", body: JSON.stringify(data) });
      else await api("/debts", { method: "POST", body: JSON.stringify(data) });
      showToast(id ? "Debt updated." : "Debt created.");
    } else if (type === "property") {
      data.project_id = data.project_id ? Number(data.project_id) : null;
      data.price = numberValue(data.price);
      data.area = numberValue(data.area);
      data.bedrooms = numberValue(data.bedrooms, 0);
      data.bathrooms = numberValue(data.bathrooms, 0);
      // Land and commercial property have no bedrooms or bathrooms.
      if (!propertyTypeInfo(data.property_type).rooms) { data.bedrooms = 0; data.bathrooms = 0; }
      data.featured = data.featured ? 1 : 0;
      readListingFields(data);
      const photoFiles = [...(form.querySelector('input[type="file"][name="photo"]')?.files || [])];
      delete data.photo;
      const saved = id
        ? await api(`/properties/${id}`, { method: "PUT", body: JSON.stringify(data) })
        : await api("/properties", { method: "POST", body: JSON.stringify(data) });
      if (photoFiles.length && saved?.id) {
        // Photos are optional: each is uploaded on its own, and a failed one is
        // reported without blocking the save or the others.
        let added = 0;
        const problems = [];
        for (const file of photoFiles) {
          const payload = new FormData();
          payload.append("file", file);
          try {
            await api(`/properties/${saved.id}/images`, { method: "POST", form: true, body: payload });
            added += 1;
          } catch (photoError) {
            problems.push(`${file.name}: ${photoError.message || "could not be uploaded"}`);
          }
        }
        if (state.propertyPhotos) delete state.propertyPhotos[saved.id];
        const what = id ? "Property updated" : "Property created";
        showToast(problems.length
          ? `${what}; ${added} of ${photoFiles.length} photos added. ${problems[0]}`
          : `${what} with ${added} photo${added === 1 ? "" : "s"}.`);
      } else {
        showToast(id ? "Property updated." : "Property created.");
      }
    } else if (type === "client") {
      data.project_id = data.project_id ? Number(data.project_id) : null;
      // The contract step is part of the client form, so its fields are split off
      // before the client is posted: the client endpoint must not receive them.
      const contractStep = {
        project_id: data.contract_project_id ? Number(data.contract_project_id) : null,
        contract_type: data.contract_type || "new",
        deal_type: data.deal_type || "",
        original_price: numberValue(data.original_price),
        discount_pct: numberValue(data.discount_pct),
      };
      const wantsContract = Boolean(contractStep.project_id) && contractStep.original_price > 0;
      delete data.contract_project_id;
      delete data.contract_type;
      delete data.deal_type;
      if (wantsContract && !contractStep.deal_type) throw new Error("Choose the contract type: Buy, Rent or Sell.");
      delete data.original_price;
      delete data.discount_pct;

      if (id) {
        // Completing an existing client: the contract is created first and passed
        // as `contract_id`, so the server sees the association when it applies the
        // completed-client rule.
        let contractId = null;
        if (wantsContract) {
          const contract = await api("/contracts", {
            method: "POST",
            body: JSON.stringify({ ...contractStep, client_id: id, client_name: data.name }),
          });
          contractId = contract.id;
        }
        const payload = contractId ? { ...data, contract_id: contractId } : data;
        await api(`/clients/${id}`, { method: "PUT", body: JSON.stringify(payload) });
        showToast(contractId ? "Client updated and contract created." : "Client updated.");
      } else {
        const client = await api("/clients", { method: "POST", body: JSON.stringify(data) });
        if (wantsContract) {
          await api("/contracts", {
            method: "POST",
            body: JSON.stringify({ ...contractStep, client_id: client.id, client_name: client.name }),
          });
          showToast("Client and contract created.");
        } else {
          showToast("Client saved as a prospect. Add a contract to complete the record.");
        }
      }
    } else if (type === "appointment") {
      data.client_id = Number(data.client_id);
      data.property_id = data.property_id ? Number(data.property_id) : null;
      data.project_id = data.project_id ? Number(data.project_id) : null;
      if (id) await api(`/appointments/${id}`, { method: "PUT", body: JSON.stringify(data) });
      else await api("/appointments", { method: "POST", body: JSON.stringify(data) });
      showToast(id ? "Appointment updated." : "Appointment created.");
    } else if (type === "document") {
      const file = form.querySelector('input[type="file"][name="file"]')?.files?.[0] || null;
      data.project_id = data.project_id ? Number(data.project_id) : null;
      data.contract_id = data.contract_id ? Number(data.contract_id) : null;
      data.client_id = data.client_id ? Number(data.client_id) : null;
      if (file && !id) {
        // Real upload path: multipart to /documents/upload, which stores the file.
        const payload = new FormData();
        payload.append("file", file);
        ["title", "category", "status", "project_id", "contract_id", "client_id", "file_reference", "notes"].forEach((key) => {
          if (data[key] !== undefined && data[key] !== null && data[key] !== "") payload.append(key, data[key]);
        });
        await api("/documents/upload", { method: "POST", form: true, body: payload });
        showToast("Document uploaded.");
      } else if (id) {
        await api(`/documents/${id}`, { method: "PUT", body: JSON.stringify(data) });
        showToast("Document updated.");
      } else {
        await api("/documents", { method: "POST", body: JSON.stringify(data) });
        showToast("Document created.");
      }
    } else if (type === "reset-password") {
      // The two fields must agree before anything is sent, so a typo never
      // becomes a password the member of staff cannot reproduce.
      if (data.password !== data.password_confirm) {
        button.disabled = false;
        button.textContent = originalLabel;
        showToast("The two passwords do not match.");
        return;
      }
      await api(`/org/users/${id}`, { method: "PUT", body: JSON.stringify({ password: data.password }) });
      showToast("Password reset. The account and its history are unchanged.");
    } else if (type === "report-generate") {
      const created = await api("/reports/generate", { method: "POST", body: JSON.stringify(reportRequestPayload(data)) });
      showToast(`Report generated: ${created.title}.`);
    } else if (type === "report-upload") {
      const file = form.querySelector('input[type="file"][name="file"]')?.files?.[0] || null;
      if (!file) throw new Error("Choose a report file to upload.");
      const payload = new FormData();
      payload.append("file", file);
      ["report_type", "title", "description", "project_id"].forEach((key) => {
        if (data[key] !== undefined && data[key] !== null && data[key] !== "") payload.append(key, data[key]);
      });
      await api("/reports/upload", { method: "POST", form: true, body: payload });
      showToast("Report uploaded.");
    }
    closeModal();
    await refresh();
  } catch (error) {
    showToast(error.message || "Unable to save record.");
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

async function deleteRecord(type, id) {
  const labels = { project: "project", contract: "contract", debt: "debt", property: "property", client: "client", appointment: "appointment", document: "document", report: "report", payment: "payment" };
  const endpoints = { project: "projects", contract: "contracts", debt: "debts", property: "properties", client: "clients", appointment: "appointments", document: "documents", report: "reports", payment: "payments" };
  const label = labels[type] || type;
  const endpoint = endpoints[type] || type;
  const confirmed = await confirmDialog({
    title: `Delete ${label}`,
    message: `This permanently deletes the ${label} and cannot be undone.`,
    confirmLabel: `Delete ${label}`,
    tone: "danger",
  });
  if (!confirmed) return;
  try {
    await api(`/${endpoint}/${id}`, { method: "DELETE" });
    showToast(`${label.charAt(0).toUpperCase()}${label.slice(1)} deleted.`);
    await refresh();
  } catch (error) { showToast(error.message || "Unable to delete record."); }
}

async function reversePayment(id) {
  state.transitionNotes = "";
  const confirmed = await confirmDialog({
    title: "Reverse payment",
    message: "The payment stays in the ledger marked Reversed and stops counting towards the installment, the balance and income.",
    confirmLabel: "Reverse payment",
    tone: "danger",
    noteLabel: "Reason (required)",
  });
  if (!confirmed) return;
  const reason = String(state.transitionNotes || "").trim();
  if (!reason) { showToast("A reason is required to reverse a payment."); return; }
  try {
    await api(`/payments/${id}/reverse`, { method: "POST", body: JSON.stringify({ reason }) });
    state.transitionNotes = "";
    showToast("Payment reversed.");
    await refresh();
  } catch (error) { showToast(error.message || "Unable to reverse this payment."); }
}

async function dismissReminder(id) {
  try {
    await api(`/reminders/${id}/acknowledge`, { method: "POST", body: "{}" });
    showToast("Reminder dismissed.");
    await refresh();
  } catch (error) { showToast(error.message || "Unable to dismiss reminder."); }
}

/**
 * Administrator-initiated password reset.
 *
 * The intended MKUYU flow is: staff contacts ICT/admin, the administrator picks
 * the account, confirms, and sets a new password. The account is the SAME
 * account afterwards. The server enforces that (PUT /org/users/:id touches
 * password_hash only, drops live sessions and writes a `password_reset` audit
 * event), so this is deliberately thin: confirm, then collect the new password.
 */
async function resetPassword(userId) {
  const user = (state.organization.users || []).find((entry) => String(entry.id) === String(userId));
  if (!user) { showToast("That staff account is no longer listed."); return; }
  const confirmed = await confirmDialog({
    title: "Reset password",
    message: `Reset the password of ${user.display_name}? Their old password stops working now. They then choose a new one themselves on the sign-in screen. Their account, role, department and history stay exactly as they are.`,
    confirmLabel: "Reset password",
    tone: "primary",
  });
  if (!confirmed) return;
  try {
    const result = await api(`/org/users/${user.id}/reset-password`, { method: "POST", body: "{}" });
    if (state.organization.users) user.password_reset_pending = true;
    render();
    infoDialog("Password reset", `Tell ${user.display_name} to do this within ${result.hours || 24} hours:`, [
      "Open the MKUYU sign-in page and click \"Forgot password?\".",
      `Type the work email ${result.email || user.email}.`,
      "Type a new password, type it again, and press \"Save new password\".",
      "Sign in with the new password.",
    ]);
  } catch (error) {
    showToast(error.message || "Unable to reset the password.");
  }
}

/** A message with numbered steps and a single Done button. */
function infoDialog(title, message, steps = []) {
  modal.dataset.type = "info";
  modal.innerHTML = `<div class="modal-head"><div><h2 class="modal-title">${escapeHtml(title)}</h2><p class="modal-sub">${escapeHtml(message)}</p></div><button class="close-btn" data-action="close-modal" aria-label="Close">${closeIcon()}</button></div>
    ${steps.length ? `<ol class="info-steps">${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>` : ""}
    <div class="form-actions"><button type="button" class="btn btn-primary" data-action="close-modal">Done</button></div>`;
  modalBackdrop.hidden = false;
  setTimeout(() => modal.querySelector(".form-actions .btn")?.focus(), 0);
}

async function removePropertyPhoto(propertyId, imageId) {
  try {
    await api(`/properties/${propertyId}/images/${imageId}`, { method: "DELETE" });
    if (state.propertyPhotos) delete state.propertyPhotos[propertyId];
    // The removed picture is gone from the server, so its cached blob must go too
    // or the next render would show it from the cache.
    clearImageBlobCache();
    showToast("Photo removed.");
    const strip = document.getElementById("photo-strip");
    if (strip) loadPropertyPhotos(propertyId);
    await refresh();
  } catch (error) { showToast(error.message || "Unable to remove photo."); }
}

// One-click PostgreSQL dump backup, then downloads it.
async function createBackup() {
  try {
    showToast("Making a backup…");
    const backup = await api("/backups", { method: "POST", body: "{}" });
    showToast(`Backup created: ${backup.name}`);
    await loadBackups();
    if (state.view === "system") render();
    await downloadFile(`/backups/${encodeURIComponent(backup.name)}/download`, backup.name);
  } catch (error) { showToast(error.message || "Backup failed."); }
}

/* --------------------------------------------------------------------------
   Simple payment entry: find the customer, paste the message, save.
   -------------------------------------------------------------------------- */
function paymentPeriodText(debt) {
  if (!debt?.period?.start) return "";
  return `${formatDate(debt.period.start)} – ${debt.period.end ? formatDate(debt.period.end) : "end of lease"}`;
}

function paymentResultRow(entry) {
  const next = entry.next_due;
  const owed = next ? `Next: ${escapeHtml(next.label)} · ${money(next.balance)} due ${formatDate(next.due_date)}${entry.deal_type === "rent" && next.period ? ` · ${escapeHtml(paymentPeriodText(next))}` : ""}` : "Nothing owed";
  return `<button type="button" class="pay-result" data-action="pay-pick" data-id="${entry.contract_id}">
    <span class="pay-result-main"><strong>${escapeHtml(entry.client_name || "")}</strong> ${badge(entry.deal_type === "rent" ? "Rent" : entry.deal_type === "sell" ? "Sell" : "Buy", entry.deal_type === "rent" ? "leased" : "open")}<span class="muted"> ${escapeHtml(entry.contract_number || "")}${entry.property_name ? ` · ${escapeHtml(entry.property_name)}` : ""}</span></span>
    <span class="pay-result-sub">${owed}${entry.reasons?.length ? ` · <em>${escapeHtml(entry.reasons.join(", "))}</em>` : ""}</span>
  </button>`;
}

function initPaymentForm(prefill) {
  const form = document.getElementById("record-form");
  if (!form) return;
  const $ = (id) => form.querySelector(`#${id}`);
  const results = $("pay-results");
  const found = new Map();
  let chosen = null;
  // Fields the message filled in may be replaced by a later message; fields
  // the officer typed are never overwritten.
  // The date (today) and method (bank) are defaults, so a message may replace them.
  const auto = new Set(["pay-date", "pay-method"]);
  const setAuto = (id, value) => {
    const input = $(id);
    if (!input || value === null || value === undefined || value === "") return;
    if (input.value && !auto.has(id)) return;
    input.value = value; auto.add(id);
  };
  ["pay-amount", "pay-reference", "pay-date", "pay-method"].forEach((id) => $(id)?.addEventListener("input", () => auto.delete(id)));

  const checkAmount = () => {
    const debtId = $("pay-debt").value;
    const debt = chosen?.open_debts?.find((entry) => String(entry.debt_id) === String(debtId));
    const amount = numberValue($("pay-amount").value);
    const short = $("pay-short");
    if (debt && amount > 0 && amount < debt.balance - 0.5) {
      $("pay-short-text").textContent = `Less than agreed: this installment is ${money(debt.balance)}. The rest (${money(debt.balance - amount)}) stays owed.`;
      short.hidden = false;
    } else {
      short.hidden = true;
    }
    const note = $("pay-message-note");
    if (debt && amount > debt.balance + 0.5 && note && !note.dataset.duplicate) note.textContent = `More than this installment: the extra ${money(amount - debt.balance)} goes to the next one.`;
  };
  $("pay-amount").addEventListener("input", checkAmount);
  $("pay-debt").addEventListener("change", () => {
    const debt = chosen?.open_debts?.find((entry) => String(entry.debt_id) === String($("pay-debt").value));
    if (debt) setAuto("pay-amount", debt.balance);
    checkAmount();
  });

  const pick = (entry) => {
    chosen = entry;
    $("pay-contract").value = entry.contract_id;
    results.innerHTML = "";
    $("pay-search").value = "";
    $("pay-selected").innerHTML = `<div class="pay-chosen">${paymentResultRow(entry).replace('data-action="pay-pick"', 'data-action="pay-change" title="Choose another customer"')}<span class="pay-change">Change</span></div>`;
    const debts = entry.open_debts || [];
    $("pay-debt").innerHTML = debts.length
      ? debts.map((debt, index) => `<option value="${debt.debt_id}"${index === 0 ? " selected" : ""}>${escapeHtml(debt.label)} · ${money(debt.balance)} · ${formatDate(debt.due_date)}${debt.period ? ` · ${escapeHtml(paymentPeriodText(debt))}` : ""}</option>`).join("")
      : `<option value="">No installment owed — general payment</option>`;
    if (debts[0]) setAuto("pay-amount", debts[0].balance);
    checkAmount();
  };
  const show = (rows, empty) => {
    rows.forEach((entry) => found.set(String(entry.contract_id), entry));
    results.innerHTML = rows.length ? rows.map(paymentResultRow).join("") : `<div class="muted pay-empty">${escapeHtml(empty)}</div>`;
  };
  results.addEventListener("click", (event) => {
    const button = event.target.closest('[data-action="pay-pick"]');
    if (button && found.get(button.dataset.id)) pick(found.get(button.dataset.id));
  });
  $("pay-selected").addEventListener("click", (event) => {
    if (!event.target.closest(".pay-chosen")) return;
    chosen = null; $("pay-contract").value = ""; $("pay-selected").innerHTML = "";
    $("pay-debt").innerHTML = `<option value="">Choose the customer first</option>`; $("pay-short").hidden = true;
    $("pay-search").focus();
  });

  let searchTimer = null;
  $("pay-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = $("pay-search").value.trim();
    if (q.length < 2) { results.innerHTML = ""; return; }
    searchTimer = setTimeout(async () => {
      try { show(await api(`/payments/lookup?q=${encodeURIComponent(q)}`), "No approved or active contract matches. Check the spelling, or search by phone or contract number."); }
      catch (error) { results.innerHTML = `<div class="muted pay-empty">${escapeHtml(error.message || "Search failed.")}</div>`; }
    }, 250);
  });

  let messageTimer = null;
  $("pay-message").addEventListener("input", () => {
    clearTimeout(messageTimer);
    const text = $("pay-message").value.trim();
    const note = $("pay-message-note");
    if (text.length < 15) { note.textContent = ""; delete note.dataset.duplicate; return; }
    messageTimer = setTimeout(async () => {
      try {
        const { parsed, suggestions, duplicate } = await api("/payments/parse-message", { method: "POST", body: { text } });
        setAuto("pay-amount", parsed.amount);
        setAuto("pay-reference", parsed.reference);
        setAuto("pay-date", parsed.paid_at);
        setAuto("pay-method", parsed.method);
        $("pay-payer-name").value = parsed.payer_name || "";
        $("pay-payer-phone").value = parsed.payer_phone || "";
        const read = [parsed.amount ? money(parsed.amount) : null, parsed.reference ? `ref ${parsed.reference}` : null, parsed.payer_name ? `from ${parsed.payer_name}` : null, parsed.payer_phone || null].filter(Boolean);
        if (duplicate) {
          note.dataset.duplicate = "1";
          note.innerHTML = `<span class="pay-warning">This reference is already recorded (payment #${duplicate.id}, ${escapeHtml(duplicate.client_name || "")}, ${escapeHtml(duplicate.status)}). Do not record it twice.</span>`;
        } else {
          delete note.dataset.duplicate;
          note.textContent = read.length ? `Read from the message: ${read.join(" · ")}. Check it before saving.` : "This message could not be read; type the amount and reference yourself.";
        }
        if (!chosen && suggestions.length) {
          const [top, second] = suggestions;
          if (top.score >= 60 && (!second || second.score <= top.score - 25)) pick(top);
          else show(suggestions, "");
        }
        checkAmount();
      } catch (error) {
        note.textContent = error.message || "Unable to read the message.";
      }
    }, 400);
  });

  // Opened from an installment: that contract and installment are chosen already.
  if (prefill.contract_id) {
    api(`/payments/lookup?q=`).then((rows) => {
      const entry = rows.find((row) => String(row.contract_id) === String(prefill.contract_id));
      if (!entry) return;
      pick(entry);
      if (prefill.debt_id) { $("pay-debt").value = String(prefill.debt_id); $("pay-debt").dispatchEvent(new Event("change")); }
    }).catch(() => {});
  } else {
    setTimeout(() => $("pay-search")?.focus(), 0);
  }
}

/** One line on the automatic daily backup: on/off, the last one, and the copy folder. */
function autoBackupNote(status) {
  if (!status) return "";
  if (!status.enabled) return `<div class="page-tip">${icon("alert")}<span>Automatic daily backup is OFF. Remove AUTO_BACKUP=0 from the server settings to turn it on.</span></div>`;
  const last = status.last_automatic ? `Last one: ${formatDateTime(status.last_automatic.created_at, true)}.` : "The first one is made a few minutes after the server starts.";
  const copy = status.copy_dir_set
    ? "Each backup and the uploaded files are also copied to the backup folder set in BACKUP_COPY_DIR."
    : "Tip: set BACKUP_COPY_DIR to a Google Drive, OneDrive or USB folder so a copy is kept outside this computer.";
  return `<div class="page-tip">${icon("check")}<span>Automatic daily backup is ON and keeps the last ${Number(status.keep || 14)} days. ${last} ${copy}${status.last_error ? ` Last attempt failed: ${escapeHtml(status.last_error)}` : ""}</span></div>`;
}

/** The backups kept on the server (System & backups page, administrator only). */
async function loadBackups() {
  if (!isAdmin()) return;
  state.backupsRequested = true;
  try {
    const [list, status] = await Promise.all([api("/backups"), api("/backups/status").catch(() => null)]);
    state.backups = { list, status };
  } catch (error) {
    state.backups = { list: [], error: error.message || "Unable to load backups." };
  }
}

async function previewReport() {
  const form = document.getElementById("record-form");
  if (!form) return;
  const data = Object.fromEntries(new FormData(form));
  try {
    state.reportPreview = await api("/reports/preview", { method: "POST", body: JSON.stringify(reportRequestPayload(data)) });
    openModal("report-preview");
  } catch (error) {
    showToast(error.message || "Unable to preview report.");
  }
}

async function downloadReportById(id) {
  const report = (state.reportHistory || []).find((entry) => String(entry.id) === String(id));
  if (!report) return;
  const path = report.source === "uploaded"
    ? `/reports/${report.id}/file?download=1`
    : `/reports/${report.id}/export?format=${encodeURIComponent(report.file_format || "xlsx")}`;
  const filename = `${report.title || "report"}.${report.file_format || "xlsx"}`;
  try {
    await downloadFile(path, filename);
  } catch (error) {
    showToast(error.message || "Unable to download report.");
  }
}

/**
 * Runs a contract workflow step. Notes are optional except for the steps that
 * exist precisely to explain themselves (changes requested, rejections).
 */
// Plain-language wording for each workflow step's confirmation. The server
// still decides whether the step is allowed; this only explains it.
const CONTRACT_STEP_TEXT = {
  submit: { question: "Submit this contract to Legal for review?", confirm: "Submit to Legal", done: "Contract submitted to Legal." },
  start_review: { question: "Start the legal review of this contract?", confirm: "Start review", done: "Legal review started." },
  legal_approve: { question: "Give legal approval to this contract?", confirm: "Approve legally", done: "Legal approval recorded." },
  finance_validate: { question: "Confirm the price, deposit and payment plan are correct?", confirm: "Validate financial terms", done: "Financial terms validated." },
  submit_management: { question: "Send this contract to the Managing Director for approval?", confirm: "Send for approval", done: "Sent for management approval." },
  management_approve: { question: "Approve this contract on behalf of management?", confirm: "Approve", done: "Management approval recorded." },
  send_to_customer: { question: "Release this approved contract to the customer for signature?", confirm: "Send to customer", done: "Contract sent to the customer." },
  record_signature: { question: "Record that the customer has signed? The contract becomes active.", confirm: "Record signature", done: "Signature recorded; the contract is active.", note: "Signed by (customer's full name)", noteField: "signed_by", required: true },
  complete: { question: "Mark this contract as completed?", confirm: "Mark completed", done: "Contract completed." },
  cancel: { question: "Cancel this contract? It will be withdrawn from the workflow.", confirm: "Cancel contract", done: "Contract cancelled.", tone: "danger" },
  request_changes: { question: "Send this contract back for corrections. The reason is stored permanently in the contract history.", confirm: "Request changes", done: "Changes requested.", note: "Reason / required corrections", required: true },
  reject: { question: "Reject this contract? The reason is stored permanently in the contract history.", confirm: "Reject contract", done: "Contract rejected.", note: "Reason for rejection", required: true, tone: "danger" },
  management_reject: { question: "Reject this contract on behalf of management? The reason is stored permanently.", confirm: "Reject contract", done: "Contract rejected by management.", note: "Reason for rejection", required: true, tone: "danger" },
};

async function runContractTransition(id, action) {
  const text = CONTRACT_STEP_TEXT[action] || { question: `Move this contract to the next step?`, confirm: "Continue", done: "Contract updated." };
  state.transitionNotes = "";
  const confirmed = await confirmDialog({
    title: text.confirm,
    message: text.question,
    confirmLabel: text.confirm,
    tone: text.tone || "primary",
    noteLabel: text.note || null,
  });
  if (!confirmed) return;
  const note = String(state.transitionNotes || "").trim();
  if (text.required && !note) { showToast(`${text.note} is required.`); return; }
  try {
    const payload = { action };
    if (note) payload[text.noteField || "notes"] = note;
    await api(`/contracts/${id}/transition`, { method: "POST", body: JSON.stringify(payload) });
    showToast(text.done);
    state.transitionNotes = "";
    await refresh();
  } catch (error) {
    showToast(error.message || "Unable to move the contract.");
  }
}

async function showContractHistory(id) {
  try {
    const revisions = await api(`/contracts/${id}/history`);
    const contract = (state.contracts || []).find((item) => String(item.id) === String(id));
    const rows = (revisions || []).map((entry) => `<tr><td>#${entry.revision}</td><td>${contractStatusBadge(entry.status)}</td><td>${escapeHtml(String(entry.action || "—").replace(/_/g, " "))}</td><td>${escapeHtml(entry.changed_by_name || entry.changed_by_display_name || "—")}</td><td class="cell-sub">${escapeHtml(entry.notes || "—")}</td><td class="align-right">${formatDateTime(entry.created_at)}</td></tr>`).join("");
    modal.dataset.type = "contract-history";
    modal.innerHTML = `<div class="modal-head"><div><h2 class="modal-title">Contract history</h2><p class="modal-sub">${escapeHtml(contract?.contract_number || `Contract #${id}`)} — every step, in order</p></div><button class="close-btn" data-action="close-modal" aria-label="Close">${closeIcon()}</button></div>
      ${rows ? `<div class="table-wrap"><table><thead><tr><th>Rev</th><th>Status</th><th>Action</th><th>By</th><th>Notes</th><th class="align-right">When</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">No history recorded yet.</div>`}
      <div class="form-actions"><button type="button" class="btn" data-action="close-modal">Close</button></div>`;
    modalBackdrop.hidden = false;
  } catch (error) {
    showToast(error.message || "Unable to load the contract history.");
  }
}

async function openDocumentFile(id) {
  try {
    await openFileInTab(`/documents/${id}/file`);
  } catch (error) {
    showToast(error.message || "Unable to open document.");
  }
}

/* --------------------------------------------------------------------------
   Contract viewer: the generated contract ON its template.
   The server describes the contract's own Word file (page size and margins,
   the template's header and footer, pictures behind the text, and the
   agreement's paragraphs). Here the paragraphs are flowed onto A4 pages, each
   page carrying the header, footer and page design, and "Page X of Y" is
   filled in - what the printed contract looks like.
   -------------------------------------------------------------------------- */
function contractPageShell(preview, number) {
  const { page } = preview;
  const element = document.createElement("div");
  element.className = "docx-page";
  element.style.width = `${page.width}px`;
  element.style.height = `${page.height}px`;
  // Server-built HTML: every text is escaped and every style value validated there.
  element.innerHTML = `${(preview.layers || []).join("")}${number === 1 ? (preview.firstPageLayers || []).join("") : ""}
    <div class="docx-header" style="top:${page.header}px;left:${page.margin.left}px;right:${page.margin.right}px">${preview.header || ""}</div>
    <div class="docx-body" style="top:${page.margin.top}px;left:${page.margin.left}px;right:${page.margin.right}px;bottom:${page.margin.bottom}px"></div>
    <div class="docx-footer" style="bottom:${page.footer}px;left:${page.margin.left}px;right:${page.margin.right}px">${preview.footer || ""}</div>`;
  return element;
}

function layoutContractPages(preview, host) {
  host.innerHTML = "";
  const pages = [];
  const addPage = () => {
    const shell = contractPageShell(preview, pages.length + 1);
    host.appendChild(shell);
    pages.push(shell);
    return shell.querySelector(".docx-body");
  };
  let body = addPage();
  const holder = document.createElement("div");
  for (const html of preview.blocks || []) {
    holder.innerHTML = html;
    const block = holder.firstElementChild;
    if (!block) continue;
    if (block.classList.contains("docx-page-break") && body.childElementCount) body = addPage();
    body.appendChild(block);
    // Too long for this page: it starts the next one (unless it alone fills a
    // page). A heading kept with its text ("keep with next") moves along with
    // it, so no clause title is left alone at the foot of a page.
    if (body.scrollHeight > body.clientHeight + 1 && body.childElementCount > 1) {
      const moving = [block];
      while (body.childElementCount > moving.length && moving[0].previousElementSibling?.classList.contains("docx-keep-next")) {
        moving.unshift(moving[0].previousElementSibling);
      }
      if (body.childElementCount === moving.length) moving.splice(0, moving.length - 1);
      moving.forEach((element) => element.remove());
      body = addPage();
      moving.forEach((element) => body.appendChild(element));
    }
  }
  pages.forEach((page, index) => {
    page.querySelectorAll('[data-field="PAGE"]').forEach((field) => { field.textContent = String(index + 1); });
    page.querySelectorAll('[data-field="NUMPAGES"]').forEach((field) => { field.textContent = String(pages.length); });
  });
  return pages.length;
}

async function openContractPreview(contractId) {
  if (!canModule("documents")) { showToast("You do not have Documents access."); return; }
  let preview;
  try {
    preview = await api(`/contracts/${contractId}/preview`);
  } catch (error) {
    // A contract that is not a Word file (an uploaded PDF, say) opens as before.
    if (error?.status === 415 || error?.status === 422) { openContractDocumentEditor(contractId); return; }
    showToast(error.message || "Unable to open the contract.");
    return;
  }
  modal.dataset.type = "contract-preview";
  modal.dataset.contractId = String(contractId);
  modal.classList.add("modal-wide", "modal-document");
  const mayEditWording = can("edit");
  modal.innerHTML = `<div class="modal-head"><div><h2 class="modal-title">${escapeHtml(preview.title || "Contract")}</h2><p class="modal-sub">${escapeHtml(preview.contract_number || "")}<span id="docx-page-count"></span></p></div><button class="close-btn" data-action="close-modal" aria-label="Close">${closeIcon()}</button></div>
    <div class="docx-viewer"><div class="docx-pages" id="docx-pages"></div></div>
    <div class="row-actions docx-actions"><button type="button" class="btn" data-action="close-modal">Close</button>${mayEditWording ? `<button type="button" class="btn btn-ghost" data-action="edit-contract-wording" data-id="${contractId}">Edit wording</button>` : ""}<button type="button" class="btn btn-primary" data-action="download-generated-document" data-id="${preview.document_id}" data-filename="${escapeHtml(preview.original_filename || "contract.docx")}">${icon("file")}Download Word</button></div>`;
  modalBackdrop.hidden = false;
  const host = document.getElementById("docx-pages");
  const total = layoutContractPages(preview, host);
  const count = document.getElementById("docx-page-count");
  if (count) count.textContent = ` · ${total} page${total === 1 ? "" : "s"}`;
  // Fit the A4 pages to the window without changing the layout.
  const viewer = modal.querySelector(".docx-viewer");
  const fit = () => {
    const room = (viewer?.clientWidth || preview.page.width) - 32;
    host.style.zoom = String(Math.min(1, room / preview.page.width));
  };
  fit();
}

async function openContractDocumentEditor(contractId) {
  if (!canModule("documents")) { showToast("You do not have Documents access."); return; }
  try {
    const document = await api(`/contracts/${contractId}/document-content`);
    const canEditDocument = document.can_edit && can("edit");
    modal.dataset.type = "contract-document-editor";
    modal.dataset.contractId = String(contractId);
    modal.classList.add("modal-wide");
    modal.innerHTML = `<div class="modal-head"><div><h2 class="modal-title">${escapeHtml(document.title || "Contract document")}</h2><p class="modal-sub">${escapeHtml(document.original_filename || "Generated contract")}</p></div><button class="close-btn" data-action="close-modal" aria-label="Close">${closeIcon()}</button></div>
      ${document.word_template ? `<div class="notice">This contract was produced on your Word template, so its design is kept in the downloaded file. To change the wording, download it, edit it in Word, then attach the revised copy with <strong>Upload document</strong>.</div>` : ""}
      <div class="field"><label for="contract-document-body">${document.word_template ? "Contract wording (preview)" : "Contract contents"}</label><textarea id="contract-document-body" class="contract-document-editor"${canEditDocument ? "" : " readonly aria-readonly=\"true\""}>${escapeHtml(document.body_text || "")}</textarea></div>
      <div class="row-actions"><button type="button" class="btn" data-action="close-modal">Close</button><button type="button" class="btn btn-soft" data-action="download-generated-document" data-id="${document.document_id}" data-filename="${escapeHtml(document.original_filename || "contract.docx")}">Download</button>${canEditDocument ? `<button type="button" class="btn btn-primary" data-action="save-contract-document" data-id="${contractId}">Save and close</button>` : ""}</div>`;
    modalBackdrop.hidden = false;
    modal.querySelector("#contract-document-body")?.focus();
  } catch (error) {
    showToast(error.message || "Unable to open the contract document.");
  }
}

async function saveContractDocument(contractId) {
  const bodyText = document.getElementById("contract-document-body")?.value || "";
  const button = modal.querySelector('[data-action="save-contract-document"]');
  if (button) button.disabled = true;
  try {
    await api(`/contracts/${contractId}/document-content`, { method: "PUT", body: JSON.stringify({ body_text: bodyText }) });
    closeModal();
    showToast("Contract document updated and replaced.");
    refresh();
  } catch (error) {
    if (button) button.disabled = false;
    showToast(error.message || "Unable to save contract changes.");
  }
}

// Navigation is delegated because the items are generated per caller: a static
// listener list would bind to elements that no longer exist after a sign-in.
document.getElementById("primary-nav").addEventListener("click", (event) => {
  const item = event.target.closest(".nav-item[data-view]");
  if (!item) return;
  state.view = item.dataset.view;
  if (state.view === "templates") { state.templatesLoaded = false; state.templatesRequested = false; }
  if (state.view === "requests") { state.requests = null; state.requestsRequested = false; }
  state.filters = { project: "", type: "", status: "", debtStatus: "", propertyStatus: "", clientStatus: "", appointmentStatus: "", documentStatus: "", documentSearch: "", sort: "", paymentStatus: "" };
  // On a small screen the navigation is a drawer: choosing a destination closes it.
  setNavOpen(false);
  // Re-render the nav so the active marker follows the new view.
  updateNavigation();
  render();
});

/**
 * Opens the contract an installment belongs to.
 *
 * The contract is read from `state.contracts`, the same server-scoped list the
 * Contracts register renders, so this is a navigation shortcut rather than a new
 * data path: if the caller may not see the contract, it is not in the list and
 * no button was rendered. The modal is read-only — opening a contract from
 * Finance must not offer the edit controls the Contracts screen shows.
 */
/** Legal, Sales and the MD may attach the signed copy (the server checks again). */
function maySignedCopy(contract) {
  if (!contract || ["rejected", "cancelled"].includes(contract.status)) return false;
  return can("approve_legal") || can("submit_contract") || can("approve_management");
}

/** The contract's document: the signed copy when there is one, else the generated agreement. */
function contractDocumentBlock(contract) {
  const signed = contract.signed_document_id
    ? `<div class="page-tip">${icon("check")}<span><strong>Signed contract attached</strong>${contract.signed_by_names ? ` · signed by ${escapeHtml(contract.signed_by_names)}` : ""}${contract.signed_uploaded_by_name ? ` · uploaded by ${escapeHtml(contract.signed_uploaded_by_name)}` : ""}${contract.signed_uploaded_at ? ` on ${formatDate(contract.signed_uploaded_at)}` : ""}. This is the official copy.</span></div>`
    : `<div class="page-tip">${icon("alert")}<span>${contract.generated_document_id ? "The contract made by the system has no signatures." : "No contract document yet."} When the contract is signed, or if it was prepared outside the system, use “Replace with signed contract” to attach the signed copy.</span></div>`;
  const buttons = [
    contract.signed_document_id ? `<button type="button" class="btn btn-primary btn-small" data-action="open-signed-contract" data-id="${contract.id}">Open signed contract</button>` : "",
    maySignedCopy(contract) ? `<button type="button" class="btn btn-soft btn-small" data-action="signed-copy" data-id="${contract.id}">${contract.signed_document_id ? "Replace signed contract" : "Replace with signed contract"}</button>` : "",
  ].filter(Boolean).join("");
  return `<div class="section"><div class="section-head"><div><h2 class="section-title">Contract document</h2></div>${buttons ? `<div class="row-actions">${buttons}</div>` : ""}</div>${signed}</div>`;
}

/** Upload form for the signed contract (scan, photo or PDF made outside the system). */
function openSignedCopyForm(contractId) {
  const contract = (state.contracts || []).find((item) => String(item.id) === String(contractId));
  if (!contract) { showToast("That contract is not available to you."); return; }
  modal.dataset.type = "signed-copy";
  const replacing = Boolean(contract.signed_document_id);
  modal.innerHTML = `<div class="modal-head"><div><h2 class="modal-title">${replacing ? "Replace signed contract" : "Replace with signed contract"}</h2><p class="modal-sub">${escapeHtml(contract.contract_number || `Contract #${contract.id}`)} · ${escapeHtml(contract.client_name || "")}</p></div><button class="close-btn" data-action="close-modal" aria-label="Close">${closeIcon()}</button></div>
    <form id="signed-copy-form" class="form-grid" data-id="${contract.id}">
      <div class="field full"><label for="signed-file">Signed contract file <span class="req">*</span></label><input id="signed-file" name="file" type="file" required accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx"><div class="field-help">A scan, a clear photo or a PDF of the signed contract, including contracts prepared outside the system.</div></div>
      <div class="field full"><label for="signed-by">Signed by <span class="req">*</span></label><input id="signed-by" name="signed_by" required maxlength="300" placeholder="e.g. Johnny Anthony Frederick (buyer) and Fatuma Juma for MKUYU"></div>
      <div class="field full"><label for="signed-notes">Notes</label><textarea id="signed-notes" name="notes" rows="2" maxlength="1000" placeholder="Optional, e.g. signed at the MKUYU office on 3 October"></textarea></div>
      <div class="field full"><div class="field-help">${replacing ? "The current signed copy stays in Documents; the new file becomes the official copy." : "The contract made by the system stays in Documents; this signed copy becomes the official copy."} The change is recorded in the contract history.</div></div>
    </form>
    <div class="form-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" form="signed-copy-form" class="btn btn-primary">Save signed contract</button></div>`;
  modalBackdrop.hidden = false;
}

document.addEventListener("submit", async (event) => {
  if (event.target.id !== "signed-copy-form") return;
  event.preventDefault();
  const form = event.target;
  const id = form.dataset.id;
  const button = modal.querySelector('button[form="signed-copy-form"]');
  if (button) button.disabled = true;
  try {
    const updated = await api(`/contracts/${id}/signed-document`, { method: "POST", form: true, body: new FormData(form) });
    state.contracts = (state.contracts || []).map((item) => (String(item.id) === String(id) ? { ...item, ...updated } : item));
    closeModal();
    showToast("Signed contract saved. It is now the official copy.");
    render();
  } catch (error) {
    showToast(error.message || "Unable to save the signed contract.");
    if (button) button.disabled = false;
  }
});

function viewContract(contractId) {
  if (!canModule("contracts")) { showToast("You do not have access to the contract register."); return; }
  const contract = state.contracts.find((item) => String(item.id) === String(contractId));
  if (!contract) { showToast("That contract is not available to you."); return; }
  modal.dataset.type = "contract-view";
  const installments = state.debts
    .filter((debt) => String(debt.contract_id) === String(contract.id))
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  // Only approved money counts as collected.
  const paidTotal = (state.payments || [])
    .filter((payment) => String(payment.contract_id) === String(contract.id) && payment.status === "approved")
    .reduce((sum, payment) => sum + numberValue(payment.amount), 0);
  const financial = canSeeFinancial();
  const installmentRows = installments.map((debt) => {
    const stateValue = debtState(debt);
    return `<tr><td><span class="cell-main">${escapeHtml(debt.notes || `Installment`)}</span></td><td>${formatDate(debt.due_date)}</td><td>${badgeVariant(debtStateLabel(stateValue), stateValue)}</td><td class="amount">${money(debt.amount)}</td></tr>`;
  }).join("");
  const head = `<div class="modal-head"><div><h2 class="modal-title">${escapeHtml(contract.contract_number || `Contract #${contract.id}`)}</h2><p class="modal-sub">${escapeHtml(contract.client_name || "")}${contract.project_name ? ` · ${escapeHtml(contract.project_name)}` : ""}</p></div><button class="close-btn" data-action="close-modal" aria-label="Close">${closeIcon()}</button></div>`;
  modal.innerHTML = `${head}
    <div class="form-grid">
      <div class="field"><span class="muted">Status</span><div>${contractStatusBadge(contract)}${contractPositionNote(contract)}</div></div>
      <div class="field"><span class="muted">Contract type</span><div>${contract.deal_type ? badge(dealTypeLabel(contract.deal_type), "open") : "Not recorded"}</div></div>
      <div class="field"><span class="muted">Agreement</span><div>${badge(contract.contract_type)}</div></div>
      <div class="field"><span class="muted">Start</span><div>${formatDate(contract.start_date)}</div></div>
      <div class="field"><span class="muted">End</span><div>${formatDate(contract.end_date)}</div></div>
      <div class="field"><span class="muted">Contract value</span><div class="amount">${money(contract.value)}</div></div>
      ${Number(contract.discount_pct || 0) > 0 ? `<div class="field"><span class="muted">Original price</span><div class="amount">${money(contract.original_price)}</div></div><div class="field"><span class="muted">Discount</span><div class="amount">${escapeHtml(String(contract.discount_pct))}% (− ${money(contract.discount_amount)})</div></div><div class="field"><span class="muted">Final price</span><div class="amount">${money(contract.final_price ?? contract.value)}</div></div>` : ""}
      ${financial ? "" : `<div class="field"><span class="muted">Collected</span><div class="amount">${money(paidTotal)}</div></div>`}
    </div>
    ${contractDocumentBlock(contract)}
    ${financial ? `<div id="contract-account" class="section"><p class="muted">Loading the contract account…</p></div>` : ""}
    ${!financial && installmentRows ? `<div class="section"><div class="section-head"><div><h2 class="section-title">Installments</h2><div class="section-note">Payment plan attached to this contract</div></div></div><div class="table-wrap"><table><thead><tr><th>Installment</th><th>Due</th><th>State</th><th class="align-right">Amount</th></tr></thead><tbody>${installmentRows}</tbody></table></div></div>` : ""}
    <div class="form-actions">
      <button type="button" class="btn" data-action="close-modal">Close</button>
      ${contract.generated_document_id && canModule("documents") ? `<button type="button" class="btn btn-soft" data-action="view-generated-contract" data-id="${contract.id}">View / Edit</button><button type="button" class="btn" data-action="download-generated-document" data-id="${contract.generated_document_id}" data-filename="${escapeHtml(`${contract.contract_number || "contract"}.docx`)}">Download DOCX</button>` : ""}
      ${can("edit") && canAuthorContracts() ? `<button type="button" class="btn btn-primary" data-action="edit-contract-from-view" data-id="${contract.id}">Edit contract</button>` : ""}
      ${canModule("documents") && can("create") ? `<button type="button" class="btn" data-action="upload-contract-document" data-id="${contract.id}">Upload document</button>` : ""}
      <button type="button" class="btn btn-soft" data-action="contract-history" data-id="${contract.id}">History</button>
    </div>`;
  modalBackdrop.hidden = false;
  if (financial) loadContractAccount(contract.id);
}

/** Payment methods offered on money forms (report config, or a safe default). */
function paymentMethodChoices() {
  return (state.reportPaymentMethods || []).length
    ? state.reportPaymentMethods
    : [{ value: "cash", label: "Cash" }, { value: "bank", label: "Bank transfer" }, { value: "mobile", label: "Mobile money" }, { value: "card", label: "Card" }, { value: "other", label: "Other" }];
}

/**
 * Fills the "Account" part of the contract view for Finance and the MD: price,
 * money received and confirmed, balance, next due and overdue installments,
 * every payment with its MKUYU receipt, and refunds (with a form to record one).
 */
async function loadContractAccount(contractId) {
  const host = document.getElementById("contract-account");
  if (!host) return;
  let account;
  try {
    account = await api(`/contracts/${contractId}/account`);
  } catch (error) {
    host.innerHTML = `<p class="muted">${escapeHtml(error.message || "Unable to load the contract account.")}</p>`;
    return;
  }
  if (!document.getElementById("contract-account")) return;
  const t = account.totals || {};
  const me = state.organization.me || {};
  const deskUser = can("validate_finance") && me.financial === true;
  const stat = (label, value, extra = "") => `<div class="field"><span class="muted">${escapeHtml(label)}</span><div class="amount ${extra}">${value}</div></div>`;
  const totals = `<div class="form-grid">
    ${stat("Contract price", money(t.price))}
    ${stat("Received (approved)", money(t.received), "amount-positive")}
    ${t.pending_approval > 0 ? stat("Waiting for approval", money(t.pending_approval)) : ""}
    ${t.refunded > 0 ? stat("Refunded", money(t.refunded)) : ""}
    ${t.unapplied_credit > 0 ? stat("Credit not yet on an installment", money(t.unapplied_credit)) : ""}
    ${stat("Balance", money(t.balance))}
    ${stat("Next due", account.next_due ? `${money(account.next_due.amount)} · ${formatDate(account.next_due.due_date)}` : "Nothing due")}
    ${t.overdue_count > 0 ? stat("Overdue", `${money(t.overdue_amount)} · ${t.overdue_count} installment${t.overdue_count === 1 ? "" : "s"}`) : ""}
  </div>`;
  const installmentRows = (account.installments || []).map((row) => {
    const paid = row.balance <= 0;
    const late = !paid && row.due_date && String(row.due_date).slice(0, 10) < today();
    const stateBadge = paid ? badge("Paid", "approved") : row.paid > 0 ? badge("Part paid", "pending") : late ? badge("Overdue", "rejected") : badge("Open", "neutral");
    return `<tr><td><span class="cell-main">${escapeHtml(row.label || "Installment")}</span></td><td>${formatDate(row.due_date)}</td><td>${stateBadge}</td><td class="amount">${money(row.amount)}</td><td class="amount">${money(row.balance)}</td></tr>`;
  }).join("");
  const paymentRows = (account.payments || []).map((row) => {
    const status = row.status === "approved" ? badge("Approved", "approved") : row.status === "reversed" ? badge("Reversed", "rejected") : badge("Pending approval", "pending");
    const receipt = row.status === "approved" && row.receipt_number
      ? `<button class="btn btn-small" data-action="mkuyu-receipt" data-id="${row.id}" data-filename="${escapeHtml(row.receipt_number)}.pdf">${icon("receipt")}${escapeHtml(row.receipt_number)}</button>`
      : `<span class="muted cell-plain">—</span>`;
    return `<tr><td>${formatDate(row.paid_at)}</td><td class="amount">${money(row.amount)}</td><td><span class="mono">${escapeHtml(row.reference || "—")}</span></td><td>${status}</td><td>${receipt}</td></tr>`;
  }).join("");
  const refundRows = (account.refunds || []).map((row) => {
    const approveBtn = row.status === "pending" && deskUser
      ? `<button class="btn btn-primary btn-small" data-action="approve-refund" data-id="${row.id}" data-contract="${contractId}">Approve refund</button>`
      : "";
    return `<tr><td>${formatDate(row.paid_at)}</td><td class="amount">${money(row.amount)}</td><td><span class="mono">${escapeHtml(row.reference || "—")}</span></td><td>${escapeHtml(row.reason || "")}</td><td>${row.status === "approved" ? `${badge("Approved", "approved")}${row.self_approved ? `<span class="cell-sub">self-approved (single Finance)</span>` : ""}` : badge("Pending approval", "pending")}</td><td>${approveBtn}</td></tr>`;
  }).join("");
  const table = (head, rows) => `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  const refundForm = deskUser && t.received - t.refunded > 0 ? `
    <div class="form-actions"><button type="button" class="btn btn-soft" data-action="show-refund-form">Record refund</button></div>
    <div id="refund-form" class="form-grid" hidden>
      <div class="field"><label for="refund-amount">Amount refunded</label><input id="refund-amount" type="number" min="0" step="0.01" max="${escapeHtml(String(Math.max(0, t.received - t.refunded)))}"></div>
      <div class="field"><label for="refund-date">Paid on</label><input id="refund-date" type="date" value="${today()}"></div>
      <div class="field"><label for="refund-method">Method</label><select id="refund-method">${paymentMethodChoices().map((m) => `<option value="${escapeHtml(m.value)}"${m.value === "bank" ? " selected" : ""}>${escapeHtml(m.label)}</option>`).join("")}</select></div>
      <div class="field"><label for="refund-reference">Transfer reference</label><input id="refund-reference" maxlength="160"></div>
      <div class="field full"><label for="refund-reason">Reason</label><input id="refund-reason" maxlength="500" placeholder="e.g. Security deposit returned at the end of the lease"></div>
      <div class="field full"><label for="refund-evidence">Proof</label><textarea id="refund-evidence" maxlength="4000" rows="2" placeholder="Paste the transfer message or describe the slip"></textarea></div>
      <div class="form-actions full"><button type="button" class="btn btn-primary" data-action="submit-refund" data-id="${contractId}">Save refund</button></div>
    </div>` : "";
  host.innerHTML = `<div class="section-head"><div><h2 class="section-title">Account</h2><div class="section-note">Only money approved by Finance counts. Each approved payment has an MKUYU receipt for the customer.</div></div></div>
    ${totals}
    ${installmentRows ? `<h3 class="section-title" style="margin-top:18px">Installments</h3>${table(`<th>Installment</th><th>Due</th><th>State</th><th class="align-right">Amount</th><th class="align-right">Left to pay</th>`, installmentRows)}` : `<p class="muted">No payment plan yet.</p>`}
    ${paymentRows ? `<h3 class="section-title" style="margin-top:18px">Payments</h3>${table(`<th>Paid on</th><th class="align-right">Amount</th><th>Reference</th><th>Status</th><th>MKUYU receipt</th>`, paymentRows)}` : ""}
    ${refundRows ? `<h3 class="section-title" style="margin-top:18px">Refunds</h3>${table(`<th>Paid on</th><th class="align-right">Amount</th><th>Reference</th><th>Reason</th><th>Status</th><th></th>`, refundRows)}` : ""}
    ${refundForm}`;
}

async function submitRefund(contractId) {
  const value = (id) => String(document.getElementById(id)?.value || "").trim();
  const payload = { contract_id: Number(contractId), amount: numberValue(value("refund-amount")), paid_at: value("refund-date"), method: value("refund-method"), reference: value("refund-reference"), reason: value("refund-reason"), evidence_text: value("refund-evidence") };
  if (!(payload.amount > 0)) { showToast("Enter the amount refunded."); return; }
  if (!payload.reference || !payload.reason || !payload.evidence_text) { showToast("Reference, reason and proof are all required for a refund."); return; }
  try {
    await api("/payments/refunds", { method: "POST", body: JSON.stringify(payload) });
    showToast("Refund recorded. It needs Finance approval.");
    await loadContractAccount(contractId);
  } catch (error) {
    showToast(error.message || "Unable to record the refund.");
  }
}

async function approveRefund(refundId, contractId) {
  try {
    await api(`/payments/refunds/${refundId}/approve`, { method: "POST", body: "{}" });
    showToast("Refund approved.");
    await loadContractAccount(contractId);
  } catch (error) {
    showToast(error.message || "Unable to approve the refund.");
  }
}

/** Opens or closes the small-screen navigation drawer. */
function setNavOpen(open) {
  state.navOpen = Boolean(open);
  document.getElementById("primary-nav")?.classList.toggle("nav-open", state.navOpen);
  document.querySelector('[data-action="toggle-menu"]')?.setAttribute("aria-expanded", String(state.navOpen));
}

document.addEventListener("click", async (event) => {
  // Any click outside an open row menu closes it.
  if (!event.target.closest?.(".row-menu")) closeRowMenus();
  // A tap outside the open drawer closes it (the menu button toggles itself).
  if (state.navOpen && !event.target.closest?.(".sidebar") && !event.target.closest?.('[data-action="toggle-menu"]')) setNavOpen(false);
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;
  if (action === "toggle-row-menu") {
    // The list is positioned against the viewport so a table's scroll container
    // can never clip it. Opening one menu closes any other.
    const list = target.parentElement?.querySelector(".row-menu-list");
    if (!list) return;
    const opening = list.hidden;
    closeRowMenus(opening ? list : null);
    list.hidden = !opening;
    target.setAttribute("aria-expanded", String(opening));
    if (opening) {
      const rect = target.getBoundingClientRect();
      list.style.top = `${Math.round(rect.bottom + 6)}px`;
      list.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
      const menuHeight = list.offsetHeight || 0;
      if (rect.bottom + 6 + menuHeight > window.innerHeight - 8) list.style.top = `${Math.max(8, Math.round(rect.top - 6 - menuHeight))}px`;
      list.querySelector("button")?.focus();
    }
    return;
  }
  // Choosing an entry closes its menu before the action runs.
  if (target.closest(".row-menu-list")) closeRowMenus();
  if (action === "new-project") openModal("project");
  if (action === "edit-project") openModalFor("projects", id, "project");
  if (action === "delete-project") deleteRecord("project", id);
  if (action === "project-properties" && allowedViewFor("properties") !== false) {
    // A shortcut into the existing Properties filter; nothing new is fetched
    // beyond the register's own scoped page.
    state.view = "properties";
    state.filters = { ...state.filters, project: String(id || ""), propertyStatus: "", type: "" };
    updateNavigation();
    render();
  }
  if (action === "new-property") openModal("property");
  if (action === "edit-property") openModalFor("properties", id, "property");
  if (action === "delete-property") deleteRecord("property", id);
  if (action === "property-status") {
    let change = {};
    try { change = JSON.parse(target.dataset.change || "{}"); } catch { change = {}; }
    changePropertyStatus(id, change, target.dataset.name, target.dataset.closing);
  }
  if (action === "new-contract") await openGenerateContractModal();
  if (action === "generate-contract") await openGenerateContractModal(target.dataset.deal ? { deal_type: target.dataset.deal, client_id: target.dataset.clientId || "", client_name: target.dataset.clientName || "", client_phone: target.dataset.clientPhone || "", client_email: target.dataset.clientEmail || "" } : {});
  if (action === "contract-preview") {
    const form = document.getElementById("contract-generate-form");
    if (form?.reportValidity()) {
      state.contractGen.data = generateContractFormData();
      state.contractGen.step = "review";
      renderGenerateContractModal();
    }
  }
  if (action === "contract-confirm") await submitGenerateContract();
  if (action === "contract-back") {
    state.contractGen.data = generateContractFormData();
    state.contractGen.step = "form";
    renderGenerateContractModal();
  }
  if (action === "view-generated-contract") openContractPreview(id);
  if (action === "edit-contract-wording") openContractDocumentEditor(id);
  if (action === "save-contract-document") await saveContractDocument(id);
  if (action === "open-generated-document") openDocumentFile(id);
  if (action === "download-generated-document") downloadFile(`/documents/${id}/file?download=1`, target.dataset.filename || "contract.pdf").catch((error) => showToast(error.message || "Unable to download the contract."));
  if (action === "edit-contract") openModalFor("contracts", id, "contract");
  if (action === "delete-contract") deleteRecord("contract", id);
  if (action === "new-debt") openModal("debt");
  if (action === "edit-debt") openModalFor("debts", id, "debt");
  if (action === "delete-debt") deleteRecord("debt", id);
  if (action === "reverse-payment") reversePayment(id);
  if (action === "mkuyu-receipt") downloadFile(`/payments/${id}/mkuyu-receipt`, target.dataset.filename || "receipt.pdf").catch((error) => showToast(error.message || "Unable to download the receipt."));
  if (action === "show-refund-form") { const form = document.getElementById("refund-form"); if (form) form.hidden = !form.hidden; }
  if (action === "submit-refund") await submitRefund(id);
  if (action === "approve-refund") await approveRefund(id, target.dataset.contract);
  if (action === "generate-schedule") openModalFor("contracts", id, "schedule");
  if (action === "contract-transition") runContractTransition(id, target.dataset.transition);
  if (action === "contract-history") showContractHistory(id);
  if (action === "template-download") {
    downloadFile(`/contract-templates/${id}/file`, target.dataset.filename || "template.docx").catch((error) => showToast(error.message || "Download failed."));
  }
  if (action === "template-starter") {
    event.preventDefault();
    downloadFile("/contract-templates/starter", "MKUYU-letterhead-template.docx").catch((error) => showToast(error.message || "Download failed."));
  }
  if (action === "template-default") {
    try { await api(`/contract-templates/${id}`, { method: "PUT", body: JSON.stringify({ is_default: true }) }); showToast("Default template updated."); state.templatesLoaded = false; state.templatesRequested = false; render(); }
    catch (error) { showToast(error.message || "Unable to update the template."); }
  }
  if (action === "template-delete") {
    const ok = await confirmDialog({ title: "Delete template", message: "Delete this contract template? Contracts already generated are not affected.", confirmLabel: "Delete template" });
    if (ok) {
      try { await api(`/contract-templates/${id}`, { method: "DELETE" }); showToast("Template deleted."); state.templatesLoaded = false; state.templatesRequested = false; render(); }
      catch (error) { showToast(error.message || "Unable to delete the template."); }
    }
  }
  if (action === "upload-contract-document") {
    // Opens the normal New document form, already linked to this contract.
    const contract = (state.contracts || []).find((item) => String(item.id) === String(id));
    closeModal();
    openModal("document", { prefill: true, contract_id: id, project_id: contract?.project_id, client_id: contract?.client_id, category: "agreement", title: contract ? `${contract.contract_number || "Contract"} · ` : "" });
  }
  if (action === "view-contract") viewContract(id);
  if (action === "signed-copy") { closeModal(); openSignedCopyForm(id); }
  if (action === "open-signed-contract") openFileInTab(`/contracts/${id}/signed-document`).catch((error) => showToast(error.message || "Unable to open the signed contract."));
  if (action === "edit-contract-from-view") {
    // Resolved by id: the contract being viewed may not be on the current page.
    closeModal();
    openModalFor("contracts", id, "contract");
  }
  if (action === "new-payment") openModal("payment");
  if (action === "approve-payment") {
    try { await api(`/payments/${id}/approve`, { method: "POST", body: {} }); await refresh(); showToast("Payment approved."); }
    catch (error) { showToast(error.message || "Unable to approve this payment."); }
  }
  if (action === "record-payment") {
    // The installment may be on a later page of the debt register, so it is
    // fetched by id rather than assumed present in the loaded rows.
    findRecord("debts", id).then((debt) => {
      if (debt) openModal("payment", { contract_id: debt.contract_id, debt_id: debt.id, amount: debt.amount });
    });
  }
  // Contract wizard, step 1: what is this contract for?
  if (action === "contract-kind") {
    const kind = target.dataset.kind;
    const data = state.contractGen.data || {};
    // A different kind may need a different template, so the choice is reset.
    if (data.deal_type !== kind) data.template_choice = "";
    state.contractGen.data = { ...data, deal_type: kind };
    state.contractGen.step = "form";
    renderGenerateContractModal();
    updateGenerateContractPreview();
  }
  if (action === "contract-change-kind") {
    state.contractGen.data = generateContractFormData();
    state.contractGen.step = "type";
    renderGenerateContractModal();
  }
  if (action === "arrange-appointment") openArrangeAppointment(id);
  if (action === "answer-message") {
    const ok = await confirmDialog({ title: "Mark message answered", message: "Record how you answered the visitor. Sales and the MD will see it under Requests.", confirmLabel: "Mark answered", tone: "primary", noteLabel: "How was the visitor answered?" });
    if (ok) {
      const note = String(state.transitionNotes || "").trim();
      if (!note) { showToast("Write how the visitor was answered."); return; }
      try {
        await api(`/org/requests/${id}/answer`, { method: "POST", body: JSON.stringify({ note }) });
        showToast("Message marked answered.");
        await reloadRequests();
        updateNavigation();
        updateNotificationDot();
        if (state.view === "requests") render();
      } catch (error) { showToast(error.message || "Unable to mark the message answered."); }
    }
  }
  if (action === "delete-payment") deleteRecord("payment", id);
  if (action === "edit-payment") openModalFor("payments", id, "payment");
  // Pager. `data-list` names the register, so one handler serves every table.
  if (action === "page-prev" || action === "page-next") {
    const kind = target.dataset.list;
    const current = Number(state.pages[kind]?.page || 1);
    loadList(kind, { page: action === "page-next" ? current + 1 : Math.max(1, current - 1) });
  }
  if (action === "open-receipt") openFileInTab(`/payments/${id}/receipt`).catch((error) => showToast(error.message));
  if (action === "dismiss-reminder") dismissReminder(id);
  if (action === "remove-photo") removePropertyPhoto(target.dataset.property, target.dataset.image);
  // Small-screen navigation. The button existed in the markup with no handler,
  // so the sidebar was unreachable below the mobile breakpoint.
  if (action === "toggle-menu") {
    state.navOpen = !state.navOpen;
    document.getElementById("primary-nav")?.classList.toggle("nav-open", state.navOpen);
    target.setAttribute("aria-expanded", String(state.navOpen));
  }
  if (action === "show-alerts") showAlertsPanel();
  if (action === "show-profile") showProfile();
  if (action === "remove-profile-image") {
    try { await api(`/org/me/${target.dataset.kind}`, { method: "DELETE" }); showToast("Removed."); await reloadProfile(); }
    catch (error) { showToast(error.message || "Unable to remove."); }
  }
  if (action === "save-signature-title") {
    try { await api("/org/me/signature-title", { method: "PUT", body: JSON.stringify({ signature_title: document.getElementById("signature-title")?.value || "" }) }); showToast("Signature title saved."); await reloadProfile(); }
    catch (error) { showToast(error.message || "Unable to save."); }
  }
  if (action === "work-go") {
    // A "Your work today" card: open the screen already narrowed to the job.
    closeModal();
    if (allowedViewFor(target.dataset.view) !== false) {
      let filters = {};
      try { filters = JSON.parse(target.dataset.filters || "{}"); } catch { filters = {}; }
      const { taskBox, ...listFilters } = filters;
      state.filters = { ...state.filters, status: "", debtStatus: "", paymentStatus: "", ...listFilters };
      if (taskBox) { state.taskBox = taskBox; state.tasks = null; state.tasksRequested = false; }
      state.view = target.dataset.view;
      updateNavigation();
      render();
      const scroll = target.dataset.scroll;
      if (scroll) setTimeout(() => document.querySelector(scroll)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }
  }
  if (action === "open-alert-view") {
    // Route through the normal view switch, which re-applies the navigation
    // permission filter, so a stale link can never open a forbidden screen.
    closeModal();
    if (allowedViewFor(target.dataset.view) !== false) {
      state.view = target.dataset.view;
      updateNavigation();
      render();
    }
  }
  // Tapping a destination closes the drawer, otherwise it stays over the content.
  if (target.closest("#primary-nav .nav-item")) {
    state.navOpen = false;
    document.getElementById("primary-nav")?.classList.remove("nav-open");
  }
  if (action === "backup-now") createBackup();
  if (action === "open-administration") {
    state.view = "organization";
    updateNavigation();
    render();
    // Organization counters and collections are only needed on this screen.
    loadAdminExtras().then(() => { if (state.view === "organization") render(); });
  }
  if (action === "reload-allocation") {
    state.allocationUnassigned = state.allocationUnassigned === false ? true : false;
    loadAllocation().then(render);
  }
  if (action === "reload-duties") {
    // Clear the request flag as well as the payload, so the button genuinely
    // re-fetches rather than short-circuiting on the once-per-session guard.
    state.duties = null;
    state.dutiesRequested = false;
    loadDuties().then(render);
  }
  if (action === "select-allocation") {
    state.allocationEntity = target.dataset.entity;
    render();
  }
  if (action === "save-allocation") {
    const entity = target.dataset.entity;
    const recordId = target.dataset.id;
    const owner = document.querySelector(`[data-allocation-owner="${entity}:${recordId}"]`)?.value;
    const department = document.querySelector(`[data-allocation-department="${entity}:${recordId}"]`)?.value;
    const visibility = document.querySelector(`[data-allocation-visibility="${entity}:${recordId}"]`)?.value;
    try {
      await api(`/org/records/${entity}/${recordId}/access`, { method: "PUT", body: JSON.stringify({ owner_id: owner || null, department_id: department || null, visibility }) });
      await loadAllocation();
      await refresh();
      showToast("Record ownership updated.");
    } catch (error) { showToast(error.message || "Unable to update ownership."); }
  }
  if (action === "open-shares") await openShares(target.dataset.entity, target.dataset.id);
  if (action === "share-record") {
    const entity = state.shares?.entity;
    const recordId = state.shares?.recordId;
    const userId = document.getElementById("share-user")?.value;
    const departmentId = document.getElementById("share-department")?.value;
    try {
      await api(`/org/records/${entity}/${recordId}/shares`, { method: "POST", body: JSON.stringify({ user_id: userId || null, department_id: departmentId || null }) });
      await openShares(entity, recordId);
      showToast("Record shared.");
    } catch (error) { showToast(error.message || "Unable to share the record."); }
  }
  if (action === "revoke-share") {
    const { entity, recordId } = state.shares || {};
    try {
      await api(`/org/records/${entity}/${recordId}/shares/${id}`, { method: "DELETE" });
      await openShares(entity, recordId);
      showToast("Share revoked.");
    } catch (error) { showToast(error.message || "Unable to revoke the share."); }
  }
  if (action === "new-client") openModal("client");
  if (action === "edit-client") openModalFor("clients", id, "client");
  if (action === "delete-client") deleteRecord("client", id);
  if (action === "new-appointment") openModal("appointment");
  if (action === "edit-appointment") openModalFor("appointments", id, "appointment");
  if (action === "delete-appointment") deleteRecord("appointment", id);
  if (action === "new-document") openModal("document");
  if (action === "edit-document") openModalFor("documents", id, "document");
  if (action === "delete-document") deleteRecord("document", id);
  if (action === "open-document") openDocumentFile(id);
  if (action === "open-report-generate") openModal("report-generate");
  if (action === "open-report-upload") openModal("report-upload");
  // Task assignment. Every action is offered by the server for that specific
  // task and person; a rejected call simply reports the refusal.
  if (action === "new-task") openTaskModal();
  if (action === "hand-off-lead") handOffLead(target.dataset.id);
  if (action === "request-stage") { state.requestStage = target.dataset.stage || ""; render(); }
  if (action === "open-task") openTask(id);
  if (action === "task-action") submitTaskAction(id, target.dataset.taskAction);
  if (action === "task-box") {
    state.taskBox = target.dataset.box;
    state.tasks = null;
    state.tasksRequested = false;
    loadTasks().then(() => { if (state.view === "assignments") render(); });
  }
  if (action === "preview-report") previewReport();
  if (action === "download-report") downloadReportById(id);
  if (action === "reexport-report") openModal("report-generate", state.reportHistory.find((item) => String(item.id) === id));
  if (action === "delete-report") deleteRecord("report", id);
  if (action === "create-department") {
    const name = document.querySelector('[data-org-field="department"]')?.value?.trim();
    if (!name) { showToast("Type the new department's name first."); return; }
    try { await api("/org/departments", { method: "POST", body: JSON.stringify({ name }) }); await refresh(); showToast("Department created. Add staff to it below."); }
    catch (error) { showToast(error.message); }
  }
  if (action === "rename-department") openRenameDepartment(id);
  if (action === "add-department-staff") openAddDepartmentStaff(id);
  if (action === "change-my-password") openChangeMyPassword();
  if (action === "complete-appointment") openCompleteAppointment(id);
  if (action === "change-staff-department") openStaffDepartment(id);
  if (action === "change-staff-role") openStaffRole(id);
  if (action === "toggle-dept-staff") {
    const set = state.openDepartments || (state.openDepartments = new Set());
    const key = Number(id);
    if (set.has(key)) set.delete(key); else set.add(key);
    render();
  }
  if (action === "request-outcome") { modalBackdrop.hidden = true; openRequestOutcome(id); }
  if (action === "add-task-note") {
    const text = document.getElementById("task-note")?.value.trim();
    if (!text) { showToast("Write the note first."); return; }
    try { await api(`/org/tasks/${id}/comments`, { method: "POST", body: { body: text } }); showToast("Note saved."); openTask(id); }
    catch (error) { showToast(error.message || "Unable to save the note."); }
  }
  if (action === "toggle-department") {
    try { await api(`/org/departments/${id}`, { method: "PUT", body: JSON.stringify({ active: target.dataset.active === "1" }) }); await refresh(); showToast(target.dataset.active === "1" ? "Department activated." : "Department deactivated."); }
    catch (error) { showToast(error.message || "Unable to update the department."); }
  }
  if (action === "delete-department") {
    const dept = (state.organization.departments || []).find((d) => String(d.id) === String(id));
    if (!window.confirm(`Delete the department "${titleCase(dept?.name || "")}"? This cannot be undone.`)) return;
    try { await api(`/org/departments/${id}`, { method: "DELETE" }); await refresh(); showToast("Department deleted."); }
    catch (error) { showToast(error.message || "Unable to delete the department."); }
  }
  if (action === "download-backup") {
    const name = target.dataset.name;
    try { await downloadFile(`/backups/${encodeURIComponent(name)}/download`, name); }
    catch (error) { showToast(error.message || "Unable to download the backup."); }
  }
  if (action === "delete-backup") {
    const name = target.dataset.name;
    if (!window.confirm(`Delete the backup "${name}"? This cannot be undone.`)) return;
    try { await api(`/backups/${encodeURIComponent(name)}`, { method: "DELETE" }); await loadBackups(); render(); showToast("Backup deleted."); }
    catch (error) { showToast(error.message || "Unable to delete the backup."); }
  }
  if (action === "create-role") {
    const name = document.querySelector('[data-org-field="role"]')?.value;
    const roleRank = document.querySelector('[data-org-field="role-rank"]')?.value;
    const roleScope = document.querySelector('[data-org-field="role-scope"]')?.value;
    if (name) { try { await api("/org/roles", { method: "POST", body: JSON.stringify({ name, rank: roleRank, scope: roleScope }) }); await refresh(); } catch (error) { showToast(error.message); } }
  }
  if (action === "save-role-rank") {
    const roleId = document.querySelector('[data-org-field="role-id"]')?.value;
    const roleRank = document.querySelector('[data-org-field="role-rank-edit"]')?.value;
    const roleScope = document.querySelector('[data-org-field="role-scope-edit"]')?.value;
    if (roleId) { try { await api(`/org/roles/${roleId}`, { method: "PUT", body: JSON.stringify({ rank: roleRank, scope: roleScope }) }); await refresh(); showToast("Role rank and data scope updated."); } catch (error) { showToast(error.message); } }
  }
  if (action === "save-role-permissions") {
    const roleId = document.querySelector('[data-org-field="role-id"]')?.value;
    const selected = Array.from(document.querySelectorAll('.check-grid input[name="permissions"]:checked')).map((input) => input.value);
    if (roleId) { try { await api(`/org/roles/${roleId}/permissions`, { method: "PUT", body: JSON.stringify({ permissions: selected }) }); await refresh(); showToast("Role permissions saved."); } catch (error) { showToast(error.message); } }
  }
  if (action === "toggle-user") {
    try { await api(`/org/users/${id}`, { method: "PUT", body: JSON.stringify({ active: target.dataset.active === "1" }) }); await refresh(); showToast("Staff access updated."); }
    catch (error) { showToast(error.message || "Unable to update staff access."); }
  }
  if (action === "reset-password") resetPassword(id);
  if (action === "convert-lead") openBecomeClient(id);
  if (action === "decide-approval") {
    try { await api(`/org/approvals/${id}`, { method: "PUT", body: JSON.stringify({ status: target.dataset.status }) }); await refresh(); showToast(`Approval ${target.dataset.status}.`); }
    catch (error) { showToast(error.message || "Unable to update approval."); }
  }
  if (action === "view-debts") {
    state.view = "debts";
    updateNavigation();
    render();
  }
  if (action === "close-modal") closeModal();
  if (action === "confirm-dialog-accept") {
    const resolve = state.confirmResolve;
    state.transitionNotes = document.getElementById("confirm-note")?.value || "";
    state.confirmResolve = null;
    modalBackdrop.hidden = true;
    modal.innerHTML = "";
    if (resolve) resolve(true);
  }
});

content.addEventListener("change", (event) => {
  if (event.target.dataset.orgField === "role-id") {
    const selectedOption = event.target.selectedOptions?.[0];
    const selected = JSON.parse(selectedOption?.dataset.permissions || "[]");
    const rankField = document.querySelector('[data-org-field="role-rank-edit"]');
    if (rankField) rankField.value = selectedOption?.dataset.rank || 0;
    document.querySelectorAll('.check-grid input[name="permissions"]').forEach((input) => { input.checked = selected.includes(input.value); });
    return;
  }
  // Priority and status filters on the assignments workspace. Both are re-read
  // from the server rather than filtering the rows in the browser, so the counts
  // and the badge stay consistent with the whole table, not one page of it.
  if (event.target.dataset.action === "task-priority-filter") {
    state.taskPriority = event.target.value;
    loadTasks().then(() => { if (state.view === "assignments") render(); });
    return;
  }
  if (event.target.dataset.action === "task-status-filter") {
    state.taskStatus = event.target.value;
    loadTasks().then(() => { if (state.view === "assignments") render(); });
    return;
  }
  const filter = event.target.dataset.filter;
  if (!filter) return;
  if (Object.prototype.hasOwnProperty.call(state.reportFilters, filter)) {
    state.reportFilters[filter] = event.target.value;
    loadReportHistory();
    return;
  }
  state.filters[filter] = event.target.value;
  render();
});

content.addEventListener("submit", async (event) => {
  if (event.target.id !== "template-upload-form") return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const payload = new FormData(form);
    if (!payload.get("is_default")) payload.delete("is_default");
    const result = await api("/contract-templates/upload", { method: "POST", form: true, body: payload });
    showToast(`Template "${result.title}" uploaded (${(result.placeholders || []).length} placeholders found).`);
    state.templatesLoaded = false;
    state.templatesRequested = false;
    render();
  } catch (error) {
    showToast(error.message || "Upload failed.");
    if (button) button.disabled = false;
  }
});

content.addEventListener("submit", async (event) => {
  if (event.target.id !== "lead-form") return;
  event.preventDefault();
  try { await api("/org/leads", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); await refresh(); showToast("Lead added."); }
  catch (error) { showToast(error.message || "Unable to add lead."); }
});

content.addEventListener("submit", async (event) => {
  if (event.target.id !== "follow-up-form") return;
  event.preventDefault();
  try { await api("/org/follow-ups", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); await refresh(); showToast("Follow-up scheduled."); }
  catch (error) { showToast(error.message || "Unable to schedule follow-up."); }
});

content.addEventListener("submit", async (event) => {
  if (event.target.id !== "staff-form") return;
  event.preventDefault();
  try {
    const body = Object.fromEntries(new FormData(event.target));
    body.role_ids = body.role_ids ? [body.role_ids] : [];
    body.department_ids = body.department_ids ? [body.department_ids] : [];
    await api("/org/users", { method: "POST", body: JSON.stringify(body) });
    await refresh();
    showToast("Staff account created.");
  }
  catch (error) { showToast(error.message || "Unable to create staff account."); }
});

// Report history search reloads as you type (debounced), keeping the caret in place.
content.addEventListener("input", (event) => {
  if (event.target.dataset.filter !== "search") return;
  state.reportFilters.search = event.target.value;
  clearTimeout(state.reportSearchTimer);
  state.reportSearchTimer = setTimeout(loadReportHistory, 350);
});

modal.addEventListener("submit", handleFormSubmit);
modal.addEventListener("input", (event) => {
  if (!event.target.closest("#contract-generate-form")) return;
  if (event.target.id === "gc-original") event.target.dataset.touched = "1";
  state.contractGen.data = generateContractFormData();
  updateGenerateContractPreview();
});
modal.addEventListener("change", (event) => {
  if (event.target.dataset?.profileUpload) {
    uploadProfileImage(event.target.dataset.profileUpload, event.target.files?.[0]);
    return;
  }
  if (event.target.id === "gc-attachment") {
    state.contractGen.attachment = event.target.files?.[0] || null;
    return;
  }
  if (event.target.id === "gc-project") {
    const data = generateContractFormData();
    state.contractGen.data = { ...data, property_id: null };
    renderGenerateContractModal();
    updateGenerateContractPreview();
    return;
  }
  if (event.target.id === "gc-client") {
    const selected = event.target.selectedOptions?.[0];
    const name = document.getElementById("gc-client-name");
    const phone = document.getElementById("gc-client-phone");
    const email = document.getElementById("gc-client-email");
    if (name && selected?.dataset.name) name.value = selected.dataset.name;
    if (phone && selected) phone.value = selected.dataset.phone || "";
    if (email && selected) email.value = selected.dataset.email || "";
  }
  if (event.target.closest("#contract-generate-form")) {
    state.contractGen.data = generateContractFormData();
    updateGenerateContractPreview();
  }
});
modalBackdrop.addEventListener("click", (event) => { if (event.target === modalBackdrop) closeModal(); });
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  // An open row menu is the innermost layer, so Escape closes it first.
  const openMenu = document.querySelector(".row-menu-list:not([hidden])");
  if (openMenu) {
    const toggle = openMenu.parentElement?.querySelector('[data-action="toggle-row-menu"]');
    closeRowMenus();
    toggle?.focus();
    return;
  }
  if (!modalBackdrop.hidden) closeModal();
});
// A fixed-position menu would drift away from its row on scroll; close it.
window.addEventListener("scroll", () => closeRowMenus(), { passive: true, capture: true });
window.addEventListener("resize", () => closeRowMenus());

// Topbar search filters the rows already on screen. It re-applies after every
// render so a filter survives navigation within the same term.
if (globalSearch) {
  globalSearch.addEventListener("input", applySearch);
  globalSearch.addEventListener("search", applySearch);
  // Cmd/Ctrl+K focuses the box, matching the shortcut shown beside it.
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      globalSearch.focus();
      globalSearch.select();
    }
    if (event.key === "Escape" && document.activeElement === globalSearch) {
      globalSearch.value = "";
      applySearch();
      globalSearch.blur();
    }
  });
}

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(authForm));
  // The chosen portal travels with the credential so the server can refuse the
  // wrong pairing. It is a request, never a grant: `enterWorkspace` still routes
  // on the role the server reports, never on this value.
  body.portal = authMode === "setup" ? "admin" : authPortal;
  body.remember = authRemember ? authRemember.checked : true;
  authSubmit.disabled = true;
  try {
    const path = authMode === "setup" ? "/auth/setup" : "/auth/login";
    const user = await api(path, { method: "POST", body: JSON.stringify(body) });
    enterWorkspace(user);
  } catch (error) {
    showAuthMessage(error.message || "Unable to sign in.");
  } finally {
    authSubmit.disabled = false;
  }
});

authToggle.addEventListener("click", () => setAuthMode(authMode === "setup" ? "login" : "setup"));

if (portalTabs) {
  portalTabs.addEventListener("click", (event) => {
    const tab = event.target.closest(".portal-tab");
    if (tab) setAuthPortal(tab.dataset.portal);
  });
}

// Forgot password. Staff ask the administrator, who presses "Reset password".
// Only then does "Forgot password?" open the form where the person chooses a
// new password; otherwise it tells them to contact the administrator.
const resetForm = document.getElementById("reset-form");
const resetMessage = document.getElementById("reset-message");

function showResetForm(email) {
  authForm.hidden = true;
  if (portalTabs) portalTabs.hidden = true;
  document.querySelector(".auth-switch")?.setAttribute("hidden", "");
  resetForm.hidden = false;
  resetForm.reset();
  const emailInput = document.getElementById("reset-email");
  emailInput.value = email || "";
  resetMessage.hidden = true;
  authTitle.textContent = "Forgot your password?";
  authSubtitle.textContent = "Type your email and choose a new password. This works after your administrator has reset your password.";
  (email ? document.getElementById("reset-password") : emailInput).focus();
}

function closeResetForm(message = "") {
  resetForm.hidden = true;
  authForm.hidden = false;
  document.querySelector(".auth-switch")?.removeAttribute("hidden");
  setAuthMode("login");
  if (message) showAuthMessage(message, "info");
}

// One form: email, new password and confirm, then Save. The server checks that
// the administrator has reset this account; if not, it says to contact them.
if (authForgot) {
  authForgot.addEventListener("click", () => {
    if (authPortal === "admin") {
      showAuthMessage("The administrator account changes its password from Staff → Change my password.", "info");
      return;
    }
    showResetForm(String(document.getElementById("auth-email").value || "").trim());
  });
}

resetForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(resetForm));
  const show = (text, tone = "error") => { resetMessage.textContent = text; resetMessage.classList.toggle("info", tone === "info"); resetMessage.hidden = false; };
  body.email = String(body.email || "").trim();
  if (!body.email || !document.getElementById("reset-email").checkValidity()) { show("Type your work email."); return; }
  if (String(body.new_password || "").length < 8) { show("The new password must have at least 8 characters."); return; }
  if (body.new_password !== body.confirm_password) { show("The two passwords do not match. Type them again."); return; }
  const submit = document.getElementById("reset-submit");
  submit.disabled = true;
  try {
    await api("/auth/reset-password", { method: "POST", body: JSON.stringify(body) });
    const email = body.email;
    closeResetForm("Your new password is saved. Sign in with it now.");
    document.getElementById("auth-email").value = email;
    document.getElementById("auth-password").value = "";
    document.getElementById("auth-password").focus();
  } catch (error) {
    if (error.status === 403 || /no password reset/i.test(error.message || "")) show("Your administrator has not reset your password yet. Contact your administrator, then try again.", "info");
    else show(error.message || "Unable to save the new password.");
  } finally {
    submit.disabled = false;
  }
});
document.getElementById("reset-back")?.addEventListener("click", () => closeResetForm());
// A new attempt clears the previous answer, so an old message never sits under new input.
resetForm?.addEventListener("input", () => { resetMessage.hidden = true; });

document.querySelector('[data-action="logout"]')?.addEventListener("click", async () => {
  try {
    await api("/auth/logout", { method: "POST", body: "{}" });
  } catch (_) { /* sign out locally even if the request fails */ }
  endSession();
  setAuthMode("login");
  setAuthPortal("staff");
});

async function boot() {
  try {
    const { configured } = await api("/auth/state");
    setAuthMode(configured ? "login" : "setup");
  } catch (_) {
    setAuthMode("login");
  }
  // Without a live cookie this is simply the sign-in screen: no "expired" notice.
  try {
    const response = await fetch(`${API_ROOT}/auth/me`, { headers: { ...CSRF_HEADERS }, credentials: "same-origin" });
    if (!response.ok) return;
    enterWorkspace(await response.json());
  } catch (_) {
    hideAuthMessage();
  }
}

boot();
