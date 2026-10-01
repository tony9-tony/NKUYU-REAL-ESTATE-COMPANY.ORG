// ---------------------------------------------------------------------------
// Contract generation: values -> rendered document.
//
// This module is the single place that knows HOW a contract document is
// assembled. It does no database and no filesystem work of its own beyond
// handing the finished text to the PDF writer, so the mapping from a contract
// to its document text can be reasoned about (and tested) on its own.
//
// Every value comes from the server's authoritative records. Nothing here is
// derived from a request body.
// ---------------------------------------------------------------------------
import { CONTRACT_PLACEHOLDERS, formatDocumentDate, formatMoney, generateContractDocument, renderTemplate, unknownPlaceholders } from "./workflow.js";
import { AGREEMENTS, agreementFor } from "./agreements.js";

const PROPERTY_TYPE_LABELS = { land: "Land / plot", house: "House", apartment: "Apartment", villa: "Villa", commercial: "Commercial property", penthouse: "Penthouse" };

/** Frequency -> how many months one step covers. */
const FREQUENCY_MONTHS = {
  monthly: 1,
  quarterly: 3,
  "semi-annual": 6,
  "half-yearly": 6,
  biannual: 6,
  annual: 12,
  yearly: 12,
};

export const PAYMENT_FREQUENCIES = Object.keys(FREQUENCY_MONTHS);

export function monthsPerFrequency(frequency) {
  return FREQUENCY_MONTHS[String(frequency || "monthly").toLowerCase()] || 1;
}

/**
 * Builds the placeholder dictionary for one contract.
 *
 * `companyName` comes from the organization row, so the company identity is
 * read from the existing configuration rather than hardcoded here.
 */
export function buildContractValues({ contract, project, property, client, companyName, plan = {} }) {
  // "24 months" - the unit is stored as a singular-or-plural word and is printed
  // exactly as the office entered it, so "1 months" is never invented.
  const unit = String(contract.agreement_duration_unit || "months").replace(/s$/, "");
  const duration = contract.agreement_duration ? `${contract.agreement_duration} ${unit}${Number(contract.agreement_duration) === 1 ? "" : "s"}` : "";
  const agreement = agreementFor(contract.deal_type);
  const area = Number(property?.area);
  return {
    CONTRACT_TITLE: agreement.title,
    CLIENT_ROLE: agreement.clientRole,
    TITLE_DEED_NUMBER: contract.title_deed_number || property?.title_deed_number || "To be confirmed",
    PROPERTY_TYPE: PROPERTY_TYPE_LABELS[property?.property_type] || (property?.property_type ? String(property.property_type) : "Not specified"),
    PROPERTY_AREA: Number.isFinite(area) && area > 0 ? `${area.toLocaleString("en-US")} square metres` : "Not specified",
    CLIENT_NAME: contract.client_name || client?.name || "",
    CLIENT_PHONE: contract.client_phone || client?.phone || "Not provided",
    CLIENT_EMAIL: contract.client_email || client?.email || "Not provided",
    COMPANY_NAME: companyName || "MKUYU",
    PROJECT_NAME: project?.name || "",
    PROPERTY_NAME: property?.name || "",
    // A property has no separate "number" column in this schema; its identity
    // for a human reader is the project + name pair, so the id is exposed too.
    PROPERTY_NUMBER: property?.property_number || property?.code || (property?.id ? `P-${String(property.id).padStart(4, "0")}` : ""),
    PROPERTY_LOCATION: property?.location || "",
    ORIGINAL_PRICE: formatMoney(contract.original_price),
    DISCOUNT_PERCENT: `${formatMoney(contract.discount_pct)}%`,
    DISCOUNT_AMOUNT: formatMoney(contract.discount_amount),
    // The final price is the same number the payment schedule and reports read:
    // `contracts.value`. There is no second definition of the amount owed.
    FINAL_PRICE: formatMoney(contract.value),
    DEPOSIT: formatMoney(plan.deposit ?? contract.deposit_amount ?? 0),
    INSTALLMENT_COUNT: String(contract.installment_count ?? plan.installments ?? 0),
    PAYMENT_FREQUENCY: String(contract.payment_frequency || plan.frequency || "Not specified"),
    FIRST_DUE_DATE: formatDocumentDate(contract.first_due_date || plan.first_due_date) || "Not specified",
    AGREEMENT_START_DATE: formatDocumentDate(contract.start_date),
    AGREEMENT_END_DATE: formatDocumentDate(contract.end_date),
    AGREEMENT_DURATION: duration,
    CONTRACT_DATE: formatDocumentDate(contract.contract_date),
    CONTRACT_NUMBER: contract.contract_number || "",
    // A blank signing line for custom templates. Once Legal approves, the
    // approving lawyer's real signature is added as a block at the end.
    LAWYER_SIGNATURE: "____________________________",
  };
}

/** The built-in agreement for a deal type (Buy, Rent or Sell). */
export function builtInAgreement(dealType) {
  return agreementFor(dealType);
}

/** The built-in template, used when the caller does not select one: a Sale. */
export const DEFAULT_CONTRACT_TEMPLATE = AGREEMENTS.buy.body;

/**
 * Values for one contract, plus CONTRACT_BODY: the agreement wording for the
 * contract's type, already filled, for a letterhead template to carry.
 */
export function buildDocumentValues(args, agreementBody) {
  const values = buildContractValues(args);
  // The lawyer's signature spot stays a placeholder inside the body, so the
  // Word filler can put the real signature there once Legal approves.
  const { LAWYER_SIGNATURE, ...bodyValues } = values;
  return { ...values, CONTRACT_BODY: renderTemplate(agreementBody || agreementFor(args.contract?.deal_type).body, bodyValues) };
}

/** Renders a template body with the contract's own values. */
export function renderContractDocument(templateBody, values) {
  return renderTemplate(templateBody, values);
}

/** Generates the real PDF and returns the stored-file facts. */
export async function produceContractDocument({ templateBody, values, title, contractNumber, signature = null }) {
  return generateContractDocument({ text: renderContractDocument(templateBody, values), title, contractNumber, signature });
}

export { CONTRACT_PLACEHOLDERS, formatDocumentDate, formatMoney, unknownPlaceholders };
