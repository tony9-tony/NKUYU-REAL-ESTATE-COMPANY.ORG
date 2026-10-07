import { Router } from "express";
import { autoBackupStatus, backupNamePattern, createBackup, listBackups } from "../backups.js";
import { normalizePhone, parsePaymentMessage } from "../payments/parseMessage.js";
import { emailReceipt, receiptCoverage, writeReceiptPdf } from "../payments/notices.js";
import { parseStatement } from "../payments/statement.js";
import multer from "multer";
import { mailConfigured, sendMail } from "../mail.js";
import { maybeAnnounceListing, noticeAfterPayment, noticeStatus, runScheduledNotices } from "../notify/customerNotices.js";
import { sendSms } from "../notify/sms.js";
import customerRoutes from "./customer.js";
import { uploadProgressImages, progressUploadsDir, MAX_PROGRESS_PHOTOS } from "../uploads.js";
import { smsNumber } from "../notify/messages.js";
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
import { findExistingClient } from "../org/clientMatch.js";
import PDFDocument from "pdfkit";
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
import customerPaymentRoutes from "./customerPayments.js";
import { ACCEPTED_REQUEST_SQL, contractBlockedMessage, invoiceBlockingContract } from "../payments/invoices.js";
import publicRoutes from "./public.js";
import { audit } from "../org/audit.js";
import { requirePermissionForMethod, provisionSystemAdministrator, organizationId, requireAdmin, can as canPermission } from "../org/rbac.js";
import { accessMiddleware, can, ownershipFields, scopeCondition } from "../org/access.js";
import {
  CONTRACT_ACTIONS,
  CONTRACT_STATUSES,
  CREATABLE_CONTRACT_STATUSES,
  availableActions,
  canTransition,
  contractPosition,
  transitionBlockedReason,
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
import { announceWrites, broadcastChange, liveStream } from "../live.js";
import { callsRingingDesk, callView, currentCall, finishCall, newRoom } from "../calls.js";
import { customersOf, notifyCustomer, recordVerificationEvent } from "../notify/diasporaNotices.js";
import { clearTyping, isTyping, REACTIONS, setTyping, DELETE_ALL_WINDOW_MS, EDIT_WINDOW_MS } from "../typing.js";
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

const projectKinds = new Set(["estate", "building"]);
function validateProject(body, current = {}) {
  return {
    name: requiredText(body.name ?? current.name, "name"),
    status: enumValue(body.status ?? current.status, projectStatuses, "active", "status"),
    // "building": one block of floors and numbered units; "estate": separate
    // homes or plots. Either can have units to rent, to buy, or both.
    kind: enumValue(body.kind ?? current.kind, projectKinds, "estate", "kind"),
    location: optionalText(body.location ?? current.location, "location", 160),
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
    // One property, one live deal per category: a house cannot be sold (or
    // let) to two customers at once. Checked when the property or the type of
    // deal is chosen, not on every later edit of the same contract.
    const changed = !current.id || Number(current.property_id) !== Number(data.property_id) || current.deal_type !== data.deal_type;
    if (changed && (data.deal_type === "buy" || data.deal_type === "rent")) {
      await assertPropertyFree(property, data.deal_type, current.id || null);
    }
  }
  if (data.start_date && data.end_date && data.end_date < data.start_date) throw new HttpError(400, "end_date cannot be before start_date");
  return data;
}

/** Refuses a second live Buy (or Rent) contract on the same property. */
async function assertPropertyFree(property, dealType, exceptContractId = null) {
  const other = await queryOne(
    `SELECT id, contract_number, client_name, status FROM contracts
      WHERE organization_id=$1 AND property_id=$2 AND deal_type=$3 AND id <> COALESCE($4::int, 0)
        AND status NOT IN ('rejected','cancelled') AND NOT ($3 = 'rent' AND status = 'completed')
      ORDER BY id LIMIT 1`,
    [await organizationId(), property.id, dealType, exceptContractId],
  );
  if (other) {
    throw new HttpError(409, `${property.name} already has a ${dealType === "rent" ? "lease" : "sale"} contract in progress (${other.contract_number || `#${other.id}`}, ${other.client_name}, ${String(other.status).replace(/_/g, " ")}); cancel that one first`);
  }
  if (dealType === "buy" && property.sale_status === "sold") throw new HttpError(409, `${property.name} is already sold`);
  if (dealType === "rent" && property.rent_status === "rented") throw new HttpError(409, `${property.name} is already rented`);
}

/**
 * Every contract belongs to a client in the register. When Sales types a name
 * instead of choosing a client, the client is found by phone or email, or
 * registered as a prospect, so that client's contracts and payments are always
 * found together.
 */
async function ensureContractClient(data) {
  if (data.client_id) return data;
  const existing = await findExistingClient(await organizationId(), { email: data.client_email, phone: data.client_phone });
  if (existing) { data.client_id = existing.id; return data; }
  const clientType = { buy: "buyer", rent: "tenant", sell: "seller" }[data.deal_type] || "buyer";
  const created = await Client.create({
    project_id: data.project_id || null, name: data.client_name, email: data.client_email || null, phone: data.client_phone || null,
    client_type: clientType, status: "lead", notes: "Registered automatically when their contract was prepared.",
  });
  data.client_id = created.id;
  return data;
}

// Contract transitions that release a property the contract was holding.
const PROPERTY_RELEASE_ACTIONS = new Set(["cancel", "reject", "management_reject", "request_changes", "complete"]);

/**
 * A property's Buy/Rent state follows its contracts: Reserved while an approved
 * contract is with the customer, Sold/Rented once the contract is active, and
 * available again when that contract is cancelled, rejected or sent back (or,
 * for a lease, completed). Sell mandates are about the owner's property and
 * leave MKUYU's listing alone.
 */
async function syncPropertyForContract(contractId, action, userId) {
  const contract = await queryOne("SELECT id, organization_id, property_id, deal_type, status, client_id FROM contracts WHERE id=$1", [contractId]);
  if (!contract?.property_id || !["buy", "rent"].includes(contract.deal_type)) return;
  const property = await queryOne("SELECT id, status, sale_status, rent_status, offer_buy, offer_rent FROM properties WHERE id=$1", [contract.property_id]);
  if (!property) return;
  const field = contract.deal_type === "buy" ? "sale_status" : "rent_status";
  const closed = contract.deal_type === "buy" ? "sold" : "rented";
  const statuses = (await query("SELECT status FROM contracts WHERE property_id=$1 AND deal_type=$2", [property.id, contract.deal_type])).rows.map((row) => row.status);
  let target;
  if (statuses.some((status) => status === "active" || (status === "completed" && contract.deal_type === "buy"))) target = closed;
  else if (statuses.some((status) => status === "approved" || status === "customer_pending")) target = "reserved";
  else target = "available";
  const currentState = property[field] || "available";
  if (target === currentState) return;
  // Freeing a property only undoes what a contract did; a hand-set Reserved on a
  // property whose contract is still in draft is left alone.
  if (target === "available" && !(PROPERTY_RELEASE_ACTIONS.has(action) && [closed, "reserved"].includes(currentState))) return;
  const next = { ...property, [field]: target };
  const status = overallStatus(next, property.status);
  await query(`UPDATE properties SET ${field}=$1, status=$2 WHERE id=$3`, [target, status, property.id]);
  await recordPropertyHistory(property.id, userId, "status_changed", { from: property.status, to: status, [field.replace("_status", "")]: target, contract_id: contract.id, action });
  // The customer is a client in force once their contract is.
  if (contract.status === "active" && contract.client_id) {
    await query("UPDATE clients SET status='active' WHERE id=$1 AND status='lead'", [contract.client_id]);
  }
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

/** Months covered by an agreement duration (days and weeks round up to whole months). */
function leaseMonths(duration, unit = "months") {
  const value = Number(duration);
  if (!Number.isFinite(value) || value <= 0) return 0;
  switch (String(unit || "months").toLowerCase()) {
    case "years": return value * 12;
    case "weeks": return Math.max(1, Math.ceil((value * 7) / 30));
    case "days": return Math.max(1, Math.ceil(value / 30));
    default: return value;
  }
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
    // An installment's status is never typed in: it follows the approved
    // payments against it (see Payment.syncInstallment). A `status` in the body
    // is ignored, so nobody can mark money as received without recording it.
    status: current.id ? current.status : "pending",
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
    // A unit in a building: its floor (0 = ground, negative = basement) and the
    // unit number the staff gives it. Both optional.
    floor: optionalFloor(body.floor === undefined ? current.floor : body.floor),
    unit_number: optionalUnitNumber(body.unit_number === undefined ? current.unit_number : body.unit_number),
  };
}

function optionalUnitNumber(value) {
  const text = optionalText(typeof value === "number" ? String(value) : value, "unit_number", 20);
  if (text && !/^[\p{L}\p{N}][\p{L}\p{N} ./-]*$/u.test(text)) throw new HttpError(400, "unit_number may use letters, numbers, spaces, '.', '/' and '-' (for example 304 or B-12)");
  return text || null;
}

function optionalFloor(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < -5 || n > 200) throw new HttpError(400, "floor must be a whole number from -5 to 200 (0 is the ground floor)");
  return n;
}

/** A unit number is used once per project. */
async function assertUnitNumberFree(data, exceptId = null) {
  if (!data.project_id || !data.unit_number) return;
  const taken = await queryOne(
    "SELECT p.id, p.name FROM properties p WHERE p.project_id=$1 AND lower(p.unit_number)=lower($2) AND ($3::int IS NULL OR p.id<>$3) LIMIT 1",
    [data.project_id, data.unit_number, exceptId],
  );
  if (taken) throw new HttpError(409, `Unit ${data.unit_number} already exists in this project (${taken.name}). Use another unit number.`);
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


/**
 * "Agrees to receive offers about new properties" on a client. Stored apart
 * from validateClient (whose fixed-arity UPDATE must not grow), and only when
 * the request carries the field, so other client edits leave it untouched.
 */
async function setMarketingOptIn(clientId, body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, "marketing_opt_in")) return;
  const value = body.marketing_opt_in === true || body.marketing_opt_in === 1 || body.marketing_opt_in === "1" || body.marketing_opt_in === "on";
  await query("UPDATE clients SET marketing_opt_in=$1, marketing_opt_in_at=CASE WHEN $1 AND NOT marketing_opt_in THEN NOW() WHEN $1 THEN marketing_opt_in_at END WHERE id=$2", [value, clientId]);
}

/**
 * Diaspora client (lives abroad) and their country. Only diaspora clients can
 * be invited to the customer portal; un-marking one disables their portal.
 */
async function setDiasporaFields(clientId, body, access = null) {
  // The Diaspora Desk only ever works diaspora customers: whatever it creates or
  // edits stays a diaspora client (and so stays visible to the desk).
  if (access?.diasporaDeskOnly) body = { ...(body || {}), is_diaspora: true };
  if (!body) return;
  if (Object.prototype.hasOwnProperty.call(body, "country")) {
    await query("UPDATE clients SET country=$1 WHERE id=$2", [String(body.country || "").trim().slice(0, 80) || null, clientId]);
  }
  if (!Object.prototype.hasOwnProperty.call(body, "is_diaspora")) return;
  const value = body.is_diaspora === true || body.is_diaspora === 1 || body.is_diaspora === "1" || body.is_diaspora === "on";
  await query("UPDATE clients SET is_diaspora=$1 WHERE id=$2", [value, clientId]);
  if (!value) await disablePortalAccount(clientId);
}

async function disablePortalAccount(clientId) {
  const account = await queryOne("UPDATE customer_accounts SET status='disabled' WHERE client_id=$1 AND status<>'disabled' RETURNING id", [clientId]);
  if (account) await query("DELETE FROM customer_sessions WHERE account_id=$1", [account.id]);
  return Boolean(account);
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

// Money is received only on a contract that has been approved: from the MD's
// approval (deposit at signing) through the active life of the contract. A
// draft, a contract under review, or a rejected/cancelled one takes no money.
export const PAYABLE_CONTRACT_STATUSES = new Set(["approved", "customer_pending", "active"]);

async function validatePayment(body, current = {}) {
  const contractId = parseId(body.contract_id ?? current.contract_id, "contract_id");
  // The contract and installment are read through the caller's own scope
  // (organization + role/department visibility), so a payment can never be
  // written against - or reveal the client of - a contract they cannot see.
  const contract = requireRecord(await Contract.get(contractId), "Contract");
  if (!PAYABLE_CONTRACT_STATUSES.has(contract.status)) {
    throw new HttpError(409, `payments can only be recorded on an approved or active contract (this one is ${String(contract.status).replace(/_/g, " ")})`);
  }
  // The transaction reference (bank, M-Pesa, Mixx, Airtel...) is what ties the
  // money to one real transfer. It is required, and one reference may back only
  // one live payment, so the same SMS or screenshot cannot be recorded twice.
  const reference = optionalText(body.reference ?? current.reference, "reference", 160)?.trim() || null;
  if (!reference) throw new HttpError(400, "reference is required: enter the transaction or receipt number from the bank or mobile-money message");
  const clash = await Payment.findByReference(reference, current.id || null);
  if (clash) {
    throw new HttpError(409, `reference ${reference} is already used by payment #${clash.id} (${clash.client_name}, ${clash.status}); the same transaction cannot be recorded twice`);
  }
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
    reference,
    notes: optionalText(body.notes ?? current.notes, "notes"),
    // The proof as text: a pasted SMS or a short description of the slip. A
    // receipt file is the other kind of proof; one of the two is required
    // before the payment can be approved.
    evidence_text: optionalText(body.evidence_text ?? current.evidence_text, "evidence_text", 4000),
  };
}

/** A payment has proof when it carries a receipt file or the pasted message. */
function paymentHasEvidence(payment) {
  return Boolean(payment?.receipt_document_id || payment?.receipt_stored_name || String(payment?.evidence_text || "").trim());
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
      .filter((name) => canTransition(contract.status, name) && !transitionBlockedReason(contract, name))
      .map((name) => ({ action: name, label: CONTRACT_ACTIONS[name].label, to: CONTRACT_ACTIONS[name].to })),
    position: contractPosition(contract),
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
    if (user && user.active !== false && user.password_reset_expires_at && new Date(user.password_reset_expires_at) > new Date()) {
      throw new HttpError(401, "Your password was reset by the administrator. Click \"Forgot password?\" to choose a new one.");
    }
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
// Forgot password. Staff never get an e-mailed link: they ask the
// administrator, who opens a reset (POST /org/users/:id/reset-password). While
// that reset is open (24 hours) "Forgot password?" lets the person choose a new
// password; otherwise it tells them to contact the administrator.
const passwordResetLimit = rateLimit({ name: "password-reset", limit: 20, windowMs: 15 * 60 * 1000 });
async function openResetFor(email) {
  return queryOne("SELECT id, email, active FROM users WHERE LOWER(email)=LOWER($1) AND role<>'admin' AND active AND password_reset_expires_at > NOW()", [email]);
}
router.post("/auth/forgot-password", passwordResetLimit, route(async (req, res) => {
  const email = validEmail(req.body?.email, "email");
  if (!email) throw new HttpError(400, "enter your work email");
  const open = await openResetFor(email);
  res.json(open
    ? { reset_ready: true, message: "Your administrator has reset your password. Choose a new one." }
    : { reset_ready: false, message: "Contact your administrator to reset your password, then come back here." });
}));
router.post("/auth/reset-password", passwordResetLimit, route(async (req, res) => {
  const email = validEmail(req.body?.email, "email");
  if (!email) throw new HttpError(400, "enter your work email");
  const fresh = typeof req.body?.new_password === "string" ? req.body.new_password : "";
  const confirm = typeof req.body?.confirm_password === "string" ? req.body.confirm_password : "";
  if (fresh.length < 8 || fresh.length > 128) throw new HttpError(400, "the new password must be between 8 and 128 characters");
  if (fresh !== confirm) throw new HttpError(400, "the two passwords do not match");
  if (isDemoPassword(email, fresh)) throw new HttpError(400, "that password follows the published demo scheme; choose another");
  const open = await openResetFor(email);
  if (!open) throw new HttpError(403, "There is no password reset for this account. Contact your administrator.");
  // One use only: the reset closes in the same statement that sets the password.
  const saved = await queryOne("UPDATE users SET password_hash=$1, password_reset_expires_at=NULL, password_reset_by=NULL WHERE id=$2 AND password_reset_expires_at > NOW() RETURNING id", [hashPassword(fresh), open.id]);
  if (!saved) throw new HttpError(403, "There is no password reset for this account. Contact your administrator.");
  await query("DELETE FROM sessions WHERE user_id=$1", [open.id]);
  recordLoginSuccess(req, email);
  await audit({ user: { id: open.id } }, "password_set_after_reset", "user", open.id, { email: open.email });
  res.json({ ok: true, message: "Your new password is saved. Sign in with it now." });
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
// The diaspora customer portal: its own accounts and sessions, never a staff
// session (routes/customer.js). Mounted before the staff login on purpose.
router.use("/customer", customerRoutes);
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
// Customer invoices (Finance Manager, MD). The customer side is in customer.js.
router.use("/org/customer-payments", customerPaymentRoutes);
router.use("/org", orgRoutes);

router.get("/projects", route(async (req, res) => {
  if (!paginationRequested(req.query)) return res.json(await Project.all());
  const paged = await paginatedList({ build: () => Project.paged(searchTerm(req.query.search)), ...parsePagination(req.query) });
  res.json({ data: paged.rows, pagination: paged.pagination });
}));
router.get("/projects/:id", route(async (req, res) => res.json(requireRecord(await Project.get(parseId(req.params.id)), "Project"))));
router.post("/projects", route(async (req, res) => {
  const data = validateProject(req.body || {});
  const result = await Project.create(data.name, data.status, data);
  res.status(201).json(await Project.get(result.id));
}));
router.put("/projects/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const current = requireRecord(await Project.get(id), "Project");
  const data = validateProject(req.body || {}, current);
  await Project.update(id, data.name, data.status, data);
  res.json(await Project.get(id));
}));
router.delete("/projects/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  requireRecord(await Project.get(id), "Project");
  // A project's contracts (and their installments and payments) would be
  // deleted with it, so a project with recorded money is never deleted.
  if (await queryOne("SELECT 1 AS ok FROM payments p JOIN contracts c ON c.id=p.contract_id WHERE c.project_id=$1 LIMIT 1", [id])) {
    throw new HttpError(409, "this project has contracts with recorded payments and cannot be deleted");
  }
  await Project.remove(id);
  res.json({ ok: true });
}));


router.get("/contracts", route(async (req, res) => {
  const projectId = req.query.project_id === undefined ? null : parseId(req.query.project_id, "project_id");
  const type = req.query.type || null;
  if (type && !contractTypes.has(type)) throw new HttpError(400, "type is invalid");
  // Every row says where the contract is right now (Under Sales / Legal /
  // Finance / MD review ...), in the bare list and in a page alike.
  const withPosition = (rows) => rows.map((contract) => ({ ...contract, position: contractPosition(contract) }));
  if (!paginationRequested(req.query)) return res.json(withPosition(await Contract.all(projectId, type)));
  const paged = await paginatedList({ build: () => Contract.paged(projectId, type, searchTerm(req.query.search)), ...parsePagination(req.query) });
  // The rows are returned exactly as `Contract.all` returns them - no
  // `contractResponse` enrichment. The default list has never applied it (only
  // the single-record route does), so a page must not quietly grow an extra
  // `available_actions` field the unpaged caller does not receive.
  res.json({ data: withPosition(paged.rows), pagination: paged.pagination });
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
  // Legal -> Finance -> MD: the business preconditions the status cannot express.
  const blocked = transitionBlockedReason(contract, name);
  if (blocked) throw new HttpError(409, blocked);
  // No contract goes forward while its request has an unpaid invoice.
  if (name === "submit") {
    const unpaid = await invoiceBlockingContract(contract.client_id, contract.property_id);
    if (unpaid) throw new HttpError(409, contractBlockedMessage(unpaid));
  }
  // Legal must sign off before the customer is ever asked to.
  if (name === "send_to_customer" && contract.requires_management_approval && contract.status !== "approved") {
    throw new HttpError(409, "this contract needs management approval before it goes to the customer");
  }
  const notes = optionalText(req.body?.notes, "notes", 2000);
  let signedBy = optionalText(req.body?.signed_by, "signed_by", 160);
  // A diaspora customer signed in the portal: the record says so, with when.
  if (name === "record_signature" && contract.channel === "diaspora" && contract.customer_accepted_at && !signedBy) {
    signedBy = `${contract.customer_accepted_name} (signed electronically in the portal, ${new Date(contract.customer_accepted_at).toISOString().slice(0, 16).replace("T", " ")} UTC)`.slice(0, 160);
  }
  if (name === "record_signature" && !signedBy) throw new HttpError(400, "signed_by is required to record a customer signature");
  // A contract comes into force only when the customer has signed AND paid what
  // is due at signing: the deposit (or, for cash, the whole price), confirmed by
  // Finance. The first installment of the plan is that payment.
  if (name === "record_signature") {
    const first = await queryOne("SELECT id, status, amount, notes FROM debts WHERE contract_id=$1 ORDER BY due_date NULLS LAST, id LIMIT 1", [id]);
    if (!first) throw new HttpError(409, "this contract has no payment plan yet; Finance must create it before the contract can become active");
    if (first.status !== "paid") throw new HttpError(409, `the ${String(first.notes || "first payment").toLowerCase()} must be paid and approved by Finance before the customer's signature is recorded`);
  }
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
  // Finance's validation turns the agreed terms into the payment plan.
  if (name === "finance_validate") await createScheduleFromTerms(id);
  // The property follows the contract (Reserved / Sold / Rented / available).
  await syncPropertyForContract(id, name, req.user.id);
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
  // A lease is priced from the property's rent: rent per month x the months of
  // the agreement, unless Sales entered a price themselves.
  if ((body.deal_type === "rent") && (body.original_price === undefined || body.original_price === null || body.original_price === "") && body.property_id) {
    const leased = await Property.get(parseId(body.property_id, "property_id"));
    const months = leaseMonths(body.agreement_duration, body.agreement_duration_unit);
    if (leased?.rent_price && months) {
      const monthly = leased.rent_period === "year" ? Number(leased.rent_price) / 12 : Number(leased.rent_price);
      body.original_price = Math.round(monthly * months * 100) / 100;
    }
  }
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
  // Cash: everything is paid at signing, as one installment due on the start
  // date. Installments: a deposit and equal installments. With no plan fields
  // the contract is simply created without a schedule.
  const paymentMode = body.payment_mode === undefined || body.payment_mode === null || body.payment_mode === ""
    ? null : enumValue(body.payment_mode, new Set(["cash", "installments"]), "installments", "payment_mode");
  if (paymentMode === "cash") {
    body.deposit = 0; body.installments = 1; body.frequency = "monthly";
    body.first_due_date = body.first_due_date || data.start_date;
  }
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
  // A customer living abroad gets the Diaspora agreement and the diaspora path
  // (verification first, e-signature in the portal, management approval).
  const diaspora = data.client_id ? Boolean((await queryOne("SELECT is_diaspora FROM clients WHERE id=$1", [data.client_id]))?.is_diaspora) : false;
  if (diaspora && !["buy", "rent"].includes(data.deal_type)) throw new HttpError(400, "a diaspora customer can buy or rent through the Diaspora Desk; a Sell mandate is made by Sales");
  const agreement = builtInAgreement(data.deal_type, diaspora ? "diaspora" : "standard");
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
    // Diaspora wording is fixed: a template may only be the letterhead around it.
    if (diaspora && !letterhead) {
      if (hasSelectedTemplate) throw new HttpError(400, "a diaspora contract uses the Diaspora agreement wording: choose a letterhead template or the built-in one");
      letterhead = false; templateId = null; templateWordPath = null;
    }
    if (templateId) {
      // A letterhead carries the type's wording; a full template its own.
      templateBody = letterhead ? String(template.body_text).replace(CONTRACT_BODY_TOKEN, agreement.body) : String(template.body_text);
      if (!letterhead) templateTitle = template.title || agreement.title;
      templateWordPath = templateWordFile(template);
      // In a Word letterhead the design is the file; the stored text is the wording.
      if (templateWordPath && letterhead) templateBody = agreement.body;
    }
  }
  const unknownTemplateTokens = templateWordPath
    ? await templateFileUnknownPlaceholders(fs.readFileSync(templateWordPath))
    : unknownPlaceholders(templateBody);
  if (unknownTemplateTokens.length) {
    throw new HttpError(400, `the selected template has unknown placeholder(s): ${unknownTemplateTokens.join(", ")}`);
  }

  // --- Create the contract through the existing model ----------------------
  await ensureContractClient(data);
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
  if (paymentMode || plan) await query("UPDATE contracts SET payment_mode=$1 WHERE id=$2", [paymentMode || "installments", created.id]);
  if (diaspora) await query("UPDATE contracts SET channel='diaspora', requires_management_approval=TRUE WHERE id=$1", [created.id]);
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
    const agreement = builtInAgreement(contract.deal_type, contract.channel);
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

// ---- Signed contract made outside the system --------------------------------
// The system-generated agreement carries no signatures. When the contract was
// signed on paper (or prepared outside the system), Legal or Sales uploads the
// signed copy here and it becomes the contract's official copy. Nothing is
// deleted: the generated agreement and any earlier signed copy stay in
// Documents, and every replacement is in the audit log.
const SIGNED_COPY_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp", ".doc", ".docx"]);
function requireSignedCopyRole(access) {
  if (!(can(access, "approve_legal") || can(access, "submit_contract") || can(access, "approve_management"))) {
    throw new HttpError(403, "only Legal, Sales or the Managing Director can attach the signed contract");
  }
}
router.post("/contracts/:id/signed-document", uploadDocumentFile, route(async (req, res) => {
  try {
    requireSignedCopyRole(req.access);
    const contract = requireRecord(await Contract.get(parseId(req.params.id)), "Contract");
    if (["rejected", "cancelled"].includes(contract.status)) throw new HttpError(409, `this contract is ${contract.status}; a signed copy cannot be attached`);
    const fileInfo = validateUploadedFile(req.file, SIGNED_COPY_EXTENSIONS);
    const signedBy = optionalText(req.body?.signed_by, "signed_by", 300);
    if (!signedBy) throw new HttpError(400, "signed_by is required: write who signed the contract (for example the customer and MKUYU's representative)");
    const note = optionalText(req.body?.notes, "notes", 1000);
    const created = await Document.create({
      project_id: contract.project_id || null, contract_id: contract.id, client_id: contract.client_id || null,
      title: `${contract.contract_number || `Contract #${contract.id}`} · Signed copy`, category: "agreement", status: "approved",
      file_reference: null, notes: [`Signed by: ${signedBy}`, note].filter(Boolean).join("\n"),
      original_filename: fileInfo.displayName, stored_name: fileInfo.storedName, file_size: fileInfo.size, mime_type: fileInfo.mimeType,
      uploaded_at: new Date().toISOString(),
    });
    const previous = contract.signed_document_id || null;
    await query("UPDATE contracts SET signed_document_id=$1, signed_uploaded_by=$2, signed_uploaded_at=NOW(), signed_by_names=$3 WHERE id=$4", [created.id, req.user.id, signedBy, contract.id]);
    await audit(req, previous ? "signed_contract_replaced" : "signed_contract_uploaded", "contract", contract.id, { document_id: created.id, replaced_document_id: previous, signed_by: signedBy, file: fileInfo.displayName });
    res.status(201).json(contractResponse(await Contract.get(contract.id), req));
  } catch (error) {
    cleanupUploadedFile(req.file);
    throw error;
  }
}));
router.get("/contracts/:id/signed-document", route(async (req, res) => {
  const contract = requireRecord(await Contract.get(parseId(req.params.id)), "Contract");
  if (!contract.signed_document_id) throw new HttpError(404, "No signed copy has been attached to this contract");
  const document = requireRecord(await queryOne("SELECT * FROM documents WHERE id=$1", [contract.signed_document_id]), "Signed copy");
  const fullPath = resolveStoredFile(documentUploadsDir, document.stored_name);
  if (!fullPath) throw new HttpError(404, "The signed copy file is missing");
  return sendStoredFile(res, fullPath, document.mime_type, document.original_filename || document.stored_name, req.query.download === "1");
}));
router.get("/contract-placeholders", route(async (req, res) => { res.json(CONTRACT_PLACEHOLDERS); }));

router.post("/contracts", route(async (req, res) => {
  requireContractAuthor(req.access);
  const data = await ensureContractClient(await validateContract(req.body || {}));
  const diaspora = data.client_id ? Boolean((await queryOne("SELECT is_diaspora FROM clients WHERE id=$1", [data.client_id]))?.is_diaspora) : false;
  if (diaspora && !["buy", "rent"].includes(data.deal_type)) throw new HttpError(400, "a diaspora customer can buy or rent through the Diaspora Desk; a Sell mandate is made by Sales");
  const result = await Contract.create(data);
  // A diaspora customer's contract follows the diaspora path even when it is
  // created without its document; the document is generated before it is sent.
  if (diaspora) await query("UPDATE contracts SET channel='diaspora', requires_management_approval=TRUE WHERE id=$1", [result.id]);
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
  // Deleting a contract would cascade to its installments and payments. Once
  // money has been recorded against it, the financial history must survive:
  // such a contract is cancelled, never deleted.
  if (await queryOne("SELECT 1 AS ok FROM payments WHERE contract_id=$1 LIMIT 1", [id])) {
    throw new HttpError(409, "this contract has recorded payments and cannot be deleted; cancel it instead so its financial history is kept");
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
    const withPayments = Number((await queryOne("SELECT (EXISTS(SELECT 1 FROM debts d JOIN payments p ON p.debt_id=d.id WHERE d.contract_id=$1 AND d.organization_id=$2) OR EXISTS(SELECT 1 FROM debts d JOIN payment_allocations pa ON pa.debt_id=d.id WHERE d.contract_id=$1 AND d.organization_id=$2))::int AS count", [id, orgId])).count);
    if (withPayments > 0) {
      throw new HttpError(409, "cannot replace the schedule: some installments already have recorded payments");
    }
  }
  if (existing > 0) await query("DELETE FROM debts WHERE contract_id=$1 AND organization_id=$2", [id, orgId]);
  const createdIds = await insertSchedule(contract, { deposit, installments, firstDueDate, frequency });
  // The plan Finance settled on is the contract's plan from now on.
  await query("UPDATE contracts SET deposit_amount=$1, installment_count=$2, first_due_date=$3, payment_frequency=$4 WHERE id=$5", [deposit, installments, firstDueDate, frequency, id]);
  res.status(201).json({ created: createdIds.length, debts: await Promise.all(createdIds.map((debtId) => Debt.get(debtId))) });
}));

/**
 * Writes a contract's installments (deposit first) and their reminders.
 * Installments inherit the contract's ownership, so a sales-owned contract never
 * silently hands its payment schedule to whoever created the schedule.
 */
async function insertSchedule(contract, { deposit, installments, firstDueDate, frequency }) {
  const orgId = await organizationId();
  const rows = buildSchedule(contract, { deposit, installments, firstDueDate, monthsPerStep: monthsPerFrequency(frequency) });
  const inherited = { owner_id: contract.owner_id ?? null, created_by: contract.created_by ?? null, department_id: contract.department_id ?? null, visibility: contract.visibility || "organization" };
  const createdIds = [];
  for (const row of rows) {
    const result = await queryOne("INSERT INTO debts (organization_id,contract_id,client_name,amount,due_date,status,notes,owner_id,created_by,department_id,visibility) VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10) RETURNING id", [orgId, contract.id, contract.client_name, row.amount, row.due_date, row.label, inherited.owner_id, inherited.created_by, inherited.department_id, inherited.visibility]);
    createdIds.push(result.id);
  }
  for (let index = 0; index < createdIds.length; index += 1) {
    await Payment.syncInstallment(createdIds[index]);
    await syncDebtReminderFromDb(createdIds[index]);
  }
  return createdIds;
}

/**
 * When Finance validates a contract, its payment plan is created from the terms
 * Sales put in the agreement (deposit, number of installments, frequency, first
 * due date), so the schedule can never differ from what the customer signs.
 * Nothing happens if the contract already has installments or has no plan.
 */
async function createScheduleFromTerms(contractId) {
  const contract = await queryOne("SELECT * FROM contracts WHERE id=$1", [contractId]);
  if (!contract || !(Number(contract.value) > 0)) return 0;
  const existing = Number((await queryOne("SELECT COUNT(*)::int AS n FROM debts WHERE contract_id=$1", [contractId])).n);
  if (existing > 0) return 0;
  const installments = Number(contract.installment_count || 0);
  if (!installments || !contract.first_due_date) return 0;
  const deposit = Number(contract.deposit_amount || 0);
  if (deposit >= Number(contract.value)) return 0;
  const ids = await insertSchedule(contract, { deposit, installments, firstDueDate: String(contract.first_due_date).slice(0, 10), frequency: contract.payment_frequency || "monthly" });
  return ids.length;
}

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
  await Payment.syncInstallment(id);
  await syncDebtReminderFromDb(id);
  res.status(201).json(await Debt.get(id));
}));
router.put("/debts/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const current = requireRecord(await Debt.get(id), "Debt");
  const data = await validateDebt(req.body || {}, current);
  await Debt.update(id, data);
  // A changed amount or due date can change the derived status.
  await Payment.syncInstallment(id);
  await syncDebtReminderFromDb(id);
  res.json(await Debt.get(id));
}));
// "Mark paid" without money is gone: an installment is paid only by approved
// payments. The route answers with a clear instruction instead of a 404.
router.post("/debts/:id/pay", route(async () => {
  throw new HttpError(410, "an installment cannot be marked paid by hand; record the payment with its reference and proof, and it is settled once Finance approves it");
}));
router.delete("/debts/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  requireRecord(await Debt.get(id), "Debt");
  if (await queryOne("SELECT 1 AS ok FROM payments WHERE debt_id=$1 UNION ALL SELECT 1 FROM payment_allocations WHERE debt_id=$1 LIMIT 1", [id])) {
    throw new HttpError(409, "this installment has recorded payments and cannot be deleted");
  }
  await Debt.remove(id);
  res.json({ ok: true });
}));

// ---- Simple payment entry ------------------------------------------------
// Finance types a few letters of the customer (or pastes the SMS / bank
// message) and picks the right contract from a short list. The list shows
// each payable contract with what is still owed and the next installment.
function requireFinancialAccess(req) {
  if (!can(req.access, "view_financial")) throw new HttpError(403, "payments are handled by Finance");
}
const DAY_MS = 86400000;
async function payableContracts(req) {
  const values = [await organizationId()];
  const scope = scopeCondition("c", "contract", req.access, values, { read: true });
  const contracts = (await query(`SELECT c.id, c.contract_number, c.client_id, c.client_name, c.client_phone, c.deal_type, c.status, c.payment_mode, c.value, c.end_date,
        cl.phone AS register_phone, cl.name AS register_name, pr.name AS property_name
      FROM contracts c LEFT JOIN clients cl ON cl.id=c.client_id LEFT JOIN properties pr ON pr.id=c.property_id
      WHERE c.organization_id=$1 AND c.status IN ('approved','customer_pending','active') AND ${scope}
      ORDER BY c.id DESC LIMIT 1000`, values)).rows;
  if (!contracts.length) return [];
  const debts = (await query(`SELECT d.id, d.contract_id, d.notes AS label, d.due_date, d.amount,
        COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.status='approved' WHERE pa.debt_id=d.id), 0) AS paid
      FROM debts d WHERE d.contract_id = ANY($1::int[]) ORDER BY d.contract_id, d.due_date NULLS LAST, d.id`, [contracts.map((row) => row.id)])).rows;
  const byContract = new Map();
  for (const debt of debts) {
    if (!byContract.has(debt.contract_id)) byContract.set(debt.contract_id, []);
    byContract.get(debt.contract_id).push(debt);
  }
  const iso = (value) => (value ? new Date(value).toISOString().slice(0, 10) : null);
  return contracts.map((contract) => {
    const rows = byContract.get(contract.id) || [];
    const open = rows.map((debt, index) => {
      const balance = Math.max(0, Math.round((Number(debt.amount) - Number(debt.paid)) * 100) / 100);
      // A lease installment pays for a period: from its due date to the day
      // before the next one (the last runs to the end of the lease).
      let period = null;
      if (contract.deal_type === "rent" && debt.due_date) {
        const next = rows[index + 1]?.due_date;
        const end = next ? new Date(new Date(next).getTime() - DAY_MS) : (contract.end_date ? new Date(contract.end_date) : null);
        period = { start: iso(debt.due_date), end: end ? iso(end) : null };
      }
      return { debt_id: debt.id, label: debt.label || "Installment", due_date: iso(debt.due_date), amount: Number(debt.amount), balance, period };
    }).filter((debt) => debt.balance > 0);
    return {
      contract_id: contract.id, contract_number: contract.contract_number, client_id: contract.client_id,
      client_name: contract.client_name || contract.register_name, phones: [contract.client_phone, contract.register_phone].map(normalizePhone).filter(Boolean),
      deal_type: contract.deal_type, status: contract.status, payment_mode: contract.payment_mode, property_name: contract.property_name,
      open_balance: Math.round(open.reduce((sum, debt) => sum + debt.balance, 0) * 100) / 100,
      next_due: open[0] || null, open_debts: open,
    };
  });
}
const lookupText = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
router.get("/payments/lookup", route(async (req, res) => {
  requireFinancialAccess(req);
  const q = lookupText(req.query.q);
  const digits = q.replace(/\D/g, "");
  const all = await payableContracts(req);
  const matches = !q ? all : all.filter((entry) =>
    lookupText(entry.client_name).includes(q) || lookupText(entry.contract_number).includes(q) || lookupText(entry.property_name).includes(q)
    || (digits.length >= 4 && entry.phones.some((phone) => phone.includes(normalizePhone(digits) || digits))));
  matches.sort((a, b) => String(a.next_due?.due_date || "9999").localeCompare(String(b.next_due?.due_date || "9999")));
  res.json(matches.slice(0, 12));
}));
/** Contracts this payer has paid before (by phone or name), with how often. */
async function learnedContracts(parsed) {
  const learned = new Map();
  if (!parsed.payer_phone && !parsed.payer_name) return learned;
  const values = [await organizationId(), parsed.payer_phone || null, parsed.payer_name || null];
  for (const row of (await query("SELECT contract_id, COUNT(*)::int AS n FROM payments WHERE organization_id=$1 AND status<>'reversed' AND ((payer_phone IS NOT NULL AND payer_phone=$2) OR (payer_name IS NOT NULL AND UPPER(payer_name)=UPPER($3))) GROUP BY contract_id", values)).rows) learned.set(row.contract_id, row.n);
  return learned;
}
/** Ranks the payable contracts for one payment: best match first, with the reasons. */
function rankContracts(parsed, all, learned) {
  const payerWords = lookupText(parsed.payer_name).split(" ").filter((word) => word.length >= 3);
  return all.map((entry) => {
    let score = 0;
    const reasons = [];
    if (parsed.contract_number && entry.contract_number === parsed.contract_number) { score += 100; reasons.push("contract number in the message"); }
    if (learned.has(entry.contract_id)) { score += 60; reasons.push("this payer paid this contract before"); }
    if (parsed.payer_phone && entry.phones.includes(parsed.payer_phone)) { score += 50; reasons.push("phone number matches"); }
    if (payerWords.length) {
      const name = lookupText(entry.client_name);
      const hits = payerWords.filter((word) => name.includes(word)).length;
      if (hits === payerWords.length) { score += 30; reasons.push("name matches"); } else if (hits) { score += 15; reasons.push("name partly matches"); }
    }
    if (parsed.amount) {
      if (entry.next_due && Math.abs(entry.next_due.balance - parsed.amount) < 1) { score += 25; reasons.push("amount equals the next installment"); }
      else if (entry.open_debts.some((debt) => Math.abs(debt.balance - parsed.amount) < 1)) { score += 15; reasons.push("amount equals an installment"); }
    }
    return { ...entry, score, reasons };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || String(a.next_due?.due_date || "9999").localeCompare(String(b.next_due?.due_date || "9999")));
}
router.post("/payments/parse-message", route(async (req, res) => {
  requireFinancialAccess(req);
  const text = optionalText(req.body?.text, "text", 4000) || "";
  const parsed = parsePaymentMessage(text);
  const all = await payableContracts(req);
  const suggestions = rankContracts(parsed, all, await learnedContracts(parsed)).slice(0, 5);
  const duplicate = parsed.reference ? await Payment.findByReference(parsed.reference, null) : null;
  res.json({ parsed, suggestions, duplicate: duplicate ? { id: duplicate.id, client_name: duplicate.client_name, status: duplicate.status } : null });
}));

// ---- Bank statement upload -----------------------------------------------
// Finance downloads the day's statement from internet banking (CSV or Excel)
// and uploads it. Every credit is shown with the contract it most likely
// belongs to; Finance checks the list and saves the ones they want at once.
const statementUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single("file");
router.post("/payments/statement", (req, res, next) => statementUpload(req, res, (error) => (error ? next(new HttpError(400, error.message)) : next())), route(async (req, res) => {
  requireFinanceDesk(req);
  if (!req.file?.buffer?.length) throw new HttpError(400, "choose the statement file (CSV or Excel)");
  const { credits, skipped, columns } = await parseStatement(req.file.buffer, req.file.originalname);
  const all = await payableContracts(req);
  const rows = [];
  for (const credit of credits) {
    const duplicate = await Payment.findByReference(credit.reference, null);
    const ranked = rankContracts(credit, all, await learnedContracts(credit)).slice(0, 3);
    // A contract number that is not open for payments yet (still in review).
    let note = null;
    if (credit.contract_number && !ranked.some((entry) => entry.contract_number === credit.contract_number)) {
      const named = await queryOne("SELECT status, finance_validated_at FROM contracts WHERE organization_id=$1 AND contract_number=$2", [await organizationId(), credit.contract_number]);
      if (named) note = `${credit.contract_number} is not approved yet (${contractPosition(named).label}); it takes payments once the MD has approved it`;
    }
    rows.push({ ...credit, note, already_recorded: duplicate ? { id: duplicate.id, client_name: duplicate.client_name, status: duplicate.status } : null, suggestions: ranked.map((entry) => ({ contract_id: entry.contract_id, contract_number: entry.contract_number, client_name: entry.client_name, deal_type: entry.deal_type, score: entry.score, reasons: entry.reasons })) });
  }
  res.json({ rows, skipped, columns, contracts: all.map((entry) => ({ contract_id: entry.contract_id, contract_number: entry.contract_number, client_name: entry.client_name, deal_type: entry.deal_type })) });
}));
router.post("/payments/statement/save", route(async (req, res) => {
  requireFinanceDesk(req);
  const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 500) : [];
  if (!rows.length) throw new HttpError(400, "choose at least one line to save");
  const approve = req.body?.approve === true;
  if (approve && await Payment.otherApprovers(req.user.id) > 0) throw new HttpError(403, "another Finance person must approve these payments; save them without approving");
  const results = [];
  for (const row of rows) {
    try {
      const data = await validatePayment({ contract_id: row.contract_id, amount: row.amount, paid_at: row.paid_at, method: "bank", reference: row.reference, notes: row.notes || null, evidence_text: `Bank statement line: ${String(row.description || "").slice(0, 300)} (${row.paid_at}, TZS ${row.amount})` });
      const created = await Payment.create(data);
      if (row.payer_name || row.payer_phone) await query("UPDATE payments SET payer_name=$1, payer_phone=$2 WHERE id=$3", [row.payer_name ? String(row.payer_name).toUpperCase().slice(0, 120) : null, normalizePhone(row.payer_phone), created.id]);
      const saved = approve ? await approvePayment(req, created.id) : paymentResponse(await Payment.get(created.id));
      results.push({ line: row.line, ok: true, payment_id: created.id, status: saved.status, receipt_number: saved.receipt_number || null });
    } catch (error) {
      results.push({ line: row.line, ok: false, error: error.message });
    }
  }
  await audit(req, "bank_statement_saved", "payment", null, { lines: rows.length, saved: results.filter((r) => r.ok).length, approved: approve });
  res.json({ results, saved: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
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
  await checkApproveNow(req);
  const data = await validatePayment(req.body || {});
  if (!data.evidence_text) {
    throw new HttpError(400, "proof is required: paste the bank or mobile-money message, or record the payment with its receipt file");
  }
  if (data.debt_id) requireRecord(await Debt.get(data.debt_id), "Debt");
  const result = await Payment.create(data);
  await Payment.syncInstallment(data.debt_id);
  await syncDebtReminderFromDb(data.debt_id);
  res.status(201).json(await afterPaymentCreated(req, result.id));
}));
// Create a payment with an optional receipt file in one request.
router.post("/payments/upload", uploadDocumentFile, route(async (req, res) => {
  let paymentId = null;
  try {
    await checkApproveNow(req);
    const data = await validatePayment(req.body || {});
    if (data.debt_id) requireRecord(await Debt.get(data.debt_id), "Debt");
    if (!req.file && !data.evidence_text) {
      throw new HttpError(400, "proof is required: attach the receipt or paste the bank or mobile-money message");
    }
    const fileInfo = req.file ? validateUploadedFile(req.file, documentExtensions) : null;
    const contract = fileInfo ? requireRecord(await Contract.get(data.contract_id), "Contract") : null;
    const orgId = await organizationId();
    await withTransaction(async (client) => {
      const payment = await client.query(
        // Ownership is recorded like any other payment (who recorded it matters
        // for approval: nobody approves their own payment).
        "INSERT INTO payments (organization_id,contract_id,debt_id,client_name,amount,paid_at,method,reference,notes,evidence_text,owner_id,created_by,department_id,visibility) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id",
        [orgId, data.contract_id, data.debt_id || null, data.client_name, data.amount, data.paid_at, data.method || "cash", data.reference || null, data.notes || null, data.evidence_text || null, ...Object.values((({ owner_id, created_by, department_id, visibility }) => ({ owner_id, created_by, department_id, visibility }))(ownershipFields(req.access)))],
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
  res.status(201).json(await afterPaymentCreated(req, paymentId));
}));
router.put("/payments/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const current = requireRecord(await Payment.get(id), "Payment");
  if (current.status !== "pending") {
    throw new HttpError(409, current.status === "approved"
      ? "an approved payment cannot be edited; reverse it with a reason and record the correct payment"
      : "a reversed payment cannot be edited");
  }
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
  res.json(await approvePayment(req, parseId(req.params.id)));
}));
async function approvePayment(req, id) {
  if (!canPermission(req.access, "validate_finance") || !canPermission(req.access, "view_financial")) {
    throw new HttpError(403, "only Finance can approve payments");
  }
  const payment = requireRecord(await Payment.get(id), "Payment");
  if (payment.status === "approved") throw new HttpError(409, "this payment is already approved");
  if (payment.status === "reversed") throw new HttpError(409, "a reversed payment cannot be approved");
  // Two-person rule: a second Finance person confirms the money. While MKUYU has
  // only ONE Finance person, that person may approve their own entry; the
  // payment is marked self-approved for the MD to review. The moment a second
  // Finance person exists, the two-person rule applies again by itself.
  const selfApproved = Number(payment.created_by) === Number(req.user.id);
  if (selfApproved && await Payment.otherApprovers(req.user.id) > 0) {
    throw new HttpError(403, "a payment must be approved by someone other than the person who recorded it");
  }
  if (!paymentHasEvidence(payment)) throw new HttpError(409, "attach the receipt or paste the bank / mobile-money message before approving this payment");
  const result = await Payment.approve(id, req.user.id, { selfApproved });
  if (!result.rowCount) throw new HttpError(409, "this payment could not be approved");
  // Approval is the moment the money counts: it is spread over the oldest
  // unpaid installments (surplus onto the next) and they settle now.
  await resyncInstallmentState([payment.debt_id, ...(result.touchedDebts || [])]);
  await audit(req, "payment_approved", "payment", id, { amount: payment.amount, contract_id: payment.contract_id, reference: payment.reference, self_approved: selfApproved });
  // The customer's receipt goes out by e-mail in the background (when e-mail
  // is set up); a mail problem never affects the approval.
  emailReceipt(id).catch((error) => console.warn(`receipt e-mail failed: ${error.message}`));
  // ...and the SMS: "received, balance, next installment", or "fully paid".
  noticeAfterPayment(id).catch((error) => console.warn(`payment SMS failed: ${error.message}`));
  return paymentResponse(await Payment.get(id));
}

/**
 * "Save & approve" is only for a Finance person who may approve their own entry
 * (MKUYU's single-Finance mode). Checked BEFORE the payment is written, so a
 * refusal never leaves a half-done request behind.
 */
async function checkApproveNow(req) {
  const body = req.body || {};
  if (!(body.approve_now === true || body.approve_now === "true" || body.approve_now === "1")) return;
  if (!canPermission(req.access, "validate_finance") || !canPermission(req.access, "view_financial")) throw new HttpError(403, "only Finance can approve payments");
  if (await Payment.otherApprovers(req.user.id) > 0) throw new HttpError(403, "another Finance person must approve this payment; save it without approving");
}

/** After a payment is created: remember who paid, and approve at once when asked. */
async function afterPaymentCreated(req, paymentId) {
  const body = req.body || {};
  const payerName = optionalText(body.payer_name, "payer_name", 120);
  const payerPhone = normalizePhone(body.payer_phone);
  if (payerName || payerPhone) await query("UPDATE payments SET payer_name=$1, payer_phone=$2 WHERE id=$3", [payerName ? payerName.toUpperCase() : null, payerPhone, paymentId]);
  const approveNow = body.approve_now === true || body.approve_now === "true" || body.approve_now === "1";
  if (approveNow) return approvePayment(req, paymentId);
  return paymentResponse(await Payment.get(paymentId));
}

// Reversal: the correction for an approved payment that was wrong (bounced,
// recorded on the wrong contract, wrong amount). The payment stays in the
// ledger with who reversed it and why; it simply stops counting.
router.post("/payments/:id/reverse", route(async (req, res) => {
  if (!canPermission(req.access, "validate_finance") || !canPermission(req.access, "view_financial")) {
    throw new HttpError(403, "only Finance can reverse payments");
  }
  const id = parseId(req.params.id);
  const payment = requireRecord(await Payment.get(id), "Payment");
  if (payment.status !== "approved") {
    throw new HttpError(409, payment.status === "reversed" ? "this payment is already reversed" : "only an approved payment is reversed; a pending one can be corrected or deleted");
  }
  const reason = optionalText(req.body?.reason, "reason", 500);
  if (!reason) throw new HttpError(400, "reason is required to reverse a payment");
  const result = await Payment.reverse(id, req.user.id, reason);
  if (!result.rowCount) throw new HttpError(409, "this payment could not be reversed");
  await resyncInstallmentState([payment.debt_id, ...(result.touchedDebts || [])]);
  await audit(req, "payment_reversed", "payment", id, { amount: payment.amount, contract_id: payment.contract_id, reference: payment.reference, reason });
  res.json(paymentResponse(await Payment.get(id)));
}));

// ---------------------------------------------------------------------------
// Refunds: money paid back to a customer (a lease's security deposit, a deal
// cancelled after a deposit). Same discipline as a payment: a reference, proof,
// and confirmation by a second Finance person (or self-approval while MKUYU has
// a single Finance person). Declared before /payments/:id so the paths win.
// ---------------------------------------------------------------------------
function requireFinanceDesk(req) {
  if (!canPermission(req.access, "validate_finance") || !canPermission(req.access, "view_financial")) {
    throw new HttpError(403, "only Finance can do this");
  }
}
router.get("/contracts/:id/refunds", route(async (req, res) => {
  requireFinanceDesk(req);
  const contractId = parseId(req.params.id);
  requireRecord(await Contract.get(contractId), "Contract");
  const rows = (await query(`SELECT r.*, cu.display_name AS created_by_name, au.display_name AS approved_by_name, c.client_name, c.contract_number
      FROM refunds r JOIN contracts c ON c.id = r.contract_id LEFT JOIN users cu ON cu.id = r.created_by LEFT JOIN users au ON au.id = r.approved_by
     WHERE r.organization_id=$1 AND ($2::int IS NULL OR r.contract_id=$2) ORDER BY r.created_at DESC LIMIT 500`, [await organizationId(), contractId])).rows;
  res.json(rows);
}));
router.post("/payments/refunds", route(async (req, res) => {
  requireFinanceDesk(req);
  const body = req.body || {};
  const contract = requireRecord(await Contract.get(parseId(body.contract_id, "contract_id")), "Contract");
  const amount = positiveNumber(body.amount, "amount");
  const reference = optionalText(body.reference, "reference", 160);
  if (!reference) throw new HttpError(400, "reference is required: the transfer or cheque number of the refund");
  const reason = optionalText(body.reason, "reason", 500);
  if (!reason) throw new HttpError(400, "reason is required (e.g. security deposit returned at the end of the lease)");
  const evidence = optionalText(body.evidence_text, "evidence_text", 4000);
  if (!evidence) throw new HttpError(400, "proof is required: paste the transfer message or describe the slip");
  const paidAt = optionalDate(body.paid_at, "paid_at") || await todayDate();
  const received = Number((await queryOne("SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE contract_id=$1 AND status='approved'", [contract.id])).t);
  const refunded = Number((await queryOne("SELECT COALESCE(SUM(amount),0) AS t FROM refunds WHERE contract_id=$1", [contract.id])).t);
  if (amount > received - refunded + 0.001) throw new HttpError(409, `a refund cannot exceed the money received on this contract (TZS ${(received - refunded).toLocaleString("en-US")} available)`);
  const method = enumValue(body.method, paymentMethods, "bank", "method");
  const row = await queryOne("INSERT INTO refunds (organization_id, contract_id, amount, paid_at, method, reference, reason, evidence_text, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
    [await organizationId(), contract.id, amount, paidAt, method, reference, reason, evidence, req.user.id]);
  await audit(req, "refund_recorded", "contract", contract.id, { refund_id: row.id, amount, reference, reason });
  res.status(201).json(row);
}));
router.post("/payments/refunds/:id/approve", route(async (req, res) => {
  requireFinanceDesk(req);
  const id = parseId(req.params.id);
  const refund = await queryOne("SELECT * FROM refunds WHERE id=$1 AND organization_id=$2", [id, await organizationId()]);
  if (!refund) throw new HttpError(404, "Refund not found");
  requireRecord(await Contract.get(refund.contract_id), "Contract");
  if (refund.status === "approved") throw new HttpError(409, "this refund is already approved");
  const selfApproved = Number(refund.created_by) === Number(req.user.id);
  if (selfApproved && await Payment.otherApprovers(req.user.id) > 0) throw new HttpError(403, "a refund must be approved by someone other than the person who recorded it");
  const row = await queryOne("UPDATE refunds SET status='approved', approved_by=$1, approved_at=NOW(), self_approved=$2 WHERE id=$3 AND status='pending' RETURNING *", [req.user.id, selfApproved, id]);
  await audit(req, "refund_approved", "contract", refund.contract_id, { refund_id: id, amount: refund.amount, self_approved: selfApproved });
  res.json(row);
}));

// The money side of one contract, for Finance and the MD: price, what has been
// received and confirmed, how it is spread over the installments, the balance,
// the next installment due and anything overdue.
router.get("/contracts/:id/account", route(async (req, res) => {
  if (!can(req.access, "view_financial")) throw new HttpError(403, "the account of a contract requires financial access");
  const contract = requireRecord(await Contract.get(parseId(req.params.id)), "Contract");
  const orgId = await organizationId();
  const installments = (await query(
    `SELECT d.id, d.notes AS label, d.due_date, d.amount, d.status,
            COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.status='approved' WHERE pa.debt_id=d.id), 0) AS paid
       FROM debts d WHERE d.contract_id=$1 AND d.organization_id=$2 ORDER BY d.due_date NULLS LAST, d.id`, [contract.id, orgId])).rows
    .map((row) => ({ ...row, amount: Number(row.amount), paid: Number(row.paid), balance: Math.max(0, Math.round((Number(row.amount) - Number(row.paid)) * 100) / 100) }));
  const payments = (await query(
    `SELECT p.id, p.amount, p.paid_at, p.method, p.reference, p.status, p.receipt_number, p.self_approved, p.reversal_reason, ab.display_name AS approved_by_name
       FROM payments p LEFT JOIN users ab ON ab.id=p.approved_by WHERE p.contract_id=$1 AND p.organization_id=$2 ORDER BY p.paid_at, p.id`, [contract.id, orgId])).rows
    .map((row) => ({ ...row, amount: Number(row.amount) }));
  const refunds = (await query("SELECT id, amount, paid_at, method, reference, reason, status, self_approved FROM refunds WHERE contract_id=$1 ORDER BY created_at", [contract.id])).rows.map((row) => ({ ...row, amount: Number(row.amount) }));
  const sum = (rows, test) => Math.round(rows.filter(test).reduce((total, row) => total + Number(row.amount), 0) * 100) / 100;
  const price = Number(contract.value || 0);
  const received = sum(payments, (row) => row.status === "approved");
  const pending = sum(payments, (row) => row.status === "pending");
  const allocated = Math.round(installments.reduce((total, row) => total + row.paid, 0) * 100) / 100;
  const scheduled = Math.round(installments.reduce((total, row) => total + row.amount, 0) * 100) / 100;
  const refunded = sum(refunds, (row) => row.status === "approved");
  const today = (await todayDate());
  const open = installments.filter((row) => row.balance > 0);
  const next = open[0] || null;
  const overdue = open.filter((row) => row.due_date && String(row.due_date).slice(0, 10) < today);
  res.json({
    contract: { id: contract.id, contract_number: contract.contract_number, client_name: contract.client_name, status: contract.status, deal_type: contract.deal_type, payment_mode: contract.payment_mode || null, position: contractPosition(contract) },
    totals: {
      price, scheduled, received, pending_approval: pending, allocated,
      unapplied_credit: Math.max(0, Math.round((received - allocated) * 100) / 100),
      refunded, balance: Math.max(0, Math.round((price - received + refunded) * 100) / 100),
      overdue_count: overdue.length, overdue_amount: Math.round(overdue.reduce((total, row) => total + row.balance, 0) * 100) / 100,
    },
    next_due: next ? { id: next.id, label: next.label, due_date: next.due_date, amount: next.balance } : null,
    installments, payments, refunds,
  });
}));

// MKUYU's own receipt for an approved payment, as a PDF.
router.get("/payments/:id/mkuyu-receipt", route(async (req, res) => {
  const payment = requireRecord(await Payment.get(parseId(req.params.id)), "Payment");
  if (payment.status !== "approved" || !payment.receipt_number) throw new HttpError(409, "a receipt is issued once the payment is approved");
  const contract = requireRecord(await Contract.get(payment.contract_id), "Contract");
  const org = await queryOne("SELECT name FROM organizations WHERE id=$1", [await organizationId()]);
  const doc = new PDFDocument({ size: "A5", margin: 40 });
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `${req.query.download === "1" ? "attachment" : "inline"}; filename="${payment.receipt_number}.pdf"`);
  doc.pipe(res);
  writeReceiptPdf(doc, payment, contract, org?.name, await receiptCoverage(payment.id));
  doc.end();
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
  // Only a pending payment (never counted) may be deleted. Approved money is
  // reversed instead, so the ledger keeps every transaction that was confirmed.
  if (payment.status !== "pending") {
    throw new HttpError(409, payment.status === "approved"
      ? "an approved payment cannot be deleted; reverse it with a reason instead"
      : "a reversed payment stays in the ledger and cannot be deleted");
  }
  let document = null;
  await withTransaction(async (client) => {
    await client.query("DELETE FROM payments WHERE id=$1 AND status='pending'", [id]);
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

// ---- Backups in data/backups (see backups.js) ------------------------------
router.get("/backups", requireAdmin(), route((req, res) => res.json(listBackups())));
router.get("/backups/status", requireAdmin(), route((req, res) => res.json(autoBackupStatus())));
// Whether customer e-mails (receipts, reminders) are set up, and the latest ones sent.
router.get("/email/status", route(async (req, res) => {
  if (!req.access?.isAdmin && !can(req.access, "view_financial")) throw new HttpError(403, "only Finance and the administrator see e-mail status");
  const recent = (await query("SELECT kind, recipient, subject, status, error, created_at FROM email_log ORDER BY id DESC LIMIT 20")).rows;
  res.json({ configured: mailConfigured(), receipts: process.env.MAIL_RECEIPTS !== "0", reminders: process.env.MAIL_REMINDERS !== "0", reminder_days: Number(process.env.MAIL_REMINDER_DAYS || 3), recent });
}));
// ---- Diaspora customer portal: Sales invites a diaspora client ------------
// Everything about one client on a single screen (the client overlay): who they
// are, their portal sign-up, the property and project they took, what they have
// paid, and what they asked for. The client lookup enforces the caller's scope,
// and the contracts are filtered by the contract scope too.
router.get("/clients/:id/profile", route(async (req, res) => {
  const client = requireRecord(await Client.get(parseId(req.params.id)), "Client");
  const extra = await queryOne(
    `SELECT c.nationality, c.residence_code, c.phone_country, c.residence_check, c.verification_status, c.verification_note,
            c.verified_at, c.desk_checked_at, c.citizenship_confirmed_at, c.created_at, u.display_name AS officer_name, pr.name AS project_name, pr.location AS project_location
       FROM clients c LEFT JOIN users u ON u.id=c.diaspora_officer_id LEFT JOIN projects pr ON pr.id=c.project_id WHERE c.id=$1`, [client.id]);
  const account = await queryOne("SELECT username, email, status, invited_at, activated_at, last_login_at, created_at FROM customer_accounts WHERE client_id=$1", [client.id]);
  const values = [client.id];
  const scope = scopeCondition("c", "contract", req.access, values, { read: true });
  const contracts = (await query(
    `SELECT c.id, c.contract_number, c.status, c.deal_type, c.channel, c.value, c.start_date, c.end_date, c.created_at, c.customer_accepted_at,
            c.property_id, p.name AS property_name, p.location AS property_location, p.property_type, p.price AS property_price,
            pr.id AS project_id, pr.name AS project_name, pr.location AS project_location,
            (SELECT pi.id FROM property_images pi WHERE pi.property_id=p.id ORDER BY pi.id LIMIT 1) AS photo_id,
            COALESCE((SELECT SUM(pm.amount) FROM payments pm WHERE pm.contract_id=c.id AND pm.status='approved'),0)
              - COALESCE((SELECT SUM(rf.amount) FROM refunds rf WHERE rf.contract_id=c.id AND rf.status='approved'),0) AS paid,
            (SELECT json_build_object('due_date', d.due_date, 'amount', d.amount) FROM debts d WHERE d.contract_id=c.id AND d.status<>'paid' ORDER BY d.due_date NULLS LAST, d.id LIMIT 1) AS next_due
       FROM contracts c LEFT JOIN properties p ON p.id=c.property_id LEFT JOIN projects pr ON pr.id=c.project_id
      WHERE c.client_id=$1 AND ${scope} ORDER BY c.id DESC`, values)).rows.map((c) => ({
    ...c,
    paid: Math.max(0, Number(c.paid || 0)),
    balance: Math.max(0, Number(c.value || 0) - Math.max(0, Number(c.paid || 0))),
    photo_url: c.photo_id ? `/api/v1/properties/${c.property_id}/images/${c.photo_id}/file` : null,
  }));
  const requests = (await query(
    `SELECT l.id, l.service, l.status, l.budget, l.notes, l.created_at, l.source, p.name AS property_name, p.id AS property_id,
            (SELECT pi.id FROM property_images pi WHERE pi.property_id=p.id ORDER BY pi.id LIMIT 1) AS photo_id
       FROM leads l LEFT JOIN properties p ON p.id=l.property_id
      WHERE l.organization_id=$2 AND l.client_id=$1 ORDER BY l.created_at DESC LIMIT 20`, [client.id, req.access.organizationId])).rows
    .map((r) => ({ ...r, photo_url: r.photo_id ? `/api/v1/properties/${r.property_id}/images/${r.photo_id}/file` : null }));
  const documents = (await queryOne("SELECT COUNT(*)::int AS n FROM documents WHERE client_id=$1 AND category LIKE 'kyc\\_%' AND status <> 'superseded'", [client.id]))?.n ?? 0;
  res.json({ client: { ...client, ...extra }, account, contracts, requests, kyc_documents: documents });
}));
router.get("/clients/:id/portal", route(async (req, res) => {
  const client = requireRecord(await Client.get(parseId(req.params.id)), "Client");
  const account = await queryOne("SELECT email, status, invited_at, activated_at, last_login_at FROM customer_accounts WHERE client_id=$1", [client.id]);
  res.json({ is_diaspora: Boolean(client.is_diaspora), account });
}));
router.post("/clients/:id/portal-invite", route(async (req, res) => {
  const client = requireRecord(await Client.get(parseId(req.params.id)), "Client");
  // Diaspora clients, and Tanzanian clients with an accepted buy/rent request
  // (they see their invoices, contracts and receipts; nothing diaspora-only).
  const accepted = client.is_diaspora ? null : await queryOne(`SELECT 1 FROM leads l WHERE l.client_id=$1 AND ${ACCEPTED_REQUEST_SQL} LIMIT 1`, [client.id]);
  if (!client.is_diaspora && !accepted) throw new HttpError(400, "Only a diaspora client, or a Tanzanian client whose buy or rent request MKUYU has accepted, can be invited to the portal.");
  const email = String(client.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Add the client's e-mail address first: they sign in with a code sent there.");
  const taken = await queryOne("SELECT client_id FROM customer_accounts WHERE lower(email)=$1 AND status<>'disabled' AND client_id<>$2", [email, client.id]);
  if (taken) throw new HttpError(409, "Another client already uses this e-mail for the portal.");
  const contracts = await queryOne("SELECT COUNT(*)::int AS n FROM contracts WHERE client_id=$1 AND status NOT IN ('draft','rejected','cancelled')", [client.id]);
  const account = await queryOne(
    `INSERT INTO customer_accounts (client_id, email, status, invited_by, invited_at) VALUES ($1,$2,'invited',$3,NOW())
     ON CONFLICT (client_id) DO UPDATE SET email=EXCLUDED.email, invited_by=EXCLUDED.invited_by, invited_at=NOW(),
       status=CASE WHEN customer_accounts.status='active' AND customer_accounts.email=EXCLUDED.email THEN 'active' ELSE 'invited' END
     RETURNING id, email, status`, [client.id, email, req.user.id]);
  const site = String(process.env.DIASPORA_SITE_URL || process.env.PUBLIC_SITE_URL || "").trim().replace(/\/+$/, "");
  const link = site ? `${site}/login.html` : "the MKUYU website (Diaspora login)";
  const mail = mailConfigured()
    ? await sendMail({ to: email, subject: client.is_diaspora ? "Your MKUYU diaspora portal" : "Your MKUYU customer portal",
        text: `Dear ${client.name},\n\n${client.is_diaspora
          ? "You can now follow your MKUYU property from wherever you are: your contract, every payment and receipt, the balance and next installment, and photos of the construction progress."
          : "You can now see your MKUYU invoices in the customer portal, pay them (press Pay now for MKUYU's payment details), upload your receipt, and follow your contract and every receipt."}\n\nOpen ${link}, choose 'Forgot password or first time here?', enter this e-mail address (${email}) and set your password with the code we send you. After that you sign in with your e-mail and password.\n\nMKUYU Africa` ,
        kind: "portal_invite" })
    : { sent: false, error: "e-mail is not set up" };
  await audit(req, "portal_invited", "client", client.id, { email, contracts: contracts.n, emailed: mail.sent });
  res.json({ account, emailed: mail.sent, email_error: mail.sent ? null : mail.error, contracts: contracts.n });
}));
router.post("/clients/:id/portal-disable", route(async (req, res) => {
  const client = requireRecord(await Client.get(parseId(req.params.id)), "Client");
  const disabled = await disablePortalAccount(client.id);
  await audit(req, "portal_disabled", "client", client.id, {});
  res.json({ ok: true, disabled });
}));

// ---- Diaspora verification: the Desk verifies, Legal confirms nationality ----
// A self sign-up proves who they are before MKUYU serves them:
//   submitted (documents in) --Desk: verify--> verified
//     -> the customer gets the Verified badge and may request properties;
//   then Legal confirms nationality (citizenship_confirmed_at), which decides the
//   contract MKUYU may offer: no agreement is signed before that.
//   Desk or Legal may send documents back with a note; the customer uploads again.
// desk_checked is the old intermediate stage; such customers can be verified directly.
// Purpose-built endpoints, so Legal can do its step without being given the
// Desk's whole client list.
const DESK_NAME = "DIASPORA DESK";
async function inDiasporaDesk(userId) {
  return Boolean(await queryOne("SELECT 1 FROM user_departments ud JOIN departments d ON d.id=ud.department_id WHERE ud.user_id=$1 AND d.name=$2 AND d.active=TRUE", [userId, DESK_NAME]));
}
const isLegalVerifier = (req) => canPermission(req.access, "approve_legal");
async function verificationRole(req) {
  const desk = await inDiasporaDesk(req.user.id);
  const legal = isLegalVerifier(req);
  const oversight = canPermission(req.access, "approve_management");
  if (!desk && !legal && !oversight) throw new HttpError(403, "Only the Diaspora Desk, Legal and the MD see customer verification.");
  return { desk, legal, oversight };
}
router.get("/diaspora/verifications", route(async (req, res) => {
  const role = await verificationRole(req);
  const rows = (await query(
    `SELECT c.id, c.name, c.email, c.phone, c.country, c.residence_code, c.nationality, c.phone_country, c.residence_check,
            c.verification_status, c.verification_note, c.created_at, c.desk_checked_at, c.verified_at, c.citizenship_confirmed_at,
            o.display_name AS officer_name, dc.display_name AS desk_checked_by_name, vb.display_name AS verified_by_name,
            cb.display_name AS citizenship_confirmed_by_name,
            COALESCE((SELECT json_agg(json_build_object('id', d.id, 'kind', substr(d.category, 5), 'name', d.original_filename, 'uploaded_at', d.uploaded_at, 'expires_on', to_char(d.expires_on,'YYYY-MM-DD')) ORDER BY d.id)
                        FROM documents d WHERE d.client_id=c.id AND d.category LIKE 'kyc_%' AND d.status <> 'superseded'), '[]') AS documents
       FROM clients c LEFT JOIN users o ON o.id=c.diaspora_officer_id LEFT JOIN users dc ON dc.id=c.desk_checked_by LEFT JOIN users vb ON vb.id=c.verified_by
            LEFT JOIN users cb ON cb.id=c.citizenship_confirmed_by
      WHERE c.organization_id=$1 AND c.is_diaspora=TRUE AND c.verification_status IS NOT NULL
      ORDER BY CASE c.verification_status WHEN 'submitted' THEN 0 WHEN 'desk_checked' THEN 0 WHEN 'unverified' THEN 2 WHEN 'rejected' THEN 3 ELSE 4 END, c.id DESC LIMIT 300`,
    [await organizationId()])).rows;
  res.json({ role, rows });
}));
router.get("/diaspora/verifications/:id/documents/:docId", route(async (req, res) => {
  await verificationRole(req);
  const doc = requireRecord(await queryOne(`SELECT d.* FROM documents d JOIN clients c ON c.id=d.client_id
    WHERE d.id=$1 AND c.id=$2 AND c.is_diaspora=TRUE AND d.category LIKE 'kyc_%'`, [parseId(req.params.docId, "document_id"), parseId(req.params.id)]), "Document");
  const fullPath = resolveStoredFile(documentUploadsDir, doc.stored_name);
  if (!fullPath) throw new HttpError(404, "Document file not found");
  await audit(req, "kyc_document_viewed", "client", doc.client_id, { document_id: doc.id });
  return sendStoredFile(res, fullPath, doc.mime_type || null, doc.original_filename || doc.stored_name, false);
}));
// ---- Messages between diaspora customers and the Diaspora Desk -----------------
router.get("/diaspora/messages", route(async (req, res) => {
  const role = await verificationRole(req);
  const rows = (await query(
    `SELECT c.id, c.name, c.country, c.verification_status,
            (SELECT CASE WHEN m.deleted_at IS NOT NULL THEN 'This message was deleted' ELSE m.body END FROM customer_messages m WHERE m.client_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
            (SELECT sender FROM customer_messages m WHERE m.client_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_from,
            (SELECT MAX(created_at) FROM customer_messages m WHERE m.client_id=c.id) AS last_at,
            (SELECT COUNT(*)::int FROM customer_messages m WHERE m.client_id=c.id AND m.sender='customer' AND m.read_at IS NULL) AS unread,
            EXISTS (SELECT 1 FROM video_calls v WHERE v.client_id=c.id AND v.started_by='customer' AND v.status='ringing' AND v.created_at > NOW() - INTERVAL '60 seconds') AS calling
       FROM clients c WHERE c.organization_id=$1 AND c.is_diaspora=TRUE AND EXISTS (SELECT 1 FROM customer_messages m WHERE m.client_id=c.id)
      ORDER BY (SELECT MAX(created_at) FROM customer_messages m WHERE m.client_id=c.id) DESC LIMIT 200`, [await organizationId()])).rows;
  await query("UPDATE customer_messages SET delivered_at=NOW() WHERE sender='customer' AND delivered_at IS NULL AND client_id = ANY($1::int[])", [rows.map((r) => r.id)]);
  res.json({ rows, can_reply: role.desk || role.legal, calls: await callsRingingDesk(await organizationId(), req.user.display_name || "Diaspora Desk") });
}));
router.get("/diaspora/messages/:id", route(async (req, res) => {
  await verificationRole(req);
  const clientId = parseId(req.params.id);
  const client = requireRecord(await queryOne("SELECT id, name, country, phone, verification_status FROM clients WHERE id=$1 AND is_diaspora=TRUE AND organization_id=$2", [clientId, await organizationId()]), "Customer");
  const rows = (await query(`SELECT m.id, m.sender, m.body, m.created_at, m.read_at, m.delivered_at, m.reply_to, m.reaction_customer, m.reaction_staff, m.edited_at, m.deleted_at, m.staff_user_id,
      u.display_name AS staff_name, r.body AS reply_body, r.sender AS reply_sender, r.deleted_at AS reply_deleted, ru.display_name AS reply_staff_name
    FROM customer_messages m LEFT JOIN users u ON u.id=m.staff_user_id
    LEFT JOIN customer_messages r ON r.id=m.reply_to LEFT JOIN users ru ON ru.id=r.staff_user_id
    WHERE m.client_id=$1 AND NOT EXISTS (SELECT 1 FROM customer_message_hides h WHERE h.message_id=m.id AND h.user_id=$2)
    ORDER BY m.id DESC LIMIT 200`, [clientId, req.user.id])).rows.reverse();
  await query("UPDATE customer_messages SET read_at=NOW(), delivered_at=COALESCE(delivered_at, NOW()) WHERE client_id=$1 AND sender='customer' AND read_at IS NULL", [clientId]);
  // Seen from the desk: "me" is the desk member, "them" the customer.
  const messages = rows.map((m) => ({
    id: m.id, sender: m.sender, body: m.deleted_at ? "" : m.body, created_at: m.created_at, staff_name: m.staff_name,
    deleted: Boolean(m.deleted_at), edited: Boolean(m.edited_at) && !m.deleted_at, own: m.sender === "staff" && m.staff_user_id === req.user.id,
    read: Boolean(m.read_at), delivered: Boolean(m.delivered_at || m.read_at),
    reactions: { me: m.reaction_staff || null, them: m.reaction_customer || null },
    reply: m.reply_to && m.reply_body ? { id: m.reply_to, from: m.reply_sender, name: m.reply_sender === "staff" ? (m.reply_staff_name || "Diaspora Desk") : client.name, body: m.reply_deleted ? "" : String(m.reply_body).slice(0, 140), deleted: Boolean(m.reply_deleted) } : null,
  }));
  const call = callView(await currentCall(clientId), "staff", { desk: req.user.display_name || "Diaspora Desk", customer: client.name });
  res.json({ client, messages, typing: isTyping(clientId, "customer"), reactions: REACTIONS, call });
}));

// ---- Video calls (Jitsi room per call) ---------------------------------------------
router.post("/diaspora/calls/:id", route(async (req, res) => {
  const role = await verificationRole(req);
  if (!role.desk && !role.legal) throw new HttpError(403, "Only the Diaspora Desk or Legal can call customers.");
  const clientId = parseId(req.params.id);
  const client = requireRecord(await queryOne("SELECT id, name FROM clients WHERE id=$1 AND is_diaspora=TRUE AND organization_id=$2", [clientId, await organizationId()]), "Customer");
  let call = await currentCall(clientId);
  if (call && call.started_by === "customer" && call.status === "ringing") {
    // The customer is already calling: answering it is the same as joining.
    await query("UPDATE video_calls SET status='active', answered_at=NOW(), staff_user_id=$2 WHERE id=$1", [call.id, req.user.id]);
  } else if (!call) {
    await query("INSERT INTO video_calls (client_id, started_by, staff_user_id, room) VALUES ($1,'staff',$2,$3)", [clientId, req.user.id, newRoom()]);
    await query("INSERT INTO customer_messages (client_id, sender, staff_user_id, body) VALUES ($1,'staff',$2,'📹 Video call: the Diaspora Desk is calling you')", [clientId, req.user.id]);
    notifyCustomer(clientId, { subject: "the Diaspora Desk is calling you", lines: "Open your portal now and press Join to talk by video. If you miss the call, write to us in Messages.", where: "Messages" });
  }
  call = await currentCall(clientId);
  broadcastChange("diaspora");
  res.status(201).json({ call: callView(call, "staff", { desk: req.user.display_name || "Diaspora Desk", customer: client.name }) });
}));
router.post("/diaspora/calls/:id/answer", route(async (req, res) => {
  const role = await verificationRole(req);
  if (!role.desk && !role.legal) throw new HttpError(403, "Only the Diaspora Desk or Legal can answer calls.");
  const done = await query("UPDATE video_calls SET status='active', answered_at=NOW(), staff_user_id=$2 WHERE id=$1 AND status='ringing' AND started_by='customer' RETURNING id", [parseId(req.params.id), req.user.id]);
  if (!done.rows.length) throw new HttpError(409, "The call has ended.");
  broadcastChange("diaspora");
  res.json({ ok: true });
}));
router.post("/diaspora/calls/:id/end", route(async (req, res) => {
  const role = await verificationRole(req);
  if (!role.desk && !role.legal) throw new HttpError(403, "Only the Diaspora Desk or Legal can end calls.");
  await finishCall(parseId(req.params.id), { decline: req.body?.decline === true });
  res.json({ ok: true });
}));

router.post("/diaspora/messages/:id/typing", route(async (req, res) => {
  const role = await verificationRole(req);
  if (!role.desk && !role.legal) return res.json({ ok: true });
  setTyping(parseId(req.params.id), "staff");
  res.json({ ok: true });
}));
router.post("/diaspora/messages/:id/react", route(async (req, res) => {
  const role = await verificationRole(req);
  if (!role.desk && !role.legal) throw new HttpError(403, "Only the Diaspora Desk or Legal can react.");
  const clientId = parseId(req.params.id);
  const messageId = Number.parseInt(req.body?.message_id, 10);
  const emoji = req.body?.emoji ? String(req.body.emoji) : null;
  if (!Number.isSafeInteger(messageId)) throw new HttpError(400, "Choose a message.");
  if (emoji && !REACTIONS.includes(emoji)) throw new HttpError(400, "That reaction is not available.");
  const done = await query("UPDATE customer_messages SET reaction_staff=$3 WHERE id=$1 AND client_id=$2 RETURNING id", [messageId, clientId, emoji]);
  if (!done.rows.length) throw new HttpError(404, "Message not found.");
  broadcastChange("diaspora");
  res.json({ ok: true });
}));
router.post("/diaspora/messages/:id/edit", route(async (req, res) => {
  const role = await verificationRole(req);
  if (!role.desk && !role.legal) throw new HttpError(403, "Only the Diaspora Desk or Legal can edit messages.");
  const clientId = parseId(req.params.id);
  const messageId = Number.parseInt(req.body?.message_id, 10);
  const body = String(req.body?.body || "").replace(/\r\n/g, "\n").trim();
  if (!Number.isSafeInteger(messageId)) throw new HttpError(400, "Choose a message.");
  if (!body) throw new HttpError(400, "A message cannot be empty. Delete it instead.");
  if (body.length > 2000) throw new HttpError(400, "Please keep the message under 2000 characters.");
  const m = await queryOne("SELECT id, created_at, deleted_at FROM customer_messages WHERE id=$1 AND client_id=$2 AND sender='staff' AND staff_user_id=$3", [messageId, clientId, req.user.id]);
  if (!m || m.deleted_at) throw new HttpError(404, "Message not found. You can edit only your own messages.");
  if (Date.now() - new Date(m.created_at).getTime() > EDIT_WINDOW_MS) throw new HttpError(409, "A message can be edited for 15 minutes after it is sent.");
  await query("UPDATE customer_messages SET body=$2, edited_at=NOW() WHERE id=$1", [messageId, body]);
  broadcastChange("diaspora");
  res.json({ ok: true });
}));
router.post("/diaspora/messages/:id/delete", route(async (req, res) => {
  const role = await verificationRole(req);
  const clientId = parseId(req.params.id);
  const messageId = Number.parseInt(req.body?.message_id, 10);
  const scope = req.body?.scope === "all" ? "all" : "me";
  if (!Number.isSafeInteger(messageId)) throw new HttpError(400, "Choose a message.");
  const m = await queryOne("SELECT id, sender, staff_user_id, created_at FROM customer_messages WHERE id=$1 AND client_id=$2", [messageId, clientId]);
  if (!m) throw new HttpError(404, "Message not found.");
  if (scope === "all") {
    if (!role.desk && !role.legal) throw new HttpError(403, "Only the Diaspora Desk or Legal can delete messages for everyone.");
    if (m.sender !== "staff" || m.staff_user_id !== req.user.id) throw new HttpError(403, "You can delete for everyone only the messages you sent.");
    if (Date.now() - new Date(m.created_at).getTime() > DELETE_ALL_WINDOW_MS) throw new HttpError(409, "A message can be deleted for everyone within 48 hours of sending.");
    await query("UPDATE customer_messages SET deleted_at=COALESCE(deleted_at, NOW()), reaction_customer=NULL, reaction_staff=NULL WHERE id=$1", [messageId]);
  } else {
    await query("INSERT INTO customer_message_hides (message_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [messageId, req.user.id]);
  }
  broadcastChange("diaspora");
  res.json({ ok: true });
}));
router.post("/diaspora/messages/:id", route(async (req, res) => {
  const role = await verificationRole(req);
  if (!role.desk && !role.legal) throw new HttpError(403, "Only the Diaspora Desk or Legal can reply to customers.");
  const clientId = parseId(req.params.id);
  const client = requireRecord(await queryOne("SELECT id, name, email FROM clients WHERE id=$1 AND is_diaspora=TRUE AND organization_id=$2", [clientId, await organizationId()]), "Customer");
  const body = String(req.body?.body || "").replace(/\r\n/g, "\n").trim();
  if (!body) throw new HttpError(400, "Write the reply first.");
  if (body.length > 2000) throw new HttpError(400, "Please keep the reply under 2000 characters.");
  let replyTo = null;
  if (req.body?.reply_to) {
    const target = await queryOne("SELECT id FROM customer_messages WHERE id=$1 AND client_id=$2", [Number.parseInt(req.body.reply_to, 10) || 0, clientId]);
    replyTo = target?.id || null;
  }
  const row = (await query("INSERT INTO customer_messages (client_id, sender, staff_user_id, body, reply_to) VALUES ($1,'staff',$2,$3,$4) RETURNING id, created_at", [clientId, req.user.id, body, replyTo])).rows[0];
  clearTyping(clientId, "staff");
  // The customer's own messages up to now count as answered, so the desk's unread count falls.
  await query("UPDATE customer_messages SET read_at=COALESCE(read_at, NOW()), delivered_at=COALESCE(delivered_at, NOW()) WHERE client_id=$1 AND sender='customer'", [clientId]);
  broadcastChange("diaspora");
  notifyCustomer(clientId, { subject: "you have a new message", lines: "The Diaspora Desk replied to you in your portal.", where: "Messages" });
  res.status(201).json({ ok: true, id: row.id });
}));
router.post("/diaspora/verifications/:id", route(async (req, res) => {
  const role = await verificationRole(req);
  const clientId = parseId(req.params.id);
  const client = requireRecord(await queryOne("SELECT id, name, email, notify_email, verification_status, citizenship_confirmed_at FROM clients WHERE id=$1 AND is_diaspora=TRUE AND organization_id=$2", [clientId, await organizationId()]), "Customer");
  const action = String(req.body?.action || "");
  const note = String(req.body?.note || "").trim().slice(0, 1000) || null;
  const documentsIn = ["submitted", "desk_checked"].includes(client.verification_status);
  let update;
  if (action === "verify") {
    // The Diaspora Desk verifies identity. Legal may verify too; when Legal
    // does, nationality is confirmed in the same step.
    if (!role.desk && !role.legal) throw new HttpError(403, "Customers are verified by the Diaspora Desk.");
    if (!documentsIn) throw new HttpError(409, client.verification_status === "verified" ? "This customer is already verified." : "The customer must upload their documents first.");
    const have = await queryOne("SELECT COUNT(*) FILTER (WHERE category='kyc_passport')::int AS p, COUNT(*) FILTER (WHERE category='kyc_residence')::int AS r FROM documents WHERE client_id=$1 AND status <> 'superseded'", [clientId]);
    if (!have.p || !have.r) throw new HttpError(409, `The ${!have.p ? "passport" : "proof of residence"} is still missing. Press "Send back" and ask the customer to upload it.`);
    update = role.legal && !role.desk
      ? ["UPDATE clients SET verification_status='verified', verified_by=$2, verified_at=NOW(), verification_note=$3, citizenship_confirmed_by=$2, citizenship_confirmed_at=NOW() WHERE id=$1", [clientId, req.user.id, note]]
      : ["UPDATE clients SET verification_status='verified', verified_by=$2, verified_at=NOW(), verification_note=$3 WHERE id=$1", [clientId, req.user.id, note]];
  } else if (action === "confirm_citizenship") {
    if (!role.legal) throw new HttpError(403, "Nationality is confirmed by Legal.");
    if (client.verification_status !== "verified") throw new HttpError(409, "The Diaspora Desk verifies the customer first.");
    if (client.citizenship_confirmed_at) throw new HttpError(409, "Nationality is already confirmed.");
    update = ["UPDATE clients SET citizenship_confirmed_by=$2, citizenship_confirmed_at=NOW(), verification_note=COALESCE($3, verification_note) WHERE id=$1", [clientId, req.user.id, note]];
  } else if (action === "desk_ok") {
    // Older two-step screens: kept so they still work. New screens verify directly.
    if (!role.desk) throw new HttpError(403, "The first check is done by the Diaspora Desk.");
    if (client.verification_status !== "submitted") throw new HttpError(409, "Only a customer whose documents are in can be checked.");
    update = ["UPDATE clients SET verification_status='desk_checked', desk_checked_by=$2, desk_checked_at=NOW(), verification_note=$3 WHERE id=$1", [clientId, req.user.id, note]];
  } else if (action === "reject") {
    if (!role.desk && !role.legal) throw new HttpError(403, "Only the Diaspora Desk or Legal can send documents back.");
    if (!note) throw new HttpError(400, "Write what the customer must correct; they will see it.");
    // Legal may still send back a verified customer whose nationality it cannot confirm.
    const legalReview = role.legal && client.verification_status === "verified" && !client.citizenship_confirmed_at;
    if (!["submitted", "desk_checked", "unverified"].includes(client.verification_status) && !legalReview) throw new HttpError(409, "Nothing to send back.");
    update = ["UPDATE clients SET verification_status='rejected', verification_note=$2, verified_by=NULL, verified_at=NULL WHERE id=$1", [clientId, note]];
  } else if (action === "revoke") {
    // A verification given in error, or a document later found wrong, is taken back.
    // The customer returns to "sent back": they see the reason and upload again.
    if (!role.desk && !role.legal) throw new HttpError(403, "Only the Diaspora Desk or Legal can remove a verification.");
    if (client.verification_status !== "verified") throw new HttpError(409, "This customer is not verified.");
    if (!note) throw new HttpError(400, "Write why the verification is removed; the customer will read it.");
    update = ["UPDATE clients SET verification_status='rejected', verification_note=$2, verified_by=NULL, verified_at=NULL, citizenship_confirmed_by=NULL, citizenship_confirmed_at=NULL WHERE id=$1", [clientId, note]];
  } else throw new HttpError(400, "Unknown action.");
  await query(update[0], update[1]);
  await audit(req, `kyc_${action}`, "client", clientId, { note });
  await recordVerificationEvent(clientId, req.user.id, action, note);
  if (mailConfigured() && client.email && client.notify_email !== false && ["verify", "reject", "revoke", "confirm_citizenship"].includes(action)) {
    const site = String(process.env.DIASPORA_SITE_URL || process.env.PUBLIC_SITE_URL || "").trim().replace(/\/+$/, "");
    sendMail({ to: client.email, subject: action === "verify" ? "MKUYU: you are verified" : action === "confirm_citizenship" ? "MKUYU: your nationality is confirmed" : "MKUYU: please check your documents",
      text: action === "confirm_citizenship"
        ? `Dear ${client.name},\n\nMKUYU's Legal team has confirmed your nationality. When your agreement is ready, you can read and sign it in your portal.\n\n${site ? `${site}/login.html` : "Website → Diaspora login"}\n\nMKUYU Africa`
        : action === "verify"
        ? `Dear ${client.name},\n\nMKUYU has verified your identity. Your portal now shows the Verified badge, and you can request any property from it.\n\n${site ? `${site}/login.html` : "Website → Diaspora login"}\n\nMKUYU Africa`
        : action === "revoke"
        ? `Dear ${client.name},\n\nYour MKUYU verification has been removed:\n\n${note}\n\nPlease sign in and upload your documents again. Until then you cannot send new property requests.\n\nMKUYU Africa`
        : `Dear ${client.name},\n\nWe could not verify your documents yet:\n\n${note}\n\nPlease sign in and upload them again.\n\nMKUYU Africa`,
      kind: "kyc" }).catch(() => {});
  }
  const now = await queryOne("SELECT verification_status, citizenship_confirmed_at FROM clients WHERE id=$1", [clientId]);
  res.json({ ok: true, status: now.verification_status, citizenship_confirmed: Boolean(now.citizenship_confirmed_at) });
}));



// ---- Requests from diaspora customers' portals -------------------------------------
// A customer presses "Request" on a property in the portal; it arrives here for the
// Diaspora Desk (it is also a lead for Sales, but the Desk does not need the Leads module).
const REQUEST_STATUS_TEXT = { new: "New", handed_off: "With our customer team", contacted: "Contacted", appointment: "Meeting arranged", converted: "Moving to an agreement", lost: "Closed", closed: "Closed" };
router.get("/diaspora/requests", route(async (req, res) => {
  const role = await verificationRole(req);
  const rows = (await query(
    `SELECT l.id, l.client_id, l.service, l.status, l.budget, l.preferred_contact, l.notes, l.created_at, l.appointment_at,
            c.name AS client_name, c.country, c.phone, p.id AS property_id, p.name AS property_name, p.location AS property_location, u.display_name AS officer_name
       FROM leads l JOIN clients c ON c.id=l.client_id AND c.is_diaspora=TRUE
       LEFT JOIN properties p ON p.id=l.property_id LEFT JOIN users u ON u.id=c.diaspora_officer_id
      WHERE l.source='diaspora-portal' AND l.organization_id=$1 ORDER BY (l.status='new') DESC, l.id DESC LIMIT 300`, [await organizationId()])).rows;
  res.json({ can_act: role.desk || role.legal, rows: rows.map((r) => ({ ...r, status_text: REQUEST_STATUS_TEXT[r.status] || r.status, budget: r.budget === null ? null : Number(r.budget) })) });
}));
router.post("/diaspora/requests/:id", route(async (req, res) => {
  const role = await verificationRole(req);
  if (!role.desk && !role.legal) throw new HttpError(403, "Only the Diaspora Desk or Legal can update a customer's request.");
  const id = parseId(req.params.id);
  const lead = requireRecord(await queryOne("SELECT id, client_id, status FROM leads WHERE id=$1 AND source='diaspora-portal' AND organization_id=$2", [id, await organizationId()]), "Request");
  const status = String(req.body?.status || "");
  if (!["contacted", "closed", "lost"].includes(status)) throw new HttpError(400, "Choose what happened to the request.");
  await query("UPDATE leads SET status=$2 WHERE id=$1", [id, status]);
  await audit(req, "diaspora_request_status", "lead", id, { from: lead.status, to: status });
  broadcastChange("requests"); broadcastChange("diaspora");
  res.json({ ok: true });
}));

// ---- Diaspora report: numbers for the Desk, Legal and the MD ------------------------
router.get("/diaspora/report", route(async (req, res) => {
  await verificationRole(req);
  const org = await organizationId();
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const one = async (sql, params = []) => (await queryOne(sql, params)) || {};
  const customers = (await query(
    `SELECT COALESCE(verification_status,'new') AS status, COUNT(*)::int AS n FROM clients WHERE is_diaspora=TRUE GROUP BY 1`)).rows;
  const joined = await one(`SELECT COUNT(*)::int AS n FROM clients WHERE is_diaspora=TRUE AND created_at >= NOW() - ($1 || ' days')::interval`, [days]);
  const requests = (await query(
    `SELECT l.status, COUNT(*)::int AS n FROM leads l JOIN clients c ON c.id=l.client_id AND c.is_diaspora=TRUE
      WHERE l.source='diaspora-portal' AND l.organization_id=$1 AND l.created_at >= NOW() - ($2 || ' days')::interval GROUP BY 1`, [org, days])).rows;
  const response = await one(
    `SELECT COUNT(*)::int AS answered,
            ROUND(AVG(EXTRACT(EPOCH FROM (r.at - m.created_at)) / 60))::int AS avg_minutes,
            ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (r.at - m.created_at)) / 60))::numeric)::int AS median_minutes
       FROM customer_messages m
       JOIN LATERAL (SELECT MIN(s.created_at) AS at FROM customer_messages s WHERE s.client_id=m.client_id AND s.sender='staff' AND s.id > m.id) r ON r.at IS NOT NULL
      WHERE m.sender='customer' AND m.deleted_at IS NULL AND m.created_at >= NOW() - ($1 || ' days')::interval
        AND NOT EXISTS (SELECT 1 FROM customer_messages p WHERE p.client_id=m.client_id AND p.sender='customer' AND p.id < m.id AND p.id > COALESCE((SELECT MAX(x.id) FROM customer_messages x WHERE x.client_id=m.client_id AND x.sender='staff' AND x.id < m.id), 0))`, [days]);
  const waiting = await one(
    `SELECT COUNT(*)::int AS n FROM (SELECT DISTINCT ON (client_id) client_id, sender FROM customer_messages WHERE deleted_at IS NULL ORDER BY client_id, id DESC) t
       JOIN clients c ON c.id=t.client_id AND c.is_diaspora=TRUE WHERE t.sender='customer'`);
  const calls = await one(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE answered_at IS NOT NULL)::int AS answered,
            COUNT(*) FILTER (WHERE status='missed')::int AS missed,
            COUNT(*) FILTER (WHERE status='declined')::int AS declined,
            COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (ended_at - answered_at)) / 60) FILTER (WHERE answered_at IS NOT NULL AND ended_at IS NOT NULL))::int, 0) AS avg_minutes
       FROM video_calls WHERE created_at >= NOW() - ($1 || ' days')::interval`, [days]);
  // How fast requests move: waiting for Customer Care, how many are late, time to hand over and to report back.
  const lateAfter = Math.max(1, Number(process.env.HANDOFF_OVERDUE_HOURS) || 24);
  const handoff = await one(
    `SELECT COUNT(*) FILTER (WHERE l.status='handed_off' AND l.outcome IS NULL)::int AS awaiting,
            COUNT(*) FILTER (WHERE l.status='handed_off' AND l.outcome IS NULL AND l.handed_off_at <= NOW() - ($2 || ' hours')::interval)::int AS overdue,
            ROUND(AVG(EXTRACT(EPOCH FROM (l.handed_off_at - l.created_at)) / 60) FILTER (WHERE l.handed_off_at IS NOT NULL AND l.handed_off_at >= l.created_at AND l.created_at >= NOW() - ($1 || ' days')::interval))::int AS to_handoff_minutes,
            ROUND(AVG(EXTRACT(EPOCH FROM (l.outcome_at - l.handed_off_at)) / 60) FILTER (WHERE l.outcome_at IS NOT NULL AND l.handed_off_at IS NOT NULL AND l.outcome_at >= l.handed_off_at AND l.outcome_at >= NOW() - ($1 || ' days')::interval))::int AS to_report_minutes
       FROM leads l JOIN clients c ON c.id=l.client_id AND c.is_diaspora=TRUE
      WHERE l.source='diaspora-portal' AND l.organization_id=$3`, [days, lateAfter, org]);
  const expiring = await one(
    `SELECT COUNT(*)::int AS n FROM documents d JOIN clients c ON c.id=d.client_id AND c.is_diaspora=TRUE
      WHERE d.category LIKE 'kyc\\_%' AND d.status <> 'superseded' AND d.expires_on IS NOT NULL AND d.expires_on <= CURRENT_DATE + 30`);
  const transfers = (await query(
    `SELECT COALESCE(ct.transfer_stage,'not_started') AS stage, COUNT(*)::int AS n FROM contracts ct JOIN clients c ON c.id=ct.client_id AND c.is_diaspora=TRUE
      WHERE ct.organization_id=$1 AND ct.status NOT IN ('cancelled','draft') GROUP BY 1`, [org])).rows;
  res.json({
    days, customers, joined: joined.n || 0, requests, waiting: waiting.n || 0,
    response: { answered: response.answered || 0, avg_minutes: response.avg_minutes ?? null, median_minutes: response.median_minutes ?? null },
    calls: { total: calls.total || 0, answered: calls.answered || 0, missed: calls.missed || 0, declined: calls.declined || 0, avg_minutes: calls.avg_minutes || 0 },
    handoff: { awaiting: handoff.awaiting || 0, overdue: handoff.overdue || 0, late_after_hours: lateAfter, to_handoff_minutes: handoff.to_handoff_minutes ?? null, to_report_minutes: handoff.to_report_minutes ?? null },
    expiring: expiring.n || 0, transfers,
  });
}));

// ---- Verification history ------------------------------------------------------
const EVENT_TEXT = { documents_submitted: "Documents sent", verify: "Verified", reject: "Sent back", revoke: "Verification removed", confirm_citizenship: "Nationality confirmed by Legal", desk_ok: "Checked by the Desk", expiry_reminder: "Reminder: a document is about to expire" };
router.get("/diaspora/verifications/:id/history", route(async (req, res) => {
  await verificationRole(req);
  const clientId = parseId(req.params.id);
  requireRecord(await queryOne("SELECT id FROM clients WHERE id=$1 AND is_diaspora=TRUE AND organization_id=$2", [clientId, await organizationId()]), "Customer");
  const rows = (await query(`SELECT e.id, e.action, e.note, e.created_at, u.display_name AS who FROM verification_events e LEFT JOIN users u ON u.id=e.actor_user_id
    WHERE e.client_id=$1 ORDER BY e.id DESC LIMIT 100`, [clientId])).rows;
  res.json(rows.map((r) => ({ id: r.id, action: r.action, text: EVENT_TEXT[r.action] || r.action, note: r.note, who: r.who || "Customer / system", at: r.created_at })));
}));

// ---- Legal status of properties and the transfer of ownership -------------------
// Legal records what it has checked on each property (title deed, a note the customer
// reads) and where each sale's ownership transfer stands. The Desk and the MD can read.
const LEGAL_STATUSES = ["not_checked", "in_review", "verified", "issues"];
const TRANSFER_STAGES = ["not_started", "documents", "tax_clearance", "registry", "transferred"];
const TRANSFER_LABELS = { not_started: "Not started", documents: "Transfer documents prepared", tax_clearance: "Tax clearance", registry: "Land registry", transferred: "Transferred to the buyer" };
router.get("/diaspora/legal", route(async (req, res) => {
  const role = await verificationRole(req);
  const org = await organizationId();
  const properties = (await query(
    `SELECT p.id, p.name, p.location, p.status, pr.name AS project_name, p.legal_status, p.title_deed_no, p.title_deed_kind, p.legal_note, p.legal_checked_at, u.display_name AS legal_checked_by_name
       FROM properties p LEFT JOIN projects pr ON pr.id=p.project_id LEFT JOIN users u ON u.id=p.legal_checked_by
      WHERE p.organization_id=$1 ORDER BY (p.legal_status='not_checked') DESC, (p.legal_status='issues') DESC, p.name LIMIT 3000`, [org])).rows;
  const transfers = (await query(
    `SELECT c.id, c.contract_number, c.status, c.transfer_stage, c.transfer_note, c.transfer_updated_at, cl.name AS client_name, p.name AS property_name
       FROM contracts c JOIN clients cl ON cl.id=c.client_id AND cl.is_diaspora=TRUE LEFT JOIN properties p ON p.id=c.property_id
      WHERE c.organization_id=$1 AND COALESCE(c.deal_type,'buy')='buy' AND c.status IN ('active','completed') ORDER BY c.id DESC LIMIT 200`, [org])).rows;
  res.json({ can_edit: role.legal, statuses: LEGAL_STATUSES, stages: TRANSFER_STAGES.map((key) => ({ key, label: TRANSFER_LABELS[key] })), properties, transfers });
}));
router.post("/diaspora/legal/properties/:id", route(async (req, res) => {
  const role = await verificationRole(req);
  if (!role.legal) throw new HttpError(403, "Only Legal records the legal status of a property.");
  const id = parseId(req.params.id);
  const property = requireRecord(await queryOne("SELECT id, name, legal_status FROM properties WHERE id=$1 AND organization_id=$2", [id, await organizationId()]), "Property");
  const status = String(req.body?.legal_status || "");
  if (!LEGAL_STATUSES.includes(status)) throw new HttpError(400, "Choose a legal status.");
  const deedNo = String(req.body?.title_deed_no || "").trim().slice(0, 80) || null;
  const deedKind = String(req.body?.title_deed_kind || "").trim().slice(0, 80) || null;
  const note = String(req.body?.legal_note || "").trim().slice(0, 1000) || null;
  if (status === "verified" && !deedNo) throw new HttpError(400, "Enter the title deed number before marking the property as verified.");
  if (status === "issues" && !note) throw new HttpError(400, "Write what the issue is; customers with this property will read it.");
  await query("UPDATE properties SET legal_status=$2, title_deed_no=$3, title_deed_kind=$4, legal_note=$5, legal_checked_at=NOW(), legal_checked_by=$6 WHERE id=$1", [id, status, deedNo, deedKind, note, req.user.id]);
  await recordPropertyHistory(id, req.user.id, "legal_status", { from: property.legal_status, to: status });
  await audit(req, "legal_status", "property", id, { status });
  if (status !== property.legal_status && ["verified", "issues"].includes(status)) {
    customersOf({ propertyId: id }).then((ids) => ids.forEach((cid) => notifyCustomer(cid, { subject: status === "verified" ? "Legal has verified your property" : "Legal update on your property",
      lines: [status === "verified" ? `Our Legal team has checked ${property.name} and verified its title.` : `Our Legal team has a note about ${property.name}:\n${note}`], where: "My property" }))).catch(() => {});
  }
  broadcastChange("diaspora");
  res.json({ ok: true });
}));
router.post("/diaspora/legal/contracts/:id/transfer", route(async (req, res) => {
  const role = await verificationRole(req);
  if (!role.legal) throw new HttpError(403, "Only Legal records the ownership transfer.");
  const id = parseId(req.params.id);
  const contract = requireRecord(await queryOne("SELECT c.id, c.client_id, c.transfer_stage, c.deal_type, c.status, p.name AS property_name FROM contracts c LEFT JOIN properties p ON p.id=c.property_id WHERE c.id=$1 AND c.organization_id=$2", [id, await organizationId()]), "Contract");
  if (contract.deal_type && contract.deal_type !== "buy") throw new HttpError(409, "Only a purchase has an ownership transfer.");
  if (!["active", "completed"].includes(contract.status)) throw new HttpError(409, "The transfer starts once the agreement is signed.");
  const stage = String(req.body?.stage || "");
  if (!TRANSFER_STAGES.includes(stage)) throw new HttpError(400, "Choose a transfer stage.");
  const note = String(req.body?.note || "").trim().slice(0, 500) || null;
  await query("UPDATE contracts SET transfer_stage=$2, transfer_note=$3, transfer_updated_at=NOW() WHERE id=$1", [id, stage, note]);
  await audit(req, "transfer_stage", "contract", id, { stage });
  if (stage !== contract.transfer_stage && contract.client_id) {
    notifyCustomer(contract.client_id, { subject: "update on your ownership transfer", lines: [`${contract.property_name || "Your property"}: ${TRANSFER_LABELS[stage]}.`, note || ""].filter(Boolean), where: "My property" });
  }
  broadcastChange("diaspora");
  res.json({ ok: true });
}));

// ---- Construction stages of a project ------------------------------------------
router.get("/projects/:id/stages", route(async (req, res) => {
  const project = requireRecord(await Project.get(parseId(req.params.id)), "Project");
  const row = await queryOne("SELECT progress_pct, to_char(expected_completion,'YYYY-MM-DD') AS expected_completion FROM projects WHERE id=$1", [project.id]);
  const stages = (await query("SELECT id, title, status, to_char(planned_date,'YYYY-MM-DD') AS planned_date, to_char(done_date,'YYYY-MM-DD') AS done_date FROM project_stages WHERE project_id=$1 ORDER BY position, id", [project.id])).rows;
  res.json({ progress_pct: row?.progress_pct ?? null, expected_completion: row?.expected_completion || null, stages });
}));
router.put("/projects/:id/stages", route(async (req, res) => {
  const project = requireRecord(await Project.get(parseId(req.params.id)), "Project");
  const list = Array.isArray(req.body?.stages) ? req.body.stages.slice(0, 20) : null;
  if (!list) throw new HttpError(400, "Send the list of stages.");
  const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? v : null);
  const clean = list.map((s) => ({ title: String(s?.title || "").trim().slice(0, 100), status: ["upcoming", "current", "done"].includes(s?.status) ? s.status : "upcoming", planned: dateOrNull(s?.planned_date), done: dateOrNull(s?.done_date) })).filter((s) => s.title);
  if (clean.filter((s) => s.status === "current").length > 1) throw new HttpError(400, "Only one stage can be in progress at a time.");
  const pctRaw = req.body?.progress_pct;
  const pct = pctRaw === null || pctRaw === undefined || pctRaw === "" ? null : Number(pctRaw);
  if (pct !== null && (!Number.isInteger(pct) || pct < 0 || pct > 100)) throw new HttpError(400, "Progress is a whole number from 0 to 100.");
  const before = (await query("SELECT title, status FROM project_stages WHERE project_id=$1", [project.id])).rows;
  await query("DELETE FROM project_stages WHERE project_id=$1", [project.id]);
  for (const [index, s] of clean.entries()) {
    await query("INSERT INTO project_stages (project_id, position, title, status, planned_date, done_date) VALUES ($1,$2,$3,$4,$5,$6)",
      [project.id, index, s.title, s.status, s.planned, s.status === "done" ? (s.done || new Date().toISOString().slice(0, 10)) : null]);
  }
  await query("UPDATE projects SET progress_pct=$2, expected_completion=$3 WHERE id=$1", [project.id, pct, dateOrNull(req.body?.expected_completion)]);
  await audit(req, "project_stages", "project", project.id, { stages: clean.length, progress: pct });
  const wasDone = new Set(before.filter((b) => b.status === "done").map((b) => b.title));
  const newlyDone = clean.filter((s) => s.status === "done" && !wasDone.has(s.title));
  if (newlyDone.length) customersOf({ projectId: project.id }).then((ids) => ids.forEach((cid) => notifyCustomer(cid, { subject: `${project.name}: a stage is complete`,
    lines: [`${project.name}: ${newlyDone.map((s) => s.title).join(", ")} completed.`, pct !== null ? `Overall progress: ${pct}%.` : ""].filter(Boolean), where: "My property" }))).catch(() => {});
  res.json({ ok: true });
}));

// ---- Construction progress for customers (a dated note with photos) --------
async function progressList(projectId) {
  const updates = (await query(`SELECT u.*, p.name AS property_name, us.display_name AS created_by_name FROM construction_updates u
    LEFT JOIN properties p ON p.id=u.property_id LEFT JOIN users us ON us.id=u.created_by WHERE u.project_id=$1 ORDER BY u.update_date DESC, u.id DESC`, [projectId])).rows;
  const images = updates.length ? (await query("SELECT id, update_id FROM construction_update_images WHERE update_id = ANY($1::int[]) ORDER BY id", [updates.map((u) => u.id)])).rows : [];
  return updates.map((u) => ({ ...u, photos: images.filter((i) => i.update_id === u.id).map((i) => ({ id: i.id, url: `/api/v1/projects/${projectId}/progress/photos/${i.id}` })) }));
}
router.get("/projects/:id/progress", route(async (req, res) => {
  const project = requireRecord(await Project.get(parseId(req.params.id)), "Project");
  res.json(await progressList(project.id));
}));
router.post("/projects/:id/progress", uploadProgressImages, route(async (req, res) => {
  const files = req.files || [];
  const cleanup = () => files.forEach((file) => cleanupUploadedFile(file));
  try {
    const project = requireRecord(await Project.get(parseId(req.params.id)), "Project");
    const title = String(req.body?.title || "").trim().slice(0, 160);
    if (!title) throw new HttpError(400, "Write a short title, for example 'Foundation completed'.");
    const note = String(req.body?.note || "").trim().slice(0, 2000) || null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.update_date || "")) ? req.body.update_date : null;
    const propertyId = req.body?.property_id ? parseId(req.body.property_id, "property_id") : null;
    if (propertyId) {
      const property = requireRecord(await Property.get(propertyId), "Property");
      if (Number(property.project_id) !== Number(project.id)) throw new HttpError(400, "That property is not in this project.");
    }
    if (files.length > MAX_PROGRESS_PHOTOS) throw new HttpError(400, `At most ${MAX_PROGRESS_PHOTOS} photos per update.`);
    const checked = files.map((file) => validateUploadedFile(file, propertyImageExtensions));
    const update = await queryOne(`INSERT INTO construction_updates (organization_id, project_id, property_id, title, note, update_date, created_by)
      VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, CURRENT_DATE),$7) RETURNING id`, [await organizationId(), project.id, propertyId, title, note, date, req.user.id]);
    for (const info of checked) {
      await query("INSERT INTO construction_update_images (update_id, stored_name, original_filename, mime_type, file_size) VALUES ($1,$2,$3,$4,$5)",
        [update.id, info.storedName, info.displayName, info.mimeType, info.size]);
    }
    await audit(req, "progress_published", "project", project.id, { update_id: update.id, photos: checked.length });
    customersOf({ projectId: project.id, propertyId }).then((ids) => ids.forEach((id) => notifyCustomer(id, { subject: `new update on ${project.name}`,
      lines: [`${project.name}: ${title}`, note ? note.slice(0, 400) : "New photos and notes are in your portal."], where: "My property" }))).catch(() => {});
    res.status(201).json((await progressList(project.id)).find((u) => u.id === update.id));
  } catch (error) { cleanup(); throw error; }
}));
router.get("/projects/:id/progress/photos/:photoId", route(async (req, res) => {
  const project = requireRecord(await Project.get(parseId(req.params.id)), "Project");
  const photo = requireRecord(await queryOne(`SELECT i.* FROM construction_update_images i JOIN construction_updates u ON u.id=i.update_id
    WHERE i.id=$1 AND u.project_id=$2`, [parseId(req.params.photoId, "photo_id"), project.id]), "Photo");
  const fullPath = resolveStoredFile(progressUploadsDir, photo.stored_name);
  if (!fullPath) throw new HttpError(404, "Photo file not found");
  return sendStoredFile(res, fullPath, photo.mime_type || null, photo.original_filename || photo.stored_name, false);
}));
router.delete("/projects/:id/progress/:updateId", route(async (req, res) => {
  const project = requireRecord(await Project.get(parseId(req.params.id)), "Project");
  const updateId = parseId(req.params.updateId, "update_id");
  const photos = (await query("SELECT i.stored_name FROM construction_update_images i JOIN construction_updates u ON u.id=i.update_id WHERE u.id=$1 AND u.project_id=$2", [updateId, project.id])).rows;
  const removed = await query("DELETE FROM construction_updates WHERE id=$1 AND project_id=$2", [updateId, project.id]);
  if (!removed.rowCount) throw new HttpError(404, "Update not found");
  for (const photo of photos) { const full = resolveStoredFile(progressUploadsDir, photo.stored_name); if (full) try { fs.unlinkSync(full); } catch { /* already gone */ } }
  await audit(req, "progress_deleted", "project", project.id, { update_id: updateId });
  res.json({ ok: true });
}));

// Customer SMS notices: how they are set up and the latest ones (Finance, admin).
router.get("/notifications/status", route(async (req, res) => {
  if (!req.access?.isAdmin && !can(req.access, "view_financial")) throw new HttpError(403, "only Finance and the administrator see customer notices");
  res.json(await noticeStatus());
}));
// Run the reminder / overdue pass now instead of waiting for the hourly one.
router.post("/notifications/run", requireAdmin(), route(async (req, res) => {
  const result = await runScheduledNotices({ force: true });
  await audit(req, "notices_run", "notification", null, result);
  res.json(result);
}));
// One test SMS to a number the administrator types (their own phone).
router.post("/notifications/test-sms", requireAdmin(), route(async (req, res) => {
  const number = smsNumber(req.body?.phone);
  if (!number) throw new HttpError(400, "enter a Tanzanian mobile number, e.g. 0712 345 678");
  const text = `${String(process.env.SMS_COMPANY_NAME || "MKUYU")}: Huu ni ujumbe wa majaribio kutoka mfumo wa MKUYU. / This is a test message from the MKUYU system.`;
  const result = await sendSms(number, text);
  await query("INSERT INTO notification_log (kind, channel, dedupe_key, recipient, message, status, error, provider, provider_ref, sent_at) VALUES ('test','sms',$1,$2,$3,$4,$5,$6,$7,NOW())",
    [`test:${Date.now()}`, number, text, result.status === "off" ? "off" : result.status, result.error || null, result.provider || null, result.ref || null]);
  await audit(req, "test_sms", "notification", null, { to: number, status: result.status });
  res.json(result);
}));
router.post("/backups", requireAdmin(), route(async (req, res) => {
  res.status(201).json(await createBackup());
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
  await assertUnitNumberFree(data);
  const listing = validatePropertyListing(req.body || {}, {}, data.price);
  const result = await Property.create(data);
  const propertyId = result.id;
  await Property.setListing(propertyId, listing);
  await applyCategoryStatus(propertyId, req.body || {}, {}, listing, data);
  await recordPropertyHistory(propertyId, req.user.id, "created", { status: data.status, price: data.price });
  const saved = await Property.get(propertyId);
  // Published straight away: tell the customers who asked for new offers.
  if (maybeAnnounceListing({}, saved)) await recordPropertyHistory(propertyId, req.user.id, "announced", { audience: "opted-in customers" });
  res.status(201).json(saved);
}));
router.put("/properties/:id", route(async (req, res) => {
  const id = parseId(req.params.id);
  const current = requireRecord(await Property.get(id), "Property");
  const data = validateProperty(req.body || {}, current);
  await assertUnitNumberFree(data, id);
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
  const saved = await Property.get(id);
  // Newly published, or open again after a cancelled sale/rent: announce it.
  const announced = maybeAnnounceListing(current, saved);
  if (announced) await recordPropertyHistory(id, req.user.id, "announced", { service: announced, audience: "opted-in customers" });
  res.json(saved);
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
  // Ndani ya nchi / Diaspora: the two client lists the desks work from.
  const segment = ["diaspora", "local"].includes(req.query.segment) ? req.query.segment : null;
  if (!paginationRequested(req.query)) return res.json(await Client.all(projectId, status, segment));
  const paged = await paginatedList({ build: () => Client.paged(projectId, status, searchTerm(req.query.search), segment), ...parsePagination(req.query) });
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
  await setMarketingOptIn(result.id, req.body);
  await setDiasporaFields(result.id, req.body, req.access);
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
  await setMarketingOptIn(id, req.body);
  await setDiasporaFields(id, req.body, req.access);
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
