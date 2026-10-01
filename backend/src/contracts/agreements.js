// ---------------------------------------------------------------------------
// The three MKUYU agreements.
//
// Every contract is one of three deals, and the wording follows the deal:
//
//   buy   Sale Agreement            MKUYU sells a property to a Buyer
//   rent  Lease Agreement           MKUYU lets a property to a Tenant
//   sell  Property Sale Mandate     an Owner (Seller) sells through MKUYU
//
// The text is the CONTENT of the contract. It is always placed on the
// organization's contract template (the letterhead): either the uploaded
// default Word template, at its {{CONTRACT_BODY}} spot, or the built-in MKUYU
// letterhead. Line syntax understood by the document writers:
//
//   # Title              the agreement's title (centred, once)
//   ## 1. Heading        a numbered clause heading
//   - item               a bullet
//   > note               a small italic note
//   blank line           paragraph break
//
// Placeholders are the ones in CONTRACT_PLACEHOLDERS (workflow.js).
// ---------------------------------------------------------------------------

const SIGNATURES = (companyRole, clientRole) => `## Signatures

IN WITNESS WHEREOF the Parties have signed this Agreement on the date first written above.

Signed for and on behalf of {{COMPANY_NAME}} (the "${companyRole}"):

Name: ______________________________   Signature: ______________________   Date: ____________

Approved by Legal: {{LAWYER_SIGNATURE}}

Signed by the ${clientRole}, {{CLIENT_NAME}}:

Name: ______________________________   Signature: ______________________   Date: ____________

In the presence of (Witness):

Name: ______________________________   Signature: ______________________   Date: ____________`;

// A lease is about a property only, so it names no project.
const PROPERTY_SCHEDULE_FOR = ({ project = true } = {}) => `## 2. The Property

The property which is the subject of this Agreement (the "Property") is:

- Property: {{PROPERTY_NAME}} ({{PROPERTY_NUMBER}})
- Type: {{PROPERTY_TYPE}}
- Location: {{PROPERTY_LOCATION}}
${project ? "- Project: {{PROJECT_NAME}}\n" : ""}- Size: {{PROPERTY_AREA}}
- Title deed / certificate of occupancy number: {{TITLE_DEED_NUMBER}}`;
const PROPERTY_SCHEDULE = PROPERTY_SCHEDULE_FOR();

const GENERAL = (number) => `## ${number}. Governing Law and Disputes

This Agreement is governed by the laws of the United Republic of Tanzania. The Parties shall first try to settle any dispute amicably within thirty (30) days; failing that, the dispute shall be referred to the courts of competent jurisdiction in Tanzania.

## ${number + 1}. General

This Agreement is the entire agreement between the Parties about the Property and replaces any earlier understanding. A change to it is valid only if made in writing and signed by both Parties. Notices shall be delivered to the addresses, telephone numbers or e-mail addresses given in this Agreement. This Agreement is issued under contract number {{CONTRACT_NUMBER}}.`;

export const AGREEMENTS = {
  buy: {
    title: "Sale Agreement",
    clientRole: "Buyer",
    companyRole: "Seller",
    summary: "MKUYU sells a property to a buyer",
    body: `# Sale Agreement

Contract number: {{CONTRACT_NUMBER}}   ·   Date: {{CONTRACT_DATE}}

## 1. Parties and Introduction

This Sale Agreement (the "Agreement") is made on {{CONTRACT_DATE}} between {{COMPANY_NAME}}, a real estate company incorporated in the United Republic of Tanzania (the "Seller"), and {{CLIENT_NAME}}, of telephone {{CLIENT_PHONE}} and e-mail {{CLIENT_EMAIL}} (the "Buyer"), together the "Parties".

The Seller is the lawful owner of the Property described below and wishes to sell it. The Buyer has inspected the Property and wishes to buy it on the terms of this Agreement.

${PROPERTY_SCHEDULE}

The Seller shall hand over the original title deed, or procure its transfer into the Buyer's name, once the Purchase Price has been paid in full.

## 3. Purchase Price

The list price of the Property is TZS {{ORIGINAL_PRICE}}. A discount of {{DISCOUNT_PERCENT}} (TZS {{DISCOUNT_AMOUNT}}) is allowed, so the purchase price payable by the Buyer is TZS {{FINAL_PRICE}} (the "Purchase Price").

## 4. Payment

The Buyer shall pay a deposit of TZS {{DEPOSIT}} on signing, and the balance in {{INSTALLMENT_COUNT}} installment(s) on a {{PAYMENT_FREQUENCY}} basis, the first falling due on {{FIRST_DUE_DATE}}. Payment is made to the Seller's official accounts only, and every payment is acknowledged with a receipt.

## 5. Agreement Term and Possession

This Agreement takes effect on {{AGREEMENT_START_DATE}} and runs for {{AGREEMENT_DURATION}}, until {{AGREEMENT_END_DATE}}. Vacant possession is given to the Buyer when the Purchase Price is paid in full, unless the Parties agree otherwise in writing.

## 6. Obligations of the Parties

The Seller warrants that the Property is free of any charge, mortgage or claim not disclosed to the Buyer, and shall sign every document needed to transfer the title. The Buyer shall pay the Purchase Price on time and bear the government fees, stamp duty and transfer costs payable by a buyer under the law.

## 7. Default and Termination

If the Buyer fails to pay an installment within thirty (30) days of its due date, the Seller may give written notice to remedy. If the default is not remedied within a further thirty (30) days, the Seller may terminate this Agreement and refund the amounts paid less ten percent (10%) of the Purchase Price as agreed damages. If the Seller cannot transfer good title, the Buyer is entitled to a full refund.

${GENERAL(8)}

${SIGNATURES("Seller", "Buyer")}`,
  },

  rent: {
    title: "Lease Agreement",
    clientRole: "Tenant",
    companyRole: "Landlord",
    summary: "MKUYU lets a property to a tenant",
    body: `# Lease Agreement

Contract number: {{CONTRACT_NUMBER}}   ·   Date: {{CONTRACT_DATE}}

## 1. Parties and Introduction

This Lease Agreement (the "Lease") is made on {{CONTRACT_DATE}} between {{COMPANY_NAME}}, a real estate company incorporated in the United Republic of Tanzania (the "Landlord"), and {{CLIENT_NAME}}, of telephone {{CLIENT_PHONE}} and e-mail {{CLIENT_EMAIL}} (the "Tenant"), together the "Parties".

The Landlord agrees to let, and the Tenant agrees to take, the Property described below for the term and rent set out in this Lease.

${PROPERTY_SCHEDULE_FOR({ project: false })}

## 3. Term

The Lease begins on {{AGREEMENT_START_DATE}} and runs for {{AGREEMENT_DURATION}}, ending on {{AGREEMENT_END_DATE}}. It may be renewed by written agreement signed before it ends.

## 4. Rent and Deposit

The rent for the term is TZS {{ORIGINAL_PRICE}}; after a discount of {{DISCOUNT_PERCENT}} (TZS {{DISCOUNT_AMOUNT}}) the rent payable is TZS {{FINAL_PRICE}}. The Tenant pays a deposit of TZS {{DEPOSIT}} on signing and the rent in {{INSTALLMENT_COUNT}} payment(s) on a {{PAYMENT_FREQUENCY}} basis, the first falling due on {{FIRST_DUE_DATE}}. The deposit is refunded at the end of the Lease, less the cost of any damage beyond fair wear and tear and any rent unpaid.

## 5. Use and Care of the Property

The Tenant shall use the Property only as a residence or for the use agreed in writing, keep it clean and in good repair, pay the utility bills for the term, and shall not sub-let, make structural changes or keep anything unlawful on the Property without the Landlord's written consent.

## 6. Landlord's Obligations

The Landlord shall give the Tenant quiet possession of the Property, keep the structure, roof and main services in good repair, and give at least twenty-four (24) hours' notice before an inspection, except in an emergency.

## 7. Default and Termination

If rent is unpaid for thirty (30) days after it is due, or the Tenant materially breaches this Lease, the Landlord may give thirty (30) days' written notice to remedy, after which the Lease may be terminated and the Property must be vacated. Either Party may end the Lease early on ninety (90) days' written notice, subject to rent being paid up to the end of the notice.

${GENERAL(8)}

${SIGNATURES("Landlord", "Tenant")}`,
  },

  sell: {
    title: "Property Sale Mandate",
    clientRole: "Seller",
    companyRole: "Agent",
    summary: "An owner (seller) sells a property through MKUYU",
    body: `# Property Sale Mandate

Contract number: {{CONTRACT_NUMBER}}   ·   Date: {{CONTRACT_DATE}}

## 1. Parties and Introduction

This Property Sale Mandate (the "Agreement") is made on {{CONTRACT_DATE}} between {{CLIENT_NAME}}, of telephone {{CLIENT_PHONE}} and e-mail {{CLIENT_EMAIL}} (the "Seller"), and {{COMPANY_NAME}}, a real estate company incorporated in the United Republic of Tanzania (the "Agent"), together the "Parties".

The Seller owns the Property described below and appoints the Agent to market it and find a buyer on the terms of this Agreement.

${PROPERTY_SCHEDULE}

The Seller shall give the Agent a copy of the title deed and every document needed to show good title, and confirms that the Property is free of any charge, mortgage or claim except as disclosed in writing.

## 3. Price

The Seller's asking price is TZS {{ORIGINAL_PRICE}}. The Seller authorises the Agent to accept offers of not less than TZS {{FINAL_PRICE}} (after an allowance of {{DISCOUNT_PERCENT}}, TZS {{DISCOUNT_AMOUNT}}), and to refer any lower offer to the Seller.

## 4. Mandate Period

The Agent's mandate begins on {{AGREEMENT_START_DATE}} and runs for {{AGREEMENT_DURATION}}, until {{AGREEMENT_END_DATE}}. During that period the Seller shall refer every enquiry about the Property to the Agent.

## 5. The Agent's Duties

The Agent shall list and market the Property (including on the MKUYU website), arrange and attend viewings, qualify buyers, negotiate in the Seller's interest, and keep the Seller informed of every offer received.

## 6. Payments to the Seller

The purchase money is received by the Agent on the Seller's behalf and paid to the Seller as agreed: TZS {{DEPOSIT}} after the buyer's first payment, and the balance in {{INSTALLMENT_COUNT}} payment(s) on a {{PAYMENT_FREQUENCY}} basis from {{FIRST_DUE_DATE}}, less the Agent's commission of ______ percent (____%) of the sale price.

## 7. Termination

Either Party may end this Agreement on thirty (30) days' written notice. A sale to a buyer introduced by the Agent before the Agreement ends remains subject to the Agent's commission.

${GENERAL(8)}

${SIGNATURES("Agent", "Seller")}`,
  },
};

export const DEAL_TYPES = Object.keys(AGREEMENTS);

/** The agreement for a deal type; an unknown or missing type is a Sale. */
export function agreementFor(dealType) {
  return AGREEMENTS[dealType] || AGREEMENTS.buy;
}
