const API_ROOT = "/api/v1";
const ADMIN_PATH = "/admin";
const STAFF_PATH = "/staff";
const TOKEN_STORAGE_KEY = "mkuyu_token";

function getToken() {
  try { return localStorage.getItem(TOKEN_STORAGE_KEY); } catch (_) { return null; }
}

function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch (_) { /* storage unavailable (e.g. private mode) */ }
}

function clearToken() { setToken(null); }

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
  allocation: null,
  allocationEntity: "client",
  allocationUnassigned: true,
  shares: null,
  reportFilters: { source: "", reportType: "", projectId: "", search: "", from: "", to: "" },
  filters: { project: "", type: "", status: "", debtStatus: "", propertyStatus: "", clientStatus: "", appointmentStatus: "", documentStatus: "", documentSearch: "", sort: "" },
  loading: true,
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

let authMode = "login";
let currentUser = null;

function showAuthMessage(message) {
  authMessage.textContent = message;
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
  authTitle.textContent = isSetup ? "Create workspace" : "Sign in";
  authSubtitle.textContent = isSetup ? "Set up the first private office account." : "Use your private workspace credentials.";
  authSubmit.innerHTML = isSetup ? 'Create workspace <span>↗</span>' : 'Enter workspace <span>↗</span>';
  authSwitchLabel.textContent = isSetup ? "Already have access?" : "New private workspace?";
  authToggle.textContent = isSetup ? "Sign in" : "Create an account";
  hideAuthMessage();
}

function endSession(message = "") {
  clearToken();
  currentUser = null;
  closeModal();
  // Cached picture blobs belong to the session that fetched them. Signing out
  // releases them rather than leaving them for whoever signs in next.
  clearImageBlobCache();
  state.navOpen = false;
  document.getElementById("primary-nav")?.classList.remove("nav-open");
  workspace.hidden = true;
  authScreen.hidden = false;
  if (message) showAuthMessage(message);
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
  document.getElementById("user-avatar").textContent = name.charAt(0).toUpperCase();
  bootstrap();
}

/** Resolves the caller's permissions, scope and module list before anything renders. */
async function bootstrap() {
  state.loading = true;
  try {
    const me = await api("/org/me");
    state.organization.me = me;
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
  dashboard: ["Dashboard", "Overview of contracts, debts, and reminders"],
  projects: ["Projects", "Organize contracts and client records by development"],
  properties: ["Properties", "List, track, and classify estate inventory"],
  clients: ["Clients", "Contacts, roles, and relationship status across projects"],
  contracts: ["Contracts", "Track new and terminal contracts across every project"],
  debts: ["Debts", "Monitor client balances, due dates, and payment progress"],
  appointments: ["Appointments", "Viewings, calls, meetings, and inspections"],
  documents: ["Documents", "Agreements, titles, invoices, reports, and permits"],
  reports: ["Reports", "Turn project activity into clear management records"],
  "admin-dashboard": ["Admin overview", "Control staff access, privileges, and organization performance"],
  organization: ["Administration", "Staff, roles, departments, approvals, and organization activity"],
};

// Contract lifecycle labels. The status vocabulary is defined server-side in
// backend/src/contracts/workflow.js; this is the display layer over it, and the
// matching badge colours live in app.css.
const CONTRACT_STATUS_LABELS = {
  draft: "Draft",
  submitted: "Submitted to Legal",
  under_review: "Under legal review",
  changes_requested: "Changes requested",
  legal_approved: "Legally approved",
  pending_management_approval: "Pending management approval",
  approved: "Approved",
  customer_pending: "Awaiting customer",
  active: "Active",
  completed: "Completed",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

function contractStatusBadge(status) {
  return `<span class="badge badge-contract-${escapeHtml(String(status || "draft"))}">${escapeHtml(contractStatusLabel(status))}</span>`;
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
  return { paid: "Paid", partial: "Part paid", overdue: "Overdue", upcoming: "Upcoming", pending: "Pending" }[state] || state;
}

function badge(value, variant) {
  const normalized = String(value || "").toLowerCase();
  const key = variant ? String(variant).toLowerCase() : normalized;
  return `<span class="badge badge-${escapeHtml(key)}">${escapeHtml(value)}</span>`;
}

function badgeVariant(value, variant) {
  const safe = String(value ?? "").trim() || "unknown";
  const key = String(variant || safe).toLowerCase();
  return `<span class="badge badge-${escapeHtml(key)}">${escapeHtml(safe)}</span>`;
}

function documentIcon(category) {
  const map = {
    agreement: "⌥",
    title: "⌖",
    invoice: "$",
    receipt: "✓",
    report: "✦",
    permit: "⌘",
    other: "▱",
  };
  return `<span class="doc-icon-mark">${map[category] || map.other}</span>`;
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
  const token = getToken();
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API_ROOT}${path}`, { headers });
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
  const token = getToken();
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API_ROOT}${path}`, { headers });
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
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API_ROOT}${path}`, { ...rest, headers });
  const payload = await response.json().catch(() => ({}));
  const isCredentialRequest = path.startsWith("/auth/login") || path.startsWith("/auth/setup");
  if (response.status === 401 && !isCredentialRequest) {
    const error = new Error(payload.error || "session expired");
    error.sessionExpired = true;
    endSession("Your session has expired. Please sign in again.");
    throw error;
  }
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
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
  updateNavigation();
  render();
}

function applyWorkspace(payload) {
  const admin = payload.admin || {};
  state.projects = payload.projects || [];
  state.contracts = payload.contracts || [];
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
  state.organization.leads = payload.leads || [];
  state.organization.followUps = payload.followUps || [];
  state.organization.departments = admin.departments || [];
  state.organization.roles = admin.roles || [];
  state.organization.users = admin.users || [];
  state.organization.audit = admin.audit || [];
  state.organization.approvals = admin.approvals || [];
  state.organization.dashboard = admin.dashboard || null;
  state.organization.collections = admin.collections || null;
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

function can(permission) {
  return isAdmin() || (state.organization.me?.permissions || []).includes(permission);
}

function canModule(module) {
  return isAdmin() || (state.organization.me?.modules || []).includes(module);
}

function canSeeFinancial() {
  return isAdmin() || state.organization.me?.financial === true;
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
const NAV_ITEMS = [
  { view: "dashboard", label: "Dashboard", icon: "◆" },
  { view: "admin-dashboard", label: "Admin overview", icon: "⚙", adminOnly: true },
  { view: "projects", label: "Projects", icon: "▦", module: "projects", permission: "view" },
  { view: "properties", label: "Properties", icon: "⌂", module: "properties", permission: "view" },
  { view: "clients", label: "Clients", icon: "◌", module: "clients", permission: "view" },
  { view: "contracts", label: "Contracts", icon: "▤", module: "contracts", permission: "view" },
  { view: "debts", label: "Payments", icon: "◷", module: "debts", permission: "view_financial" },
  { view: "appointments", label: "Appointments", icon: "◫", module: "appointments", permission: "view" },
  { view: "documents", label: "Documents", icon: "▱", module: "documents", permission: "view" },
  { view: "reports", label: "Reports", icon: "↗", module: "reports", permission: "view_reports" },
  { view: "organization", label: "Administration", icon: "◎", adminOnly: true },
];

/** Whether the caller is entitled to a navigation entry at all. */
function canSeeNavItem(item) {
  if (item.adminOnly) return isAdmin();
  if (!item.module) return true;
  return canModule(item.module) && can(item.permission);
}

// Navigation mirrors the server's module list, so a visible item is also a
// request the server would allow. Items the caller may not open are never
// written into the DOM, so they cannot be clicked, focused or inspected.
function updateNavigation() {
  const nav = document.getElementById("primary-nav");
  if (nav) {
    const allowed = NAV_ITEMS.filter(canSeeNavItem);
    const activeView = state.view;
    nav.innerHTML = allowed.map((item) => `<button class="nav-item${item.view === activeView ? " active" : ""}" data-view="${item.view}"><span class="nav-ic">${item.icon}</span><span>${escapeHtml(item.label)}</span></button>`).join("");
  }
  // Administrator-only controls outside the nav are hidden for anyone else, but
  // the element is RESTORED rather than deleted. Removing it permanently meant a
  // staff session that ran this once left the button missing for the next
  // administrator who signed in on the same page.
  document.querySelectorAll("[data-admin-only]").forEach((element) => {
    element.hidden = !isAdmin();
  });
  if (!isAdmin() && (state.view === "admin-dashboard" || state.view === "organization")) state.view = "dashboard";
  if (allowedViewFor(state.view) === false) state.view = "dashboard";
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
      <button class="btn btn-soft btn-small" data-action="open-shares" data-entity="${active.entity}" data-id="${record.id}">Shares</button>
    </div></td>
  </tr>`).join("");
  const tabs = entities.filter((entry) => entry.unassigned > 0 || entry.total > 0).map((entry) => `<button class="btn btn-small ${entry.entity === active.entity ? "btn-primary" : "btn-soft"}" data-action="select-allocation" data-entity="${entry.entity}">${escapeHtml(entry.entity)} (${entry.unassigned})</button>`).join(" ");
  return `<section class="card glass">
    <div class="section-head"><div><h2 class="section-title">Record allocation</h2><div class="section-note">Assign an owner and department so records follow sector visibility instead of the office-wide pool</div></div>
      <button class="btn btn-soft btn-small" data-action="reload-allocation">${state.allocationUnassigned === false ? "Show all" : "Unassigned only"}</button>
    </div>
    <div class="row-actions" style="margin-bottom:12px">${tabs}</div>
    ${rows ? `<div class="table-wrap"><table><thead><tr><th>Record</th><th>Owner</th><th>Department</th><th>Shares</th><th class="align-right">Assign</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="empty"><strong>Nothing to allocate</strong>Every ${escapeHtml(active.entity)} record already has an owner.</div>`}
  </section>`;
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
  modal.innerHTML = `<div class="modal-head"><div><h2>Sharing</h2><p>${escapeHtml(entity)} #${recordId}</p></div><button class="icon-btn" data-action="close-modal">×</button></div>
    <div class="form-grid">
      <div class="field"><label for="share-user">Share with a person</label><select id="share-user"><option value="">Select staff</option>${users}</select></div>
      <div class="field"><label for="share-department">Or a department</label><select id="share-department"><option value="">Select department</option>${departments}</select></div>
      <button class="btn btn-primary" data-action="share-record">Share record</button>
    </div>
    ${rows ? `<div class="table-wrap" style="margin-top:16px"><table><thead><tr><th>Shared with</th><th>Type</th><th>Since</th><th class="align-right">Action</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty" style="margin-top:16px">Not shared with anyone yet.</div>`}`;
  modalBackdrop.hidden = false;
}

function renderOrganization() {
  const org = state.organization;
  const permissions = org.me?.permissions || [];
  const canManage = permissions.includes("manage_permissions") || permissions.includes("manage_roles");
  const metrics = org.dashboard || {};
  const leadRows = org.leads.map((lead) => `<tr><td><strong>${escapeHtml(lead.name)}</strong><div class="table-sub">${escapeHtml(lead.email || lead.phone || "No contact")}</div></td><td>${badge(lead.status)}</td><td>${escapeHtml(lead.source || "Direct")}</td><td>${lead.client_id ? "Converted" : `<button class="btn btn-soft" data-action="convert-lead" data-id="${lead.id}">Convert</button>`}</td></tr>`).join("");
  // The staff register is grouped by DEPARTMENT, in the organization's declared
  // order, because that is the structure MKUYU actually runs on. A person's role
  // is shown inside their department as a badge - a role is never used as a
  // heading, so "Legal Officer" can never be mistaken for a department. Grouping
  // is derived from each user's real `departments`, so the display can never
  // disagree with the access model.
  const DEPARTMENT_ORDER = [
    "MANAGEMENT",
    "FINANCE & ACCOUNTS",
    "SALES, MARKETING & OPERATIONS",
    "ICT & ADMINISTRATION",
    "LEGAL",
    "CUSTOMER SERVICE",
  ];
  // Display names, so a demo does not read as a shouty constant.
  const DEPARTMENT_LABELS = {
    "MANAGEMENT": "Management",
    "FINANCE & ACCOUNTS": "Finance & Accounts",
    "SALES, MARKETING & OPERATIONS": "Sales, Marketing & Operations",
    "ICT & ADMINISTRATION": "ICT & Administration",
    "LEGAL": "Legal",
    "CUSTOMER SERVICE": "Customer Service",
  };

  const userRow = (user) => `<tr><td><strong>${escapeHtml(user.display_name)}</strong><div class="table-sub">${escapeHtml(user.email)}</div></td><td>${user.roles?.map((role) => badge(role.name)).join(" ") || "No role"}</td><td>${user.active ? badge("Active", "approved") : badge("Inactive", "archived")}</td><td><div class="row-actions">${isAdmin() ? `<button class="btn btn-soft btn-small" data-action="reset-password" data-id="${user.id}" title="Set a new sign-in password without changing the account">Reset password</button>` : ""}<button class="btn btn-soft btn-small" data-action="toggle-user" data-id="${user.id}" data-active="${user.active ? 0 : 1}">${user.active ? "Deactivate" : "Activate"}</button></div></td></tr>`;

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

  const departmentGroups = DEPARTMENT_ORDER.filter((name) => usersByDepartment.get(name).length)
    .map((name) => {
      const members = usersByDepartment.get(name).slice().sort(byRank);
      return `<div class="dept-group" data-department="${escapeHtml(name)}">
        <div class="dept-group-head"><span class="dept-group-name">${escapeHtml(DEPARTMENT_LABELS[name] || name)}</span><span class="dept-group-count">${members.length} ${members.length === 1 ? "person" : "people"}</span></div>
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
  const roleRows = org.roles.map((role) => `<tr><td><strong>${escapeHtml(role.name)}</strong>${role.system_role ? `<div class="table-sub">System role</div>` : ""}</td><td>${badge(`Rank ${Number(role.rank || 0)}`, "neutral")}</td><td>${role.permission_count || 0} privileges</td><td>${(role.permissions || []).map((permission) => badge(permission, "approved")).join(" ")}</td></tr>`).join("");
  const roleOptions = org.roles.map((role) => `<option value="${role.id}" data-rank="${Number(role.rank || 0)}" data-permissions="${escapeHtml(JSON.stringify(role.permissions || []))}">${escapeHtml(role.name)} · rank ${Number(role.rank || 0)} · ${role.permission_count || 0} privileges</option>`).join("");
  const staffRoleOptions = org.roles.filter((role) => !role.system_role).map((role) => `<option value="${role.id}">${escapeHtml(role.name)} · rank ${Number(role.rank || 0)}</option>`).join("");
  const departmentOptions = org.departments.map((department) => `<option value="${department.id}">${escapeHtml(department.name)}</option>`).join("");
  const permissionOptions = org.permissions.map((permission) => `<label class="check-field"><input type="checkbox" name="permissions" value="${escapeHtml(permission.permission_key)}">${escapeHtml(permission.permission_key)}</label>`).join("");
  return `<div class="section-grid org-grid">
    <section class="card glass org-intro"><div><div class="eyebrow">Workspace governance</div><h2>Organization control center</h2><p>Keep people, access, approvals, and operational activity aligned across MKUYU.</p></div><div class="org-intro-stats"><span><strong>${permissions.length}</strong> permissions</span><span><strong>${org.users.filter((user) => user.active).length}</strong> active staff</span><span><strong>${org.approvals.filter((item) => item.status === "pending").length}</strong> pending approvals</span></div></section>
    <section class="card glass"><div class="section-head"><div><h2 class="section-title">Management overview</h2><div class="section-note">Live organization records and financial position</div></div></div><div class="metric-grid"><div class="metric"><span>Projects</span><strong>${metrics.projects ?? 0}</strong></div><div class="metric"><span>Properties</span><strong>${metrics.properties ?? 0}</strong></div><div class="metric"><span>Available</span><strong>${metrics.available_properties ?? 0}</strong></div><div class="metric"><span>Clients</span><strong>${metrics.clients ?? 0}</strong></div><div class="metric"><span>Leads</span><strong>${metrics.leads ?? 0}</strong></div><div class="metric"><span>Contracts</span><strong>${metrics.contracts ?? 0}</strong></div><div class="metric"><span>Income</span><strong>${money(metrics.payments)}</strong></div><div class="metric"><span>Outstanding</span><strong>${money(metrics.outstanding)}</strong></div><div class="metric"><span>Overdue</span><strong>${money(metrics.overdue)}</strong></div></div></section>
    <section class="card glass"><div class="section-head"><div><h2 class="section-title">Access map</h2><div class="section-note">${escapeHtml(org.me?.user?.display_name || "Workspace")} · ${permissions.length} permissions</div></div></div><div class="table-wrap"><table><thead><tr><th>Departments</th><th>Roles</th><th>Staff</th></tr></thead><tbody><tr><td>${org.departments.length}</td><td>${org.roles.length}</td><td>${org.users.length}</td></tr></tbody></table></div>${canManage ? `<div class="form-grid" style="margin-top:18px"><div class="field"><label for="org-department">New department</label><input id="org-department" data-org-field="department" placeholder="Department name"></div><button class="btn btn-primary" data-action="create-department">Add department</button><div class="field"><label for="org-role">New role</label><input id="org-role" data-org-field="role" placeholder="Role name"></div><div class="field"><label for="org-role-rank">Role rank</label><input id="org-role-rank" data-org-field="role-rank" type="number" min="0" max="100" value="20" placeholder="20"></div><div class="field"><label for="org-role-scope">Data scope</label><select id="org-role-scope" data-org-field="role-scope"><option value="own">Own records only</option><option value="department">Department records</option><option value="organization">Whole organization</option></select></div><button class="btn btn-primary" data-action="create-role">Add role</button><div class="field"><label for="org-role-select">Assign permissions to role</label><select id="org-role-select" data-org-field="role-id"><option value="">Select role</option>${roleOptions}</select></div><div class="field"><label for="org-role-rank-edit">Selected role rank</label><input id="org-role-rank-edit" data-org-field="role-rank-edit" type="number" min="0" max="100" value="0" placeholder="20"></div><div class="field"><label for="org-role-scope-edit">Selected role scope</label><select id="org-role-scope-edit" data-org-field="role-scope-edit"><option value="">Keep current</option><option value="own">Own records only</option><option value="department">Department records</option><option value="organization">Whole organization</option></select></div><div class="field full check-grid">${permissionOptions}</div><button class="btn btn-gold" data-action="save-role-permissions">Save role permissions</button><button class="btn btn-soft" data-action="save-role-rank">Save role rank</button></div>` : ""}</section>
    <section class="card glass"><div class="section-head"><div><h2 class="section-title">Lead intake</h2><div class="section-note">Sales and marketing queue</div></div></div><form id="lead-form" class="form-grid"><div class="field"><label for="lead-name">Name</label><input id="lead-name" name="name" required placeholder="Customer inquiry"></div><div class="field"><label for="lead-contact">Email</label><input id="lead-contact" name="email" type="email" placeholder="customer@example.com"></div><div class="field"><label for="lead-source">Source</label><input id="lead-source" name="source" placeholder="Public website"></div><button class="btn btn-primary" type="submit">Add lead</button></form><div class="table-wrap" style="margin-top:18px"><table><thead><tr><th>Lead</th><th>Status</th><th>Source</th><th>Next</th></tr></thead><tbody>${leadRows || `<tr><td colspan="4" class="empty">No leads yet</td></tr>`}</tbody></table></div></section>
    <section class="card glass"><div class="section-head"><div><h2 class="section-title">Follow-up desk</h2><div class="section-note">Sales, service, and collections activity</div></div></div><form id="follow-up-form" class="form-grid"><div class="field"><label for="follow-up-date">Due date</label><input id="follow-up-date" name="due_at" type="datetime-local" required></div><div class="field"><label for="follow-up-type">Type</label><select id="follow-up-type" name="follow_up_type"><option value="call">Call</option><option value="meeting">Meeting</option><option value="visit">Visit</option><option value="message">Message</option></select></div><div class="field"><label for="follow-up-notes">Notes</label><input id="follow-up-notes" name="notes" placeholder="Next action"></div><button class="btn btn-primary" type="submit">Schedule follow-up</button></form><div class="table-wrap" style="margin-top:16px"><table><thead><tr><th>Type</th><th>Due</th><th>Status</th><th>Outcome</th></tr></thead><tbody>${followUpRows || `<tr><td colspan="4" class="empty">No follow-ups yet</td></tr>`}</tbody></table></div></section>
    ${permissions.includes("manage_users") ? `<section class="card glass"><div class="section-head"><div><h2 class="section-title">Staff access</h2><div class="section-note">Grouped by department · one role per person</div></div></div><form id="staff-form" class="form-grid"><div class="field"><label for="staff-name">Display name</label><input id="staff-name" name="display_name" required placeholder="Staff member"></div><div class="field"><label for="staff-email">Email</label><input id="staff-email" name="email" type="email" required placeholder="staff@company.com"></div><div class="field"><label for="staff-password">Temporary password</label><input id="staff-password" name="password" type="password" minlength="8" required placeholder="At least 8 characters"></div><div class="field"><label for="staff-role">Role and privilege rank</label><select id="staff-role" name="role_ids" required><option value="">Select role</option>${staffRoleOptions}</select></div><div class="field"><label for="staff-department">Department</label><select id="staff-department" name="department_ids"><option value="">No department</option>${departmentOptions}</select></div><button class="btn btn-primary" type="submit">Create staff</button></form><div style="margin-top:16px">${userRows || `<div class="card glass empty"><strong>No staff records</strong></div>`}</div></section>` : ""}
    ${permissions.includes("view_financial") ? `<section class="card glass"><div class="section-head"><div><h2 class="section-title">Collections pulse</h2><div class="section-note">Outstanding and due soon</div></div></div><div class="metric-grid"><div class="metric"><span>Outstanding</span><strong>${org.collections?.outstanding?.length || 0}</strong></div><div class="metric"><span>Overdue</span><strong>${org.collections?.overdue?.length || 0}</strong></div><div class="metric"><span>Due soon</span><strong>${org.collections?.due_soon?.length || 0}</strong></div><div class="metric"><span>Open follow-ups</span><strong>${org.collections?.follow_ups?.length || 0}</strong></div></div></section>` : ""}
    <section class="card glass"><div class="section-head"><div><h2 class="section-title">Activity</h2><div class="section-note">Recorded organization actions</div></div></div><div class="table-wrap"><table><thead><tr><th>User</th><th>Action</th><th>Module</th><th>When</th></tr></thead><tbody>${activityRows || `<tr><td colspan="4" class="empty">No activity recorded</td></tr>`}</tbody></table></div></section>
    ${permissions.includes("approve") ? `<section class="card glass"><div class="section-head"><div><h2 class="section-title">Approvals</h2><div class="section-note">Contracts, documents, and financial decisions</div></div></div><div class="table-wrap"><table><thead><tr><th>Module</th><th>Record</th><th>Status</th><th>Decision</th><th>Action</th></tr></thead><tbody>${approvalRows || `<tr><td colspan="5" class="empty">No approval requests</td></tr>`}</tbody></table></div></section>` : ""}
    ${permissions.includes("manage_users") ? `<section class="card glass"><div class="section-head"><div><h2 class="section-title">Record allocation</h2><div class="section-note">Move records out of the office-wide pool into an owner and department</div></div><button class="btn btn-soft btn-small" data-action="reload-allocation">Refresh</button></div>${renderAllocation(state.allocationEntity || "client")}</section>` : ""}
  </div>`;
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
const liveImageUrls = new WeakSet();

function revokeImageBlob(url) {
  if (!url || !url.startsWith("blob:")) return;
  try { URL.revokeObjectURL(url); } catch (_) { /* already revoked */ }
}

// Called after each render: release any blob whose <img> is no longer on screen.
function releaseDetachedImageBlobs(root = document) {
  for (const [src, url] of imageBlobCache) {
    if (liveImageUrls.has(url)) continue;
    const stillUsed = Array.from(root.querySelectorAll("img")).some((img) => img.src === url);
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
      const token = getToken();
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(src, { headers });
      if (!response.ok) throw new Error(`image load failed (${response.status})`);
      const url = URL.createObjectURL(await response.blob());
      imageBlobCache.set(src, url);
      liveImageUrls.add(url);
      img.src = url;
    } catch (_) {
      // Pictures are optional: a missing image never breaks the view.
      if (img.closest(".photo-chip")) img.closest(".photo-chip").remove();
      else img.remove();
    }
  }));
  releaseDetachedImageBlobs(root);
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

function card(label, value, foot, icon = "◆", tone = "") {
  return `<article class="card glass card-accent"><div><div class="card-label">${escapeHtml(label)}</div><div class="card-value">${value}</div><div class="card-foot">${foot}</div></div><div class="card-icon ${tone}">${icon}</div></article>`;
}

function renderLoading() {
  content.innerHTML = `<div class="loading glass"><div><div class="spinner"></div>Loading workspace…</div></div>`;
}

// Sector dashboard. Only cards whose module the caller holds are rendered, and
// every monetary card is gated on `view_financial`, so a sales dashboard can
// never display balances or income.
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

  const cards = [];
  if (canModule("projects")) cards.push(card("Active projects", summary.active_projects || 0, "Developments in progress", "▥", "teal"));
  if (canModule("properties")) cards.push(card("Available properties", summary.properties_available || 0, "Ready to sell or lease", "⌂", "teal"));
  if (canModule("leads")) cards.push(card("Open leads", leads.filter((lead) => lead.status !== "converted").length, `${leads.filter((lead) => lead.status === "new").length} new enquiries`, "◌", "teal"));
  if (canModule("clients")) cards.push(card("Active clients", summary.clients_active || 0, "Relationships on record", "◍", "teal"));
  if (canModule("follow_ups")) cards.push(card("Follow-ups", followUps.filter((entry) => entry.status === "open").length, "Open tasks assigned", "↻", "teal"));
  if (canModule("contracts")) cards.push(card("New contracts", newContracts.count || 0, `${money(newContracts.total || 0)} active value`, "↗", "teal"));
  if (canModule("appointments")) cards.push(card("Scheduled viewings", summary.appointments_scheduled || 0, "Appointments booked", "◫", "teal"));
  if (canModule("documents")) cards.push(card("Pending documents", summary.documents_pending || 0, "Awaiting approval", "▱", "amber"));
  if (financial && canModule("debts")) cards.push(card("Open debts", pending.count || 0, `${money(pending.total || 0)} awaiting payment`, "◷", "amber"));
  if (financial && canModule("debts")) cards.push(card("Overdue", overdue.count || 0, `${money(overdue.total || 0)} needs follow-up`, "!", "red"));
  if (financial && canModule("payments")) cards.push(card("Collected · 30 days", money(income30.total || 0), `${income30.count || 0} payment${income30.count === 1 ? "" : "s"} recorded`, "$", "teal"));

  // Declared before the panels below: the portfolio panel renders this chart.
  const maxProjectValue = Math.max(1, ...state.projectReports.map((project) => numberValue(project.contract_value)));
  const chart = state.projectReports.length ? state.projectReports.map((project) => {
    const height = Math.max(5, Math.round(numberValue(project.contract_value) / maxProjectValue * 110));
    return `<div class="chart-col" title="${escapeHtml(project.name)}: ${money(project.contract_value)}"><div class="chart-value">${money(project.contract_value)}</div><div class="chart-bar" style="height:${height}px"></div><div class="chart-label">${escapeHtml(project.name)}</div></div>`;
  }).join("") : `<div class="empty">Add a project to begin building your portfolio.</div>`;

  const panels = [];
  if (canModule("projects") || canModule("contracts")) {
    panels.push(`<article class="card glass"><div class="section-head"><div><h2 class="section-title">Portfolio value</h2><div class="section-note">Contract value by project</div></div><span class="badge badge-active">Live records</span></div><div class="chart">${chart}</div></article>`);
  }
  if (canModule("contracts")) {
    panels.push(`<article class="card glass"><div class="section-head"><div><h2 class="section-title">Contract mix</h2><div class="section-note">New versus terminal records</div></div></div><div class="grid grid-2"><div><div class="card-label">New contracts</div><div class="card-value positive">${newContracts.count || 0}</div><div class="card-foot">${money(newContracts.total || 0)}</div></div><div><div class="card-label">Terminal contracts</div><div class="card-value warning-text">${terminal.count || 0}</div><div class="card-foot">${money(terminal.total || 0)}</div></div></div><div class="trend">Use Reports for a detailed breakdown.</div></article>`);
  }
  if (canModule("leads")) {
    const rows = leads.slice(0, 6).map((lead) => `<tr><td><span class="cell-main">${escapeHtml(lead.name)}</span><span class="cell-sub">${escapeHtml(lead.source || "—")}</span></td><td>${badge(lead.status, "neutral")}</td><td class="align-right">${formatDate(lead.created_at)}</td></tr>`).join("");
    panels.push(`<article class="card glass"><div class="section-head"><div><h2 class="section-title">Latest leads</h2><div class="section-note">Enquiries assigned to your sector</div></div></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>Lead</th><th>Status</th><th class="align-right">Received</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><strong>No leads yet</strong>New enquiries will appear here.</div>`}</article>`);
  }
  if (canModule("appointments")) {
    const rows = [...state.appointments].sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at))).slice(0, 6).map((entry) => `<tr><td><span class="cell-main">${escapeHtml(entry.title)}</span><span class="cell-sub">${escapeHtml(entry.client_name || "")}</span></td><td>${escapeHtml(entry.project_name || "—")}</td><td class="align-right">${formatDateTime(entry.starts_at)}</td></tr>`).join("");
    panels.push(`<article class="card glass"><div class="section-head"><div><h2 class="section-title">Next appointments</h2><div class="section-note">Viewings, calls and inspections</div></div></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>Appointment</th><th>Project</th><th class="align-right">When</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><strong>Nothing booked</strong>Schedule a viewing or call.</div>`}</article>`);
  }

  if (canModule("contracts")) {
    // The contract value is deliberately shown to every caller holding the
    // contracts module, financial or not: Sales negotiates the price and Legal
    // reviews the commercial terms, so the server returns `contracts.value` to
    // them and the UI must agree. What is withheld from a non-financial caller
    // is the FINANCIAL aggregate set - outstanding, overdue, income, the debt
    // and payment registers - and those are gated on `financial` above.
    panels.push(`<article class="card glass"><div class="section-head"><div><h2 class="section-title">Recent contracts</h2><div class="section-note">Latest additions to the register</div></div>${can("create") ? `<button class="btn btn-soft btn-small" data-action="new-contract">+ New contract</button>` : ""}</div>${recent.length ? `<div class="table-wrap"><table><thead><tr><th>Client</th><th>Project</th><th>Type</th><th>Value</th></tr></thead><tbody>${recent.map((contract) => `<tr><td><span class="cell-main">${escapeHtml(contract.client_name)}</span></td><td><span class="cell-sub">${escapeHtml(contract.project_name)}</span></td><td>${badge(contract.contract_type)}</td><td class="amount">${money(contract.value)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty"><strong>No contracts yet</strong>Create the first contract to start the register.</div>`}</article>`);
  }
  // Reminders are their own module with their own access key, so the panel is
  // gated on `reminders` rather than on `debts`. Anything the panel links to is
  // gated separately, so a caller without the debts module still gets the list.
  if (financial && canModule("reminders")) {
    panels.push(`<article class="card glass"><div class="section-head"><div><h2 class="section-title">Payment reminders</h2><div class="section-note">Due now or within the next 7 days</div></div>${canModule("debts") ? `<button class="btn btn-soft btn-small" data-action="view-debts">View debts</button>` : ""}</div><div class="reminder-list">${upcoming.length ? upcoming.map((debt) => `<div class="reminder"><div class="reminder-icon">◷</div><div class="reminder-copy"><div class="reminder-title">${escapeHtml(debt.client_name)}</div><div class="reminder-meta">${escapeHtml(debt.project_name)} · ${money(debt.amount)} · due ${formatDate(debt.due_date)}</div></div>${debt.remind_at ? `<button class="btn btn-small" data-action="dismiss-reminder" data-id="${debt.id}" title="Mark reminder as handled">Dismiss</button>` : ""}<button class="btn btn-small" data-action="edit-debt" data-id="${debt.debt_id || debt.id}">Review</button></div>`).join("") : `<div class="empty"><strong>All clear</strong>No payments are due in the next 7 days.</div>`}</div></article>`);
  }
  if (canModule("follow_ups")) {
    const rows = followUps.slice(0, 6).map((entry) => `<tr><td><span class="cell-main">${escapeHtml(entry.follow_up_type)}</span></td><td>${badge(entry.status, "neutral")}</td><td class="align-right">${formatDateTime(entry.due_at)}</td></tr>`).join("");
    panels.push(`<article class="card glass"><div class="section-head"><div><h2 class="section-title">Open follow-ups</h2><div class="section-note">Outstanding tasks in your sector</div></div></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>Type</th><th>Status</th><th class="align-right">Due</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><strong>Nothing outstanding</strong>Schedule a follow-up to keep clients engaged.</div>`}</article>`);
  }
  const scope = state.organization.me?.scope || "own";
  const scopeNote = {
    own: "You are seeing your own records and anything shared with you.",
    department: "You are seeing your department's records.",
    organization: "You are seeing every record in the organization.",
  }[scope];
  content.innerHTML = `
    <div class="hero-strip"><div class="hero-copy"><div class="eyebrow">${escapeHtml(state.organization.me?.user?.roles?.[0]?.name || "Workspace")}</div><h2>${escapeHtml(currentUser?.display_name || "Your workspace")}</h2><p>${escapeHtml(scopeNote || "")}</p></div></div>
    ${cards.length ? `<div class="grid grid-5">${cards.join("")}</div>` : `<div class="card glass empty"><strong>No workspace modules assigned</strong>Ask an administrator to grant module access.</div>`}
    ${panels.length ? `<div class="section grid grid-2">${panels.join("")}</div>` : ""}`;
}

function renderProjects() {
  const rows = state.projects.map((project) => {
    const contracts = state.contracts.filter((contract) => contract.project_id === project.id);
    const value = contracts.reduce((sum, contract) => sum + numberValue(contract.value), 0);
    return `<tr><td><span class="cell-main">${escapeHtml(project.name)}</span><span class="cell-sub">${formatDate(project.created_at)}</span></td><td>${badge(project.status)}</td><td class="amount">${contracts.length}</td><td class="amount">${money(value)}</td><td><div class="row-actions">${can("edit") ? `<button class="btn btn-small" data-action="edit-project" data-id="${project.id}">Edit</button>` : ""}${can("delete") ? `<button class="btn btn-danger btn-small icon-btn" data-action="delete-project" data-id="${project.id}" title="Delete project">×</button>` : ""}</div></td></tr>`;
  }).join("");
  content.innerHTML = `<div class="section-head"><div><h2 class="section-title">Project register</h2><div class="section-note">${state.projects.length} projects in the workspace</div></div></div>${state.projects.length ? `<div class="table-wrap"><table><thead><tr><th>Project</th><th>Status</th><th>Contracts</th><th>Value</th><th class="align-right">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="card glass empty"><strong>No projects yet</strong>Create a project before adding contracts.</div>`}`;
}

function renderContracts() {
  const filters = state.filters;
  // Generating a payment schedule creates financial records, so the action is
  // only offered to callers allowed to see money. Built per row: the contract id
  // is only in scope inside the map callback.
  const scheduleAction = (id) => canSeeFinancial() ? `<button class="btn btn-soft btn-small" data-action="generate-schedule" data-id="${id}" title="Generate a payment schedule">Schedule</button>` : "";
  // The workflow steps the API said this caller may take. Rendered as buttons so
  // Legal, Finance, Sales and the MD each act only on their own steps.
  const workflowButtons = (contract) => (contract.available_actions || []).slice(0, 3)
    .map((entry) => `<button class="btn btn-soft btn-small" data-action="contract-transition" data-id="${contract.id}" data-transition="${escapeHtml(entry.action)}" title="${escapeHtml(entry.label)}">${escapeHtml(entry.label)}</button>`)
    .join("");
  const rows = state.contracts.filter((contract) => (!filters.project || String(contract.project_id) === filters.project) && (!filters.type || contract.contract_type === filters.type) && (!filters.status || contract.status === filters.status)).map((contract) => `<tr><td><span class="cell-main">${escapeHtml(contract.client_name)}</span><span class="cell-sub">${escapeHtml(contract.contract_number || contract.project_name || "")}</span></td><td>${badge(contract.contract_type)}</td><td>${contractStatusBadge(contract.status)}</td><td>${formatDate(contract.start_date)}</td><td>${formatDate(contract.end_date)}</td><td class="amount">${money(contract.value)}</td><td><div class="row-actions">${workflowButtons(contract)}<button class="btn btn-small" data-action="contract-history" data-id="${contract.id}">History</button>${can("edit") ? `<button class="btn btn-small" data-action="edit-contract" data-id="${contract.id}">Edit</button>` : ""}${scheduleAction(contract.id)}${can("delete") ? `<button class="btn btn-danger btn-small icon-btn" data-action="delete-contract" data-id="${contract.id}" title="Delete contract">×</button>` : ""}</div></td></tr>`).join("");
  const statusOptions = Object.entries(CONTRACT_STATUS_LABELS)
    .map(([value, label]) => `<option value="${value}" ${filters.status === value ? "selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
  // The visible count is derived from the filtered list, not by counting `<tr>`
  // fragments in the rendered HTML: that regex counted every row marker in the
  // markup and reported a number that had nothing to do with the records shown.
  const visibleCount = state.contracts.filter((contract) => (!filters.project || String(contract.project_id) === filters.project) && (!filters.type || contract.contract_type === filters.type) && (!filters.status || contract.status === filters.status)).length;
  const visibleLabel = `${visibleCount} ${visibleCount === 1 ? "contract" : "contracts"}`;
  content.innerHTML = `<div class="filters"><label class="muted">Filters</label>${projectSelect(filters.project)}<select class="filter-input" data-filter="type" aria-label="Filter by contract type"><option value="">All types</option><option value="new" ${filters.type === "new" ? "selected" : ""}>New</option><option value="terminal" ${filters.type === "terminal" ? "selected" : ""}>Terminal</option></select><select class="filter-input" data-filter="status" aria-label="Filter by contract status"><option value="">All statuses</option>${statusOptions}</select></div><div class="section-head"><div><h2 class="section-title">Contract register</h2><div class="section-note">${visibleLabel}</div></div>${can("create") ? `<button class="btn btn-primary" data-action="new-contract">+ New contract</button>` : ""}</div>${rows ? `<div class="table-wrap"><table><thead><tr><th>Client / project</th><th>Type</th><th>Status</th><th>Start</th><th>End</th><th>Value</th><th class="align-right">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="card glass empty"><strong>No contracts found</strong>Try another filter or create a new contract.</div>`}`;
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
  const rows = state.debts.filter((debt) => (!filters.project || String(debt.project_id) === filters.project) && (!filters.debtStatus || debtState(debt) === filters.debtStatus)).map((debt) => {
    const debtStateValue = debtState(debt);
    const viewContract = canSeeContract && state.contracts.some((c) => String(c.id) === String(debt.contract_id))
      ? `<button class="btn btn-small" data-action="view-contract" data-id="${debt.contract_id}" title="Open the contract this installment belongs to">View contract</button>` : "";
    const settle = debt.status !== "paid"
      ? `${mayEdit ? `<button class="btn btn-soft btn-small" data-action="pay-debt" data-id="${debt.id}">Mark paid</button>` : ""}${mayCreate ? `<button class="btn btn-small" data-action="record-payment" data-id="${debt.id}" title="Record a payment with an optional receipt">Record payment</button>` : ""}`
      : "";
    const edit = mayEdit ? `<button class="btn btn-small" data-action="edit-debt" data-id="${debt.id}">Edit</button>` : "";
    const remove = mayDelete ? `<button class="btn btn-danger btn-small icon-btn" data-action="delete-debt" data-id="${debt.id}" title="Delete debt">×</button>` : "";
    return `<tr><td><span class="cell-main">${escapeHtml(debt.client_name)}</span><span class="cell-sub">${escapeHtml(debt.project_name)}</span></td><td>${badge(debt.contract_type)}</td><td>${badgeVariant(debtStateLabel(debtStateValue), debtStateValue)}</td><td>${formatDate(debt.due_date)}</td><td class="amount ${debtStateValue === "overdue" ? "danger-text" : ""}">${money(debt.amount)}</td><td>${debt.status === "paid" ? "—" : escapeHtml(debt.notes || "")}</td><td><div class="row-actions">${settle}${viewContract}${edit}${remove}</div></td></tr>`;
  }).join("");
  content.innerHTML = `<div class="filters"><label class="muted">Filters</label>${projectSelect(filters.project)}<select class="filter-input" data-filter="debtStatus" aria-label="Filter by debt state"><option value="">All debt states</option><option value="pending" ${filters.debtStatus === "pending" ? "selected" : ""}>Pending</option><option value="partial" ${filters.debtStatus === "partial" ? "selected" : ""}>Part paid</option><option value="upcoming" ${filters.debtStatus === "upcoming" ? "selected" : ""}>Upcoming</option><option value="overdue" ${filters.debtStatus === "overdue" ? "selected" : ""}>Overdue</option><option value="paid" ${filters.debtStatus === "paid" ? "selected" : ""}>Paid</option></select></div><div class="section-head"><div><h2 class="section-title">Debt register</h2><div class="section-note">Client balances linked to contracts</div></div>${mayCreate ? `<button class="btn btn-primary" data-action="new-debt">+ New debt</button>` : ""}</div>${rows ? `<div class="table-wrap"><table><thead><tr><th>Client / project</th><th>Contract</th><th>State</th><th>Due date</th><th>Amount</th><th>Note</th><th class="align-right">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="card glass empty"><strong>No debts found</strong>Add a debt to a contract or change the filters.</div>`}
    <div class="section">
      <div class="section-head"><div><h2 class="section-title">Recorded payments</h2><div class="section-note">Money actually received, with receipts</div></div>${mayCreate ? `<button class="btn btn-soft btn-small" data-action="new-payment">+ Record payment</button>` : ""}</div>
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
  if (!reminders.length) return `<div class="card glass empty"><strong>No reminders due</strong>Nothing needs a payment reminder right now.</div>`;
  // Acknowledging a reminder and opening the debt are both writes the API gates,
  // so both buttons follow the caller's own edit permission.
  const mayEdit = can("edit");
  const rows = reminders.map((reminder) => `<tr>
    <td><span class="cell-main">${escapeHtml(reminder.client_name)}</span><span class="cell-sub">${escapeHtml(reminder.project_name || "")}</span></td>
    <td>${formatDate(reminder.due_date)}</td>
    <td class="amount">${money(reminder.amount)}</td>
    <td>${formatDate(reminder.remind_at, true)}</td>
    <td class="align-right"><div class="row-actions">${mayEdit ? `<button class="btn btn-soft btn-small" data-action="dismiss-reminder" data-id="${reminder.id}">Mark handled</button>` : ""}${mayEdit ? `<button class="btn btn-small" data-action="edit-debt" data-id="${reminder.debt_id}">Review debt</button>` : ""}</div></td>
  </tr>`).join("");
  return `<div class="table-wrap"><table><thead><tr><th>Client / project</th><th>Due date</th><th>Amount</th><th>Reminder at</th><th class="align-right">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// Payments history under the debts view; receipts open in a new tab.
// The permissions are passed in by the caller so the row actions match exactly
// the set the debts register offers on the same screen.
function renderPaymentsTable(mayEdit = can("edit"), mayDelete = can("delete")) {
  const payments = [...(state.payments || [])].sort((a, b) => String(b.paid_at).localeCompare(String(a.paid_at)));
  if (!payments.length) return `<div class="card glass empty"><strong>No payments recorded</strong>Use “Record payment” on a debt to log income with an optional receipt.</div>`;
  const rows = payments.map((payment) => {
    const remove = mayDelete ? `<button class="btn btn-danger btn-small icon-btn" data-action="delete-payment" data-id="${payment.id}" title="Delete payment">×</button>` : "";
    return `<tr><td><span class="cell-main">${escapeHtml(payment.client_name)}</span><span class="cell-sub">${escapeHtml(payment.project_name || "")}</span></td><td>${formatDate(payment.paid_at, String(payment.paid_at).length > 10)}</td><td>${badge(payment.method, "neutral")}</td><td class="amount">${money(payment.amount)}</td><td>${escapeHtml(payment.reference || "—")}</td><td><div class="row-actions">${payment.has_receipt ? `<button class="btn btn-small" data-action="open-receipt" data-id="${payment.id}">View receipt</button>` : `<span class="muted">None</span>`}${remove}</div></td></tr>`;
  }).join("");
  return `<div class="table-wrap"><table><thead><tr><th>Client / project</th><th>Paid at</th><th>Method</th><th>Amount</th><th>Reference</th><th class="align-right">Receipt & actions</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderReports() {
  const filters = state.reportFilters;
  const types = state.reportTypes || [];
  const history = state.reportHistory || [];
  const typeOptions = types.map((type) => `<option value="${escapeHtml(type.id)}" ${filters.reportType === type.id ? "selected" : ""}>${escapeHtml(type.label)}</option>`).join("");
  const sourceOptions = `<option value="">All sources</option><option value="generated" ${filters.source === "generated" ? "selected" : ""}>Generated</option><option value="uploaded" ${filters.source === "uploaded" ? "selected" : ""}>Uploaded</option>`;
  const projectHistoryOptions = projectOptions(filters.projectId);
  const rows = history.map((report) => {
    const date = formatDateTime(report.created_at, true);
    return `<tr>
      <td><span class="cell-main">${escapeHtml(report.title)}</span><span class="cell-sub">${escapeHtml(reportTypeLabel(report.report_type))}</span></td>
      <td>${sourceBadge(report.source)}</td>
      <td>${reportKindBadge(report.file_format)}</td>
      <td><span class="cell-sub">${escapeHtml(report.project_name || "—")}</span></td>
      <td>${escapeHtml(date)}</td>
      <td class="align-right">
        <div class="row-actions">
          <button class="btn btn-small" data-action="download-report" data-id="${report.id}" data-format="${escapeHtml(report.file_format || "xlsx")}" data-source="${escapeHtml(report.source)}">Download</button>
          ${report.source === "generated" ? `<button class="btn btn-small" data-action="reexport-report" data-id="${report.id}" title="Re-generate this report">Re-export</button>` : ""}
          <button class="btn btn-danger btn-small icon-btn" data-action="delete-report" data-id="${report.id}" title="Delete report">×</button>
        </div>
      </td>
    </tr>`;
  }).join("");
  content.innerHTML = `
    <div class="filters">
      <span class="muted">History</span>
      <select class="filter-input" data-filter="source" aria-label="Filter by source">${sourceOptions}</select>
      <select class="filter-input" data-filter="reportType" aria-label="Filter by report type"><option value="">All types</option>${typeOptions}</select>
      <select class="filter-input" data-filter="projectId" aria-label="Filter by project">${projectHistoryOptions}</select>
      <input class="filter-input" data-filter="search" type="search" value="${escapeHtml(filters.search)}" placeholder="Search title or filename" aria-label="Search reports" style="min-width:200px">
      <input class="filter-input" data-filter="from" type="date" value="${escapeHtml(filters.from || "")}" aria-label="From date" style="min-width:150px">
      <input class="filter-input" data-filter="to" type="date" value="${escapeHtml(filters.to || "")}" aria-label="To date" style="min-width:150px">
    </div>
    <div class="section-head">
      <div><h2 class="section-title">Report history</h2><div class="section-note">${history.length} report${history.length === 1 ? "" : "s"} in the workspace</div></div>
      <div class="row-actions">
        <button class="btn btn-primary" data-action="open-report-generate">+ Generate report</button>
        <button class="btn" data-action="open-report-upload">+ Upload report</button>
      </div>
    </div>
    ${rows ? `<div class="table-wrap"><table><thead><tr><th>Report</th><th>Source</th><th>Format</th><th>Project</th><th>Created</th><th class="align-right">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="card glass empty"><strong>No reports found</strong>Generate or upload a report to build the history.</div>`}`;
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
    // `cover_image_id` is only set by the server when the file really exists, so
    // no cover markup is emitted for a picture that would 404.
    const cover = property.cover_image_id
      ? `<div class="property-cover"><img data-src="${API_ROOT}/properties/${property.id}/images/${property.cover_image_id}/file" alt="${escapeHtml(property.name)}" loading="lazy"></div>`
      : "";
    return `<div class="property-card">
      ${cover}
      <div class="property-head">
        <div class="property-name">${escapeHtml(property.name)}</div>
        <div class="property-type">${badge(property.property_type, "neutral")}</div>
      </div>
      <div class="property-meta">
        <div><span class="muted">Status</span>${badge(property.status)}</div>
        <div><span class="muted">Price</span><span class="amount">${price}</span></div>
        ${property.location ? `<div><span class="muted">Location</span>${escapeHtml(property.location)}</div>` : ""}
        ${property.area ? `<div><span class="muted">Area</span>${numberValue(property.area)} units</div>` : ""}
        ${(property.bedrooms || property.bathrooms) ? `<div><span class="muted">Layout</span>${property.bedrooms || 0} bed · ${property.bathrooms || 0} bath</div>` : ""}
        ${property.image_count ? `<div><span class="muted">Photos</span>${property.image_count}</div>` : ""}
      </div>
      ${property.description ? `<p class="property-desc">${escapeHtml(property.description)}</p>` : ""}
      <div class="property-foot">
        <div><span class="muted">Project</span><span class="cell-sub">${escapeHtml(property.project_name || "—")}</span></div>
        <div><span class="muted">Added</span>${formatDate(property.created_at)}</div>
        <div class="row-actions">
          <button class="btn btn-small" data-action="edit-property" data-id="${property.id}"${can("edit") ? "" : " hidden"}>Edit</button>
          <button class="btn btn-danger btn-small icon-btn" data-action="delete-property" data-id="${property.id}" title="Delete property"${can("delete") ? "" : " hidden"}>×</button>
        </div>
      </div>
    </div>`;
  }).join("");
  content.innerHTML = `
    <div class="filters">
      <span class="muted">Filters</span>
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
    <div class="section-head">
      <div><h2 class="section-title">Property register</h2><div class="section-note">${rows.length} propert${rows.length === 1 ? "y" : "ies"} in the workspace</div></div>
      <button class="btn btn-primary" data-action="new-property">+ New property</button>
    </div>
    ${rows.length
      ? `<div class="property-grid">${list}</div>`
      : `<div class="card glass empty"><strong>No properties found</strong>Add the first property to start building your portfolio.</div>`}`;
}

function renderClients() {
  const filters = state.filters;
  const rows = (state.clients || []).filter((client) =>
    (!filters.project || String(client.project_id) === filters.project) &&
    (!filters.clientStatus || client.status === filters.clientStatus)
  );
  const list = rows.map((client) => {
    return `<div class="client-card">
      <div class="client-head">
        <div class="client-name">${escapeHtml(client.name)}</div>
        <div class="client-type">${badge(client.client_type, "neutral")}</div>
      </div>
      <div class="client-meta">
        ${client.email ? `<div><span class="muted">Email</span>${escapeHtml(client.email)}</div>` : ""}
        ${client.phone ? `<div><span class="muted">Phone</span>${escapeHtml(client.phone)}</div>` : ""}
        <div><span class="muted">Status</span>${badge(client.status)}</div>
        ${client.notes ? `<p class="client-notes">${escapeHtml(client.notes)}</p>` : ""}
      </div>
      <div class="client-foot">
        <div><span class="muted">Project</span><span class="cell-sub">${escapeHtml(client.project_name || "—")}</span></div>
        <div><span class="muted">Added</span>${formatDate(client.created_at)}</div>
        <div class="row-actions">
          <button class="btn btn-small" data-action="edit-client" data-id="${client.id}"${can("edit") ? "" : " hidden"}>Edit</button>
          <button class="btn btn-danger btn-small icon-btn" data-action="delete-client" data-id="${client.id}" title="Delete client"${can("delete") ? "" : " hidden"}>×</button>
        </div>
      </div>
    </div>`;
  }).join("");
  content.innerHTML = `
    <div class="filters">
      <span class="muted">Filters</span>
      <select class="filter-input" data-filter="project" aria-label="Filter by project">
        <option value="">All projects</option>
        ${(state.projects || []).map((p) => `<option value="${p.id}" ${filters.project === String(p.id) ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
      </select>
      <select class="filter-input" data-filter="clientStatus" aria-label="Filter by client status">
        <option value="">All statuses</option>
        <option value="lead" ${filters.clientStatus === "lead" ? "selected" : ""}>Lead</option>
        <option value="active" ${filters.clientStatus === "active" ? "selected" : ""}>Active</option>
        <option value="inactive" ${filters.clientStatus === "inactive" ? "selected" : ""}>Inactive</option>
      </select>
    </div>
    <div class="section-head">
      <div><h2 class="section-title">Client register</h2><div class="section-note">${rows.length} contact${rows.length === 1 ? "" : "s"} in the workspace</div></div>
      <button class="btn btn-primary" data-action="new-client">+ New client</button>
    </div>
    ${rows.length
      ? `<div class="client-grid">${list}</div>`
      : `<div class="card glass empty"><strong>No clients found</strong>Add the first contact to begin tracking people.</div>`}`;
}

function renderAppointments() {
  const filters = state.filters;
  const rows = (state.appointments || []).filter((apt) =>
    (!filters.project || String(apt.project_id) === filters.project) &&
    (!filters.appointmentStatus || apt.status === filters.appointmentStatus) &&
    (!filters.type || apt.appointment_type === filters.type)
  ).sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
  const list = rows.map((apt) => {
    return `<div class="apt-row">
      <div class="apt-time">
        <div class="apt-datetime">${formatDateTime(apt.starts_at, true)}</div>
        ${apt.ends_at ? `<div class="apt-datetime muted">${formatDateTime(apt.ends_at, true)}</div>` : ""}
      </div>
      <div class="apt-body">
        <div class="apt-title">${escapeHtml(apt.title)}</div>
        <div class="apt-meta">
          <div><span class="muted">Client</span><span class="cell-main">${escapeHtml(apt.client_name || "—")}</span></div>
          ${apt.property_name ? `<div><span class="muted">Property</span><span class="cell-sub">${escapeHtml(apt.property_name)}</span></div>` : ""}
          <div><span class="muted">Project</span><span class="cell-sub">${escapeHtml(apt.project_name || "—")}</span></div>
          <div><span class="muted">Type</span>${badge(apt.appointment_type, "neutral")}</div>
          <div><span class="muted">Status</span>${badge(apt.status)}</div>
          ${apt.notes ? `<p class="apt-notes">${escapeHtml(apt.notes)}</p>` : ""}
        </div>
      </div>
      <div class="apt-actions">
        <button class="btn btn-small" data-action="edit-appointment" data-id="${apt.id}"${can("edit") ? "" : " hidden"}>Edit</button>
        <button class="btn btn-danger btn-small icon-btn" data-action="delete-appointment" data-id="${apt.id}" title="Delete appointment"${can("delete") ? "" : " hidden"}>×</button>
      </div>
    </div>`;
  }).join("");
  content.innerHTML = `
    <div class="filters">
      <span class="muted">Filters</span>
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
    <div class="section-head">
      <div><h2 class="section-title">Appointment schedule</h2><div class="section-note">${rows.length} appointment${rows.length === 1 ? "" : "s"} in the workspace</div></div>
      <button class="btn btn-primary" data-action="new-appointment">+ New appointment</button>
    </div>
    ${rows.length
      ? `<div class="apt-list">${list}</div>`
      : `<div class="card glass empty"><strong>No appointments found</strong>Schedule a viewing, call, meeting, or inspection.</div>`}`;
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
    const openPath = hasFile ? `/documents/${doc.id}/file?download=1` : null;
    return `<div class="doc-row">
      <div class="doc-icon">${documentIcon(doc.category)}</div>
      <div class="doc-body">
        <div class="doc-title">${escapeHtml(doc.title)}</div>
        <div class="doc-meta">
          <div><span class="muted">Category</span>${badge(doc.category, "neutral")}</div>
          <div><span class="muted">Status</span>${badge(doc.status)}</div>
          <div><span class="muted">Uploaded</span>${formatDate(doc.uploaded_at || doc.created_at)}</div>
          ${hasFile ? `<div><span class="muted">File</span><span class="cell-sub">${escapeHtml(doc.original_filename || doc.file_name || "")} · ${formatBytes(doc.file_size)}</span></div>` : ""}
          ${doc.client_name ? `<div><span class="muted">Client</span><span class="cell-sub">${escapeHtml(doc.client_name)}</span></div>` : ""}
          ${doc.contract_client ? `<div><span class="muted">Contract</span><span class="cell-sub">${escapeHtml(doc.contract_client)}</span></div>` : ""}
          <div><span class="muted">Project</span><span class="cell-sub">${escapeHtml(doc.project_name || "—")}</span></div>
          ${doc.file_reference ? `<div><span class="muted">Reference</span>${escapeHtml(doc.file_reference)}</div>` : ""}
          ${doc.notes ? `<p class="doc-notes">${escapeHtml(doc.notes)}</p>` : ""}
        </div>
      </div>
      <div class="doc-actions">
        ${hasFile ? `<button class="btn btn-small" data-action="open-document" data-id="${doc.id}">Open</button>` : ""}
        <button class="btn btn-small" data-action="edit-document" data-id="${doc.id}"${can("edit") ? "" : " hidden"}>Edit</button>
        <button class="btn btn-danger btn-small icon-btn" data-action="delete-document" data-id="${doc.id}" title="Delete document"${can("delete") ? "" : " hidden"}>×</button>
      </div>
    </div>`;
  }).join("");
  content.innerHTML = `
    <div class="filters">
      <span class="muted">Filters</span>
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
      <input class="filter-input" data-filter="documentSearch" type="search" value="${escapeHtml(filters.documentSearch || "")}" placeholder="Search title" aria-label="Search documents" style="min-width:200px">
    </div>
    <div class="section-head">
      <div><h2 class="section-title">Document register</h2><div class="section-note">${rows.length} document${rows.length === 1 ? "" : "s"} in the workspace</div></div>
      <button class="btn btn-primary" data-action="new-document">+ New document</button>
    </div>
    ${rows.length
      ? `<div class="document-list">${list}</div>`
      : `<div class="card glass empty"><strong>No documents found</strong>Upload or register the first document.</div>`}`;
}

function render() {
  const [title, sub] = viewMeta[state.view] || ["Workspace", ""];
  pageTitle.textContent = title;
  pageSub.textContent = sub;
  const view = (name, permission) => state.view === name && canModule(name) && can(permission);
  topbarActions.innerHTML =
    view("projects", "create") ? `<button class="btn btn-primary" data-action="new-project">+ New project</button>` :
    view("properties", "create") ? `<button class="btn btn-primary" data-action="new-property">+ New property</button>` :
    view("clients", "create") ? `<button class="btn btn-primary" data-action="new-client">+ New client</button>` :
    view("contracts", "create") ? `<button class="btn btn-primary" data-action="new-contract">+ New contract</button>` :
    state.view === "debts" && canModule("debts") && can("create") ? `<button class="btn btn-primary" data-action="new-debt">+ New debt</button>${can("create") ? `<button class="btn" data-action="new-payment">+ Record payment</button>` : ""}` :
    view("appointments", "create") ? `<button class="btn btn-primary" data-action="new-appointment">+ New appointment</button>` :
    view("documents", "create") ? `<button class="btn btn-primary" data-action="new-document">+ New document</button>` :
    state.view === "reports" && canModule("reports") && can("view_reports") ? `<button class="btn btn-primary" data-action="open-report-generate">+ Generate report</button>${can("export") ? `<button class="btn" data-action="open-report-upload">+ Upload report</button>` : ""}` :
    "";
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
  if (state.view === "appointments") renderAppointments();
  if (state.view === "documents") renderDocuments();
  if (state.view === "reports") renderReports();
  if (state.view === "organization") content.innerHTML = renderOrganization();
  // The record-allocation panel is administrator-only and loads on demand. The
  // `allocationRequested` guard means a failed load is not retried on every
  // render, which previously produced an unbounded request loop.
  if (state.view === "organization" && can("manage_users") && !state.allocation && !state.allocationRequested) loadAllocation().then(() => { if (state.view === "organization") render(); });
  // Authenticated image blobs for property covers, etc.
  hydrateImages(content);
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
      <div class="field"><label for="field-client-contract-type">Contract type</label><select id="field-client-contract-type" name="contract_type"><option value="new">New</option><option value="terminal">Terminal</option></select></div>
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
    body = `<div class="form-grid"><div class="field full"><label for="field-project">Project</label><select id="field-project" name="project_id" required><option value="">Select project</option>${projectOptions(record?.project_id)}</select></div><div class="field full"><label for="field-linked-client">Client from register (optional)</label><select id="field-linked-client" name="client_id">${linkedClientOptions(record?.client_id)}</select></div><div class="field"><label for="field-client">Client name</label><input id="field-client" name="client_name" required maxlength="120" value="${escapeHtml(record?.client_name || "")}" placeholder="Client full name"></div><div class="field"><label for="field-type">Contract type</label><select id="field-type" name="contract_type" required><option value="new" ${record?.contract_type === "new" ? "selected" : ""}>New</option><option value="terminal" ${record?.contract_type === "terminal" ? "selected" : ""}>Terminal</option></select></div><div class="field"><label for="field-contract-status">Status</label><select id="field-contract-status" name="status"><option value="active" ${record?.status !== "closed" && record?.status !== "cancelled" ? "selected" : ""}>Active</option><option value="closed" ${record?.status === "closed" ? "selected" : ""}>Closed</option><option value="cancelled" ${record?.status === "cancelled" ? "selected" : ""}>Cancelled</option></select></div><div class="field"><label for="field-original-price">Original price</label><input id="field-original-price" name="original_price" type="number" min="0" step="0.01" required value="${escapeHtml(record?.original_price ?? record?.value ?? "")}" placeholder="0"></div><div class="field"><label for="field-discount-pct">Discount %</label><input id="field-discount-pct" name="discount_pct" type="number" min="0" max="100" step="0.01" value="${escapeHtml(record?.discount_pct ?? 0)}" placeholder="0"></div><div class="field"><label for="field-discount-amount">Discount amount</label><input id="field-discount-amount" type="text" value="${escapeHtml(money(pricingPreview(record).discount_amount))}" readonly aria-readonly="true" tabindex="-1" title="Calculated by the system from the original price and discount"></div><div class="field"><label for="field-final-price">Final price</label><input id="field-final-price" type="text" value="${escapeHtml(money(pricingPreview(record).final_price))}" readonly aria-readonly="true" tabindex="-1" title="Calculated by the system. This is the amount the payment plan is built from."></div><div class="field"><label for="field-start">Start date</label><input id="field-start" name="start_date" type="date" value="${escapeHtml(record?.start_date || "")}"></div><div class="field"><label for="field-end">End date</label><input id="field-end" name="end_date" type="date" value="${escapeHtml(record?.end_date || "")}"></div><div class="field full"><label for="field-notes">Notes</label><textarea id="field-notes" name="notes" placeholder="Property, unit, payment terms, or reference">${escapeHtml(record?.notes || "")}</textarea></div></div>`;
  }
  if (type === "schedule") {
    title = "Generate payment schedule";
    subtitle = record ? `Deposit + installments for ${escapeHtml(record.client_name)} · ${money(record.value)}` : "Deposit + equal monthly installments.";
    submitLabel = "Generate schedule";
    const hasDebts = (state.debts || []).some((debt) => String(debt.contract_id) === String(record?.id));
    body = `<div class="form-grid">
      <div class="field"><label for="field-deposit">Deposit now</label><input id="field-deposit" name="deposit" type="number" min="0" step="0.01" value="0" placeholder="0"></div>
      <div class="field"><label for="field-installments">Installments</label><input id="field-installments" name="installments" type="number" min="1" max="120" required value="6"></div>
      <div class="field full"><label for="field-first-due">First installment due</label><input id="field-first-due" name="first_due_date" type="date" required value="${today()}"></div>
      ${hasDebts ? `<div class="field full"><label class="checkbox-field"><input type="checkbox" name="replace" value="yes"><span>This contract already has installments — replace them</span></label></div>` : ""}
      <div class="field full"><div class="field-help">Installments split the remaining value (${money(Math.max(0, numberValue(record?.value) - 0))}) equally, due monthly from the first date. The final installment absorbs rounding. Reminders are created automatically.</div></div>
    </div>`;
  }
  if (type === "payment") {
    title = "Record payment";
    subtitle = "Log money received; attaching a receipt is optional.";
    submitLabel = "Record payment";
    const methods = (state.reportPaymentMethods || []).length
      ? state.reportPaymentMethods
      : [{ value: "cash", label: "Cash" }, { value: "bank", label: "Bank transfer" }, { value: "mobile", label: "Mobile money" }, { value: "card", label: "Card" }, { value: "other", label: "Other" }];
    const prefill = record || {};
    body = `<div class="form-grid">
      <div class="field full"><label for="field-payment-contract">Contract</label><select id="field-payment-contract" name="contract_id" required><option value="">Select contract</option>${contractOptions(prefill.contract_id)}</select></div>
      <div class="field"><label for="field-payment-debt">Installment (optional)</label><select id="field-payment-debt" name="debt_id"><option value="">None — general payment</option>${(state.debts || []).filter((debt) => !prefill.contract_id || String(debt.contract_id) === String(prefill.contract_id)).map((debt) => `<option value="${debt.id}" ${String(debt.id) === String(prefill.debt_id || "") ? "selected" : ""}>${escapeHtml(debt.client_name)} · ${money(debt.amount)} · ${formatDate(debt.due_date)}</option>`).join("")}</select></div>
      <div class="field"><label for="field-payment-amount">Amount</label><input id="field-payment-amount" name="amount" type="number" min="0" step="0.01" required value="${escapeHtml(prefill.amount ?? "")}" placeholder="0"></div>
      <div class="field"><label for="field-payment-date">Paid at</label><input id="field-payment-date" name="paid_at" type="date" required value="${today()}"></div>
      <div class="field"><label for="field-payment-method">Method</label><select id="field-payment-method" name="method">${methods.map((m) => `<option value="${escapeHtml(m.value)}">${escapeHtml(m.label)}</option>`).join("")}</select></div>
      <div class="field"><label for="field-payment-reference">Reference</label><input id="field-payment-reference" name="reference" maxlength="120" placeholder="Receipt no. / transaction ID"></div>
      <div class="field full"><label for="field-payment-receipt">Receipt (optional)</label><input id="field-payment-receipt" name="file" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp,.bmp"><div class="field-help">PDF or image of the receipt. You can attach it later too.</div></div>
      <div class="field full"><label for="field-payment-notes">Notes</label><textarea id="field-payment-notes" name="notes" maxlength="2000" placeholder="Purpose or follow-up note">${escapeHtml(prefill.notes || "")}</textarea></div>
    </div>`;
  }
  if (type === "debt") {
    title = record ? "Edit debt" : "New debt";
    subtitle = record ? "Update this client balance." : "Record an amount due from a contract.";
    body = `<div class="form-grid"><div class="field full"><label for="field-contract">Contract</label><select id="field-contract" name="contract_id" required><option value="">Select contract</option>${contractOptions(record?.contract_id)}</select></div><div class="field"><label for="field-debt-client">Client name</label><input id="field-debt-client" name="client_name" required maxlength="120" value="${escapeHtml(record?.client_name || "")}" placeholder="Client full name"></div><div class="field"><label for="field-amount">Amount due</label><input id="field-amount" name="amount" type="number" min="0" step="0.01" required value="${escapeHtml(record?.amount ?? "")}" placeholder="0"></div><div class="field"><label for="field-due">Due date</label><input id="field-due" name="due_date" type="date" value="${escapeHtml(record?.due_date || "")}"></div><div class="field"><label for="field-debt-status">Status</label><select id="field-debt-status" name="status"><option value="pending" ${record?.status === "pending" ? "selected" : ""}>Pending</option><option value="overdue" ${record?.status === "overdue" ? "selected" : ""}>Overdue</option><option value="paid" ${record?.status === "paid" ? "selected" : ""}>Paid</option></select></div><div class="field full"><label for="field-debt-notes">Notes</label><textarea id="field-debt-notes" name="notes" placeholder="Installment or follow-up note">${escapeHtml(record?.notes || "")}</textarea></div></div>`;
  }
  if (type === "property") {
    title = record ? "Edit property" : "New property";
    subtitle = record ? "Update this estate listing." : "Register a new estate asset.";
    body = `<div class="form-grid">
      <div class="field full"><label for="field-project">Project</label><select id="field-project" name="project_id"><option value="">Select project</option>${projectOptions(record?.project_id)}</select></div>
      <div class="field full"><label for="field-name">Property name</label><input id="field-name" name="name" required maxlength="120" value="${escapeHtml(record?.name || "")}" placeholder="e.g. Signature Residence · Phase 1"></div>
      <div class="field"><label for="field-property-type">Type</label><select id="field-property-type" name="property_type"><option value="land" ${record?.property_type === "land" ? "selected" : ""}>Land</option><option value="house" ${record?.property_type === "house" ? "selected" : ""}>House</option><option value="apartment" ${record?.property_type === "apartment" ? "selected" : ""}>Apartment</option><option value="villa" ${record?.property_type === "villa" ? "selected" : ""}>Villa</option><option value="commercial" ${record?.property_type === "commercial" ? "selected" : ""}>Commercial</option><option value="penthouse" ${record?.property_type === "penthouse" ? "selected" : ""}>Penthouse</option></select></div>
      <div class="field"><label for="field-property-status">Status</label><select id="field-property-status" name="status"><option value="available" ${record?.status === "available" ? "selected" : ""}>Available</option><option value="reserved" ${record?.status === "reserved" ? "selected" : ""}>Reserved</option><option value="sold" ${record?.status === "sold" ? "selected" : ""}>Sold</option><option value="leased" ${record?.status === "leased" ? "selected" : ""}>Leased</option></select></div>
      <div class="field"><label for="field-price">Price</label><input id="field-price" name="price" type="number" min="0" step="0.01" value="${escapeHtml(record?.price ?? "")}" placeholder="0"></div>
      <div class="field"><label for="field-location">Location</label><input id="field-location" name="location" required maxlength="120" value="${escapeHtml(record?.location || "")}" placeholder="City or area"></div>
      <div class="field"><label for="field-area">Area</label><input id="field-area" name="area" type="number" min="0" step="0.01" value="${escapeHtml(record?.area ?? "")}" placeholder="0"></div>
      <div class="field"><label for="field-bedrooms">Bedrooms</label><input id="field-bedrooms" name="bedrooms" type="number" min="0" value="${escapeHtml(record?.bedrooms ?? "")}" placeholder="0"></div>
      <div class="field"><label for="field-bathrooms">Bathrooms</label><input id="field-bathrooms" name="bathrooms" type="number" min="0" value="${escapeHtml(record?.bathrooms ?? "")}" placeholder="0"></div>
      <div class="field full"><label for="field-description">Description</label><textarea id="field-description" name="description" maxlength="2000" placeholder="Property summary">${escapeHtml(record?.description || "")}</textarea></div>
      <div class="field"><label class="checkbox-field"><input type="checkbox" name="featured" ${record?.featured ? "checked" : ""}><span>Featured listing</span></label></div>
      ${record ? `<div class="field full"><label>Photos (optional)</label><div class="photo-strip" id="photo-strip" data-property-id="${record.id}">${renderPhotoStrip(record)}</div></div>` : ""}
      <div class="field full"><label for="field-photo">Photo (optional)</label><input id="field-photo" name="photo" type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.bmp" data-photo-upload>${record ? "" : `<div class="field-help">Optional. You can add more photos after saving.</div>`}</div>
    </div>`;
  }
  if (type === "client") {
    title = record ? "Edit client" : "New client";
    subtitle = record ? "Update this contact." : "Add a new person or organization.";
    body = `<div class="form-grid">
      <div class="field full"><label for="field-project">Project</label><select id="field-project" name="project_id"><option value="">Select project</option>${projectOptions(record?.project_id)}</select></div>
      <div class="field full"><label for="field-client-name">Full name</label><input id="field-client-name" name="name" required maxlength="120" value="${escapeHtml(record?.name || "")}" placeholder="Client full name"></div>
      <div class="field"><label for="field-email">Email</label><input id="field-email" name="email" type="email" maxlength="120" value="${escapeHtml(record?.email || "")}" placeholder="contact@example.com"></div>
      <div class="field"><label for="field-phone">Phone</label><input id="field-phone" name="phone" maxlength="120" value="${escapeHtml(record?.phone || "")}" placeholder="+255 700 000 000"></div>
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
      <div class="field full"><label for="field-client">Client</label><select id="field-client" name="client_id" required><option value="">Select client</option>${clientOptions(record?.client_id)}</select></div>
      <div class="field full"><label for="field-title">Title</label><input id="field-title" name="title" required maxlength="120" value="${escapeHtml(record?.title || "")}" placeholder="e.g. Premium residence tour"></div>
      <div class="field"><label for="field-property">Property</label><select id="field-property" name="property_id"><option value="">None</option>${propertyOptions(record?.property_id)}</select></div>
      <div class="field"><label for="field-project">Project</label><select id="field-project" name="project_id"><option value="">None</option>${projectOptions(record?.project_id)}</select></div>
      <div class="field"><label for="field-type">Type</label><select id="field-type" name="appointment_type"><option value="viewing" ${record?.appointment_type === "viewing" ? "selected" : ""}>Viewing</option><option value="call" ${record?.appointment_type === "call" ? "selected" : ""}>Call</option><option value="meeting" ${record?.appointment_type === "meeting" ? "selected" : ""}>Meeting</option><option value="inspection" ${record?.appointment_type === "inspection" ? "selected" : ""}>Inspection</option></select></div>
      <div class="field"><label for="field-status">Status</label><select id="field-status" name="status"><option value="scheduled" ${record?.status === "scheduled" ? "selected" : ""}>Scheduled</option><option value="completed" ${record?.status === "completed" ? "selected" : ""}>Completed</option><option value="cancelled" ${record?.status === "cancelled" ? "selected" : ""}>Cancelled</option></select></div>
      <div class="field"><label for="field-start">Start</label><input id="field-start" name="starts_at" type="datetime-local" value="${escapeHtml(record?.starts_at ? record.starts_at.replace(" ", "T") : "")}"></div>
      <div class="field"><label for="field-end">End</label><input id="field-end" name="ends_at" type="datetime-local" value="${escapeHtml(record?.ends_at ? record.ends_at.replace(" ", "T") : "")}"></div>
      <div class="field full"><label for="field-notes">Notes</label><textarea id="field-notes" name="notes" maxlength="2000" placeholder="Agenda or preparation note">${escapeHtml(record?.notes || "")}</textarea></div>
    </div>`;
  }
  if (type === "document") {
    title = record ? "Edit document" : "New document";
    subtitle = record ? "Update this document record." : "Upload a file and register the document.";
    const hasFile = record?.has_file;
    body = `<div class="form-grid">
      <div class="field full"><label for="field-project">Project</label><select id="field-project" name="project_id"><option value="">Select project</option>${projectOptions(record?.project_id)}</select></div>
      <div class="field"><label for="field-contract">Contract</label><select id="field-contract" name="contract_id"><option value="">Select contract</option>${contractOptions(record?.contract_id)}</select></div>
      <div class="field"><label for="field-client">Client</label><select id="field-client" name="client_id"><option value="">Select client</option>${clientOptions(record?.client_id)}</select></div>
      <div class="field full"><label for="field-title">Title</label><input id="field-title" name="title" required maxlength="120" value="${escapeHtml(record?.title || "")}" placeholder="Document title"></div>
      <div class="field"><label for="field-category">Category</label><select id="field-category" name="category"><option value="agreement" ${record?.category === "agreement" ? "selected" : ""}>Agreement</option><option value="title" ${record?.category === "title" ? "selected" : ""}>Title</option><option value="invoice" ${record?.category === "invoice" ? "selected" : ""}>Invoice</option><option value="receipt" ${record?.category === "receipt" ? "selected" : ""}>Receipt</option><option value="report" ${record?.category === "report" ? "selected" : ""}>Report</option><option value="permit" ${record?.category === "permit" ? "selected" : ""}>Permit</option><option value="other" ${record?.category === "other" ? "selected" : ""}>Other</option></select></div>
      <div class="field"><label for="field-status">Status</label><select id="field-status" name="status"><option value="pending" ${record?.status === "pending" ? "selected" : ""}>Pending</option><option value="approved" ${record?.status === "approved" ? "selected" : ""}>Approved</option><option value="archived" ${record?.status === "archived" ? "selected" : ""}>Archived</option></select></div>
      <div class="field full"><label for="field-file">File</label><input id="field-file" name="file" type="file" ${record ? "disabled" : ""}>${hasFile ? `<div class="field-help">Current file: <strong>${escapeHtml(record.original_filename || record.file_name || "attached")}</strong></div>` : record ? `<div class="field-help">Files can only be attached while creating a document.</div>` : ""}</div>
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
  const isPreview = type === "report-preview";
  const actions = `<div class="form-actions">
    <button type="button" class="btn" data-action="close-modal">${isPreview ? "Close" : "Cancel"}</button>
    ${type === "report-generate" ? `<button type="button" class="btn btn-soft" data-action="preview-report">Preview</button>` : ""}
    ${isPreview ? "" : `<button type="submit" class="btn btn-primary">${submitLabel}</button>`}
  </div>`;
  const head = `<div class="modal-head"><div><h2 class="modal-title">${title}</h2><p class="modal-sub">${subtitle}</p></div><button class="close-btn" data-action="close-modal" aria-label="Close">×</button></div>`;
  modal.innerHTML = isPreview
    ? `${head}${body}${actions}`
    : `${head}<form id="record-form" data-id="${escapeHtml(record?.id || "")}">${body}${actions}</form>`;
  modalBackdrop.hidden = false;
  hydrateImages(modal);
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

function closeModal() {
  // A pending confirm dialog resolves as "no" so awaiting callers never hang.
  if (typeof state.confirmResolve === "function") {
    const resolve = state.confirmResolve;
    state.confirmResolve = null;
    resolve(false);
  }
  modalBackdrop.hidden = true;
  modal.innerHTML = "";
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
    const head = `<div class="modal-head"><div><h2 class="modal-title">${escapeHtml(title)}</h2><p class="modal-sub">${escapeHtml(message)}</p></div><button class="close-btn" data-action="close-modal" aria-label="Close">×</button></div>`;
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
  const data = Object.fromEntries(new FormData(form));
  const type = modal.dataset.type;
  const id = form.dataset.id;
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
        replace: data.replace === "yes",
      };
      const result = await api(`/contracts/${id}/schedule`, { method: "POST", body: JSON.stringify(payload) });
      showToast(`Schedule created: ${result.created} installment${result.created === 1 ? "" : "s"}.`);
    } else if (type === "payment") {
      data.contract_id = Number(data.contract_id);
      data.debt_id = data.debt_id ? Number(data.debt_id) : null;
      data.amount = numberValue(data.amount);
      const receiptFile = form.querySelector('input[type="file"][name="file"]')?.files?.[0] || null;
      delete data.file;
      if (receiptFile) {
        // Multipart path stores the receipt alongside the payment record.
        const payload = new FormData();
        payload.append("file", receiptFile);
        ["contract_id", "debt_id", "amount", "paid_at", "method", "reference", "notes"].forEach((key) => {
          if (data[key] !== undefined && data[key] !== null && data[key] !== "") payload.append(key, data[key]);
        });
        await api("/payments/upload", { method: "POST", form: true, body: payload });
        showToast("Payment recorded with receipt.");
      } else {
        await api("/payments", { method: "POST", body: JSON.stringify(data) });
        showToast("Payment recorded.");
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
      data.featured = data.featured ? 1 : 0;
      const photoFile = form.querySelector('input[type="file"][name="photo"]')?.files?.[0] || null;
      delete data.photo;
      const saved = id
        ? await api(`/properties/${id}`, { method: "PUT", body: JSON.stringify(data) })
        : await api("/properties", { method: "POST", body: JSON.stringify(data) });
      if (photoFile && saved?.id) {
        // Photos are optional: a failed upload reports but never blocks the save.
        const payload = new FormData();
        payload.append("file", photoFile);
        try {
          await api(`/properties/${saved.id}/images`, { method: "POST", form: true, body: payload });
          if (state.propertyPhotos) delete state.propertyPhotos[saved.id];
          showToast(id ? "Property and photo updated." : "Property and photo created.");
        } catch (photoError) {
          showToast(photoError.message || "Photo could not be uploaded.");
        }
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
        original_price: numberValue(data.original_price),
        discount_pct: numberValue(data.discount_pct),
      };
      const wantsContract = Boolean(contractStep.project_id) && contractStep.original_price > 0;
      delete data.contract_project_id;
      delete data.contract_type;
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

async function markPaid(id) {
  try {
    await api(`/debts/${id}/pay`, { method: "POST", body: "{}" });
    showToast("Debt marked as paid.");
    await refresh();
  } catch (error) { showToast(error.message || "Unable to update debt."); }
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
    message: `Set a new password for ${user.display_name}? Their account, role, department and history stay exactly as they are.`,
    confirmLabel: "Continue",
    tone: "primary",
  });
  if (!confirmed) return;
  openModal("reset-password", user);
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
    const backup = await api("/backups", { method: "POST", body: "{}" });
    showToast(`Backup created: ${backup.name}`);
    await downloadFile(`/backups/${encodeURIComponent(backup.name)}/download`, backup.name);
  } catch (error) { showToast(error.message || "Backup failed."); }
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
async function runContractTransition(id, action) {
  const needsNotes = ["request_changes", "reject", "management_reject"].includes(action);
  state.transitionNotes = "";
  const confirmed = await confirmDialog({
    title: "Contract workflow",
    message: needsNotes
      ? `Explain why you are requesting changes. The reason is stored permanently in the contract history.`
      : `Move this contract to "${action.replace(/_/g, " ")}"?`,
    confirmLabel: needsNotes ? "Request changes" : "Continue",
    tone: "primary",
    noteLabel: needsNotes ? "Reason / required corrections" : null,
  });
  if (!confirmed) return;
  try {
    const payload = { action };
    if (needsNotes && state.transitionNotes) payload.notes = state.transitionNotes;
    await api(`/contracts/${id}/transition`, { method: "POST", body: JSON.stringify(payload) });
    showToast(`Contract moved to ${action.replace(/_/g, " ")}.`);
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
    modal.innerHTML = `<div class="modal-head"><div><h2 class="modal-title">Contract history</h2><p class="modal-sub">${escapeHtml(contract?.contract_number || `Contract #${id}`)} — every step, in order</p></div><button class="close-btn" data-action="close-modal" aria-label="Close">×</button></div>
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

// Navigation is delegated because the items are generated per caller: a static
// listener list would bind to elements that no longer exist after a sign-in.
document.getElementById("primary-nav").addEventListener("click", (event) => {
  const item = event.target.closest(".nav-item[data-view]");
  if (!item) return;
  state.view = item.dataset.view;
  state.filters = { project: "", type: "", status: "", debtStatus: "", propertyStatus: "", clientStatus: "", appointmentStatus: "", documentStatus: "", documentSearch: "", sort: "" };
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
function viewContract(contractId) {
  if (!canModule("contracts")) { showToast("You do not have access to the contract register."); return; }
  const contract = state.contracts.find((item) => String(item.id) === String(contractId));
  if (!contract) { showToast("That contract is not available to you."); return; }
  modal.dataset.type = "contract-view";
  const installments = state.debts
    .filter((debt) => String(debt.contract_id) === String(contract.id))
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  const paidTotal = (state.payments || [])
    .filter((payment) => installments.some((debt) => String(debt.id) === String(payment.debt_id)))
    .reduce((sum, payment) => sum + numberValue(payment.amount), 0);
  const installmentRows = installments.map((debt) => {
    const stateValue = debtState(debt);
    return `<tr><td><span class="cell-main">${escapeHtml(debt.notes || `Installment`)}</span></td><td>${formatDate(debt.due_date)}</td><td>${badgeVariant(debtStateLabel(stateValue), stateValue)}</td><td class="amount">${money(debt.amount)}</td></tr>`;
  }).join("");
  const head = `<div class="modal-head"><div><h2 class="modal-title">${escapeHtml(contract.contract_number || `Contract #${contract.id}`)}</h2><p class="modal-sub">${escapeHtml(contract.client_name || "")}${contract.project_name ? ` · ${escapeHtml(contract.project_name)}` : ""}</p></div><button class="close-btn" data-action="close-modal" aria-label="Close">×</button></div>`;
  modal.innerHTML = `${head}
    <div class="form-grid">
      <div class="field"><span class="muted">Status</span><div>${contractStatusBadge(contract.status)}</div></div>
      <div class="field"><span class="muted">Type</span><div>${badge(contract.contract_type)}</div></div>
      <div class="field"><span class="muted">Start</span><div>${formatDate(contract.start_date)}</div></div>
      <div class="field"><span class="muted">End</span><div>${formatDate(contract.end_date)}</div></div>
      <div class="field"><span class="muted">Contract value</span><div class="amount">${money(contract.value)}</div></div>
      ${Number(contract.discount_pct || 0) > 0 ? `<div class="field"><span class="muted">Original price</span><div class="amount">${money(contract.original_price)}</div></div><div class="field"><span class="muted">Discount</span><div class="amount">${escapeHtml(String(contract.discount_pct))}% (− ${money(contract.discount_amount)})</div></div><div class="field"><span class="muted">Final price</span><div class="amount">${money(contract.final_price ?? contract.value)}</div></div>` : ""}
      <div class="field"><span class="muted">Collected</span><div class="amount">${money(paidTotal)}</div></div>
    </div>
    ${installmentRows ? `<div class="section"><div class="section-head"><div><h2 class="section-title">Installments</h2><div class="section-note">Payment plan attached to this contract</div></div></div><div class="table-wrap"><table><thead><tr><th>Installment</th><th>Due</th><th>State</th><th class="align-right">Amount</th></tr></thead><tbody>${installmentRows}</tbody></table></div></div>` : ""}
    <div class="form-actions">
      <button type="button" class="btn" data-action="close-modal">Close</button>
      ${can("edit") ? `<button type="button" class="btn btn-primary" data-action="edit-contract-from-view" data-id="${contract.id}">Edit contract</button>` : ""}
      <button type="button" class="btn btn-soft" data-action="contract-history" data-id="${contract.id}">History</button>
    </div>`;
  modalBackdrop.hidden = false;
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;
  if (action === "new-project") openModal("project");
  if (action === "edit-project") openModal("project", state.projects.find((item) => String(item.id) === id));
  if (action === "delete-project") deleteRecord("project", id);
  if (action === "new-property") openModal("property");
  if (action === "edit-property") openModal("property", state.properties.find((item) => String(item.id) === id));
  if (action === "delete-property") deleteRecord("property", id);
  if (action === "new-contract") openModal("contract");
  if (action === "edit-contract") openModal("contract", state.contracts.find((item) => String(item.id) === id));
  if (action === "delete-contract") deleteRecord("contract", id);
  if (action === "new-debt") openModal("debt");
  if (action === "edit-debt") openModal("debt", state.debts.find((item) => String(item.id) === id));
  if (action === "delete-debt") deleteRecord("debt", id);
  if (action === "pay-debt") markPaid(id);
  if (action === "generate-schedule") openModal("schedule", state.contracts.find((item) => String(item.id) === id));
  if (action === "contract-transition") runContractTransition(id, target.dataset.transition);
  if (action === "contract-history") showContractHistory(id);
  if (action === "view-contract") viewContract(id);
  if (action === "edit-contract-from-view") {
    const record = state.contracts.find((item) => String(item.id) === String(id));
    closeModal();
    if (record) openModal("contract", record);
  }
  if (action === "new-payment") openModal("payment");
  if (action === "record-payment") {
    const debt = state.debts.find((item) => String(item.id) === id);
    if (debt) openModal("payment", { contract_id: debt.contract_id, debt_id: debt.id, amount: debt.amount });
  }
  if (action === "delete-payment") deleteRecord("payment", id);
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
  if (action === "edit-client") openModal("client", state.clients.find((item) => String(item.id) === id));
  if (action === "delete-client") deleteRecord("client", id);
  if (action === "new-appointment") openModal("appointment");
  if (action === "edit-appointment") openModal("appointment", state.appointments.find((item) => String(item.id) === id));
  if (action === "delete-appointment") deleteRecord("appointment", id);
  if (action === "new-document") openModal("document");
  if (action === "edit-document") openModal("document", state.documents.find((item) => String(item.id) === id));
  if (action === "delete-document") deleteRecord("document", id);
  if (action === "open-document") openDocumentFile(id);
  if (action === "open-report-generate") openModal("report-generate");
  if (action === "open-report-upload") openModal("report-upload");
  if (action === "preview-report") previewReport();
  if (action === "download-report") downloadReportById(id);
  if (action === "reexport-report") openModal("report-generate", state.reportHistory.find((item) => String(item.id) === id));
  if (action === "delete-report") deleteRecord("report", id);
  if (action === "create-department") {
    const name = document.querySelector('[data-org-field="department"]')?.value;
    if (name) { try { await api("/org/departments", { method: "POST", body: JSON.stringify({ name }) }); await refresh(); } catch (error) { showToast(error.message); } }
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
  if (action === "convert-lead") {
    try { await api(`/org/leads/${id}/convert`, { method: "POST", body: "{}" }); await refresh(); showToast("Lead converted to client."); }
    catch (error) { showToast(error.message || "Unable to convert lead."); }
  }
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
modalBackdrop.addEventListener("click", (event) => { if (event.target === modalBackdrop) closeModal(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !modalBackdrop.hidden) closeModal(); });

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(authForm));
  authSubmit.disabled = true;
  try {
    const path = authMode === "setup" ? "/auth/setup" : "/auth/login";
    const user = await api(path, { method: "POST", body: JSON.stringify(body) });
    if (!user.token) throw new Error("No session token returned");
    setToken(user.token);
    enterWorkspace(user);
  } catch (error) {
    showAuthMessage(error.message || "Unable to sign in.");
  } finally {
    authSubmit.disabled = false;
  }
});

authToggle.addEventListener("click", () => setAuthMode(authMode === "setup" ? "login" : "setup"));

document.querySelector('[data-action="logout"]').addEventListener("click", async () => {
  try {
    if (getToken()) await api("/auth/logout", { method: "POST", body: "{}" });
  } catch (_) { /* sign out locally even if the request fails */ }
  endSession();
  setAuthMode("login");
});

async function boot() {
  const token = getToken();
  try {
    const { configured } = await api("/auth/state");
    setAuthMode(configured ? "login" : "setup");
  } catch (_) {
    setAuthMode("login");
  }
  if (!token) return;
  try {
    const user = await api("/auth/me");
    enterWorkspace(user);
  } catch (error) {
    if (!error.sessionExpired) hideAuthMessage();
  }
}

boot();
