import { Router } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
import { CSRF_HEADER, clearSessionCookie, isProduction, loginBlocked, rateLimit, recordLoginFailure, recordLoginSuccess, setSessionCookie } from "../security.js";
import { demoPasswordFor } from "../org/demoCredentials.js";
import db, { DATABASE_URL, query, queryOne, withTransaction } from "../db.js";
import { buildReport, parseFilters } from "../reports/builders.js";
import { exportReport, EXPORT_FORMATS } from "../reports/exporters.js";
import {
  documentExtensions,
  reportExtensions,
  reportUploadsDir,
  documentUploadsDir,
  propertyUploadsDir,
  profileUploadsDir,
  propertyImageExtensions,
  backupsDir,
  uploadDocumentFile,
  uploadReportFile,
  uploadPropertyImageFile,
  uploadProfileImageFile,
  profileImageExtensions,
  validateUploadedFile,
  cleanupUploadedFile,
  safeDisplayFilename,
  resolveStoredFile,
  removeStoredFile,
  storedFileExists,
} from "../uploads.js";
import orgRoutes from "./org.js";
import publicRoutes from "./public.js";
import { audit } from "../org/audit.js";
import { requirePermissionForMethod, provisionSystemAdministrator, organizationId, requireAdmin, can as canPermission } from "../org/rbac.js";
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
  buildDocumentValues,
  builtInAgreement,
  monthsPerFrequency,
  produceContractDocument,
  renderContractDocument,
} from "../contracts/generation.js";
import { CONTRACT_PLACEHOLDERS, placeholdersUsed, unknownPlaceholders, writeContractDocx } from "../contracts/workflow.js";
import { shareContractWithHandoverDesks } from "../contracts/handover.js";
import { templateTextFromUpload } from "../contracts/docxText.js";
import { generateFromWordTemplate, templateFileUnknownPlaceholders, templateWordFile } from "../contracts/docxFill.js";
import { clearContractSignatureDocument, contractSignature, signContractDocument } from "../contracts/signature.js";
import { docxToPreview } from "../contracts/docxPreview.js";
import { announceWrites, liveStream } from "../live.js";
import { RENT_STATUSES, SALE_STATUSES, categoryStatusesFrom, overallStatus } from "../models/propertyStatus.js";

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

const CONTRACT_DEAL_TYPES = new Set(["buy", "rent", "sell"]);
// Where a letterhead template wants the agreement wording to go.
const CONTRACT_BODY_TOKEN = /\{\{\s*CONTRACT_BODY\s*\}\}/;
function contractDealType(value, required) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new HttpError(400, "choose the contract type: Buy, Rent or Sell");
    return null;
  }
  const type = String(value).trim().toLowerCase();
  if (!CONTRACT_DEAL_TYPES.has(type)) throw new HttpError(400, "contract type must be Buy, Rent or Sell");
  return type;
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
  const dealType = contractDealType(body.deal_type ?? current.deal_type, !current.id);
  // A Rent contract is about a property only: it carries no project.
  const rent = dealType === "rent";
  const data = {
    project_id: rent ? null : parseId(body.project_id ?? current.project_id, "project_id"),
    property_id: parseId(body.property_id ?? current.property_id, "property_id", true),
    client_id: parseId(body.client_id ?? current.client_id, "client_id", true),
    client_name: requiredText(body.client_name ?? current.client_name, "client_name"),
    contract_type: enumValue(body.contract_type ?? current.contract_type, contractTypes, "new", "contract_type"),
    // Buy / Rent / Sell: required on every new contract, kept on edits.
    deal_type: dealType,
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
    // The title deed / certificate of occupancy number printed on the agreement.
    title_deed_number: optionalText(body.title_deed_number ?? current.title_deed_number, "title_deed_number", 80),
    requires_management_approval: Boolean(body.requires_management_approval ?? current.requires_management_approval),
  };
  const client = data.client_id ? requireRecord(await Client.get(data.client_id), "Client") : null;
  data.client_phone = optionalText(body.client_phone || client?.phone, "client_phone", 40);
  data.client_email = validEmail(body.client_email || client?.email, "client_email");
  if (data.property_id) {
    const property = requireRecord(await Property.get(data.property_id), "Property");
    // The chain the spec describes is Customer <- Property <- Project <- Contract,
    // so a contract may not name a property that belongs to another project.
    if (data.project_id && property.project_id && Number(property.project_id) !== Number(data.project_id)) {
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

async function validateDebt(body, current = {}) {
  const contractId = parseId(body.contract_id ?? current.contract_id, "contract_id");
  requireRecord(await Contract.get(contractId), "Contract");
  return {
    contract_id: contractId,
    client_name: requiredText(body.client_name ?? current.client_name, "client_name"),
    amount: nonNegativeNumber(body.amount ?? current.amount, "amount"),
    due_date: optionalDate(body.due_date ?? current.due_date, "due_date"),
    status: enumValue(body.status ?? current.status, debtStatuses, "pending", "status"),
    notes: optionalText(body.notes ?? current.notes, "notes"),
  };
}

// Land and commercial property are sold by price and size; only homes have
// bedrooms and bathrooms. A room count sent for land is dropped, never stored.
const PROPERTY_TYPE_ROOMS = { land: false, commercial: false, house: true, apartment: true, villa: true, penthouse: true };

function validateProperty(body, current = {}) {
  const propertyType = enumValue(body.property_type ?? current.property_type, propertyTypes, "house", "property_type");
  const rooms = PROPERTY_TYPE_ROOMS[propertyType] !== false;
  return {
    project_id: parseId(body.project_id ?? current.project_id, "project_id", true),
    name: requiredText(body.name ?? current.name, "name"),
    property_type: propertyType,
    status: enumValue(body.status ?? current.status, propertyStatuses, "available", "status"),
    price: nonNegativeNumber(body.price ?? current.price, "price"),
    location: requiredText(body.location ?? current.location, "location"),
    area: nonNegativeNumber(body.area ?? current.area, "area"),
    bedrooms: rooms ? nonNegativeInteger(body.bedrooms ?? current.bedrooms, "bedrooms") : 0,
    bathrooms: rooms ? nonNegativeInteger(body.bathrooms ?? current.bathrooms, "bathrooms") : 0,
    description: optionalText(body.description ?? current.description, "description"),
    featured: Boolean(body.featured ?? current.featured),
  };
}

/* ---------------------------------------------------------------------------
   Public website listing (properties)

   The Sales Officer chooses Rent, Buy or both, and publishes directly: there is
   no management approval step. Publishing is refused only when the listing
   would be meaningless on the website (no service chosen, or a service with no
   price), so a half-filled record can never appear publicly.
   --------------------------------------------------------------------------- */
const rentPeriods = new Set(["month", "year"]);

function flag(value, fallback) {
  if (value === undefined) return Boolean(fallback);
  return value === true || value === 1 || value === "1" || value === "true" || value === "on";
}

function validatePropertyListing(body, current = {}, salePrice = 0) {
  const listing = {
    offer_rent: flag(body.offer_rent, current.offer_rent),
    offer_buy: flag(body.offer_buy, current.offer_buy),
    rent_price: body.rent_price === undefined
      ? (current.rent_price ?? null)
      : (body.rent_price === "" || body.rent_price === null ? null : nonNegativeNumber(body.rent_price, "rent_price")),
    rent_period: enumValue(body.rent_period ?? current.rent_period, rentPeriods, "month", "rent_period"),
    summary: optionalText(body.summary ?? current.summary, "summary", 200),
    features: optionalText(body.features ?? current.features, "features", 2000),
    public_listing: flag(body.public_listing, current.public_listing),
  };
  if (listing.public_listing) {
    if (!listing.offer_rent && !listing.offer_buy) throw new HttpError(400, "Choose Rent, Buy or both before showing this property on the website");
    if (listing.offer_buy && !(Number(salePrice) > 0)) throw new HttpError(400, "Enter the sale price before offering this property to buy on the website");
    if (listing.offer_rent && !(Number(listing.rent_price) > 0)) throw new HttpError(400, "Enter the rent price before offering this property to rent on the website");
  }
  return listing;
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

async function validateAppointment(body, current = {}) {
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
  requireRecord(await Client.get(data.client_id), "Client");
  const property = data.property_id ? requireRecord(await Property.get(data.property_id), "Property") : null;
  const project = data.project_id ? requireRecord(await Project.get(data.project_id), "Project") : null;
  if (property?.project_id && project && Number(property.project_id) !== Number(project.id)) {
    throw new HttpError(400, "property_id does not belong to the selected project");
  }
  if (!data.starts_at) throw new HttpError(400, "starts_at is required");
  if (data.starts_at && data.ends_at && data.ends_at <= data.starts_at) throw new HttpError(400, "ends_at must be after starts_at");
  return data;
}

async function validateDocument(body, current = {}) {
  const data = {
    project_id: parseId(body.project_id ?? current.project_id, "project_id", true),
    contract_id: parseId(body.contract_id ?? current.contract_id, "contract_id", true),
    client_id: parseId(body.client_id ?? current.client_id, "client_id", true),
    title: requiredText(body.title ?? current.title, "title"),
    category: enumValue(body.category ?? current.category, documentCategories, "other", "category"),
    status: enumValue(body.status ?? current.status, documentStatuses, "pending", "status"),
    file_reference: optionalText(body.file_reference ?? current.file_reference, "file_reference", 300),
    notes: optionalText(body.notes ?? current.notes, "notes"),
  };
  if (data.category === "template") throw new HttpError(403, "contract templates must be managed through the contract-template endpoints");
  const project = data.project_id ? requireRecord(await Project.get(data.project_id), "Project") : null;
  const contract = data.contract_id ? requireRecord(await Contract.get(data.contract_id), "Contract") : null;
  const client = data.client_id ? requireRecord(await Client.get(data.client_id), "Client") : null;
  if (contract && project && contract.project_id && Number(contract.project_id) !== Number(project.id)) {
    throw new HttpError(400, "contract_id does not belong to the selected project");
  }
  if (contract && client && contract.client_id && Number(contract.client_id) !== Number(client.id)) {
    throw new HttpError(400, "client_id does not belong to the selected contract");
  }
  return data;
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
  // The contract and installment are read through the caller's own scope
  // (organization + role/department visibility), so a payment can never be
  // written against - or reveal the client of - a contract they cannot see.
  const contract = requireRecord(await Contract.get(contractId), "Contract");
  const debtId = parseId(body.debt_id ?? current.debt_id, "debt_id", true);
  if (debtId) {
    const debt = requireRecord(await Debt.get(debtId), "Installment");
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

// Contracts are written by the desks responsible for them: Sales raises the
// deal, Legal prepares the agreement and the MD directs the business. Finance
// holds `create` for payments, not for contracts: it receives a contract once
// the people responsible have created it, and validates its money.
export function mayAuthorContracts(access) {
  if (!access) return true;
  return ["submit_contract", "approve_legal", "approve_management"].some((permission) => can(access, permission));
}
function requireContractAuthor(access) {
  if (!mayAuthorContracts(access)) throw new HttpError(403, "contracts are created by Sales, Legal or the MD; Finance receives them once they are created");
}

const LOCKED_CONTRACT_STATUSES = new Set(["legal_approved", "pending_management_approval", "approved", "customer_pending", "active", "completed", "rejected", "cancelled"]);
function requireEditableContract(contract) {
  const correctionRequested = contract?.status === "changes_requested";
  if (LOCKED_CONTRACT_STATUSES.has(contract?.status) || (contract?.legal_signed_by && !correctionRequested)) {
    throw new HttpError(409, "this contract has reached approval or signature; request changes through the contract workflow before editing");
  }
}

// Statuses in which a contract is still "before approval".
const PRE_APPROVAL_STATUSES = new Set(["draft", "submitted", "under_review", "changes_requested"]);
/** Why this caller may not delete this contract, or null when they may. */
export function contractDeleteRefusal(access, contract) {
  if (!access) return null;
  if (can(access, "approve_legal") || can(access, "approve_management")) return null;
  if (can(access, "submit_contract")) {
    return PRE_APPROVAL_STATUSES.has(contract.status)
      ? null
      : "Sales may delete a contract only before it is approved; ask Legal or the MD, or cancel it instead";
  }
  return "only the MD, Legal or Sales may delete a contract; cancel it instead";
}

/**
 * Who may delete a property. Holders of `delete` (the MD, managers) and Sales,
 * who keep the listings. Nobody deletes a property a contract names: it is
 * marked sold or rented instead, so the contract keeps its property.
 */
export function mayDeletePropertyAsSales(access) {
  return Boolean(access) && can(access, "access_properties") && can(access, "submit_contract");
}
async function propertyDeleteRefusal(access, propertyId) {
  if (access && !can(access, "delete") && !mayDeletePropertyAsSales(access)) return { status: 403, error: "you may not delete properties" };
  const used = Number((await queryOne("SELECT COUNT(*) AS n FROM contracts WHERE property_id=$1", [propertyId])).n);
  return used ? { status: 409, error: "this property is on a contract; mark it sold or rented instead of deleting it" } : null;
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

// Every successful write is announced to the open staff screens (live.js),
// so lists and badges update without a refresh. Mounted first, so a visitor's
// website request is announced too.
router.use(announceWrites());
router.get("/health", route((req, res) => res.json({ status: "ok" })));
router.get("/auth/state", route(async (req, res) => res.json({ configured: Number((await queryOne("SELECT COUNT(*) AS count FROM users")).count) > 0 })));
// The browser app identifies itself with the CSRF header; it receives the
// session only as an HttpOnly cookie, never in the response body. API clients
// (scripts, tests) get the token in the body as before.
function sendSession(req, res, status, payload, session) {
  const browser = req.get(CSRF_HEADER) === "1";
  setSessionCookie(req, res, session.token, session.max_age_ms);
  const { max_age_ms, ...rest } = session;
  const body = browser ? { ...payload, expires_at: session.expires_at } : { ...payload, ...rest };
  return res.status(status).json(body);
}

/** A password anyone can derive from the address (the published demo scheme). */
function isDemoPassword(email, password) {
  return String(password) === demoPasswordFor(String(email).toLowerCase());
}

// A real scrypt hash of a random secret, used only to keep failed sign-ins for
// unknown addresses as slow as those for real ones.
const TIMING_DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString("hex"));

const setupLimit = rateLimit({ name: "setup", limit: 10, windowMs: 60 * 60 * 1000 });
router.post("/auth/setup", setupLimit, route(async (req, res) => {
  if (Number((await queryOne("SELECT COUNT(*) AS count FROM users")).count) > 0) throw new HttpError(409, "workspace already configured");
  // In production the very first account also needs the setup token the
  // operator configured, so an unattended fresh install cannot be claimed by
  // whoever reaches it first.
  const setupToken = String(process.env.SETUP_TOKEN || "");
  const suppliedSetupToken = String(req.get("x-setup-token") || req.body?.setup_token || "");
  const tokenMatches = setupToken.length > 0 && Buffer.byteLength(setupToken) === Buffer.byteLength(suppliedSetupToken)
    && crypto.timingSafeEqual(Buffer.from(setupToken), Buffer.from(suppliedSetupToken));
  if (isProduction() && !tokenMatches) {
    throw new HttpError(403, "the setup token is missing or wrong");
  }
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
  // MK-07: the "no users yet" check and the insert happen inside one
  // transaction holding an advisory lock, so two simultaneous setup requests
  // cannot both see an empty workspace and both create an administrator.
  const result = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(4242001)");
    const existing = Number((await client.query("SELECT COUNT(*) AS count FROM users")).rows[0].count);
    if (existing > 0) throw new HttpError(409, "workspace already configured");
    return (await client.query("INSERT INTO users (organization_id, email, password_hash, display_name, role) VALUES ($1, $2, $3, $4, 'admin') RETURNING *", [orgId, email, hashPassword(password), displayName])).rows[0];
  });
  await provisionSystemAdministrator(result.id);
  await audit({ user: { id: result.id } }, "login", "auth", result.id, { method: "setup", portal });
  const session = await createSession(result.id, { remember: body.remember !== false });
  return sendSession(req, res, 201, { ...await publicUser(result), portal }, session);
}));
router.post("/auth/login", route(async (req, res) => {
  const body = req.body || {};
  const email = validEmail(body.email, "email");
  const password = typeof body.password === "string" ? body.password.slice(0, 256) : "";
  // MK-02: repeated failures from one address (for one account, or overall)
  // are stopped for a while. Checked before the password is even hashed.
  const blocked = loginBlocked(req, email);
  if (blocked.limited) {
    res.set("Retry-After", String(blocked.retryAfter));
    throw new HttpError(429, `Too many failed sign-in attempts. Try again in ${Math.ceil(blocked.retryAfter / 60)} minute(s).`);
  }
  const user = await queryOne("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [email]);
  // An unknown address still pays for one password hash, so the response time
  // does not tell an attacker which addresses have accounts. A deactivated
  // account is refused exactly like a wrong password.
  const passwordOk = verifyPassword(password, user?.password_hash || TIMING_DUMMY_HASH);
  if (!user || !passwordOk || user.active === false) {
    recordLoginFailure(req, email);
    throw new HttpError(401, "email or password is incorrect");
  }
  // MK-01: in production a password anyone can derive from the address (the
  // published demo scheme) is never accepted; an administrator must set a new one.
  if (isProduction() && isDemoPassword(user.email, password)) {
    throw new HttpError(403, "This account still uses a published demo password. Ask the administrator to set a new password.");
  }
  recordLoginSuccess(req, email);
  // Portal boundary. Deliberately AFTER the password check: a wrong password
  // must not reveal which portal an address belongs to, so an attacker cannot
  // probe for administrator accounts. `portal` is only a claim - the account's
  // own role decides whether it is honoured, which is why a hand-crafted
  // request cannot get further than the sign-in screen did.
  const portal = resolvePortal(body.portal, user);
  if (user.role === "admin") await provisionSystemAdministrator(user.id);
  const session = await createSession(user.id, { remember: body.remember !== false });
  await audit({ user }, "login", "auth", user.id, { portal });
  return sendSession(req, res, 200, { ...await publicUser(user), portal }, session);
}));
router.post("/auth/logout", route(async (req, res) => {
  const token = tokenFromRequest(req);
  if (token) {
    const sessionUser = await queryOne("SELECT user_id FROM sessions WHERE token_hash = $1", [hashToken(token)]);
    if (sessionUser) await audit({ user: { id: sessionUser.user_id } }, "logout", "auth", sessionUser.user_id);
    await query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
  }
  clearSessionCookie(req, res);
  res.json({ ok: true });
}));
router.get("/auth/me", requireAuth, route(async (req, res) => {
  // The portal is re-derived from the session's own role on every read, so a
  // refresh restores the correct portal and a tampered client cannot claim one.
  res.json({ ...await publicUser(req.user), portal: portalForUser(req.user) });
}));
// The public website's read-only API. Mounted BEFORE requireAuth: it needs no
// login and returns only what the Sales Officer has published.
router.use("/public", publicRoutes);
router.use(requireAuth);
// Own profile photo, kept for compatibility with the earlier /profile/photo
// endpoints. Both routes use the same stored photo as /org/me/photo, which is
// the one colleagues see (GET /org/users/:id/photo).
router.get("/profile/photo", route(async (req, res) => {
  const user = await queryOne("SELECT photo_stored_name, photo_mime FROM users WHERE id=$1", [req.user.id]);
  const fullPath = resolveStoredFile(profileUploadsDir, user?.photo_stored_name);
  if (!fullPath) throw new HttpError(404, "No profile photo is uploaded");
  res.set("Cache-Control", "private, no-store");
  return sendStoredFile(res, fullPath, user.photo_mime, "profile-photo", false);
}));
router.post("/profile/photo", uploadProfileImageFile, route(async (req, res) => {
  const fileInfo = validateUploadedFile(req.file, profileImageExtensions);
  try {
    const current = await queryOne("SELECT photo_stored_name FROM users WHERE id=$1", [req.user.id]);
    await query("UPDATE users SET photo_stored_name=$1, photo_mime=$2 WHERE id=$3", [fileInfo.storedName, fileInfo.mimeType, req.user.id]);
    if (current?.photo_stored_name && current.photo_stored_name !== fileInfo.storedName) removeStoredFile(profileUploadsDir, current.photo_stored_name);
    res.json({ profile_photo_url: `/api/v1/org/users/${req.user.id}/photo?v=${Date.now()}` });
  } catch (error) {
    cleanupUploadedFile(req.file);
    throw error;
  }
}));
// Resolve the caller once per request: role scope, departments and permissions.
// Models read it through the async-local store so list/get/update/delete all
// enforce the same visibility rules.
router.use(accessMiddleware());
// The live-update stream for a signed-in screen (see live.js).
router.get("/live", liveStream);
router.use((req, res, next) => {
  if (req.path.startsWith("/org/")) return next();
  // Contract templates carry their own authority (`upload_contract_templates`),
  // checked on every route below, rather than the generic create/edit/delete.
  if (req.path.startsWith("/contract-templates")) return next();
  // Deleting a contract has its own rule (MD, Legal, or Sales before approval),
  // enforced by the route itself, rather than the generic `delete` permission.
  if (req.method === "DELETE" && /^\/contracts\/[^/]+\/?$/.test(req.path)) {
    return can(req.access, "access_contracts") ? next() : res.status(403).json({ error: "permission denied", permission: "access_contracts" });
  }
  // Deleting a property: `delete` holders, or Sales for a listing no contract
  // names (decided by the route). Pictures keep the generic rule.
  if (req.method === "DELETE" && /^\/properties\/[^/]+\/?$/.test(req.path) && !can(req.access, "delete") && mayDeletePropertyAsSales(req.access)) {
    return next();
  }
  // Removing a property's photo is part of editing the listing.
  if (req.method === "DELETE" && /^\/properties\/[^/]+\/images\/[^/]+\/?$/.test(req.path)) {
    return can(req.access, "access_properties") && can(req.access, "edit") ? next() : res.status(403).json({ error: "permission denied", permission: "edit" });
  }
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
  const history = await Contract.history(id);
  // The finance step's notes carry payment terms; people without financial
  // access see that the step happened, not what it said.
  if (canPermission(req.access, "view_financial")) return res.json(history);
  res.json(history.map((entry) => (FINANCIAL_REVISION_ACTIONS.has(entry.action) && entry.notes ? { ...entry, notes: null, notes_redacted: true } : entry)));
}));
const FINANCIAL_REVISION_ACTIONS = new Set(["finance_validate", "schedule", "payment"]);

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
  if (name === "request_changes" && contract.legal_signed_by) {
    try {
      await clearContractSignatureDocument(contract);
    } catch (error) {
      console.error("failed to invalidate prior contract signature:", error?.stack || error);
      throw new HttpError(409, "the prior signed document could not be safely invalidated; contact the administrator");
    }
  }
  await Contract.transition(id, { ...action, action: name }, {
    notes,
    actorId: req.user.id,
    actorName: req.user.display_name,
    signedBy,
  });
  // The desk that now holds the contract must be able to open it (see handover.js).
  const sharedWith = await shareContractWithHandoverDesks(id, req.user.id);
  // Legal approval puts the approving lawyer's signature on the document.
  const signed = name === "legal_approve" ? await signContractDocument(id, req.user.id) : false;
  await audit(req, `contract_${name}`, "contract", id, { from: contract.status, to: action.to, shared_with: sharedWith, signed_by_lawyer: signed });
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
  requireContractAuthor(req.access);
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

  // --- Wording and template -----------------------------------------------
  // The contract TYPE (Buy, Rent or Sell) decides the wording: a Sale
  // Agreement, a Lease Agreement or a Property Sale Mandate (agreements.js).
  // The TEMPLATE is the design that wording is placed on:
  //   * a letterhead template (it contains {{CONTRACT_BODY}}): the type's
  //     wording goes in that spot, inside the template's design;
  //   * a full-wording template written for this type: filled as it is;
  //   * no template: the built-in MKUYU letterhead.
  // Letterheads live in the page header/footer, so every page carries them.
  const agreement = builtInAgreement(data.deal_type);
  let templateId = null;
  let templateBody = agreement.body;
  let templateTitle = agreement.title;
  let templateWordPath = null;
  let letterhead = false;
  // No template field at all (as opposed to an explicit "built-in" choice)
  // means the automatic choice: a template written for this type of deal,
  // otherwise the organization's default template.
  let useTemplateId = hasSelectedTemplate ? parseId(body.template_document_id, "template_document_id") : null;
  if (body.template_document_id === undefined) {
    const fallback = await queryOne(
      `SELECT id FROM documents WHERE organization_id=$1 AND category='template'
          AND (template_deal_type=$2 OR (is_default_template=TRUE AND (template_deal_type IS NULL OR template_deal_type=$2)))
        ORDER BY (template_deal_type IS NOT NULL) DESC, is_default_template DESC, id DESC LIMIT 1`,
      [await organizationId(), data.deal_type],
    );
    if (fallback) useTemplateId = fallback.id;
  }
  if (useTemplateId) {
    templateId = useTemplateId;
    const template = await templateRecord(templateId);
    if (!String(template.body_text || "").trim()) throw new HttpError(400, "the selected template has no body text");
    if (template.template_deal_type && template.template_deal_type !== data.deal_type) {
      throw new HttpError(400, `the selected template is for ${template.template_deal_type} contracts; choose a ${data.deal_type} template or the letterhead`);
    }
    letterhead = CONTRACT_BODY_TOKEN.test(template.body_text);
    // A letterhead carries the type's wording; a full template its own.
    templateBody = letterhead ? String(template.body_text).replace(CONTRACT_BODY_TOKEN, agreement.body) : String(template.body_text);
    if (!letterhead) templateTitle = template.title || agreement.title;
    templateWordPath = templateWordFile(template);
    // In a Word letterhead the design is the file; the stored text is the wording.
    if (templateWordPath && letterhead) templateBody = agreement.body;
  }
  const unknownTemplateTokens = templateWordPath
    ? await templateFileUnknownPlaceholders(fs.readFileSync(templateWordPath))
    : unknownPlaceholders(templateBody);
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
  const project = data.project_id ? requireRecord(await Project.get(data.project_id), "Project") : null;
  const property = data.property_id ? requireRecord(await Property.get(data.property_id), "Property") : null;
  const client = data.client_id ? await Client.get(data.client_id) : null;
  const values = buildDocumentValues({
    contract,
    project,
    property,
    client,
    // The company identity is read from the organization row, never hardcoded.
    companyName: org?.name || "",
    plan: plan || {},
  }, agreement.body);
  const renderedContractText = renderContractDocument(templateBody, values);
  const file = templateWordPath
    ? await generateFromWordTemplate({ templatePath: templateWordPath, values, title: templateTitle, contractNumber: contract.contract_number })
    : await produceContractDocument({ templateBody, values, title: templateTitle, contractNumber: contract.contract_number });
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
  await query("UPDATE documents SET body_text=$1, fill_values=$2 WHERE id=$3 AND organization_id=$4", [renderedContractText, templateWordPath ? JSON.stringify(values) : null, documentRow.id, await organizationId()]);
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
    template: templateId ? { id: templateId, title: templateTitle, letterhead } : { id: null, title: `Built-in ${agreement.title}`, letterhead: true },
    placeholders: { used: placeholdersUsed(templateBody), unknown: unknownPlaceholders(templateBody) },
    schedule,
  });
}));

// Contract templates are documents of category 'template'. They are SHARED:
// everyone who generates contracts uses them, so the list is not filtered by
// who uploaded it. Changing them - upload, default, delete - is reserved to
// holders of `upload_contract_templates` (MD, ICT administration, Sales
// Officer, Legal Officer, and the System Administrator).
const mayUseTemplates = (access) => can(access, "upload_contract_templates") || can(access, "access_contracts") || can(access, "access_documents");
function requireTemplateAuthority(access) {
  if (!can(access, "upload_contract_templates")) throw new HttpError(403, "only the MD, ICT administration, sales officers and Legal Officers may change contract templates");
}
/** A template by id, organization-wide (templates are shared, not scoped). */
async function templateRecord(id) {
  const template = await queryOne("SELECT * FROM documents WHERE id=$1 AND organization_id=$2", [id, await organizationId()]);
  if (!template) throw new HttpError(404, "Template not found");
  if (String(template.category) !== "template") throw new HttpError(400, "that document is not a contract template");
  return template;
}

router.get("/contract-templates", route(async (req, res) => {
  if (!mayUseTemplates(req.access)) throw new HttpError(403, "permission denied");
  const templates = (await query(
    `SELECT d.id, d.title, d.body_text, d.category, d.original_filename, d.stored_name, d.created_at, d.uploaded_at, d.is_default_template AS is_default, d.template_deal_type AS deal_type,
        u.display_name AS uploaded_by_name,
        (SELECT COUNT(*)::int FROM contracts c WHERE c.template_document_id = d.id) AS used_by
       FROM documents d
       LEFT JOIN users u ON u.id = d.created_by
      WHERE d.organization_id=$1 AND d.category='template'
      ORDER BY d.is_default_template DESC, d.title`,
    [await organizationId()],
  )).rows;
  res.json(templates.map((template) => ({
    ...template,
    has_file: Boolean(template.stored_name),
    // A letterhead carries the chosen type's wording at {{CONTRACT_BODY}}.
    letterhead: CONTRACT_BODY_TOKEN.test(String(template.body_text || "")),
    placeholders: placeholdersUsed(template.body_text),
    unknown: unknownPlaceholders(template.body_text),
  })));
}));

router.post("/contract-templates", route(async (req, res) => {
  requireTemplateAuthority(req.access);
  const title = requiredText(req.body?.title, "title", 160);
  const bodyText = requiredText(req.body?.body_text, "body_text", 100000);
  // A typo'd placeholder would render literally onto a customer's signed copy,
  // so it is reported now rather than discovered later.
  const unknown = unknownPlaceholders(bodyText);
  if (unknown.length) throw new HttpError(400, `unknown placeholder(s): ${unknown.join(", ")}`);
  const created = await queryOne(
    "INSERT INTO documents (organization_id,title,category,status,notes,body_text,created_by,visibility,template_deal_type) VALUES ($1,$2,'template','approved',$3,$4,$5,'organization',$6) RETURNING id",
    [await organizationId(), title, `Template using: ${placeholdersUsed(bodyText).join(", ") || "no placeholders"}`, bodyText, req.user.id, templateDealType(req.body?.deal_type)],
  );
  if (truthy(req.body?.is_default)) await setDefaultTemplate(created.id);
  await audit(req, "created", "contract_template", created.id, { title });
  res.status(201).json({ id: created.id, title, category: "template", placeholders: placeholdersUsed(bodyText), unknown });
}));

router.put("/contract-templates/:id", route(async (req, res) => {
  requireTemplateAuthority(req.access);
  const id = parseId(req.params.id);
  const template = await templateRecord(id);
  const bodyText = req.body?.body_text === undefined ? template.body_text : requiredText(req.body.body_text, "body_text", 100000);
  const title = req.body?.title === undefined ? template.title : requiredText(req.body.title, "title", 160);
  const unknown = unknownPlaceholders(bodyText);
  if (unknown.length) throw new HttpError(400, `unknown placeholder(s): ${unknown.join(", ")}`);
  const dealType = req.body?.deal_type === undefined ? template.template_deal_type : templateDealType(req.body.deal_type);
  const updated = await queryOne("UPDATE documents SET title=$1, body_text=$2, template_deal_type=$4 WHERE id=$3 RETURNING id", [title, bodyText, id, dealType]);
  if (req.body?.is_default !== undefined) {
    if (truthy(req.body.is_default)) await setDefaultTemplate(id);
    else await query("UPDATE documents SET is_default_template=FALSE WHERE id=$1", [id]);
  }
  await audit(req, "updated", "contract_template", updated.id, { title, is_default: req.body?.is_default });
  res.json({ id: updated.id, title, placeholders: placeholdersUsed(bodyText), unknown });
}));

/** A template's contract type: buy, rent, sell, or null for "any type" (a letterhead). */
function templateDealType(value) {
  if (value === undefined || value === null || value === "" || value === "any") return null;
  const type = String(value).trim().toLowerCase();
  if (!CONTRACT_DEAL_TYPES.has(type)) throw new HttpError(400, "template type must be buy, rent, sell or any");
  return type;
}

function truthy(value) {
  return value === true || value === 1 || ["true", "1", "yes", "on"].includes(String(value).toLowerCase());
}

/** Exactly one default template per organization. */
async function setDefaultTemplate(id) {
  const org = await organizationId();
  await withTransaction(async (client) => {
    await client.query("UPDATE documents SET is_default_template=FALSE WHERE organization_id=$1 AND category='template' AND id<>$2", [org, id]);
    await client.query("UPDATE documents SET is_default_template=TRUE WHERE organization_id=$1 AND category='template' AND id=$2", [org, id]);
  });
}

// A ready-made Word template containing every placeholder, for staff to
// download, adapt in Word and upload back.
router.get("/contract-templates/starter", route(async (req, res) => {
  requireTemplateAuthority(req.access);
  const tmp = path.join(os.tmpdir(), `mkuyu-starter-${crypto.randomUUID()}.docx`);
  // Default: a LETTERHEAD starter. The MKUYU header and footer repeat on every
  // page, and {{CONTRACT_BODY}} marks where the chosen type's agreement goes, so
  // one template serves Buy, Rent and Sell. `?kind=sale|lease|mandate` gives a
  // full-wording starter for one type instead.
  const full = { sale: "buy", lease: "rent", mandate: "sell" }[String(req.query.kind || "")];
  const starterText = full
    ? builtInAgreement(full).body
    : "{{CONTRACT_BODY}}";
  await writeContractDocx({ text: starterText, targetPath: tmp, title: full ? builtInAgreement(full).title : "Agreement", contractNumber: "" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", 'attachment; filename="MKUYU-contract-template.docx"');
  res.send(fs.readFileSync(tmp));
  fs.rmSync(tmp, { force: true });
}));

// Upload a Word (.docx) contract template. The wording is extracted into the
// template text (placeholders such as {{CLIENT_NAME}} included) and the
// original file is kept so it can be downloaded again. Same permissions as
// creating a template by typing it.
router.post("/contract-templates/upload", uploadDocumentFile, route(async (req, res) => {
  try {
    requireTemplateAuthority(req.access);
    const fileInfo = validateUploadedFile(req.file, documentExtensions);
    if (fileInfo.extension !== ".docx") throw new HttpError(400, "upload the contract template as a Word .docx file");
    const bodyText = templateTextFromUpload(fs.readFileSync(req.file.path), ".docx");
    if (!bodyText) throw new HttpError(400, "the Word document is empty");
    // Headers and footers count too: the whole file is filled at generation.
    const unknown = await templateFileUnknownPlaceholders(fs.readFileSync(req.file.path));
    if (unknown.length) throw new HttpError(400, `unknown placeholder(s): ${unknown.join(", ")}. Use only the placeholders listed on the Templates screen.`);
    const title = optionalText(req.body?.title, "title", 160) || fileInfo.displayName.replace(/\.docx$/i, "");
    const created = await queryOne(
      `INSERT INTO documents (organization_id,title,category,status,notes,body_text,original_filename,stored_name,file_size,mime_type,uploaded_at,created_by,visibility,template_deal_type)
       VALUES ($1,$2,'template','approved',$3,$4,$5,$6,$7,$8,NOW(),$9,'organization',$10) RETURNING id`,
      [await organizationId(), title, `Template using: ${placeholdersUsed(bodyText).join(", ") || "no placeholders"}`, bodyText, fileInfo.displayName, fileInfo.storedName, fileInfo.size, fileInfo.mimeType, req.user.id, templateDealType(req.body?.deal_type)],
    );
    if (truthy(req.body?.is_default)) await setDefaultTemplate(created.id);
    await audit(req, "uploaded", "contract_template", created.id, { title, filename: fileInfo.displayName });
    res.status(201).json({ id: created.id, title, category: "template", placeholders: placeholdersUsed(bodyText), unknown: [], characters: bodyText.length });
  } catch (error) {
    cleanupUploadedFile(req.file);
    throw error;
  }
}));

// The template's own Word file, for the people who maintain templates.
router.get("/contract-templates/:id/file", route(async (req, res) => {
  requireTemplateAuthority(req.access);
  const template = await templateRecord(parseId(req.params.id));
  const file = resolveStoredFile(documentUploadsDir, template.stored_name);
  if (!file) throw new HttpError(404, "this template has no Word file (it was typed in)");
  res.download(file, template.original_filename || `${template.title}.docx`);
}));

router.delete("/contract-templates/:id", route(async (req, res) => {
  requireTemplateAuthority(req.access);
  const id = parseId(req.params.id);
  await templateRecord(id);
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
    const agreement = builtInAgreement(contract.deal_type);
    let templateBody = agreement.body;
    if (contract.template_document_id) {
      const template = await Document.get(contract.template_document_id);
      if (template?.category === "template" && template.body_text) templateBody = String(template.body_text).replace(CONTRACT_BODY_TOKEN, agreement.body);
    }
    const organization = await queryOne("SELECT name FROM organizations WHERE id=$1", [await organizationId()]);
    const project = contract.project_id ? requireRecord(await Project.get(contract.project_id), "Project") : null;
    const property = contract.property_id ? requireRecord(await Property.get(contract.property_id), "Property") : null;
    const client = contract.client_id ? await Client.get(contract.client_id) : null;
    bodyText = renderContractDocument(templateBody, buildContractValues({ contract, project, property, client, companyName: organization?.name || "MKUYU" }));
  }
  res.json({ contract_id: contract.id, document_id: document.id, title: document.title, original_filename: document.original_filename, body_text: bodyText, word_template: Boolean(document.fill_values), can_edit: can(req.access, "edit") && !document.fill_values });
}));

router.put("/contracts/:id/document-content", route(async (req, res) => {
  if (!can(req.access, "access_documents")) throw new HttpError(403, "Documents access is required to edit the generated contract");
  if (!can(req.access, "edit")) throw new HttpError(403, "edit permission is required to revise the generated contract");
  const contract = requireRecord(await Contract.get(parseId(req.params.id)), "Contract");
  requireEditableContract(contract);
  if (!contract.generated_document_id) throw new HttpError(404, "This contract has no generated document");
  const document = requireRecord(await Document.get(contract.generated_document_id), "Generated document");
  if (Number(document.contract_id) !== Number(contract.id) || document.category !== "agreement") throw new HttpError(404, "The generated document is not linked to this contract");
  // A contract produced on an uploaded Word template carries that template's
  // design; retyping it here would throw the design away.
  if (document.fill_values) throw new HttpError(409, "This contract was produced on your Word template. To change its wording, download it, edit it in Word and attach the revised copy with Upload document.");
  const bodyText = requiredText(req.body?.body_text, "body_text", 100000);
  if (/\{\{\s*[A-Z0-9_]+\s*\}\}/.test(bodyText)) throw new HttpError(400, "replace every unresolved {{PLACEHOLDER}} before saving the contract");

  // A contract Legal has already signed keeps the signature on the revision.
  const file = await produceContractDocument({ templateBody: bodyText, values: {}, title: document.title || "Sale Agreement", contractNumber: contract.contract_number, signature: await contractSignature(contract) });
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

// The contract as it looks: the generated Word file (template, letterhead,
// header and footer) described page by page for the browser to show. Same
// gate as reading the document itself.
router.get("/contracts/:id/preview", route(async (req, res) => {
  if (!can(req.access, "access_documents")) throw new HttpError(403, "Documents access is required to view the generated contract");
  const contract = requireRecord(await Contract.get(parseId(req.params.id)), "Contract");
  if (!contract.generated_document_id) throw new HttpError(404, "This contract has no generated document");
  const document = requireRecord(await Document.get(contract.generated_document_id), "Generated document");
  if (Number(document.contract_id) !== Number(contract.id) || document.category !== "agreement") throw new HttpError(404, "The generated document is not linked to this contract");
  const file = resolveStoredFile(documentUploadsDir, document.stored_name);
  if (!file) throw new HttpError(404, "The contract file is missing");
  if (!/\.docx$/i.test(document.original_filename || document.stored_name)) throw new HttpError(415, "This contract is not a Word document; download it to view it");
  let preview;
  try {
    preview = await docxToPreview(fs.readFileSync(file));
  } catch {
    throw new HttpError(422, "This contract file cannot be shown here; download it to view it");
  }
  res.set("Cache-Control", "private, no-store");
  res.json({ contract_id: contract.id, document_id: document.id, title: document.title, original_filename: document.original_filename, contract_number: contract.contract_number, ...preview });
}));

router.get("/contract-placeholders", route(async (req, res) => { res.json(CONTRACT_PLACEHOLDERS); }));

router.post("/contracts", route(async (req, res) => {
  requireContractAuthor(req.access);
  const data = await validateContract(req.body || {});
  const result = await Contract.create(data);
  res.status(201).json(contractResponse(await Contract.get(result.id), req));
}));
router.put("/contracts/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  requireContractAuthor(req.access);
  const current = requireRecord(await Contract.get(id), "Contract");
  requireEditableContract(current);
  // The lifecycle is owned by Legal, so an edit that tries to change the status
  // is refused outright rather than silently ignored.
  if (req.body?.status && req.body.status !== current.status) {
    throw new HttpError(409, "a contract changes status through the workflow, not by editing it");
  }
  const data = await validateContract(req.body || {}, current);
  await Contract.update(id, data);
  res.json(contractResponse(await Contract.get(id), req));
}));
// Deleting a contract is for the MD, Legal and Sales - nobody else. Sales may
// only delete while the deal is still before approval; once Legal has approved
// it, the record belongs to the approval trail and only the MD or Legal may
// remove it. Everyone else cancels it through the workflow.
router.delete("/contracts/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const contract = requireRecord(await Contract.get(id), "Contract");
  const refusal = contractDeleteRefusal(req.access, contract);
  if (refusal) throw new HttpError(403, refusal);
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
  const data = await validateDebt(req.body || {});
  const result = await Debt.create(data);
  const id = result.id;
  await syncDebtReminder(id, data.due_date, data.status || "pending");
  res.status(201).json(await Debt.get(id));
}));
router.put("/debts/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const current = requireRecord(await Debt.get(id), "Debt");
  const data = await validateDebt(req.body || {}, current);
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
        // Ownership is recorded like any other payment (who recorded it matters
        // for approval: nobody approves their own payment).
        "INSERT INTO payments (organization_id,contract_id,debt_id,client_name,amount,paid_at,method,reference,notes,owner_id,created_by,department_id,visibility) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id",
        [orgId, data.contract_id, data.debt_id || null, data.client_name, data.amount, data.paid_at, data.method || "cash", data.reference || null, data.notes || null, ...Object.values((({ owner_id, created_by, department_id, visibility }) => ({ owner_id, created_by, department_id, visibility }))(ownershipFields(req.access)))],
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
// Finance approval of a recorded payment. The server decides: the caller must
// hold the Finance validation authority and financial access, the payment must
// be inside their scope and still pending, and nobody approves a payment they
// recorded themselves (a second Finance person confirms it).
router.post("/payments/:id/approve", route(async (req, res) => {
  if (!canPermission(req.access, "validate_finance") || !canPermission(req.access, "view_financial")) {
    throw new HttpError(403, "only Finance can approve payments");
  }
  const id = parseId(req.params.id);
  const payment = requireRecord(await Payment.get(id), "Payment");
  if (payment.status === "approved") throw new HttpError(409, "this payment is already approved");
  if (Number(payment.created_by) === Number(req.user.id)) throw new HttpError(403, "a payment must be approved by someone other than the person who recorded it");
  const result = await Payment.approve(id, req.user.id);
  if (!result.rowCount) throw new HttpError(409, "this payment could not be approved");
  await audit(req, "payment_approved", "payment", id, { amount: payment.amount, contract_id: payment.contract_id });
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
  const listing = validatePropertyListing(req.body || {}, {}, data.price);
  const result = await Property.create(data);
  const propertyId = result.id;
  await Property.setListing(propertyId, listing);
  await applyCategoryStatus(propertyId, req.body || {}, {}, listing, data);
  await recordPropertyHistory(propertyId, req.user.id, "created", { status: data.status, price: data.price });
  res.status(201).json(await Property.get(propertyId));
}));
router.put("/properties/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const current = requireRecord(await Property.get(id), "Property");
  const data = validateProperty(req.body || {}, current);
  const listing = validatePropertyListing(req.body || {}, current, data.price);
  await Property.update(id, data);
  await Property.setListing(id, listing);
  const states = await applyCategoryStatus(id, req.body || {}, current, listing, data);
  if (Boolean(current.public_listing) !== listing.public_listing) {
    await recordPropertyHistory(id, req.user.id, listing.public_listing ? "published" : "unpublished", { offer_rent: listing.offer_rent, offer_buy: listing.offer_buy });
  }
  if (current.status !== states.status || current.sale_status !== states.sale_status || current.rent_status !== states.rent_status) {
    await recordPropertyHistory(id, req.user.id, "status_changed", { from: current.status, to: states.status, sale: states.sale_status, rent: states.rent_status });
  }
  if (Number(current.price) !== Number(data.price)) await recordPropertyHistory(id, req.user.id, "price_changed", { from: current.price, to: data.price });
  res.json(await Property.get(id));
}));

/**
 * Writes a property's sale and rent states and the overall status they imply
 * (models/propertyStatus.js). `sale_status` / `rent_status` in the body set
 * one category; a bare `status` (the edit form, older clients) is mapped onto
 * both. Returns the stored states.
 */
async function applyCategoryStatus(id, body, current, listing, data) {
  const pick = (value, allowed, field) => {
    if (value === undefined || value === null || value === "") return undefined;
    if (!allowed.has(value)) throw new HttpError(400, `${field} is invalid`);
    return value;
  };
  let sale = pick(body.sale_status, SALE_STATUSES, "sale_status");
  let rent = pick(body.rent_status, RENT_STATUSES, "rent_status");
  if (sale === undefined && rent === undefined && body.status !== undefined && body.status !== current.status) {
    ({ sale_status: sale, rent_status: rent } = categoryStatusesFrom(data.status, current));
  }
  const states = {
    sale_status: sale ?? current.sale_status ?? categoryStatusesFrom(data.status).sale_status,
    rent_status: rent ?? current.rent_status ?? categoryStatusesFrom(data.status).rent_status,
  };
  states.status = overallStatus({ offer_buy: listing.offer_buy, offer_rent: listing.offer_rent, ...states }, data.status);
  await query("UPDATE properties SET sale_status=$1, rent_status=$2, status=$3 WHERE id=$4 AND organization_id=$5", [states.sale_status, states.rent_status, states.status, id, await organizationId()]);
  return states;
}
router.delete("/properties/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  requireRecord(await Property.get(id), "Property");
  const refusal = await propertyDeleteRefusal(req.access, id);
  if (refusal) throw new HttpError(refusal.status, refusal.error);
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
  const data = await validateAppointment(req.body || {});
  const result = await Appointment.create(data);
  res.status(201).json(await Appointment.get(result.id));
}));
// Everyone with Appointments reads the whole calendar, but changes only what
// their normal record scope reaches: a visible-but-not-theirs appointment is 403.
async function writableAppointment(id) {
  const current = requireRecord(await Appointment.get(id), "Appointment");
  if (!await Appointment.writable(id)) throw new HttpError(403, "this appointment is read only for you");
  return current;
}
router.put("/appointments/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const current = await writableAppointment(id);
  const data = await validateAppointment(req.body || {}, current);
  await Appointment.update(id, data);
  res.json(await Appointment.get(id));
}));
// "Mark as done": the MD or Sales confirms a scheduled meeting took place. The
// usual module + edit check runs first (PUT), and the record must be one the
// caller can see; an optional outcome note is kept with the appointment.
router.put("/appointments/:id/complete", route(async (req, res) => {
  if (!can(req.access, "approve_management") && !can(req.access, "submit_contract")) throw new HttpError(403, "only the Managing Director or Sales can mark an appointment done");
  const id = parseId(req.params.id);
  const current = await writableAppointment(id);
  if (current.status !== "scheduled") throw new HttpError(409, `this appointment is already ${current.status}`);
  const note = optionalText(req.body?.note, "note");
  await Appointment.complete(id, req.user.id, note ? `Outcome: ${note}` : null);
  res.json(await Appointment.get(id));
}));
router.delete("/appointments/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  await writableAppointment(id);
  // A website request booked on this appointment goes back to Sales to arrange
  // again, rather than still reading "appointment booked".
  const requests = (await query("SELECT id FROM leads WHERE appointment_id = $1", [id])).rows.map((row) => row.id);
  await Appointment.remove(id);
  if (requests.length) {
    await query("UPDATE leads SET appointment_at = NULL, appointment_type = NULL, status = 'contacted' WHERE id = ANY($1::int[]) AND status = 'appointment'", [requests]);
  }
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
  const data = await validateDocument(req.body || {});
  const result = await Document.create(data);
  res.status(201).json(documentResponse(await Document.get(result.id)));
}));
router.post("/documents/upload", uploadDocumentFile, route(async (req, res) => {
  const fileInfo = validateUploadedFile(req.file, documentExtensions);
  try {
    const data = await validateDocument({ ...(req.body || {}), file_reference: req.body?.file_reference || null });
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
  if (current.category === "template" || (current.category === "agreement" && current.contract_id)) {
    throw new HttpError(409, "contract templates and generated agreements must be changed through their dedicated workflow");
  }
  const data = await validateDocument(req.body || {}, current);
  await Document.update(id, data);
  res.json(documentResponse(await Document.get(id)));
}));
router.delete("/documents/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const current = requireRecord(await Document.get(id), "Document");
  if (current.category === "template" || (current.category === "agreement" && current.contract_id)) {
    throw new HttpError(409, "contract templates and generated agreements cannot be deleted through the generic document endpoint");
  }
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
