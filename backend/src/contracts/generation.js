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
  return {
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
  };
}

/** The built-in template, used when the caller does not select one. */
export const DEFAULT_CONTRACT_TEMPLATE = `# {{COMPANY_NAME}} - Sale Agreement

This Sale Agreement is made on {{CONTRACT_DATE}} between {{COMPANY_NAME}} (the "Seller") and {{CLIENT_NAME}} (the "Buyer") of {{CLIENT_PHONE}} / {{CLIENT_EMAIL}}.

# The Property

The Seller agrees to sell and the Buyer agrees to purchase the property described below.

Property: {{PROPERTY_NAME}}
Property number: {{PROPERTY_NUMBER}}
Location: {{PROPERTY_LOCATION}}
Project: {{PROJECT_NAME}}

# Agreement Term

This agreement commences on {{AGREEMENT_START_DATE}} and runs for {{AGREEMENT_DURATION}}, ending on {{AGREEMENT_END_DATE}}.

# Purchase Price

The original price of the property is {{ORIGINAL_PRICE}}.

A discount of {{DISCOUNT_PERCENT}} is allowed, giving a discount amount of {{DISCOUNT_AMOUNT}}.

The total purchase price payable by the Buyer is therefore {{FINAL_PRICE}}.

# Payment Plan

The Buyer shall pay a deposit of {{DEPOSIT}}, followed by {{INSTALLMENT_COUNT}} installment(s) on a {{PAYMENT_FREQUENCY}} basis, the first falling due on {{FIRST_DUE_DATE}}.

# Contract Reference

This agreement is issued under contract number {{CONTRACT_NUMBER}} and is governed by the laws of the United Republic of Tanzania.

Signed for and on behalf of the Seller: ______________________

Signed by the Buyer: ______________________`;

/** Renders a template body with the contract's own values. */
export function renderContractDocument(templateBody, values) {
  return renderTemplate(templateBody, values);
}

/** Generates the real PDF and returns the stored-file facts. */
export async function produceContractDocument({ templateBody, values, title, contractNumber }) {
  return generateContractDocument({ text: renderContractDocument(templateBody, values), title, contractNumber });
}

export { CONTRACT_PLACEHOLDERS, formatDocumentDate, formatMoney, unknownPlaceholders };
