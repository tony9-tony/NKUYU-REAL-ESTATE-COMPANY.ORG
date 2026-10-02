import { query, withTransaction } from "../db.js";

/**
 * The approval workflow, in the order a contract actually moves.
 *
 * Derived from CONTRACT_ACTIONS rather than written by hand, so the diagram can
 * never drift from the state machine the server enforces.
 *
 * `owner` is the department that OWNS the step - the desk holding the contract
 * while it sits in that state, which is who must act next and who may send it
 * back. It is deliberately not the department that pushed it there: Sales
 * submits a contract, but on arrival the contract belongs to Legal, and
 * CONTRACT_OWNERSHIP reflects that. The UI shows both.
 */
export const WORKFLOW_STAGES = [
  { status: "draft", stage: 1, label: "Draft prepared", owner: "SALES, MARKETING & OPERATIONS", actor: "SALES, MARKETING & OPERATIONS", permission: "create", note: "Sales or operations opens the deal and records the commercial terms." },
  { status: "submitted", stage: 2, label: "Submitted to Legal", owner: "LEGAL", actor: "SALES, MARKETING & OPERATIONS", permission: "submit_contract", note: "Sales hands the deal to Legal. Sales cannot approve its own submission." },
  { status: "under_review", stage: 3, label: "Under legal review", owner: "LEGAL", actor: "LEGAL", permission: "review_legal", note: "Legal opens the contract, checks the clauses and verifies the parties." },
  { status: "legal_approved", stage: 4, label: "Legal terms approved", owner: "LEGAL", actor: "LEGAL", permission: "approve_legal", note: "Legal gives legal approval. Finance must then validate the money before Legal can send it to the Managing Director." },
  { status: "pending_management_approval", stage: 5, label: "Management approval", owner: "MANAGEMENT", actor: "MANAGEMENT", permission: "approve_management", note: "The Managing Director approves on behalf of management, or sends it back." },
  { status: "approved", stage: 6, label: "Approved for release", owner: "LEGAL", actor: "LEGAL", permission: "approve_legal", note: "Legal releases the approved contract to the customer." },
  { status: "customer_pending", stage: 7, label: "With the customer", owner: "LEGAL", actor: "LEGAL", permission: "approve_legal", note: "Awaiting the customer's signature." },
  { status: "active", stage: 8, label: "Active", owner: "LEGAL", actor: "LEGAL", permission: "approve_legal", note: "The signature is recorded and the contract is in force." },
  { status: "completed", stage: 9, label: "Completed", owner: "LEGAL", actor: "LEGAL", permission: "approve_legal", note: "Handover and obligations are finished." },
];

/** States that sit outside the linear pipeline. */
export const WORKFLOW_EXCEPTIONS = [
  { status: "changes_requested", label: "Changes requested", note: "Sent back to the originating desk. Any department holding request_changes may raise corrections." },
  { status: "rejected", label: "Rejected", note: "The deal is declined. Reached from management rejection or a legal rejection." },
  { status: "cancelled", label: "Cancelled", note: "The deal is withdrawn before completion." },
];

/**
 * The permissions a caller must hold to own a given pipeline stage.
 *
 * Derived from CONTRACT_ACTIONS so it can never drift: it is the union of the
 * permissions on the actions that move a contract INTO that status, with `cancel`
 * excluded because anyone who may edit a contract can always withdraw it and that
 * would otherwise make `create` the deciding permission for the whole draft stage.
 *
 * Computed on first read rather than at module load, because CONTRACT_ACTIONS is
 * declared further down this file and a top-level call would run before it.
 */
let stagePermissions;
export function workflowStagePermissions() {
  if (stagePermissions) return stagePermissions;
  const map = {};
  for (const definition of WORKFLOW_STAGES) map[definition.status] = [];
  for (const [action, definition] of Object.entries(CONTRACT_ACTIONS)) {
    if (action === "cancel") continue;
    if (map[definition.to] && !map[definition.to].includes(definition.permission)) map[definition.to].push(definition.permission);
  }
  // `draft` is reached by creating the record rather than by a transition.
  map.draft = ["create"];
  stagePermissions = map;
  return map;
}

/** The action graph, shaped for display: every status with the ways out of it. */
export function workflowGraph() {
  const byStatus = new Map();
  const ensure = (status) => {
    if (!byStatus.has(status)) {
      const stage = WORKFLOW_STAGES.find((entry) => entry.status === status);
      const exception = WORKFLOW_EXCEPTIONS.find((entry) => entry.status === status);
      byStatus.set(status, {
        status,
        label: stage?.label || exception?.label || status,
        note: stage?.note || exception?.note || "",
        stage: stage?.stage ?? null,
        owner: stage?.owner || null,
        permission: stage?.permission || null,
        open: OPEN_CONTRACT_STATUSES.has(status),
        actions: [],
      });
    }
    return byStatus.get(status);
  };
  for (const status of CONTRACT_STATUSES) ensure(status);
  for (const [action, definition] of Object.entries(CONTRACT_ACTIONS)) {
    for (const from of definition.from) {
      ensure(from).actions.push({ action, label: definition.label, to: definition.to, permission: definition.permission });
    }
  }
  return [...byStatus.values()];
}

// ---------------------------------------------------------------------------
// MKUYU contract lifecycle.
//
//   Sales/Operations -> Legal -> Finance -> MD (when required) -> Customer
//   -> final record owned by Legal.
//
// This module is the single source of truth for the status list, the legal
// transitions between them, and the database shape that backs them. The route
// and the model both import from here so a status can never drift between the
// API, the schema and the UI.
// ---------------------------------------------------------------------------

export const CONTRACT_STATUSES = [
  "draft",
  "submitted",
  "under_review",
  "changes_requested",
  "legal_approved",
  "pending_management_approval",
  "approved",
  "customer_pending",
  "active",
  "completed",
  "rejected",
  "cancelled",
];

export const CONTRACT_STATUS_SET = new Set(CONTRACT_STATUSES);

// Statuses that mean "the deal is still being worked on inside MKUYU".
export const OPEN_CONTRACT_STATUSES = new Set([
  "draft", "submitted", "under_review", "changes_requested",
  "legal_approved", "pending_management_approval", "approved", "customer_pending",
]);
// Statuses that mean the contract is finished one way or another.
export const CLOSED_CONTRACT_STATUSES = new Set(["active", "completed", "rejected", "cancelled"]);

// Statuses a contract may be created in. Everything else must be reached through
// the workflow, so nobody can drop a contract straight to `active`.
export const CREATABLE_CONTRACT_STATUSES = new Set(["draft"]);

// Legacy status -> lifecycle status. The three original values keep their
// meaning; only `closed` is renamed to `completed`.
export const LEGACY_STATUS_MAP = { active: "active", closed: "completed", cancelled: "cancelled" };

/**
 * The status each action moves a contract to.
 *
 * `permission` is the permission key the caller must hold. `from` lists the
 * statuses the action is legal from, which is what stops someone approving a
 * contract that Legal has not reviewed yet.
 */
export const CONTRACT_ACTIONS = {
  submit: { from: ["draft", "changes_requested"], to: "submitted", permission: "submit_contract", label: "Submit to Legal" },
  start_review: { from: ["submitted"], to: "under_review", permission: "review_legal", label: "Start legal review" },
  request_changes: { from: ["submitted", "under_review", "legal_approved", "pending_management_approval", "approved", "customer_pending"], to: "changes_requested", permission: "request_changes", label: "Request changes" },
  legal_approve: { from: ["under_review", "submitted"], to: "legal_approved", permission: "approve_legal", label: "Legal approval" },
  // Finance checks the money only AFTER Legal has approved the terms, so it
  // always validates the version Legal signed off. The status stays
  // legal_approved; the validation is recorded in finance_validated_*.
  finance_validate: { from: ["legal_approved"], to: "legal_approved", permission: "validate_finance", label: "Validate financial terms" },
  submit_management: { from: ["legal_approved"], to: "pending_management_approval", permission: "approve_legal", label: "Send for management approval" },
  management_approve: { from: ["pending_management_approval"], to: "approved", permission: "approve_management", label: "Management approval" },
  management_reject: { from: ["pending_management_approval"], to: "rejected", permission: "approve_management", label: "Management rejection" },
  // Legal releases the approved contract to the customer, so this step is gated
  // on `approve_legal` rather than the Sales-side `submit_contract`.
  send_to_customer: { from: ["approved"], to: "customer_pending", permission: "approve_legal", label: "Send to customer" },
  record_signature: { from: ["customer_pending"], to: "active", permission: "approve_legal", label: "Record customer signature" },
  complete: { from: ["active", "customer_pending"], to: "completed", permission: "approve_legal", label: "Mark completed" },
  reject: { from: ["draft", "submitted", "under_review", "changes_requested", "legal_approved", "pending_management_approval"], to: "rejected", permission: "approve_legal", label: "Reject" },
  cancel: { from: [...OPEN_CONTRACT_STATUSES], to: "cancelled", permission: "edit", label: "Cancel contract" },
};

/** Transitions a contract may make right now, filtered by the caller's permissions. */
export function availableActions(status, permissions) {
  const granted = new Set(permissions || []);
  return Object.entries(CONTRACT_ACTIONS)
    .filter(([, action]) => granted.has(action.permission) && action.from.includes(status))
    .map(([name, action]) => ({ action: name, to: action.to, label: action.label }));
}

/** True when the action is legal from the contract's current status. */
export function canTransition(status, actionName) {
  const action = CONTRACT_ACTIONS[actionName];
  return Boolean(action && action.from.includes(status));
}

/**
 * Business preconditions that the status alone cannot express. Returns the
 * reason an otherwise legal step is refused right now, or null when it may go
 * ahead. Used by the transition route (to refuse) and by the action lists (to
 * hide the button), so the two can never disagree.
 *
 *   Legal -> Finance -> MD: a contract only reaches the Managing Director once
 *   Finance has validated its financial terms.
 */
export function transitionBlockedReason(contract, actionName) {
  if (!contract) return null;
  const financeDone = Boolean(contract.finance_validated_at);
  if (actionName === "submit_management" && !financeDone) {
    return "Finance must validate the financial terms before the contract goes to the Managing Director";
  }
  if (actionName === "finance_validate" && financeDone) {
    return "Finance has already validated the financial terms of this contract";
  }
  return null;
}

/**
 * Where a contract is right now, in words the whole organization (and the MD
 * in particular) can read at a glance: which desk holds it and what it is
 * waiting for. Derived from the status plus the finance stamp, never stored,
 * so it cannot drift from the workflow above.
 */
export const CONTRACT_POSITIONS = [
  { key: "sales", label: "Under Sales review", desk: "Sales" },
  { key: "legal_queue", label: "Submitted to Legal", desk: "Legal" },
  { key: "legal", label: "Under Legal review", desk: "Legal" },
  { key: "finance", label: "Under Finance review", desk: "Finance" },
  { key: "legal_to_md", label: "Finance validated · Legal to send to MD", desk: "Legal" },
  { key: "md", label: "Under MD review", desk: "Managing Director" },
  { key: "legal_release", label: "MD approved · Legal to send to customer", desk: "Legal" },
  { key: "customer", label: "With the customer for signature", desk: "Customer" },
  { key: "active", label: "Active", desk: "Legal" },
  { key: "completed", label: "Completed", desk: "Legal" },
];
const POSITION_BY_KEY = new Map(CONTRACT_POSITIONS.map((entry, index) => [entry.key, { ...entry, step: index + 1 }]));

export function contractPosition(contract) {
  const status = contract?.status || "draft";
  const at = (key, extra = {}) => ({ ...POSITION_BY_KEY.get(key), total: CONTRACT_POSITIONS.length, ...extra });
  switch (status) {
    case "draft": return at("sales");
    case "changes_requested": return at("sales", { key: "sales_changes", label: "Under Sales review · changes requested" });
    case "submitted": return at("legal_queue");
    case "under_review": return at("legal");
    case "legal_approved": return contract?.finance_validated_at ? at("legal_to_md") : at("finance");
    case "pending_management_approval": return at("md");
    case "approved": return at("legal_release");
    case "customer_pending": return at("customer");
    case "active": return at("active");
    case "completed": return at("completed");
    case "rejected": return { key: "rejected", label: "Rejected", desk: null, step: null, total: CONTRACT_POSITIONS.length };
    case "cancelled": return { key: "cancelled", label: "Cancelled", desk: null, step: null, total: CONTRACT_POSITIONS.length };
    default: return { key: status, label: String(status).replace(/_/g, " "), desk: null, step: null, total: CONTRACT_POSITIONS.length };
  }
}

// ---------------------------------------------------------------------------
// Contract template placeholders.
//
// A template is ordinary text with {{TOKEN}} placeholders. Rendering is a pure
// function of (template, values): no database, no filesystem, no framework.
// Anything not supplied is left visible as the token itself rather than being
// silently blanked, so a template that is missing a field is obvious on the
// generated document instead of quietly producing a wrong-looking contract.
// ---------------------------------------------------------------------------

/** Every placeholder the system understands, with the label shown in the editor. */
export const CONTRACT_PLACEHOLDERS = [
  { token: "CLIENT_NAME", label: "Client / buyer name" },
  { token: "CLIENT_PHONE", label: "Client phone" },
  { token: "CLIENT_EMAIL", label: "Client email" },
  { token: "COMPANY_NAME", label: "Company name" },
  { token: "PROJECT_NAME", label: "Project" },
  { token: "PROPERTY_NAME", label: "Property" },
  { token: "PROPERTY_NUMBER", label: "Property number" },
  { token: "PROPERTY_LOCATION", label: "Property location" },
  { token: "ORIGINAL_PRICE", label: "Original price" },
  { token: "DISCOUNT_PERCENT", label: "Discount %" },
  { token: "DISCOUNT_AMOUNT", label: "Discount amount" },
  { token: "FINAL_PRICE", label: "Final price" },
  { token: "DEPOSIT", label: "Deposit" },
  { token: "INSTALLMENT_COUNT", label: "Number of installments" },
  { token: "PAYMENT_FREQUENCY", label: "Payment frequency" },
  { token: "FIRST_DUE_DATE", label: "First due date" },
  { token: "AGREEMENT_START_DATE", label: "Agreement start date" },
  { token: "AGREEMENT_END_DATE", label: "Agreement end date" },
  { token: "AGREEMENT_DURATION", label: "Agreement duration" },
  { token: "CONTRACT_DATE", label: "Contract date" },
  { token: "CONTRACT_NUMBER", label: "Contract number" },
  { token: "LAWYER_SIGNATURE", label: "Lawyer signature line" },
  { token: "CONTRACT_TITLE", label: "Agreement title (Sale Agreement, Lease Agreement, Property Sale Mandate)" },
  { token: "CLIENT_ROLE", label: "Client's role (Buyer, Tenant or Seller)" },
  { token: "TITLE_DEED_NUMBER", label: "Title deed / certificate number" },
  { token: "PROPERTY_TYPE", label: "Property type" },
  { token: "PROPERTY_AREA", label: "Property size" },
  // The whole agreement wording for the chosen contract type. Put it in a
  // letterhead template where the contract text should go.
  { token: "CONTRACT_BODY", label: "Full agreement text for the chosen type (for letterhead templates)" },
];

const KNOWN = new Set(CONTRACT_PLACEHOLDERS.map((entry) => entry.token));

/** `{{ TOKEN }}` with tolerant inner whitespace. */
const TOKEN_PATTERN = /\{\{\s*([A-Z0-9_]+)\s*\}\}/g;

/** The distinct tokens a template actually uses, in first-seen order. */
export function placeholdersUsed(body) {
  const found = [];
  for (const match of String(body || "").matchAll(TOKEN_PATTERN)) {
    if (KNOWN.has(match[1]) && !found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

/** Tokens a template uses that the system does not understand. */
export function unknownPlaceholders(body) {
  const unknown = [];
  for (const match of String(body || "").matchAll(TOKEN_PATTERN)) {
    if (!KNOWN.has(match[1]) && !unknown.includes(match[1])) unknown.push(match[1]);
  }
  return unknown;
}

/**
 * Substitutes values into a template.
 *
 * A token with no supplied value is left exactly as written, so the generated
 * document shows `{{SOMETHING}}` and the operator can see the gap. This is
 * deliberate: printing an empty string would make an incomplete template look
 * like a finished contract.
 */
export function renderTemplate(body, values = {}) {
  return String(body || "").replace(TOKEN_PATTERN, (whole, token) => {
    const value = values[token];
    if (value === undefined || value === null || value === "") return whole;
    return String(value);
  });
}

/** Renders a date as `05 October 2026`, the format the documents already use. */
export function formatDocumentDate(value) {
  if (!value) return "";
  const match = String(value).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(value);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${Number(match[3])} ${months[Number(match[2]) - 1]} ${match[1]}`;
}

/** Renders an amount with thousands separators and two decimals: 108000000 -> "108,000,000.00". */
export function formatMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value === null || value === undefined ? "" : String(value);
  return number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export { TOKEN_PATTERN };

// ---------------------------------------------------------------------------
// Full contract document generation.
//
// Produces a real, multi-page PDF from a rendered template and writes it into
// the SAME upload directory the existing document system already serves from
// (`data/uploads/documents`). The file is registered as a `documents` row linked
// to the contract, so Open/Download go through the existing
// `/documents/:id/file` route and its existing RBAC check. No second storage
// location, no second serving route, no bypass.
//
// Brand colours come from reports/exporters.js, so a generated contract looks
// like the same document family as every other MKUYU export.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { AlignmentType, BorderStyle, Document as WordDocument, Footer, Header, HeadingLevel, ImageRun, Packer, PageNumber, Paragraph, TabStopType, TextRun } from "docx";
import { BRAND, BRAND_GREEN, BRAND_GOLD, BRAND_SUB } from "../reports/exporters.js";
import { documentUploadsDir, extensionMime } from "../uploads.js";

const PAGE_MARGIN = 56;

/** A filename that is safe on every filesystem and still human-readable. */
export function contractFileName(contractNumber, title) {
  const slug = String(title || "Sale Agreement")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "Contract";
  const number = String(contractNumber || "contract").replace(/[^a-zA-Z0-9-]+/g, "");
  return `${number} ${slug}`.trim() + ".docx";
}

/** A collision-free stored name, in the same spirit as the upload middleware. */
export function contractStoredName(originalFilename) {
  return `${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${originalFilename}`;
}

/**
 * Renders `text` into a real PDF at `targetPath`.
 *
 * `text` is the ALREADY rendered template - placeholder substitution happens
 * before this point, so this function only typesets. A blank line becomes
 * paragraph spacing and a line starting with `#` becomes a heading, which is
 * enough structure for an agreement without inventing a markup language.
 */
export function writeContractPdf({ text, targetPath, title, contractNumber }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const pdf = new PDFDocument({
      size: "A4",
      margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN },
      info: { Title: title || "Contract", Author: BRAND, Subject: `Contract ${contractNumber || ""}`.trim() },
    });
    const stream = fs.createWriteStream(targetPath);
    let settled = false;
    const fail = (error) => { if (settled) return; settled = true; reject(error); };
    stream.on("error", fail);
    pdf.on("error", fail);
    pdf.pipe(stream);

    // --- Letterhead: the same green/gold identity as every other export. -----
    pdf.rect(0, 0, pdf.page.width, 96).fill(`#${BRAND_GREEN}`);
    pdf.rect(0, 96, pdf.page.width, 4).fill(`#${BRAND_GOLD}`);
    pdf.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(20).text(BRAND, PAGE_MARGIN, 28);
    pdf.font("Helvetica").fontSize(9).fillColor(`#${BRAND_GOLD}`).text(BRAND_SUB.toUpperCase(), PAGE_MARGIN, 54);
    pdf.fillColor("#FFFFFF").font("Helvetica").fontSize(10)
      .text(String(title || "Sale Agreement"), PAGE_MARGIN, 70, { align: "right", width: 240 });
    pdf.y = 128;

    // --- Body ---------------------------------------------------------------
    const bodyWidth = pdf.page.width - PAGE_MARGIN * 2;
    pdf.fillColor("#16211b").font("Helvetica").fontSize(10.5);
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, "");
      if (pdf.y > pdf.page.height - PAGE_MARGIN - 50) pdf.addPage();
      if (!line.trim()) { pdf.moveDown(0.6); continue; }
      const heading = line.match(/^(#{1,3})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        pdf.moveDown(0.4);
        pdf.fillColor(`#${BRAND_GREEN}`).font("Helvetica-Bold")
          .fontSize(level === 1 ? 14 : 11.5)
          .text(heading[2], { width: bodyWidth });
        if (level === 1) {
          const y = pdf.y + 2;
          pdf.moveTo(PAGE_MARGIN, y).lineTo(PAGE_MARGIN + bodyWidth, y)
            .lineWidth(1).stroke(`#${BRAND_GOLD}`).stroke();
          pdf.y = y + 8;
        }
        pdf.fillColor("#16211b").font("Helvetica").fontSize(10.5);
        continue;
      }
      pdf.text(line.replace(/^[-*]\s+/, "- "), { width: bodyWidth, align: "justify" });
    }

    // --- Footer on every page ----------------------------------------------
    const range = pdf.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      pdf.switchToPage(index);
      const y = pdf.page.height - 40;
      pdf.moveTo(PAGE_MARGIN, y - 8).lineTo(PAGE_MARGIN + bodyWidth, y - 8)
        .lineWidth(0.5).strokeColor("#e2e7e1").stroke();
      pdf.fillColor("#6d7a72").font("Helvetica").fontSize(8)
        .text(`${BRAND} - ${contractNumber || ""}`.trim(), PAGE_MARGIN, y, { lineBreak: false })
        .text(`Page ${index + 1} of ${range.count}`, PAGE_MARGIN, y, { align: "right", lineBreak: false });
    }

    pdf.end();
    stream.on("finish", () => {
      if (settled) return;
      settled = true;
      resolve({ file_size: fs.statSync(targetPath).size, mime_type: "application/pdf" });
    });
  });
}

/** Writes the rendered agreement as an editable Word document. */
/** Pixel size of a PNG or JPEG, read from its header (null if unknown). */
export function imageSize(buffer) {
  try {
    if (buffer.readUInt32BE(0) === 0x89504e47) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), type: "png" };
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) break;
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7), type: "jpg" };
        }
        offset += 2 + length;
      }
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * The lawyer's signature block appended after the agreement text: the image,
 * the signer's name and title, and the date it was applied. It is a separate
 * block (not part of the editable text), so re-saving the text never
 * duplicates or loses it.
 */
function signatureParagraphs(signature) {
  if (!signature?.image) return [];
  const size = imageSize(signature.image);
  const width = 200;
  const height = size && size.width ? Math.max(30, Math.min(120, Math.round(width * size.height / size.width))) : 70;
  return [
    new Paragraph({ text: "", spacing: { before: 360 } }),
    new Paragraph({ children: [new TextRun({ text: `Signed for and on behalf of ${signature.company || "the Company"} (Legal)`, bold: true })], spacing: { after: 120 } }),
    new Paragraph({ children: [new ImageRun({ type: size?.type || "png", data: signature.image, transformation: { width, height } })] }),
    new Paragraph({ children: [new TextRun({ text: "______________________________" })] }),
    new Paragraph({ children: [new TextRun({ text: signature.name || "", bold: true })] }),
    ...(signature.title ? [new Paragraph({ children: [new TextRun({ text: signature.title })] })] : []),
    new Paragraph({ children: [new TextRun({ text: `Date: ${signature.date || ""}`, color: "666666" })], spacing: { after: 120 } }),
  ];
}

// ---------------------------------------------------------------------------
// The built-in MKUYU letterhead.
//
// Used whenever no Word template has been uploaded. The letterhead (logo,
// company name, the agreement title) lives in the page HEADER and the contract
// number with "Page X of Y" in the FOOTER, so Word repeats the template on
// every page however long the agreement runs: the content always stays on the
// template. Colours are the MKUYU identity of the public website.
// ---------------------------------------------------------------------------
const LETTERHEAD_INK = "16130F";
const LETTERHEAD_ACCENT = "A67C52";
const LETTERHEAD_MUTED = "6F675E";
const PAGE_CONTENT_WIDTH = 9900; // A4 (11906 twips) less two 1000-twip margins
const LOGO_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "frontend", "assets", "brand", "mkuyu-logo-192.png");
let logoBytes;
function brandLogo() {
  if (logoBytes === undefined) {
    try { logoBytes = fs.readFileSync(LOGO_PATH); } catch { logoBytes = null; }
  }
  return logoBytes;
}

function letterheadHeader(title) {
  const logo = brandLogo();
  return new Header({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: PAGE_CONTENT_WIDTH }],
        children: [
          ...(logo ? [new ImageRun({ type: "png", data: logo, transformation: { width: 46, height: 46 } }), new TextRun({ text: "  " })] : []),
          new TextRun({ text: BRAND, bold: true, size: 34, color: LETTERHEAD_INK, font: "Georgia" }),
          new TextRun({ text: `\t${title || "Agreement"}`, size: 18, color: LETTERHEAD_MUTED }),
        ],
      }),
      new Paragraph({
        spacing: { after: 120 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: LETTERHEAD_ACCENT, space: 4 } },
        children: [new TextRun({ text: "REAL ESTATE · PROPERTY · PEOPLE · AGREEMENTS", size: 14, color: LETTERHEAD_ACCENT, characterSpacing: 40 })],
      }),
    ],
  });
}

function letterheadFooter(contractNumber) {
  return new Footer({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: PAGE_CONTENT_WIDTH }],
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: "E4DDD2", space: 4 } },
        children: [
          new TextRun({ text: `${BRAND} Real Estate${contractNumber ? ` · Contract ${contractNumber}` : ""}`, size: 16, color: LETTERHEAD_MUTED }),
          new TextRun({ children: ["\tPage ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES], size: 16, color: LETTERHEAD_MUTED }),
        ],
      }),
    ],
  });
}

/** Agreement text (see agreements.js for the line syntax) -> Word paragraphs. */
export function agreementParagraphs(text) {
  const children = [];
  let previousBlank = false;
  // The signature section is kept together on one page (Word "keep with next").
  let signatures = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (/^##\s+Signatures\b/i.test(line)) signatures = true;
    if (!line.trim()) {
      // One blank line is one paragraph break; runs of blanks do not stack up.
      if (!previousBlank && children.length) children.push(new Paragraph({ text: "", keepNext: signatures, spacing: { after: 40 } }));
      previousBlank = true;
      continue;
    }
    previousBlank = false;
    if (signatures && !/^#{1,3}\s/.test(line)) {
      children.push(new Paragraph({ keepNext: true, keepLines: true, spacing: { after: 120, line: 300 }, children: [new TextRun(line)] }));
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading && heading[1].length === 1) {
      children.push(new Paragraph({
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        spacing: { before: 120, after: 80 },
        children: [new TextRun({ text: heading[2].toUpperCase(), bold: true, size: 34, color: LETTERHEAD_INK, font: "Georgia", characterSpacing: 30 })],
      }));
    } else if (heading) {
      children.push(new Paragraph({
        heading: heading[1].length === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
        keepNext: true,
        spacing: { before: 260, after: 100 },
        children: [new TextRun({ text: heading[2].toUpperCase(), bold: true, size: heading[1].length === 2 ? 22 : 20, color: LETTERHEAD_INK, font: "Georgia" })],
      }));
    } else if (/^[-*]\s+/.test(line)) {
      children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: [new TextRun({ text: line.replace(/^[-*]\s+/, "") })] }));
    } else if (/^>\s?/.test(line)) {
      children.push(new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: line.replace(/^>\s?/, ""), italics: true, size: 18, color: LETTERHEAD_MUTED })] }));
    } else if (/^Contract number:/i.test(line)) {
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [new TextRun({ text: line, size: 18, color: LETTERHEAD_MUTED })] }));
    } else {
      children.push(new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 120, line: 300 }, children: [new TextRun(line)] }));
    }
  }
  return children;
}

export async function writeContractDocx({ text, targetPath, title, contractNumber, signature = null }) {
  const document = new WordDocument({
    creator: `${BRAND} · ${BRAND_SUB}`,
    title: title || "Sale Agreement",
    subject: `Contract ${contractNumber || ""}`.trim(),
    styles: { default: { document: { run: { font: "Cambria", size: 22, color: "222222" } } } },
    sections: [{
      properties: { page: { margin: { top: 1500, right: 1000, bottom: 1200, left: 1000, header: 500, footer: 500 } } },
      headers: { default: letterheadHeader(title) },
      footers: { default: letterheadFooter(contractNumber) },
      children: [...agreementParagraphs(text), ...signatureParagraphs(signature)],
    }],
  });
  const buffer = await Packer.toBuffer(document);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, buffer);
  return { file_size: fs.statSync(targetPath).size, mime_type: extensionMime[".docx"] };
}

/** Generates the full contract DOCX into the shared document upload directory. */
export async function generateContractDocument({ text, title, contractNumber, signature = null }) {
  const originalFilename = contractFileName(contractNumber, title);
  const storedName = contractStoredName(originalFilename);
  const file = await writeContractDocx({ text, targetPath: path.join(documentUploadsDir, storedName), title, contractNumber, signature });
  return { ...file, stored_name: storedName, original_filename: originalFilename };
}

const LIFECYCLE_COLUMNS = [
  ["contract_number", "TEXT"],
  ["property_id", "INTEGER REFERENCES properties(id) ON DELETE SET NULL"],
  ["terms", "TEXT"],
  ["requires_management_approval", "BOOLEAN NOT NULL DEFAULT FALSE"],
  ["submitted_at", "TIMESTAMPTZ"],
  ["legal_reviewed_by", "INTEGER REFERENCES users(id) ON DELETE SET NULL"],
  ["legal_reviewed_at", "TIMESTAMPTZ"],
  ["legal_notes", "TEXT"],
  ["finance_validated_by", "INTEGER REFERENCES users(id) ON DELETE SET NULL"],
  ["finance_validated_at", "TIMESTAMPTZ"],
  ["finance_notes", "TEXT"],
  ["management_approved_by", "INTEGER REFERENCES users(id) ON DELETE SET NULL"],
  ["management_approved_at", "TIMESTAMPTZ"],
  ["management_notes", "TEXT"],
  ["customer_signed_at", "TIMESTAMPTZ"],
  ["customer_signed_by", "TEXT"],
  ["status_note", "TEXT"],
  ["legal_owner_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL"],
  ["updated_by", "INTEGER REFERENCES users(id) ON DELETE SET NULL"],
  ["updated_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],
];

// Additive columns for the contract-generation flow. Existing fields such as
// start_date, end_date, deposit_amount and value keep their established names;
// IF NOT EXISTS adds only fields missing from an older schema. The nullable
// contact snapshots are not backfilled, and value remains the final price.
const GENERATION_COLUMNS = [
  ["contract_date", "DATE"],
  ["agreement_duration", "INTEGER"],
  ["agreement_duration_unit", "TEXT"],
  ["client_phone", "TEXT"],
  ["client_email", "TEXT"],
  ["payment_frequency", "TEXT"],
  ["deposit_amount", "NUMERIC(14,2)"],
  ["installment_count", "INTEGER"],
  ["first_due_date", "DATE"],
  ["template_document_id", "INTEGER REFERENCES documents(id) ON DELETE SET NULL"],
  ["generated_document_id", "INTEGER REFERENCES documents(id) ON DELETE SET NULL"],
];

/**
 * Brings an existing contracts table up to the lifecycle shape:
 *   * widens the status CHECK to the twelve lifecycle values
 *   * maps any legacy status onto its equivalent
 *   * adds the lifecycle tracking columns
 *   * adds the revision-history table
 *
 * Existing rows are migrated in place; nothing is dropped or recreated.
 */
export async function migrateContractWorkflow() {
  // Two processes (a test server and a migration run, say) can reach this at the
  // same time. The drop-then-add pair below is not atomic, so without a lock both
  // drop, then the loser fails with "constraint already exists". The advisory
  // lock serialises the whole migration across processes; it is released when the
  // transaction ends, including on failure.
  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(88101)");
    // The original CHECK is auto-named, so drop it by definition before the
    // widened one is attached. No-op on a fresh database.
    await client.query("ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_status_check");
    // Map legacy values first so the new constraint never sees an unknown status.
    await client.query("UPDATE contracts SET status='completed' WHERE status='closed'");
    for (const [column, definition] of LIFECYCLE_COLUMNS) {
      await client.query(`ALTER TABLE contracts ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
    }
    // Contract templates are documents: the placeholder body lives on the same
    // table the system already uses for agreements, so there is one document
    // store rather than a second one.
    await client.query("ALTER TABLE documents ADD COLUMN IF NOT EXISTS body_text TEXT");
    // Added after `body_text` so the foreign keys below have a real target.
    for (const [column, definition] of GENERATION_COLUMNS) {
      await client.query(`ALTER TABLE contracts ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
    }
    await client.query("ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_duration_unit_check");
    await client.query(`ALTER TABLE contracts ADD CONSTRAINT contracts_duration_unit_check CHECK (agreement_duration_unit IS NULL OR agreement_duration_unit IN ('days','weeks','months','years'))`);
    await client.query(`ALTER TABLE contracts ADD CONSTRAINT contracts_status_check CHECK (status IN (${CONTRACT_STATUSES.map((status) => `'${status}'`).join(",")}))`);
    // Every contract needs a stable reference number; backfill by id so existing
    // rows are never left without one.
    await client.query("UPDATE contracts SET contract_number = 'MK-C-' || LPAD(id::text, 6, '0') WHERE contract_number IS NULL OR contract_number = ''");
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_number ON contracts(contract_number)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_contracts_property ON contracts(property_id)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS contract_revisions (
        id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
        contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
      action TEXT,
      notes TEXT,
      changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      changed_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_contract_revisions_contract ON contract_revisions(contract_id, revision DESC)");
  });
}

