import { Router } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Project } from "../models/project.js";
import { Contract } from "../models/contract.js";
import { computePricing } from "../contracts/pricing.js";
import { Debt, DEBT_STATUSES } from "../models/debt.js";
import { Payment } from "../models/payment.js";
import { Reminder } from "../models/reminder.js";
import { Report } from "../models/report.js";
import { REPORT_TYPES, REPORT_TYPE_IDS, PAYMENT_METHODS, reportTypeLabel, reportTypeIsFinancial } from "../models/reportTypes.js";
import { Property, Client, Appointment, Document, PropertyImage } from "../models/catalog.js";
import { paginatedList, paginationRequested, parsePagination, searchTerm } from "../pagination.js";
import {
  hashPassword,
  verifyPassword,
  hashToken,
  createSession,
  tokenFromRequest,
  publicUser,
  requireAuth,
  portalForUser,
  resolvePortal,
} from "../auth.js";
import db, { DATABASE_URL, query, queryOne, withTransaction } from "../db.js";
import { buildReport, parseFilters } from "../reports/builders.js";
import { exportReport, EXPORT_FORMATS } from "../reports/exporters.js";
import {
  documentExtensions,
  reportExtensions,
  reportUploadsDir,
  documentUploadsDir,
  propertyUploadsDir,
  propertyImageExtensions,
  backupsDir,
  uploadDocumentFile,
  uploadReportFile,
  uploadPropertyImageFile,
  validateUploadedFile,
  cleanupUploadedFile,
  safeDisplayFilename,
  resolveStoredFile,
  removeStoredFile,
  storedFileExists,
} from "../uploads.js";
import orgRoutes from "./org.js";
import { audit } from "../org/audit.js";
import { requirePermissionForMethod, provisionSystemAdministrator, organizationId, requireAdmin } from "../org/rbac.js";
import { accessMiddleware, can, ownershipFields } from "../org/access.js";
import {
  CONTRACT_ACTIONS,
  CONTRACT_STATUSES,
  CREATABLE_CONTRACT_STATUSES,
  availableActions,
  canTransition,
} from "../contracts/workflow.js";
import {
  DEFAULT_CONTRACT_TEMPLATE,
  PAYMENT_FREQUENCIES,
  buildContractValues,
  monthsPerFrequency,
  produceContractDocument,
  renderContractDocument,
} from "../contracts/generation.js";
import { CONTRACT_PLACEHOLDERS, placeholdersUsed, unknownPlaceholders } from "../contracts/workflow.js";

const router = Router();
const execFileAsync = promisify(execFile);
const projectStatuses = new Set(["active", "archived"]);
const contractTypes = new Set(["new", "terminal"]);
// Contract lifecycle statuses now live in contracts/workflow.js so the API, the
// database constraint and the UI can never drift apart.

// Installment status vocabulary. Imported from the model so the API validates
// against exactly the values `deriveInstallmentStatus` can produce, and `partial`
// can never be rejected on the way in or missing from the filter.
const debtStatuses = new Set(DEBT_STATUSES);
const propertyTypes = new Set(["land", "house", "apartment", "villa", "commercial", "penthouse"]);
const propertyStatuses = new Set(["available", "reserved", "sold", "leased"]);
const clientTypes = new Set(["buyer", "seller", "landlord", "tenant"]);
const clientStatuses = new Set(["lead", "active", "inactive"]);
const appointmentTypes = new Set(["viewing", "call", "meeting", "inspection"]);
const appointmentStatuses = new Set(["scheduled", "completed", "cancelled"]);
const documentCategories = new Set(["agreement", "title", "invoice", "receipt", "report", "permit", "template", "other"]);
const documentStatuses = new Set(["pending", "approved", "archived"]);
const paymentMethods = new Set(PAYMENT_METHODS.map((entry) => entry.value));
const MAX_PROPERTY_IMAGES = 12;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function route(handler) {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => handler(req, res, next))
      .catch(next);
  };
}

// Every primary key in this schema is `INTEGER GENERATED ... AS IDENTITY`, i.e.
// a 32-bit signed integer. A value above that is well-formed as a JS integer but
// cannot exist in the database: passing it through made PostgreSQL raise
// "integer out of range" and surface as a 500 instead of the 400 the caller
// deserves. Rejecting it here keeps an unrunnable id a client error.
const MAX_INT4 = 2147483647;

function parseId(value, field = "id", optional = false) {
  if (optional && (value === undefined || value === null || value === "")) return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1 || id > MAX_INT4) throw new HttpError(400, `${field} must be a positive integer`);
  return id;
}

function requiredText(value, field, max = 120) {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${field} is required`);
  const text = value.trim();
  if (text.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer`);
  return text;
}

function optionalText(value, field, max = 2000) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, `${field} must be text`);
  const text = value.trim();
  if (text.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer`);
  return text;
}

function enumValue(value, allowed, fallback, field) {
  const selected = value === undefined || value === "" ? fallback : value;
  if (!allowed.has(selected)) throw new HttpError(400, `${field} is invalid`);
  return selected;
}

function nonNegativeNumber(value, field, fallback = 0) {
  const selected = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isFinite(selected) || selected < 0) throw new HttpError(400, `${field} must be a non-negative number`);
  return selected;
}

function nonNegativeInteger(value, field, fallback = 0) {
  const selected = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(selected) || selected < 0) throw new HttpError(400, `${field} must be a non-negative integer`);
  return selected;
}

function optionalDate(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, `${field} must use YYYY-MM-DD`);
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new HttpError(400, `${field} is invalid`);
  return value;
}

function optionalDateTime(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(value)) throw new HttpError(400, `${field} must use YYYY-MM-DD HH:MM`);
  const date = new Date(value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `${field} is invalid`);
  return value.replace(" ", "T");
}

function validEmail(value, field = "email") {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) throw new HttpError(400, `${field} is invalid`);
  return value.trim();
}

function validateProject(body, current = {}) {
  return {
    name: requiredText(body.name ?? current.name, "name"),
    status: enumValue(body.status ?? current.status, projectStatuses, "active", "status"),
  };
}

async function validateContract(body, current = {}) {
  // A contract is always born as a draft and moves through the workflow from
  // there, so `status` is never taken from the request body.
  const status = current.status || (CREATABLE_CONTRACT_STATUSES.has(body.status) ? body.status : "draft");
  // Phase 2.1 pricing. `original_price` and `discount_pct` are the only inputs;
  // the server derives the discount amount and the final price. A `final_price` or
  // `discount_amount` in the body is deliberately ignored, so a client cannot
  // dictate what a contract is worth.
  //
  // A client that sends only the legacy `value` is still supported: that amount is
  // taken as the list price with no discount, so the final price equals it. This
  // is what keeps existing callers working. Note this grants no extra power - the
  // discount is 0, so the final price is exactly the amount the caller already
  // could set by sending `original_price`. What is NOT possible is making the
  // final price disagree with the discount percentage.
  const originalPrice = body.original_price ?? current.original_price ?? body.value ?? current.value ?? 0;
  const discountPct = body.discount_pct ?? current.discount_pct ?? 0;
  let pricing;
  try {
    pricing = computePricing({ originalPrice, discountPct });
  } catch (error) {
    throw new HttpError(error.status || 400, error.message);
  }
  const data = {
    project_id: parseId(body.project_id ?? current.project_id, "project_id"),
    property_id: parseId(body.property_id ?? current.property_id, "property_id", true),
    client_id: parseId(body.client_id ?? current.client_id, "client_id", true),
    client_name: requiredText(body.client_name ?? current.client_name, "client_name"),
    contract_type: enumValue(body.contract_type ?? current.contract_type, contractTypes, "new", "contract_type"),
    status,
    pricing,
    // `value` mirrors the calculated final price. It is kept because the payment
    // schedule, reports and exports all read it, and it is now defined as the
    // final price everywhere.
    value: Number(pricing.final_price),
    start_date: optionalDate(body.start_date ?? current.start_date, "start_date"),
    end_date: optionalDate(body.end_date ?? current.end_date, "end_date"),
    terms: optionalText(body.terms ?? current.terms, "terms", 4000),
    notes: optionalText(body.notes ?? current.notes, "notes"),
    requires_management_approval: Boolean(body.requires_management_approval ?? current.requires_management_approval),
  };
  const client = data.client_id ? requireRecord(await Client.get(data.client_id), "Client") : null;
  data.client_phone = optionalText(body.client_phone || client?.phone, "client_phone", 40);
  data.client_email = validEmail(body.client_email || client?.email, "client_email");
  if (data.property_id) {
    const property = requireRecord(await Property.get(data.property_id), "Property");
    // The chain the spec describes is Customer <- Property <- Project <- Contract,
    // so a contract may not name a property that belongs to another project.
    if (property.project_id && Number(property.project_id) !== Number(data.project_id)) {
      throw new HttpError(400, "property_id does not belong to the selected project");
    }
  }
  if (data.start_date && data.end_date && data.end_date < data.start_date) throw new HttpError(400, "end_date cannot be before start_date");
  return data;
}

// Adds a whole number of months (or the equivalent in days/weeks/years) to a
// YYYY-MM-DD string and returns YYYY-MM-DD. Used to check that a stated
// agreement end date actually matches a stated duration, and to derive one when
// the office only gave a duration. UTC throughout, so the result never depends
// on the server's timezone or on a daylight-saving boundary.
function addMonths(dateString, months, unit = "months") {
  const match = String(dateString).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateString;
  const [, year, month, day] = match.map(Number);
  if (unit === "days" || unit === "weeks") {
    const days = unit === "weeks" ? months * 7 : months;
    const target = new Date(Date.UTC(year, month - 1, day + days));
    return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(target.getUTCDate()).padStart(2, "0")}`;
  }
  const targetMonth = month - 1 + (unit === "years" ? months * 12 : months);
  const anchor = new Date(Date.UTC(year, targetMonth, 1));
  const lastDay = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0)).getUTCDate();
  return `${anchor.getUTCFullYear()}-${String(anchor.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

/** Today as YYYY-MM-DD, read from the database so every process agrees. */
async function todayDate() {
  const row = await queryOne("SELECT to_char(NOW(), 'YYYY-MM-DD') AS today");
  return row?.today || new Date().toISOString().slice(0, 10);
}

// Builds an equal-installment schedule: optional deposit due at start, then N
// installments on the requested frequency. Cents-safe: the last installment
// absorbs rounding. Dates are computed in UTC to stay independent of the server
// timezone.
//
// `monthsPerStep` is 1 for the monthly default this function has always used, so
// an existing caller that sends no frequency gets exactly the schedule it got
// before. It is supplied by contracts/generation.js, which is also where the
// frequency vocabulary lives - there is one schedule builder, not two.
function buildSchedule(contract, { deposit, installments, firstDueDate, monthsPerStep = 1 }) {
  const rows = [];
  const start = contract.start_date || firstDueDate;
  if (deposit > 0) {
    rows.push({ amount: deposit, due_date: start, label: "Deposit" });
  }
  const remaining = Math.round((contract.value - deposit) * 100) / 100;
  const base = Math.floor((remaining / installments) * 100) / 100;
  const [year, month, day] = firstDueDate.split("-").map(Number);
  const step = Number.isInteger(monthsPerStep) && monthsPerStep > 0 ? monthsPerStep : 1;
  let allocated = 0;
  for (let index = 0; index < installments; index += 1) {
    const amount = index === installments - 1
      ? Math.round((remaining - allocated) * 100) / 100
      : base;
    allocated = Math.round((allocated + amount) * 100) / 100;
    const anchor = new Date(Date.UTC(year, month - 1 + index * step, 1));
    const lastDay = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0)).getUTCDate();
    const dueDay = Math.min(day, lastDay);
    const dueDate = `${anchor.getUTCFullYear()}-${String(anchor.getUTCMonth() + 1).padStart(2, "0")}-${String(dueDay).padStart(2, "0")}`;
    rows.push({
      amount,
      due_date: dueDate,
      label: `Installment ${index + 1}/${installments}`,
    });
  }
  return rows.filter((row) => row.amount > 0);
}

function validateSchedule(body) {
  const installments = Number(body.installments);
  if (!Number.isInteger(installments) || installments < 1 || installments > 120) {
    throw new HttpError(400, "installments must be an integer between 1 and 120");
  }
  const deposit = nonNegativeNumber(body.deposit, "deposit", 0);
  const firstDueDate = optionalDate(body.first_due_date, "first_due_date");
  if (!firstDueDate) throw new HttpError(400, "first_due_date is required");
  // An unknown frequency is refused rather than silently treated as monthly,
  // so a typo cannot quietly produce the wrong due dates.
  const frequency = body.frequency === undefined || body.frequency === null || body.frequency === "" ? "monthly" : String(body.frequency).toLowerCase();
  if (!PAYMENT_FREQUENCIES.includes(frequency)) {
    throw new HttpError(400, `frequency must be one of ${PAYMENT_FREQUENCIES.join(", ")}`);
  }
  return { installments, deposit, firstDueDate, frequency };
}

function validateDebt(body, current = {}) {
  return {
    contract_id: parseId(body.contract_id ?? current.contract_id, "contract_id"),
    client_name: requiredText(body.client_name ?? current.client_name, "client_name"),
    amount: nonNegativeNumber(body.amount ?? current.amount, "amount"),
    due_date: optionalDate(body.due_date ?? current.due_date, "due_date"),
    status: enumValue(body.status ?? current.status, debtStatuses, "pending", "status"),
    notes: optionalText(body.notes ?? current.notes, "notes"),
  };
}

function validateProperty(body, current = {}) {
  return {
    project_id: parseId(body.project_id ?? current.project_id, "project_id", true),
    name: requiredText(body.name ?? current.name, "name"),
    property_type: enumValue(body.property_type ?? current.property_type, propertyTypes, "house", "property_type"),
    status: enumValue(body.status ?? current.status, propertyStatuses, "available", "status"),
    price: nonNegativeNumber(body.price ?? current.price, "price"),
    location: requiredText(body.location ?? current.location, "location"),
    area: nonNegativeNumber(body.area ?? current.area, "area"),
    bedrooms: nonNegativeInteger(body.bedrooms ?? current.bedrooms, "bedrooms"),
    bathrooms: nonNegativeInteger(body.bathrooms ?? current.bathrooms, "bathrooms"),
    description: optionalText(body.description ?? current.description, "description"),
    featured: Boolean(body.featured ?? current.featured),
  };
}

function validateClient(body, current = {}) {
  return {
    project_id: parseId(body.project_id ?? current.project_id, "project_id", true),
    name: requiredText(body.name ?? current.name, "name"),
    email: validEmail(body.email ?? current.email),
    phone: optionalText(body.phone ?? current.phone, "phone", 40),
    client_type: enumValue(body.client_type ?? current.client_type, clientTypes, "buyer", "client_type"),
    status: enumValue(body.status ?? current.status, clientStatuses, "lead", "status"),
    notes: optionalText(body.notes ?? current.notes, "notes"),
  };
}

/**
 * The contract a caller wants associated with a client, if any.
 *
 * Kept out of `validateClient` on purpose: that function feeds the fixed-arity
 * UPDATE statement in the client model, so an extra key would shift every bind
 * parameter and Postgres would compare text to integer. The association is read
 * separately, and `Client.update` is never asked to store it.
 */
function requestedContractId(body) {
  return parseId(body?.contract_id, "contract_id", true);
}

/**
 * Enforces the MKUYU rule that a COMPLETED client record must be backed by a
 * contract.
 *
 * The flow is New Client -> Property -> Contract -> Complete. This checks only
 * the last step: a client being created as `active`, or being MOVED to `active`,
 * must already have a contract. A client left as `lead` is a prospect and needs
 * none, which is what keeps the Leads/Prospects concept working.
 *
 * Two deliberate exclusions, both driven by the live data rather than by
 * preference:
 *
 *  - It only fires when the status CHANGES to active. Dozens of pre-existing
 *    active clients have no contract; refusing to edit one would break real
 *    records and is not what the rule is about.
 *  - A contract is not required to name a property. No existing contract links
 *    one, so demanding it would reject every legitimate contract.
 */
async function requireContractForCompletedClient(clientId, status, previousStatus) {
  if (status !== "active") return;
  // Already completed before this rule existed: editing it is not completing it.
  if (previousStatus === "active") return;
  const values = [clientId, await organizationId()];
  const linked = await queryOne(
    "SELECT 1 AS ok FROM contracts WHERE organization_id=$1 AND client_id=$2 LIMIT 1",
    [values[1], clientId],
  );
  if (linked) return;
  throw new HttpError(400, "a client cannot be completed without a contract: create the contract for this client, or save the client as a prospect (status: lead) until the contract is signed");
}

/** True when this client already has at least one contract. */
async function clientHasContract(clientId) {
  const org = await organizationId();
  return Boolean(await queryOne("SELECT 1 AS ok FROM contracts WHERE organization_id=$1 AND client_id=$2 LIMIT 1", [org, clientId]));
}

function validateAppointment(body, current = {}) {
  const data = {
    client_id: parseId(body.client_id ?? current.client_id, "client_id"),
    property_id: parseId(body.property_id ?? current.property_id, "property_id", true),
    project_id: parseId(body.project_id ?? current.project_id, "project_id", true),
    title: requiredText(body.title ?? current.title, "title"),
    appointment_type: enumValue(body.appointment_type ?? current.appointment_type, appointmentTypes, "viewing", "appointment_type"),
    starts_at: optionalDateTime(body.starts_at ?? current.starts_at, "starts_at"),
    ends_at: optionalDateTime(body.ends_at ?? current.ends_at, "ends_at"),
    status: enumValue(body.status ?? current.status, appointmentStatuses, "scheduled", "status"),
    notes: optionalText(body.notes ?? current.notes, "notes"),
  };
  if (!data.starts_at) throw new HttpError(400, "starts_at is required");
  if (data.starts_at && data.ends_at && data.ends_at <= data.starts_at) throw new HttpError(400, "ends_at must be after starts_at");
  return data;
}

function validateDocument(body, current = {}) {
  return {
    project_id: parseId(body.project_id ?? current.project_id, "project_id", true),
    contract_id: parseId(body.contract_id ?? current.contract_id, "contract_id", true),
    client_id: parseId(body.client_id ?? current.client_id, "client_id", true),
    title: requiredText(body.title ?? current.title, "title"),
    category: enumValue(body.category ?? current.category, documentCategories, "other", "category"),
    status: enumValue(body.status ?? current.status, documentStatuses, "pending", "status"),
    file_reference: optionalText(body.file_reference ?? current.file_reference, "file_reference", 300),
    notes: optionalText(body.notes ?? current.notes, "notes"),
  };
}

function positiveNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new HttpError(400, `${field} must be greater than zero`);
  return Math.round(number * 100) / 100;
}

function paymentDate(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return optionalDate(value, "paid_at");
  return optionalDateTime(value, "paid_at");
}

async function validatePayment(body, current = {}) {
  const contractId = parseId(body.contract_id ?? current.contract_id, "contract_id");
  const contract = requireRecord(await queryOne("SELECT id, client_name FROM contracts WHERE id = $1", [contractId]), "Contract");
  const debtId = parseId(body.debt_id ?? current.debt_id, "debt_id", true);
  if (debtId) {
    const debt = requireRecord(await queryOne("SELECT id, contract_id FROM debts WHERE id = $1", [debtId]), "Installment");
    if (debt.contract_id !== contractId) throw new HttpError(400, "debt_id does not belong to the selected contract");
  }
  const paidAt = paymentDate(body.paid_at ?? current.paid_at);
  if (!paidAt) throw new HttpError(400, "paid_at is required");
  return {
    contract_id: contractId,
    debt_id: debtId,
    client_name: requiredText(body.client_name ?? current.client_name ?? contract.client_name, "client_name"),
    amount: positiveNumber(body.amount ?? current.amount, "amount"),
    paid_at: paidAt,
    method: enumValue(body.method ?? current.method, paymentMethods, "cash", "method"),
    reference: optionalText(body.reference ?? current.reference, "reference", 160),
    notes: optionalText(body.notes ?? current.notes, "notes"),
  };
}

function reportTypeId(value) {
  const id = requiredText(value, "report_type", 60).toLowerCase();
  if (!REPORT_TYPE_IDS.has(id)) throw new HttpError(400, "report_type is invalid");
  return id;
}

function reportFilters(type, raw = {}) {
  try {
    return parseFilters(type, raw);
  } catch (error) {
    throw new HttpError(400, error.message);
  }
}

function historyFilters(query = {}) {
  const source = query.source || null;
  if (source && !["generated", "uploaded"].includes(source)) throw new HttpError(400, "source is invalid");
  const reportType = query.report_type ? reportTypeId(query.report_type) : null;
  return {
    projectId: query.project_id === undefined ? null : parseId(query.project_id, "project_id"),
    source,
    reportType,
    search: optionalText(query.search, "search", 120),
    from: optionalDate(query.from, "from"),
    to: optionalDate(query.to, "to"),
  };
}

function documentResponse(document) {
  if (!document) return document;
  return { ...document, has_file: storedFileExists(documentUploadsDir, document.stored_name), file_name: document.original_filename || null };
}

/**
 * Shapes a contract for the API. `available_actions` is what the UI renders as
 * buttons, computed from the caller's own permissions so Legal, Sales, Finance
 * and the MD each see only the steps they may actually take.
 */
function contractResponse(contract, req) {
  if (!contract) return contract;
  const permissions = req?.access?.permissions || [];
  const names = req?.access?.isAdmin
    ? Object.keys(CONTRACT_ACTIONS)
    : availableActions(contract.status, permissions).map((entry) => entry.action);
  return {
    ...contract,
    available_actions: names
      .filter((name) => canTransition(contract.status, name))
      .map((name) => ({ action: name, label: CONTRACT_ACTIONS[name].label, to: CONTRACT_ACTIONS[name].to })),
  };
}

function paymentResponse(payment) {
  if (!payment) return payment;
  return {
    ...payment,
    has_receipt: Boolean(payment.receipt_stored_name),
    receipt_file_name: payment.receipt_filename || null,
  };
}

// Reminder timing: 3 days before the due date, clamped to "now" when closer.
function reminderTimeFor(dueDate) {
  if (!dueDate) return null;
  const due = new Date(`${dueDate}T09:00:00`);
  const remind = new Date(due.getTime() - 3 * 86400000);
  const now = new Date();
  const target = remind > now ? remind : now;
  return target.toISOString().replace("T", " ").slice(0, 19);
}

async function syncDebtReminder(debtId, dueDate, status) {
  await Reminder.sync(debtId, status === "paid" ? null : reminderTimeFor(dueDate));
}

// After a payment changes installment state, retime/clear from the stored debt.
async function syncDebtReminderFromDb(debtId) {
  const debt = await queryOne("SELECT due_date, status FROM debts WHERE id = $1", [debtId]);
  if (debt) await syncDebtReminder(debtId, debt.due_date, debt.status);
}

async function recordPropertyHistory(propertyId, userId, event, details = null) {
  const orgId = await organizationId();
  await query("INSERT INTO property_history (organization_id, property_id, user_id, event, details) VALUES ($1, $2, $3, $4, $5::jsonb)", [orgId, propertyId, userId || null, event, details ? JSON.stringify(details) : null]);
}

// A payment create/update/delete can move between installments: resync every
// installment it touches (old + new debt link) so installment status and
// reminders always match the payment ledger. `force` reopens installments that
// lost their only payment.
async function resyncInstallmentState(debtIds) {
  for (const debtId of [...new Set((debtIds || []).filter(Boolean).map(Number))]) {
    await Payment.syncInstallment(debtId, true);
    await syncDebtReminderFromDb(debtId);
  }
}

function reportResponse(report) {
  if (!report) return report;
  return { ...report, has_file: Boolean(report.stored_name), file_name: report.original_filename || null };
}

function sendStoredFile(res, fullPath, mimeType, filename, download = false) {
  const safeName = safeDisplayFilename(filename, "download").replace(/"/g, "");
  res.setHeader("Content-Type", mimeType || "application/octet-stream");
  res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${safeName}"`);
  return res.sendFile(fullPath);
}

function requireRecord(record, label = "Record") {
  if (!record) throw new HttpError(404, `${label} not found`);
  return record;
}

router.get("/health", route((req, res) => res.json({ status: "ok" })));
router.get("/auth/state", route(async (req, res) => res.json({ configured: Number((await queryOne("SELECT COUNT(*) AS count FROM users")).count) > 0 })));
router.post("/auth/setup", route(async (req, res) => {
  if (Number((await queryOne("SELECT COUNT(*) AS count FROM users")).count) > 0) throw new HttpError(409, "workspace already configured");
  const body = req.body || {};
  const displayName = requiredText(body.display_name, "display_name", 80);
  const email = validEmail(body.email, "email");
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 8 || password.length > 128) throw new HttpError(400, "password must be between 8 and 128 characters");
  // Checked BEFORE the insert. First-run setup can only ever succeed once, so a
  // refusal that happened after the write would leave an administrator behind
  // and make every later setup attempt fail with "already configured".
  const portal = resolvePortal(body.portal, { role: "admin" });
  const orgId = await organizationId();
  const result = await queryOne("INSERT INTO users (organization_id, email, password_hash, display_name, role) VALUES ($1, $2, $3, $4, 'admin') RETURNING *", [orgId, email, hashPassword(password), displayName]);
  await provisionSystemAdministrator(result.id);
  await audit({ user: { id: result.id } }, "login", "auth", result.id, { method: "setup", portal });
  const session = await createSession(result.id);
  res.status(201).json({ ...await publicUser(result), ...session, portal });
}));
router.post("/auth/login", route(async (req, res) => {
  const body = req.body || {};
  const email = validEmail(body.email, "email");
  const password = typeof body.password === "string" ? body.password : "";
  const user = await queryOne("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [email]);
  if (!user || !verifyPassword(password, user.password_hash)) throw new HttpError(401, "email or password is incorrect");
  // Portal boundary. Deliberately AFTER the password check: a wrong password
  // must not reveal which portal an address belongs to, so an attacker cannot
  // probe for administrator accounts. `portal` is only a claim - the account's
  // own role decides whether it is honoured, which is why a hand-crafted
  // request cannot get further than the sign-in screen did.
  const portal = resolvePortal(body.portal, user);
  if (user.role === "admin") await provisionSystemAdministrator(user.id);
  const session = await createSession(user.id);
  await audit({ user }, "login", "auth", user.id, { portal });
  res.json({ ...await publicUser(user), ...session, portal });
}));
router.post("/auth/logout", route(async (req, res) => {
  const token = tokenFromRequest(req);
  if (token) {
    const sessionUser = await queryOne("SELECT user_id FROM sessions WHERE token_hash = $1", [hashToken(token)]);
    if (sessionUser) await audit({ user: { id: sessionUser.user_id } }, "logout", "auth", sessionUser.user_id);
    await query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
  }
  res.json({ ok: true });
}));
router.get("/auth/me", requireAuth, route(async (req, res) => {
  // The portal is re-derived from the session's own role on every read, so a
  // refresh restores the correct portal and a tampered client cannot claim one.
  res.json({ ...await publicUser(req.user), portal: portalForUser(req.user) });
}));
router.use(requireAuth);
// Resolve the caller once per request: role scope, departments and permissions.
// Models read it through the async-local store so list/get/update/delete all
// enforce the same visibility rules.
router.use(accessMiddleware());
router.use((req, res, next) => {
  if (req.path.startsWith("/org/")) return next();
  return requirePermissionForMethod()(req, res, next);
});
router.use((req, res, next) => {
  if (req.path.startsWith("/org/") || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 400) {
      const action = req.method === "POST" ? "created" : req.method === "DELETE" ? "deleted" : "updated";
      // Fire-and-forget: an audit failure must never reject an unhandled promise
      // and take the server down.
      audit(req, action, req.path.split("/")[1] || "system", body?.id ?? req.params?.id ?? null).catch(() => {});
    }
    return originalJson(body);
  };
  next();
});
router.use("/org", orgRoutes);

router.get("/projects", route(async (req, res) => {
  if (!paginationRequested(req.query)) return res.json(await Project.all());
  const paged = await paginatedList({ build: () => Project.paged(searchTerm(req.query.search)), ...parsePagination(req.query) });
  res.json({ data: paged.rows, pagination: paged.pagination });
}));
router.get("/projects/:id", route(async (req, res) => res.json(requireRecord(await Project.get(parseId(req.params.id)), "Project"))));
router.post("/projects", route(async (req, res) => {
  const data = validateProject(req.body || {});
  const result = await Project.create(data.name, data.status);
  res.status(201).json(await Project.get(result.id));
}));
router.put("/projects/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const current = requireRecord(await Project.get(id), "Project");
  const data = validateProject(req.body || {}, current);
  await Project.update(id, data.name, data.status);
  res.json(await Project.get(id));
}));
router.delete("/projects/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  requireRecord(await Project.get(id), "Project");
  await Project.remove(id);
  res.json({ ok: true });
}));

router.get("/contracts", route(async (req, res) => {
  const projectId = req.query.project_id === undefined ? null : parseId(req.query.project_id, "project_id");
  const type = req.query.type || null;
  if (type && !contractTypes.has(type)) throw new HttpError(400, "type is invalid");
  if (!paginationRequested(req.query)) return res.json(await Contract.all(projectId, type));
  const paged = await paginatedList({ build: () => Contract.paged(projectId, type, searchTerm(req.query.search)), ...parsePagination(req.query) });
  // The rows are returned exactly as `Contract.all` returns them - no
  // `contractResponse` enrichment. The default list has never applied it (only
  // the single-record route does), so a page must not quietly grow an extra
  // `available_actions` field the unpaged caller does not receive.
  res.json({ data: paged.rows, pagination: paged.pagination });
}));
router.get("/contracts/:id", route(async (req, res) => res.json(contractResponse(requireRecord(await Contract.get(parseId(req.params.id)), "Contract"), req))));

// Revision history. Legal owns the final record, so the trail stays readable for
// as long as the contract itself is in scope.
router.get("/contracts/:id/history", route(async (req, res) => {
  const id = parseId(req.params.id);
  requireRecord(await Contract.get(id), "Contract");
  res.json(await Contract.history(id));
}));

// The workflow. One endpoint for every transition; the resulting status comes
// from the action table and the permission comes from the caller's access
// profile, so a client can never post a status directly.
router.post("/contracts/:id/transition", route(async (req, res) => {
  const id = parseId(req.params.id);
  const contract = requireRecord(await Contract.get(id), "Contract");
  const name = String(req.body?.action || "");
  const action = CONTRACT_ACTIONS[name];
  if (!action) throw new HttpError(400, "action is invalid");
  if (!can(req.access, action.permission)) {
    throw new HttpError(403, `this step requires the ${action.permission} permission`);
  }
  if (!canTransition(contract.status, name)) {
    throw new HttpError(409, `a ${contract.status.replace(/_/g, " ")} contract cannot be moved to ${action.to.replace(/_/g, " ")}`);
  }
  // Legal must sign off before the customer is ever asked to.
  if (name === "send_to_customer" && contract.requires_management_approval && contract.status !== "approved") {
    throw new HttpError(409, "this contract needs management approval before it goes to the customer");
  }
  const notes = optionalText(req.body?.notes, "notes", 2000);
  const signedBy = optionalText(req.body?.signed_by, "signed_by", 160);
  if (name === "record_signature" && !signedBy) throw new HttpError(400, "signed_by is required to record a customer signature");
  await Contract.transition(id, { ...action, action: name }, {
    notes,
    actorId: req.user.id,
    actorName: req.user.display_name,
    signedBy,
  });
  await audit(req, `contract_${name}`, "contract", id, { from: contract.status, to: action.to });
  res.json(contractResponse(await Contract.get(id), req));
}));

// ---------------------------------------------------------------------------
// Contract generation.
//
// One endpoint for the whole flow the office performs: collect the
// information, let the SERVER calculate the price, create the contract through
// the EXISTING contract model, render the selected template into a full PDF,
// store it as a document, link it to the contract, and - only if the caller
// already holds financial authority - build the payment schedule from the
// authoritative final price.
//
// Authorization is the existing one: this route lives under /contracts, so the
// middleware has already required `access_contracts` plus the `create` method
// permission. Nothing here grants a new permission, and the schedule step
// defers to the same `view_financial` gate the standalone schedule route uses.
// ---------------------------------------------------------------------------
router.post("/contracts/generate", route(async (req, res) => {
  const body = req.body || {};
  const hasSelectedTemplate = body.template_document_id !== undefined && body.template_document_id !== null && body.template_document_id !== "";
  if (hasSelectedTemplate && !can(req.access, "access_documents")) {
    throw new HttpError(403, "using a contract template requires Documents access");
  }
  // Pricing is the server's. A final_price / discount_amount / value in the body
  // is simply never read: validateContract derives them from original_price +
  // discount_pct, exactly as the plain create route does.
  const data = await validateContract(body);

  // --- Agreement duration -------------------------------------------------
  // Start/end dates and the duration are cross-checked rather than trusted, so
  // contradictory input is refused instead of stored as a lie.
  const durationUnit = body.agreement_duration_unit ? String(body.agreement_duration_unit).toLowerCase() : "months";
  if (durationUnit && !["days", "weeks", "months", "years"].includes(durationUnit)) {
    throw new HttpError(400, "agreement_duration_unit must be days, weeks, months or years");
  }
  const duration = body.agreement_duration === undefined || body.agreement_duration === null || body.agreement_duration === ""
    ? null
    : Number(body.agreement_duration);
  if (duration === null || !Number.isInteger(duration) || duration < 1 || duration > 1200) {
    throw new HttpError(400, "agreement_duration must be a whole number between 1 and 1200");
  }
  if (!data.property_id) throw new HttpError(400, "property_id is required to generate a contract");
  if (!data.start_date) throw new HttpError(400, "start_date is required when an agreement duration is given");
  {
    const derived = addMonths(data.start_date, duration, durationUnit);
    // Only fill in an end date the caller did not state. A stated end date that
    // disagrees with the stated duration is a contradiction and is refused.
    if (!data.end_date) data.end_date = derived;
    else if (data.end_date !== derived) {
      throw new HttpError(400, `end_date does not match ${duration} ${durationUnit} from start_date`);
    }
  }
  const contractDate = body.contract_date === undefined || body.contract_date === null || body.contract_date === ""
    ? await todayDate()
    : optionalDate(body.contract_date, "contract_date");

  // --- Payment plan -------------------------------------------------------
  // Optional. With no plan fields the contract is simply created without a
  // schedule, which is a normal thing for Sales to do.
  const wantsPlan = Boolean(body.deposit || body.installments || body.first_due_date);
  const plan = wantsPlan ? validateSchedule(body) : null;
  if (plan && !(data.value > 0)) throw new HttpError(400, "the final price must be greater than 0 to build a payment plan");
  if (plan && plan.deposit >= data.value) throw new HttpError(400, "deposit must be less than the final price");

  // --- Template -----------------------------------------------------------
  // A template is a document of category 'template'. With none chosen the
  // built-in agreement is used, so generating a contract is always possible.
  let templateId = null;
  let templateBody = DEFAULT_CONTRACT_TEMPLATE;
  let templateTitle = "Sale Agreement";
  if (hasSelectedTemplate) {
    templateId = parseId(body.template_document_id, "template_document_id");
    const template = requireRecord(await Document.get(templateId), "Template");
    if (String(template.category) !== "template") throw new HttpError(400, "the selected document is not a contract template");
    if (!String(template.body_text || "").trim()) throw new HttpError(400, "the selected template has no body text");
    templateBody = String(template.body_text);
    templateTitle = template.title || "Sale Agreement";
  }
  const unknownTemplateTokens = unknownPlaceholders(templateBody);
  if (unknownTemplateTokens.length) {
    throw new HttpError(400, `the selected template has unknown placeholder(s): ${unknownTemplateTokens.join(", ")}`);
  }

  // --- Create the contract through the existing model ----------------------
  const created = await Contract.create({
    ...data,
    contract_date: contractDate,
    agreement_duration: duration,
    agreement_duration_unit: durationUnit,
    payment_frequency: plan ? plan.frequency : null,
    deposit_amount: plan ? plan.deposit : null,
    installment_count: plan ? plan.installments : null,
    first_due_date: plan ? plan.firstDueDate : null,
  });
  const contract = await Contract.get(created.id);

  // --- Generate the FULL document -----------------------------------------
  const org = await queryOne("SELECT name FROM organizations WHERE id=$1", [await organizationId()]);
  const project = requireRecord(await Project.get(data.project_id), "Project");
  const property = data.property_id ? requireRecord(await Property.get(data.property_id), "Property") : null;
  const client = data.client_id ? await Client.get(data.client_id) : null;
  const values = buildContractValues({
    contract,
    project,
    property,
    client,
    // The company identity is read from the organization row, never hardcoded.
    companyName: org?.name || "",
    plan: plan || {},
  });
  const renderedContractText = renderContractDocument(templateBody, values);
  const file = await produceContractDocument({ templateBody, values, title: templateTitle, contractNumber: contract.contract_number });
  const documentRow = await Document.create({
    project_id: contract.project_id,
    contract_id: contract.id,
    client_id: contract.client_id,
    title: templateTitle,
    category: "agreement",
    status: "pending",
    notes: `Generated from contract ${contract.contract_number}`,
    original_filename: file.original_filename,
    stored_name: file.stored_name,
    file_size: file.file_size,
    mime_type: file.mime_type,
    uploaded_at: new Date().toISOString().slice(0, 19).replace("T", " "),
  });
  await query("UPDATE documents SET body_text=$1 WHERE id=$2 AND organization_id=$3", [renderedContractText, documentRow.id, await organizationId()]);
  // The contract points at the document it generated, which is what the contract
  // screen's Documents section and its Open/Download actions read.
  await query("UPDATE contracts SET generated_document_id=$1, template_document_id=$2 WHERE id=$3", [documentRow.id, templateId, contract.id]);

  // --- Payment schedule, only with financial authority ---------------------
  // Creating installments is a financial act. A caller without
  // `view_financial` gets a contract and a document, never a schedule - the
  // same refusal the standalone schedule route gives, not a new one.
  let schedule = { created: 0, debts: [], skipped: null };
  if (plan) {
    if (!can(req.access, "view_financial")) {
      schedule.skipped = "this account may not create the payment plan; the contract and its document were still generated";
    } else {
      const rows = buildSchedule(contract, { deposit: plan.deposit, installments: plan.installments, firstDueDate: plan.firstDueDate, monthsPerStep: monthsPerFrequency(plan.frequency) });
      // Installments inherit the contract's ownership, so a sales-owned contract
      // never silently hands its schedule to whoever generated it.
      const inherited = { owner_id: contract.owner_id ?? null, created_by: contract.created_by ?? null, department_id: contract.department_id ?? null, visibility: contract.visibility || "organization" };
      const createdIds = [];
      for (const row of rows) {
        const debt = await queryOne("INSERT INTO debts (organization_id,contract_id,client_name,amount,due_date,status,notes,owner_id,created_by,department_id,visibility) VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10) RETURNING id", [await organizationId(), contract.id, contract.client_name, row.amount, row.due_date, row.label, inherited.owner_id, inherited.created_by, inherited.department_id, inherited.visibility]);
        createdIds.push(debt.id);
      }
      for (let index = 0; index < createdIds.length; index += 1) {
        await syncDebtReminder(createdIds[index], rows[index].due_date, "pending");
      }
      schedule = { created: createdIds.length, debts: await Promise.all(createdIds.map((debtId) => Debt.get(debtId))), skipped: null };
    }
  }

  await audit(req, "generated", "contract", contract.id, {
    contract_number: contract.contract_number,
    final_price: String(contract.value),
    document_id: documentRow.id,
    installments: schedule.created,
  });

  res.status(201).json({
    contract: contractResponse(await Contract.get(contract.id), req),
    pricing: {
      original_price: String(contract.original_price),
      discount_pct: String(contract.discount_pct),
      discount_amount: String(contract.discount_amount),
      final_price: String(contract.value),
    },
    document: documentResponse(await Document.get(documentRow.id)),
    template: templateId ? { id: templateId, title: templateTitle } : { id: null, title: "Built-in Sale Agreement" },
    placeholders: { used: placeholdersUsed(templateBody), unknown: unknownPlaceholders(templateBody) },
    schedule,
  });
}));

// Contract templates are documents of category 'template'. They are SHARED:
// every caller who may use documents may use every template, which is why the
// list is deliberately not filtered by who uploaded it. Management follows the
// existing document RBAC - there is no separate template permission system.
router.get("/contract-templates", route(async (req, res) => {
  if (!can(req.access, "access_documents")) throw new HttpError(403, "permission denied");
  const templates = (await query(
    `SELECT d.id, d.title, d.body_text, d.category, d.original_filename, d.stored_name, d.created_at, d.uploaded_at,
        (SELECT COUNT(*)::int FROM contracts c WHERE c.template_document_id = d.id) AS used_by
       FROM documents d
      WHERE d.organization_id=$1 AND d.category='template'
      ORDER BY d.title`,
    [await organizationId()],
  )).rows;
  res.json(templates.map((template) => ({
    ...template,
    has_file: Boolean(template.stored_name),
    placeholders: placeholdersUsed(template.body_text),
    unknown: unknownPlaceholders(template.body_text),
  })));
}));

router.post("/contract-templates", route(async (req, res) => {
  if (!can(req.access, "access_documents")) throw new HttpError(403, "permission denied");
  if (!can(req.access, "create")) throw new HttpError(403, "creating a template requires the create permission");
  const title = requiredText(req.body?.title, "title", 160);
  const bodyText = requiredText(req.body?.body_text, "body_text", 100000);
  // A typo'd placeholder would render literally onto a customer's signed copy,
  // so it is reported now rather than discovered later.
  const unknown = unknownPlaceholders(bodyText);
  if (unknown.length) throw new HttpError(400, `unknown placeholder(s): ${unknown.join(", ")}`);
  const created = await queryOne(
    "INSERT INTO documents (organization_id,title,category,status,notes,body_text) VALUES ($1,$2,'template','approved',$3,$4) RETURNING id",
    [await organizationId(), title, `Template using: ${placeholdersUsed(bodyText).join(", ") || "no placeholders"}`, bodyText],
  );
  await audit(req, "created", "contract_template", created.id, { title });
  res.status(201).json({ id: created.id, title, category: "template", placeholders: placeholdersUsed(bodyText), unknown });
}));

router.put("/contract-templates/:id", route(async (req, res) => {
  if (!can(req.access, "access_documents")) throw new HttpError(403, "permission denied");
  if (!can(req.access, "edit")) throw new HttpError(403, "editing a template requires the edit permission");
  const id = parseId(req.params.id);
  const template = requireRecord(await Document.get(id), "Template");
  if (String(template.category) !== "template") throw new HttpError(400, "that document is not a contract template");
  const bodyText = req.body?.body_text === undefined ? template.body_text : requiredText(req.body.body_text, "body_text", 100000);
  const title = req.body?.title === undefined ? template.title : requiredText(req.body.title, "title", 160);
  const unknown = unknownPlaceholders(bodyText);
  if (unknown.length) throw new HttpError(400, `unknown placeholder(s): ${unknown.join(", ")}`);
  const updated = await queryOne("UPDATE documents SET title=$1, body_text=$2 WHERE id=$3 RETURNING id", [title, bodyText, id]);
  await audit(req, "updated", "contract_template", updated.id, { title });
  res.json({ id: updated.id, title, placeholders: placeholdersUsed(bodyText), unknown });
}));

router.delete("/contract-templates/:id", route(async (req, res) => {
  if (!can(req.access, "access_documents")) throw new HttpError(403, "permission denied");
  if (!can(req.access, "delete")) throw new HttpError(403, "deleting a template requires the delete permission");
  const id = parseId(req.params.id);
  const template = requireRecord(await Document.get(id), "Template");
  if (String(template.category) !== "template") throw new HttpError(400, "that document is not a contract template");
  // A template a contract was generated from is history, not clutter: refuse
  // rather than orphan a contract's reference to a document that no longer exists.
  const inUse = Number((await queryOne("SELECT COUNT(*) AS n FROM contracts WHERE template_document_id=$1", [id])).n);
  if (inUse > 0) throw new HttpError(409, `this template was used to generate ${inUse} contract(s) and cannot be deleted`);
  await query("DELETE FROM documents WHERE id=$1", [id]);
  await audit(req, "deleted", "contract_template", id, {});
  res.json({ ok: true });
}));

// The placeholder vocabulary, so the template editor and the Generate Contract
// form are driven by the same list the renderer actually understands.
router.get("/contracts/:id/document-content", route(async (req, res) => {
  if (!can(req.access, "access_documents")) throw new HttpError(403, "Documents access is required to view the generated contract");
  const contract = requireRecord(await Contract.get(parseId(req.params.id)), "Contract");
  if (!contract.generated_document_id) throw new HttpError(404, "This contract has no generated document");
  const document = requireRecord(await Document.get(contract.generated_document_id), "Generated document");
  if (Number(document.contract_id) !== Number(contract.id) || document.category !== "agreement") throw new HttpError(404, "The generated document is not linked to this contract");

  let bodyText = document.body_text;
  if (!bodyText) {
    let templateBody = DEFAULT_CONTRACT_TEMPLATE;
    if (contract.template_document_id) {
      const template = await Document.get(contract.template_document_id);
      if (template?.category === "template" && template.body_text) templateBody = template.body_text;
    }
    const organization = await queryOne("SELECT name FROM organizations WHERE id=$1", [await organizationId()]);
    const project = requireRecord(await Project.get(contract.project_id), "Project");
    const property = contract.property_id ? requireRecord(await Property.get(contract.property_id), "Property") : null;
    const client = contract.client_id ? await Client.get(contract.client_id) : null;
    bodyText = renderContractDocument(templateBody, buildContractValues({ contract, project, property, client, companyName: organization?.name || "MKUYU" }));
  }
  res.json({ contract_id: contract.id, document_id: document.id, title: document.title, original_filename: document.original_filename, body_text: bodyText, can_edit: can(req.access, "edit") });
}));

router.put("/contracts/:id/document-content", route(async (req, res) => {
  if (!can(req.access, "access_documents")) throw new HttpError(403, "Documents access is required to edit the generated contract");
  if (!can(req.access, "edit")) throw new HttpError(403, "edit permission is required to revise the generated contract");
  const contract = requireRecord(await Contract.get(parseId(req.params.id)), "Contract");
  if (!contract.generated_document_id) throw new HttpError(404, "This contract has no generated document");
  const document = requireRecord(await Document.get(contract.generated_document_id), "Generated document");
  if (Number(document.contract_id) !== Number(contract.id) || document.category !== "agreement") throw new HttpError(404, "The generated document is not linked to this contract");
  const bodyText = requiredText(req.body?.body_text, "body_text", 100000);
  if (/\{\{\s*[A-Z0-9_]+\s*\}\}/.test(bodyText)) throw new HttpError(400, "replace every unresolved {{PLACEHOLDER}} before saving the contract");

  const file = await produceContractDocument({ templateBody: bodyText, values: {}, title: document.title || "Sale Agreement", contractNumber: contract.contract_number });
  try {
    const updated = await query(
      `UPDATE documents SET body_text=$1,original_filename=$2,stored_name=$3,file_size=$4,mime_type=$5,uploaded_at=NOW()
        WHERE id=$6 AND organization_id=$7 AND contract_id=$8 AND category='agreement'`,
      [bodyText, file.original_filename, file.stored_name, file.file_size, file.mime_type, document.id, await organizationId(), contract.id],
    );
    if (!updated.rowCount) throw new HttpError(404, "The generated document is no longer available");
  } catch (error) {
    removeStoredFile(documentUploadsDir, file.stored_name);
    throw error;
  }
  if (document.stored_name && document.stored_name !== file.stored_name) removeStoredFile(documentUploadsDir, document.stored_name);
  await audit(req, "updated", "contract_document", document.id, { contract_id: contract.id, replaced_file: true });
  res.json(documentResponse(await Document.get(document.id)));
}));

router.get("/contract-placeholders", route(async (req, res) => { res.json(CONTRACT_PLACEHOLDERS); }));

router.post("/contracts", route(async (req, res) => {
  const data = await validateContract(req.body || {});
  const result = await Contract.create(data);
  res.status(201).json(contractResponse(await Contract.get(result.id), req));
}));
router.put("/contracts/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const current = requireRecord(await Contract.get(id), "Contract");
  // The lifecycle is owned by Legal, so an edit that tries to change the status
  // is refused outright rather than silently ignored.
  if (req.body?.status && req.body.status !== current.status) {
    throw new HttpError(409, "a contract changes status through the workflow, not by editing it");
  }
  const data = await validateContract(req.body || {}, current);
  await Contract.update(id, data);
  res.json(contractResponse(await Contract.get(id), req));
}));
// Only Legal (or the administrator) may destroy a contract record. Everyone else
// cancels it through the workflow so the revision trail survives.
router.delete("/contracts/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const contract = requireRecord(await Contract.get(id), "Contract");
  const legalOwner = can(req.access, "approve_legal");
  if (!legalOwner) {
    throw new HttpError(403, "only Legal or an administrator may delete a contract record; cancel it instead");
  }
  await Contract.remove(id);
  await audit(req, "deleted", "contract", id, { contract_number: contract.contract_number });
  res.json({ ok: true });
}));

// Generate an optional payment schedule (deposit + equal monthly installments).
// Installments are financial records, so this also needs `view_financial` even
// though the route itself lives under /contracts.
router.post("/contracts/:id/schedule", route(async (req, res) => {
  if (!can(req.access, "view_financial")) throw new HttpError(403, "creating a payment schedule requires the view_financial permission");
  const id = parseId(req.params.id);
  const contract = requireRecord(await Contract.get(id), "Contract");
  const { installments, deposit, firstDueDate, frequency } = validateSchedule(req.body || {});
  if (!(contract.value > 0)) throw new HttpError(400, "contract value must be greater than 0");
  if (deposit >= contract.value) throw new HttpError(400, "deposit must be less than the contract value");
  const replaceRequested = req.body?.replace === true || req.body?.replace === "true";
  const orgId = await organizationId();
  const existing = Number((await queryOne("SELECT COUNT(*) AS count FROM debts WHERE contract_id=$1 AND organization_id=$2", [id, orgId])).count);
  if (existing > 0 && !replaceRequested) {
    throw new HttpError(409, "contract already has installments; set replace=true to regenerate");
  }
  // Replacing drops the old installments, so refuse when any current installment
  // already has recorded payments — deleting them would orphan payment history.
  if (replaceRequested && existing > 0) {
    const withPayments = Number((await queryOne("SELECT EXISTS(SELECT 1 FROM debts d JOIN payments p ON p.debt_id=d.id WHERE d.contract_id=$1 AND d.organization_id=$2) AS count", [id, orgId])).count);
    if (withPayments > 0) {
      throw new HttpError(409, "cannot replace the schedule: some installments already have recorded payments");
    }
  }
  const rows = buildSchedule(contract, { deposit, installments, firstDueDate, monthsPerStep: monthsPerFrequency(frequency) });
  const createdIds = [];
  // Installments inherit the contract's ownership, so a sales-owned contract
  // never silently hands its payment schedule to the creator of the schedule.
  const inherited = { owner_id: contract.owner_id ?? null, created_by: contract.created_by ?? null, department_id: contract.department_id ?? null, visibility: contract.visibility || "organization" };
  if (existing > 0) await query("DELETE FROM debts WHERE contract_id=$1 AND organization_id=$2", [id, orgId]);
  for (const row of rows) {
    const result = await queryOne("INSERT INTO debts (organization_id,contract_id,client_name,amount,due_date,status,notes,owner_id,created_by,department_id,visibility) VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10) RETURNING id", [orgId, id, contract.client_name, row.amount, row.due_date, row.label, inherited.owner_id, inherited.created_by, inherited.department_id, inherited.visibility]);
    createdIds.push(result.id);
  }
  for (const debtId of createdIds) await syncDebtReminder(debtId, rows[createdIds.indexOf(debtId)].due_date, "pending");
  res.status(201).json({ created: createdIds.length, debts: await Promise.all(createdIds.map((debtId) => Debt.get(debtId))) });
}));

router.get("/debts/overdue", route(async (req, res) => res.json(await Debt.overdue())));
router.get("/debts/upcoming", route(async (req, res) => {
  const days = req.query.days === undefined ? 7 : Number(req.query.days);
  if (!Number.isInteger(days) || days < 0 || days > 365) throw new HttpError(400, "days must be an integer between 0 and 365");
  res.json(await Debt.upcoming(days));
}));
router.get("/debts", route(async (req, res) => {
  const status = req.query.status || null;
  const projectId = req.query.project_id === undefined ? null : parseId(req.query.project_id, "project_id");
  if (status && !debtStatuses.has(status)) throw new HttpError(400, "status is invalid");
  if (!paginationRequested(req.query)) return res.json(await Debt.all(status, projectId));
  const paged = await paginatedList({ build: () => Debt.paged(status, projectId, searchTerm(req.query.search)), ...parsePagination(req.query) });
  res.json({ data: paged.rows, pagination: paged.pagination });
}));
router.get("/debts/:id", route(async (req, res) => res.json(requireRecord(await Debt.get(parseId(req.params.id)), "Debt"))));
router.post("/debts", route(async (req, res) => {
  const data = validateDebt(req.body || {});
  const result = await Debt.create(data);
  const id = result.id;
  await syncDebtReminder(id, data.due_date, data.status || "pending");
  res.status(201).json(await Debt.get(id));
}));
router.put("/debts/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const current = requireRecord(await Debt.get(id), "Debt");
  const data = validateDebt(req.body || {}, current);
  await Debt.update(id, data);
  await syncDebtReminder(id, data.due_date, data.status || "pending");
  res.json(await Debt.get(id));
}));
router.post("/debts/:id/pay", route(async (req, res) => {
  const id = parseId(req.params.id);
  const current = requireRecord(await Debt.get(id), "Debt");
  await Debt.markPaid(id);
  await syncDebtReminder(id, current.due_date, "paid");
  res.json(await Debt.get(id));
}));
router.delete("/debts/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  requireRecord(await Debt.get(id), "Debt");
  await Debt.remove(id);
  res.json({ ok: true });
}));

router.get("/payments", route(async (req, res) => {
  const projectId = req.query.project_id === undefined ? null : parseId(req.query.project_id, "project_id");
  const contractId = req.query.contract_id === undefined ? null : parseId(req.query.contract_id, "contract_id");
  const method = req.query.method || null;
  if (method && !paymentMethods.has(method)) throw new HttpError(400, "method is invalid");
  const from = optionalDate(req.query.from, "from");
  const to = optionalDate(req.query.to, "to");
  if (from && to && from > to) throw new HttpError(400, "from cannot be after to");
  if (!paginationRequested(req.query)) return res.json((await Payment.all({ projectId, contractId, method, from, to })).map(paymentResponse));
  const paged = await paginatedList({ build: () => Payment.paged({ projectId, contractId, method, from, to, search: searchTerm(req.query.search) }), ...parsePagination(req.query) });
  res.json({ data: paged.rows.map(paymentResponse), pagination: paged.pagination });
}));
router.get("/payments/:id", route(async (req, res) => res.json(paymentResponse(requireRecord(await Payment.get(parseId(req.params.id)), "Payment")))));
router.post("/payments", route(async (req, res) => {
  const data = await validatePayment(req.body || {});
  if (data.debt_id) requireRecord(await Debt.get(data.debt_id), "Debt");
  const result = await Payment.create(data);
  await Payment.syncInstallment(data.debt_id);
  await syncDebtReminderFromDb(data.debt_id);
  res.status(201).json(paymentResponse(await Payment.get(result.id)));
}));
// Create a payment with an optional receipt file in one request.
router.post("/payments/upload", uploadDocumentFile, route(async (req, res) => {
  let paymentId = null;
  try {
    const data = await validatePayment(req.body || {});
    if (data.debt_id) requireRecord(await Debt.get(data.debt_id), "Debt");
    const fileInfo = req.file ? validateUploadedFile(req.file, documentExtensions) : null;
    const contract = fileInfo ? requireRecord(await Contract.get(data.contract_id), "Contract") : null;
    const orgId = await organizationId();
    await withTransaction(async (client) => {
      const payment = await client.query(
        "INSERT INTO payments (organization_id,contract_id,debt_id,client_name,amount,paid_at,method,reference,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
        [orgId, data.contract_id, data.debt_id || null, data.client_name, data.amount, data.paid_at, data.method || "cash", data.reference || null, data.notes || null],
      );
      paymentId = payment.rows[0].id;
      if (fileInfo) {
        const document = await client.query(
          "INSERT INTO documents (organization_id,project_id,contract_id,client_id,title,category,status,notes,original_filename,stored_name,file_size,mime_type,uploaded_at) VALUES ($1,$2,$3,NULL,$4,'receipt','approved',$5,$6,$7,$8,$9,$10) RETURNING id",
          [orgId, contract.project_id || null, contract.id, `Receipt · ${contract.client_name} · ${data.paid_at}`, data.reference || null, fileInfo.displayName, fileInfo.storedName, fileInfo.size, fileInfo.mimeType, new Date().toISOString()],
        );
        await client.query("UPDATE payments SET receipt_document_id=$1 WHERE id=$2", [document.rows[0].id, paymentId]);
      }
    });
    await Payment.syncInstallment(data.debt_id);
    await syncDebtReminderFromDb(data.debt_id);
  } catch (error) {
    cleanupUploadedFile(req.file);
    throw error;
  }
  res.status(201).json(paymentResponse(await Payment.get(paymentId)));
}));
router.put("/payments/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const current = requireRecord(await Payment.get(id), "Payment");
  const data = await validatePayment(req.body || {}, current);
  if (data.debt_id && data.debt_id !== current.debt_id) requireRecord(await Debt.get(data.debt_id), "Debt");
  await Payment.update(id, data);
  await resyncInstallmentState([current.debt_id, data.debt_id]);
  res.json(paymentResponse(await Payment.get(id)));
}));
// Attach or replace a receipt on an existing payment.
router.post("/payments/:id/receipt", uploadDocumentFile, route(async (req, res) => {
  const id = parseId(req.params.id);
  const payment = requireRecord(await Payment.get(id), "Payment");
  try {
    const fileInfo = validateUploadedFile(req.file, documentExtensions);
    const contract = requireRecord(await Contract.get(payment.contract_id), "Contract");
    const previous = payment.receipt_document_id ? await Document.get(payment.receipt_document_id) : null;
    const orgId = await organizationId();
    let newDocumentId;
    await withTransaction(async (client) => {
      // The receipt is a financial record: it inherits the payment's ownership.
      const receipt = ownershipFields(req.access);
      const document = await client.query(
        "INSERT INTO documents (organization_id,project_id,contract_id,client_id,title,category,status,notes,original_filename,stored_name,file_size,mime_type,uploaded_at,owner_id,created_by,department_id,visibility) VALUES ($1,$2,$3,NULL,$4,'receipt','approved',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id",
        [orgId, contract.project_id || null, contract.id, `Receipt · ${contract.client_name} · ${payment.paid_at}`, payment.reference || null, fileInfo.displayName, fileInfo.storedName, fileInfo.size, fileInfo.mimeType, new Date().toISOString(), payment.owner_id ?? receipt.owner_id, payment.created_by ?? receipt.created_by, payment.department_id ?? receipt.department_id, payment.visibility || receipt.visibility],
      );
      newDocumentId = document.rows[0].id;
      await client.query("UPDATE payments SET receipt_document_id=$1 WHERE id=$2", [newDocumentId, id]);
      if (previous) await client.query("DELETE FROM documents WHERE id=$1", [previous.id]);
    });
    if (previous) removeStoredFile(documentUploadsDir, previous.stored_name);
  } catch (error) {
    cleanupUploadedFile(req.file);
    throw error;
  }
  res.json(paymentResponse(await Payment.get(id)));
}));
router.get("/payments/:id/receipt", route(async (req, res) => {
  const payment = requireRecord(await Payment.get(parseId(req.params.id)), "Payment");
  if (!payment.receipt_stored_name) throw new HttpError(404, "No receipt is attached to this payment");
  const fullPath = resolveStoredFile(documentUploadsDir, payment.receipt_stored_name);
  if (!fullPath) throw new HttpError(404, "Receipt file not found");
  return sendStoredFile(res, fullPath, payment.receipt_mime_type || null, payment.receipt_filename || payment.receipt_stored_name, req.query.download === "1");
}));
router.delete("/payments/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const payment = requireRecord(await Payment.get(id), "Payment");
  let document = null;
  await withTransaction(async (client) => {
    await client.query("DELETE FROM payments WHERE id=$1", [id]);
    if (payment.receipt_document_id) {
      const result = await client.query("DELETE FROM documents WHERE id=$1 RETURNING *", [payment.receipt_document_id]);
      document = result.rows[0] || null;
    }
  });
  await resyncInstallmentState([payment.debt_id]);
  if (document) removeStoredFile(documentUploadsDir, document.stored_name);
  res.json({ ok: true });
}));

router.get("/reminders", route(async (req, res) => res.json(await Reminder.due())));
router.get("/reminders/upcoming", route(async (req, res) => {
  const days = req.query.days === undefined ? 30 : Number(req.query.days);
  if (!Number.isInteger(days) || days < 0 || days > 365) throw new HttpError(400, "days must be an integer between 0 and 365");
  res.json(await Reminder.upcoming(days));
}));
router.post("/reminders/:id/acknowledge", route(async (req, res) => {
  const id = parseId(req.params.id);
  const result = await Reminder.acknowledge(id);
  if (!result.rowCount) throw new HttpError(404, "Reminder not found");
  res.json({ ok: true });
}));

// ---- Backups in data/backups ----------------------------------------------
// Preferred format is a PostgreSQL custom dump. When `pg_dump` is not installed
// (common on managed/shared hosting and on Windows without the PostgreSQL tools)
// the backup falls back to a self-contained JSON snapshot so the feature keeps
// working instead of failing with a 500.

const BACKUP_EXTENSIONS = [".dump", ".json"];
const backupNamePattern = /^system-[\w-]+\.(dump|json)$/;

function listBackups() {
  if (!fs.existsSync(backupsDir)) return [];
  return fs.readdirSync(backupsDir)
    .filter((name) => BACKUP_EXTENSIONS.some((extension) => name.endsWith(extension)))
    .map((name) => {
      const stats = fs.statSync(path.join(backupsDir, name));
      return { name, size: stats.size, format: name.endsWith(".json") ? "json" : "pgdump", created_at: stats.mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// Tables captured by the portable snapshot. `org: false` marks the global and
// join tables, which have no organization_id column.
const SNAPSHOT_TABLES = [
  { table: "organizations", org: false },
  { table: "permissions", org: false },
  { table: "departments" }, { table: "roles" }, { table: "users" },
  { table: "user_roles", org: false }, { table: "user_departments", org: false }, { table: "role_permissions", org: false },
  { table: "projects" }, { table: "clients" }, { table: "contracts" }, { table: "properties" },
  { table: "appointments" }, { table: "documents" }, { table: "debts" }, { table: "reminders" },
  { table: "payments" }, { table: "reports" }, { table: "leads" }, { table: "follow_ups" },
  { table: "approvals" }, { table: "record_shares" }, { table: "property_history" }, { table: "settings" },
  // Task-assignment workflow, so a portable snapshot carries the assignment
  // history and its review comments. task_comments has no organization_id, so
  // it is captured through its task.
  { table: "tasks" }, { table: "task_comments", org: false, via: "tasks" },
];

async function writeJsonSnapshot(stamp) {
  const name = `system-${stamp}.json`;
  const target = path.join(backupsDir, name);
  const org = await organizationId();
  const data = {};
  for (const { table, org: scoped = true, via } of SNAPSHOT_TABLES) {
    // Global tables are small by definition; organization tables are filtered.
    // `via` captures a child table through its parent's ids, because the child
    // carries no organization column of its own.
    const result = via
      ? await query(`SELECT c.* FROM ${table} c WHERE c.${via.replace(/s$/, "")}_id IN (SELECT id FROM ${via} WHERE organization_id = $1)`, [org])
      : scoped
        ? await query(`SELECT * FROM ${table} WHERE organization_id = $1`, [org])
        : await query(`SELECT * FROM ${table}`);
    data[table] = result.rows;
  }
  const payload = { format: "mkuyu-json-snapshot", version: 1, created_at: new Date().toISOString(), organization_id: org, data };
  fs.writeFileSync(target, JSON.stringify(payload), "utf8");
  return name;
}

router.get("/backups", requireAdmin(), route((req, res) => res.json(listBackups())));
router.post("/backups", requireAdmin(), route(async (req, res) => {
  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = `system-${stamp}.dump`;
  const pgDumpPath = process.env.PG_DUMP_PATH || "pg_dump";
  let created;
  try {
    await execFileAsync(pgDumpPath, ["--format=custom", `--file=${path.join(backupsDir, name)}`, DATABASE_URL]);
    created = name;
  } catch (error) {
    // No pg_dump (or it failed): fall back to a portable JSON snapshot rather
    // than leaving the administrator with a broken backup button.
    console.warn(`pg_dump unavailable (${error.code || error.message}); writing JSON snapshot instead`);
    try { fs.unlinkSync(path.join(backupsDir, name)); } catch { /* nothing written */ }
    created = await writeJsonSnapshot(stamp);
  }
  res.status(201).json(listBackups().find((entry) => entry.name === created));
}));
router.get("/backups/:name/download", requireAdmin(), route((req, res) => {
  const name = path.basename(String(req.params.name || ""));
  if (!backupNamePattern.test(name)) throw new HttpError(400, "invalid backup name");
  const fullPath = resolveStoredFile(backupsDir, name);
  if (!fullPath) throw new HttpError(404, "Backup not found");
  return sendStoredFile(res, fullPath, name.endsWith(".json") ? "application/json" : "application/octet-stream", name, true);
}));
router.delete("/backups/:name", requireAdmin(), route((req, res) => {
  const name = path.basename(String(req.params.name || ""));
  if (!backupNamePattern.test(name)) throw new HttpError(400, "invalid backup name");
  const fullPath = resolveStoredFile(backupsDir, name);
  if (!fullPath) throw new HttpError(404, "Backup not found");
  fs.unlinkSync(fullPath);
  res.json({ ok: true });
}));

router.get("/properties", route(async (req, res) => {
  const projectId = req.query.project_id === undefined ? null : parseId(req.query.project_id, "project_id");
  const status = req.query.status || null;
  if (status && !propertyStatuses.has(status)) throw new HttpError(400, "status is invalid");
  if (!paginationRequested(req.query)) return res.json(await Property.all(projectId, status));
  const paged = await paginatedList({ build: () => Property.paged(projectId, status, searchTerm(req.query.search)), ...parsePagination(req.query) });
  res.json({ data: paged.rows, pagination: paged.pagination });
}));
router.get("/properties/:id", route(async (req, res) => res.json(requireRecord(await Property.get(parseId(req.params.id)), "Property"))));
router.post("/properties", route(async (req, res) => {
  const data = validateProperty(req.body || {});
  const result = await Property.create(data);
  const propertyId = result.id;
  await recordPropertyHistory(propertyId, req.user.id, "created", { status: data.status, price: data.price });
  res.status(201).json(await Property.get(propertyId));
}));
router.put("/properties/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const current = requireRecord(await Property.get(id), "Property");
  const data = validateProperty(req.body || {}, current);
  await Property.update(id, data);
  if (current.status !== data.status) await recordPropertyHistory(id, req.user.id, "status_changed", { from: current.status, to: data.status });
  if (Number(current.price) !== Number(data.price)) await recordPropertyHistory(id, req.user.id, "price_changed", { from: current.price, to: data.price });
  res.json(await Property.get(id));
}));
router.delete("/properties/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  requireRecord(await Property.get(id), "Property");
  await recordPropertyHistory(id, req.user.id, "deleted");
  // Gallery rows cascade with the property; remove their files too.
  const images = await PropertyImage.listFor(id);
  await Property.remove(id);
  images.forEach((image) => removeStoredFile(propertyUploadsDir, image.stored_name));
  res.json({ ok: true });
}));

// Optional property picture gallery — properties never require pictures.
router.get("/properties/:id/images", route(async (req, res) => {
  const propertyId = parseId(req.params.id);
  requireRecord(await Property.get(propertyId), "Property");
  res.json((await PropertyImage.listFor(propertyId)).map((image) => ({
    ...image,
    // `available` is resolved against the filesystem, so the client can skip a
    // picture whose file is gone instead of firing a request that can only 404.
    // The record itself is still returned: it exists, and an administrator needs
    // to be able to see and remove it.
    available: storedFileExists(propertyUploadsDir, image.stored_name),
    file_url: `/api/v1/properties/${propertyId}/images/${image.id}/file`,
  })));
}));
router.post("/properties/:id/images", uploadPropertyImageFile, route(async (req, res) => {
  const propertyId = parseId(req.params.id);
  try {
    requireRecord(await Property.get(propertyId), "Property");
    if (await PropertyImage.countFor(propertyId) >= MAX_PROPERTY_IMAGES) {
      throw new HttpError(409, `A property can have at most ${MAX_PROPERTY_IMAGES} pictures`);
    }
    const fileInfo = validateUploadedFile(req.file, propertyImageExtensions);
    const result = await PropertyImage.create(propertyId, {
      original_filename: fileInfo.displayName,
      stored_name: fileInfo.storedName,
      file_size: fileInfo.size,
      mime_type: fileInfo.mimeType,
    });
    const image = await PropertyImage.get(propertyId, result.id);
    res.status(201).json({ ...image, file_url: `/api/v1/properties/${propertyId}/images/${image.id}/file` });
  } catch (error) {
    cleanupUploadedFile(req.file);
    throw error;
  }
}));
router.get("/properties/:id/images/:imageId/file", route(async (req, res) => {
  const propertyId = parseId(req.params.id);
  const imageId = parseId(req.params.imageId, "image_id");
  // The property lookup enforces the record scope for its gallery rows.
  requireRecord(await Property.get(propertyId), "Property");
  const image = requireRecord(await PropertyImage.get(propertyId, imageId), "Picture");
  const fullPath = resolveStoredFile(propertyUploadsDir, image.stored_name);
  if (!fullPath) throw new HttpError(404, "Picture file not found");
  return sendStoredFile(res, fullPath, image.mime_type || null, image.original_filename || image.stored_name, false);
}));
router.delete("/properties/:id/images/:imageId", route(async (req, res) => {
  const propertyId = parseId(req.params.id);
  const imageId = parseId(req.params.imageId, "image_id");
  requireRecord(await Property.get(propertyId), "Property");
  const image = requireRecord(await PropertyImage.get(propertyId, imageId), "Picture");
  await PropertyImage.remove(imageId);
  removeStoredFile(propertyUploadsDir, image.stored_name);
  res.json({ ok: true });
}));

router.get("/clients", route(async (req, res) => {
  const projectId = req.query.project_id === undefined ? null : parseId(req.query.project_id, "project_id");
  const status = req.query.status || null;
  if (status && !clientStatuses.has(status)) throw new HttpError(400, "status is invalid");
  if (!paginationRequested(req.query)) return res.json(await Client.all(projectId, status));
  const paged = await paginatedList({ build: () => Client.paged(projectId, status, searchTerm(req.query.search)), ...parsePagination(req.query) });
  res.json({ data: paged.rows, pagination: paged.pagination });
}));
router.get("/clients/:id", route(async (req, res) => res.json(requireRecord(await Client.get(parseId(req.params.id)), "Client"))));
router.post("/clients", route(async (req, res) => {
  const data = validateClient(req.body || {});
  // Completing a client in one call: the caller may pass an existing contract to
  // associate. The contract is linked to the new client, so the association is
  // recorded by the database rather than asserted by the request.
  let associatedContract = null;
  const wantedContract = requestedContractId(req.body);
  if (wantedContract) {
    associatedContract = requireRecord(await Contract.get(wantedContract), "Contract");
    if (Number(associatedContract.project_id) !== Number(data.project_id)) {
      throw new HttpError(400, "contract_id does not belong to the selected project");
    }
  }
  // A client created as a completed client needs a contract. Without one it is
  // created as a prospect instead of being refused, so the guided flow and the
  // two-step flow both work: Sales captures the person, then attaches the
  // contract and completes them.
  const completing = data.status === "active";
  if (completing && !associatedContract) {
    if (req.body?.require_contract === true) {
      throw new HttpError(400, "a client cannot be completed without a contract: create the contract for this client, or save the client as a prospect (status: lead) until the contract is signed");
    }
    data.status = "lead";
  }
  const result = await Client.create(data);
  if (associatedContract) {
    await query("UPDATE contracts SET client_id=$1 WHERE id=$2", [result.id, associatedContract.id]);
    clearAccessCache();
  }
  res.status(201).json(await Client.get(result.id));
}));
router.put("/clients/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const current = requireRecord(await Client.get(id), "Client");
  const data = validateClient(req.body || {}, current);
  // Associate the contract FIRST, so a request that supplies one and completes
  // the client in the same call is judged on the association it just made rather
  // than on the state before it.
  const wantedContract = requestedContractId(req.body);
  if (wantedContract) {
    const contract = requireRecord(await Contract.get(wantedContract), "Contract");
    await query("UPDATE contracts SET client_id=$1 WHERE id=$2", [id, contract.id]);
    clearAccessCache();
  }
  // Only a client being COMPLETED now needs a contract. Editing one that was
  // already active is not completing it, so historical records stay editable.
  if (data.status === "active" && current.status !== "active") {
    await requireContractForCompletedClient(id, data.status, current.status);
  }
  await Client.update(id, data);
  res.json(await Client.get(id));
}));
router.delete("/clients/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  requireRecord(await Client.get(id), "Client");
  await Client.remove(id);
  res.json({ ok: true });
}));

router.get("/appointments", route(async (req, res) => {
  const status = req.query.status || null;
  const projectId = req.query.project_id === undefined ? null : parseId(req.query.project_id, "project_id");
  if (status && !appointmentStatuses.has(status)) throw new HttpError(400, "status is invalid");
  if (!paginationRequested(req.query)) return res.json(await Appointment.all(status, projectId));
  const paged = await paginatedList({ build: () => Appointment.paged(status, projectId, searchTerm(req.query.search)), ...parsePagination(req.query) });
  res.json({ data: paged.rows, pagination: paged.pagination });
}));
router.get("/appointments/:id", route(async (req, res) => res.json(requireRecord(await Appointment.get(parseId(req.params.id)), "Appointment"))));
router.post("/appointments", route(async (req, res) => {
  const data = validateAppointment(req.body || {});
  const result = await Appointment.create(data);
  res.status(201).json(await Appointment.get(result.id));
}));
router.put("/appointments/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const current = requireRecord(await Appointment.get(id), "Appointment");
  const data = validateAppointment(req.body || {}, current);
  await Appointment.update(id, data);
  res.json(await Appointment.get(id));
}));
router.delete("/appointments/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  requireRecord(await Appointment.get(id), "Appointment");
  await Appointment.remove(id);
  res.json({ ok: true });
}));

router.get("/documents", route(async (req, res) => {
  const status = req.query.status || null;
  const projectId = req.query.project_id === undefined ? null : parseId(req.query.project_id, "project_id");
  if (status && !documentStatuses.has(status)) throw new HttpError(400, "status is invalid");
  if (!paginationRequested(req.query)) return res.json((await Document.all(status, projectId)).map(documentResponse));
  const paged = await paginatedList({ build: () => Document.paged(status, projectId, searchTerm(req.query.search)), ...parsePagination(req.query) });
  res.json({ data: paged.rows.map(documentResponse), pagination: paged.pagination });
}));
router.get("/documents/:id/file", route(async (req, res) => {
  const document = requireRecord(await Document.get(parseId(req.params.id)), "Document");
  const fullPath = resolveStoredFile(documentUploadsDir, document.stored_name);
  if (!fullPath) throw new HttpError(404, "No file is attached to this document");
  return sendStoredFile(res, fullPath, document.mime_type, document.original_filename || document.stored_name, req.query.download === "1");
}));
router.get("/documents/:id", route(async (req, res) => res.json(documentResponse(requireRecord(await Document.get(parseId(req.params.id)), "Document")))));
router.post("/documents", route(async (req, res) => {
  const data = validateDocument(req.body || {});
  const result = await Document.create(data);
  res.status(201).json(documentResponse(await Document.get(result.id)));
}));
router.post("/documents/upload", uploadDocumentFile, route(async (req, res) => {
  const fileInfo = validateUploadedFile(req.file, documentExtensions);
  try {
    const data = validateDocument({ ...(req.body || {}), file_reference: req.body?.file_reference || null });
    const result = await Document.create({
      ...data,
      original_filename: fileInfo.displayName,
      stored_name: fileInfo.storedName,
      file_size: fileInfo.size,
      mime_type: fileInfo.mimeType,
      uploaded_at: new Date().toISOString(),
    });
    res.status(201).json(documentResponse(await Document.get(result.id)));
  } catch (error) {
    cleanupUploadedFile(req.file);
    throw error;
  }
}));
router.put("/documents/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const current = requireRecord(await Document.get(id), "Document");
  const data = validateDocument(req.body || {}, current);
  await Document.update(id, data);
  res.json(documentResponse(await Document.get(id)));
}));
router.delete("/documents/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const current = requireRecord(await Document.get(id), "Document");
  removeStoredFile(documentUploadsDir, current.stored_name);
  await Document.remove(id);
  res.json({ ok: true });
}));

// Financial report types expose money, so they need `view_financial` on top of
// `view_reports` regardless of which endpoint was used to reach them.
function reportTypeForCaller(req, rawType) {
  const type = reportTypeId(rawType);
  if (reportTypeIsFinancial(type) && !can(req.access, "view_financial")) throw new HttpError(403, "financial reports require the view_financial permission");
  return type;
}

router.get("/reports/types", route((req, res) => {
  const financial = can(req.access, "view_financial");
  res.json({ types: REPORT_TYPES.filter((type) => financial || !reportTypeIsFinancial(type.id)), payment_methods: PAYMENT_METHODS, financial });
}));
// Report history is ALREADY bounded: `Report.history` appends its own
// `LIMIT 250` (report.js:162), so it cannot return an unbounded collection and
// does not participate in the pagination contract. Changing it here would alter
// an existing cap for no measured benefit, so the response is left exactly as
// it was. It stays opt-in-compatible for a future phase.
router.get("/reports/history", route(async (req, res) => res.json((await Report.history(historyFilters(req.query))).map(reportResponse))));
router.post("/reports/preview", route(async (req, res) => {
  const type = reportTypeForCaller(req, req.body?.report_type);
  const filters = reportFilters(type, req.body || {});
  res.json(await buildReport(type, filters));
}));
router.post("/reports/generate", route(async (req, res) => {
  const type = reportTypeForCaller(req, req.body?.report_type);
  const format = String(req.body?.format || "xlsx").toLowerCase();
  if (!EXPORT_FORMATS[format]) throw new HttpError(400, "format must be xlsx, pdf, docx or pptx");
  const filters = reportFilters(type, req.body || {});
  const payload = await buildReport(type, filters);
  const title = optionalText(req.body?.title, "title", 160) || payload.title;
  const output = await exportReport({ ...payload, title }, format);
  // Store the generated file before the DB row so a failed write never leaves a row without a file.
  const storedName = `${crypto.randomUUID()}${output.extension}`;
  const fullPath = path.join(reportUploadsDir, storedName);
  fs.mkdirSync(reportUploadsDir, { recursive: true });
  let report;
  try {
    fs.writeFileSync(fullPath, output.buffer);
    report = await Report.create({
      title,
      report_type: type,
      source: "generated",
      project_id: filters.project || parseId(req.body?.project_id, "project_id", true),
      description: payload.description,
      filters_json: JSON.stringify(filters),
      file_format: format,
      original_filename: output.fileName,
      stored_name: storedName,
      file_size: output.buffer.length,
      mime_type: output.mime,
    });
  } catch (error) {
    removeStoredFile(reportUploadsDir, storedName);
    throw error;
  }
  res.status(201).json(reportResponse(report));
}));
router.post("/reports/upload", uploadReportFile, route(async (req, res) => {
  try {
    const fileInfo = validateUploadedFile(req.file, reportExtensions);
    const type = reportTypeForCaller(req, req.body?.report_type);
    const title = requiredText(req.body?.title || fileInfo.displayName, "title", 160);
    const filters = reportFilters(type, req.body || {});
    const report = await Report.create({
      title,
      report_type: type,
      source: "uploaded",
      project_id: parseId(req.body?.project_id, "project_id", true),
      description: optionalText(req.body?.description, "description", 2000),
      filters_json: Object.keys(filters).length ? JSON.stringify(filters) : null,
      file_format: fileInfo.extension.slice(1),
      original_filename: fileInfo.displayName,
      stored_name: fileInfo.storedName,
      file_size: fileInfo.size,
      mime_type: fileInfo.mimeType,
    });
    res.status(201).json(reportResponse(report));
  } catch (error) {
    cleanupUploadedFile(req.file);
    throw error;
  }
}));
// `/reports/summary` and `/reports/by-project` back the dashboard. They stay
// open to every report reader but omit every monetary figure unless the caller
// holds `view_financial` (see Report.summary / Report.byProject).
router.get("/reports/summary", route(async (req, res) => res.json(await Report.summary())));
router.get("/reports/by-project", route(async (req, res) => res.json(await Report.byProject())));
router.get("/reports/new-contracts", route(async (req, res) => res.json(await Report.newContracts())));
router.get("/reports/terminal-contracts", route(async (req, res) => res.json(await Report.terminalContracts())));
router.get("/reports/:id/file", route(async (req, res) => {
  const report = requireRecord(await Report.get(parseId(req.params.id)), "Report");
  if (reportTypeIsFinancial(report.report_type) && !can(req.access, "view_financial")) throw new HttpError(403, "financial reports require the view_financial permission");
  const fullPath = resolveStoredFile(reportUploadsDir, report.stored_name);
  if (!fullPath) throw new HttpError(404, "No file is attached to this report");
  return sendStoredFile(res, fullPath, report.mime_type, report.original_filename || report.stored_name, req.query.download === "1");
}));
router.get("/reports/:id/export", route(async (req, res) => {
  const report = requireRecord(await Report.get(parseId(req.params.id)), "Report");
  if (reportTypeIsFinancial(report.report_type) && !can(req.access, "view_financial")) throw new HttpError(403, "financial reports require the view_financial permission");
  const format = String(req.query.format || report.file_format || "xlsx").toLowerCase();
  if (!EXPORT_FORMATS[format]) throw new HttpError(400, "format must be xlsx, pdf, docx or pptx");
  if (report.source === "uploaded") {
    const fullPath = resolveStoredFile(reportUploadsDir, report.stored_name);
    if (!fullPath) throw new HttpError(404, "No file is attached to this report");
    return sendStoredFile(res, fullPath, report.mime_type, report.original_filename || report.stored_name, true);
  }
  // `filters_json` is a JSONB column, so the driver already returns an object.
  // Accept a string too, in case a row was written by an older code path.
  let filters = {};
  const stored = report.filters_json;
  try {
    filters = typeof stored === "string" ? JSON.parse(stored) : stored || {};
  } catch (error) {
    throw new HttpError(500, "The saved report filters are invalid");
  }
  if (typeof filters !== "object" || Array.isArray(filters)) throw new HttpError(500, "The saved report filters are invalid");
  const payload = await buildReport(report.report_type, reportFilters(report.report_type, filters));
  const output = await exportReport(payload, format);
  res.setHeader("Content-Type", output.mime);
  res.setHeader("Content-Disposition", `attachment; filename="${safeDisplayFilename(output.fileName, "report").replace(/"/g, "")}"`);
  return res.send(output.buffer);
}));
router.get("/reports/:id", route(async (req, res) => res.json(reportResponse(requireRecord(await Report.get(parseId(req.params.id)), "Report")))));
router.delete("/reports/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const report = requireRecord(await Report.get(id), "Report");
  await Report.remove(id);
  removeStoredFile(reportUploadsDir, report.stored_name);
  res.json({ ok: true });
}));

router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? "internal server error" : error.message });
});

export default router;
