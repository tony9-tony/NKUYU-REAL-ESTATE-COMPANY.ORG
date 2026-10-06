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

// ---------------------------------------------------------------------------
// Diaspora agreements (Miliki Ardhi Diaspora).
//
// A customer who lives abroad buys or rents without being in Tanzania: they
// are verified remotely, pay from abroad, sign electronically in the MKUYU
// Diaspora Portal and may act through a representative at home. The wording
// below covers exactly those points. It is a careful starting text, NOT legal
// advice: MKUYU's Legal Department must review it (in particular clause 4 on
// non-citizens and the rates in clauses 8 to 10) before it is used.
// ---------------------------------------------------------------------------
const DIASPORA_SALE = `# Diaspora Sale Agreement

Contract number: {{CONTRACT_NUMBER}}   ·   Date: {{CONTRACT_DATE}}

> Miliki Ardhi Diaspora. This Agreement is concluded remotely through the MKUYU Diaspora Portal. Read every clause. If anything is unclear, ask the MKUYU Diaspora Desk before you sign.

## 1. Parties and Introduction

This Diaspora Sale Agreement (the "Agreement") is made on {{CONTRACT_DATE}} between:

- {{COMPANY_NAME}}, a real estate company incorporated in the United Republic of Tanzania (the "Seller"); and
- {{CLIENT_NAME}}, a national of {{CLIENT_NATIONALITY}} residing in {{CLIENT_RESIDENCE}}, of telephone {{CLIENT_PHONE}} and e-mail {{CLIENT_EMAIL}} (the "Buyer"),

together the "Parties" and each a "Party".

The Buyer lives outside Tanzania and enters into this Agreement remotely. The Seller has verified the Buyer's identity and residence through its Diaspora Desk and Legal Department before issuing this Agreement.

## 2. Definitions

In this Agreement:

- "Portal" means the MKUYU Diaspora Portal on the Seller's website, where the Buyer signs in with a username or e-mail and a password.
- "Diaspora Desk" means the Seller's department that serves customers living abroad.
- "Official Accounts" means the bank accounts held in the Seller's own registered name and shown in the Portal and in Schedule 2. No other account is an Official Account.
- "Purchase Price", "Deposit" and "Installment" have the meanings given in clauses 5 and 6.
- "Business Day" means a day other than a Saturday, Sunday or public holiday in Tanzania. Times are East Africa Time (EAT, UTC+3).
- "Representative" means a person the Buyer appoints under clause 15.
- "Handover" means the delivery of possession and keys under clause 12.

## 3. The Property

The Seller agrees to sell and the Buyer agrees to buy the property described in Schedule 1 (the "Property"):

- Property: {{PROPERTY_NAME}} ({{PROPERTY_NUMBER}})
- Type: {{PROPERTY_TYPE}}
- Location: {{PROPERTY_LOCATION}}
- Project: {{PROJECT_NAME}}
- Size: {{PROPERTY_AREA}}
- Title deed / certificate of occupancy number: {{TITLE_DEED_NUMBER}}

Where the Property is still under construction, it shall be completed substantially in accordance with the plans and specification the Seller has shared with the Buyer. Minor changes required by the authorities or by good building practice, which do not reduce the size, use or value of the Property, are allowed.

## 4. The Buyer's Identity, Eligibility and Form of Ownership

The Buyer confirms that the identity document, nationality and country of residence given to the Seller are true, and that the documents uploaded in the Portal are genuine.

The laws of Tanzania limit how a person who is not a citizen of Tanzania may hold land. Accordingly:

- If the Buyer is a citizen of Tanzania, the Property shall be transferred into the Buyer's own name under clause 13.
- If the Buyer is not a citizen of Tanzania, the Buyer's interest shall be held only in a form permitted by the laws of Tanzania for non-citizens. The Seller's Legal Department shall explain that form in writing in Schedule 3 before this Agreement is signed.
- If no lawful form of holding is available to the Buyer, either Party may end this Agreement by written notice, and the Seller shall refund every amount the Buyer has paid, in full, under clause 9.

The Seller does not give tax, immigration or citizenship advice. The Buyer should obtain independent advice where needed.

## 5. Purchase Price

The list price of the Property is TZS {{ORIGINAL_PRICE}}. A discount of {{DISCOUNT_PERCENT}} (TZS {{DISCOUNT_AMOUNT}}) is allowed, so the purchase price is TZS {{FINAL_PRICE}} (the "Purchase Price").

The Purchase Price is fixed in Tanzanian Shillings and is not changed by movements in exchange rates. It does not include the taxes, fees and costs in clause 14 unless Schedule 2 says otherwise.

## 6. Payment Plan

The Buyer shall pay:

- a deposit of TZS {{DEPOSIT}} (the "Deposit"), due when this Agreement is signed; and
- the balance in {{INSTALLMENT_COUNT}} installment(s) on a {{PAYMENT_FREQUENCY}} basis (each an "Installment"), the first falling due on {{FIRST_DUE_DATE}}.

The full schedule, with every due date and amount, is in Schedule 2 and is kept up to date in the Portal. The Buyer may pay earlier than the due date without any charge. This Agreement takes effect on {{AGREEMENT_START_DATE}} and the payment plan runs for {{AGREEMENT_DURATION}}, until {{AGREEMENT_END_DATE}}.

## 7. How Payments Are Made

- Every payment shall be made only to an Official Account, quoting the contract number {{CONTRACT_NUMBER}} as the reference.
- The Buyer shall NOT pay any money to a staff member, agent, relative or any other person, or to any account not in the Seller's registered name. Money paid in any other way is not a payment to the Seller.
- The Seller will never change its Official Accounts by e-mail, telephone or message alone. Before paying to any new account, the Buyer shall confirm it in the Portal or with the Diaspora Desk.
- A payment counts on the day the Seller's bank credits it, for the amount credited in Tanzanian Shillings. International transfer charges and currency conversion costs are borne by the Buyer.
- Every payment confirmed by the Seller's Finance team is acknowledged with an official MKUYU receipt, which the Buyer can download from the Portal.

## 8. Late Payment

The Seller shall remind the Buyer before each due date and when a payment is late, by SMS, e-mail or the Portal.

If an amount remains unpaid fourteen (14) days after its due date, the Diaspora Desk shall contact the Buyer to agree how it will be settled. If any amount remains unpaid thirty (30) days after its due date, the Seller may send a written notice to remedy under clause 9.

## 9. Default and Termination by the Seller

If the Buyer does not remedy a payment default within thirty (30) days of a written notice to remedy sent to the Buyer's e-mail and the Portal, the Seller may terminate this Agreement by a further written notice.

On such termination the Seller may resell the Property, and shall refund to the Buyer the amounts paid, less agreed damages of ten percent (10%) of the Purchase Price. The deduction shall never exceed the amounts actually paid.

Every refund under this Agreement shall be paid within ninety (90) days, in Tanzanian Shillings, to an account in the Buyer's own name. The Seller does not pay refunds to third parties.

## 10. Withdrawal by the Buyer

The Buyer may withdraw from this Agreement before Handover by written notice through the Portal or to the Diaspora Desk. The Seller shall then refund the amounts paid, less an administration charge of ten percent (10%) of the amounts paid.

The Buyer is entitled to a full refund, with no deduction, if:

- the Seller cannot give good title or the lawful form of holding under clause 4;
- the Seller is in material breach and does not remedy it within thirty (30) days of written notice; or
- Handover is delayed as described in clause 11.

## 11. Construction, Progress Updates and Completion

Where the Property is under construction, the Seller shall post dated progress updates with photographs in the Portal at least once a month while work is under way.

The Seller shall complete the Property within the period the Seller has communicated to the Buyer in writing, extended by any delay under clause 21. If Handover is delayed by more than six (6) months beyond that period for reasons within the Seller's control, the Buyer may terminate this Agreement and receive a full refund under clause 9.

## 12. Handover and Possession

Handover takes place after the Purchase Price and any other amount due under this Agreement have been paid in full.

Before Handover, the Buyer or the Buyer's Representative may inspect the Property and give the Seller a written list of defects within fourteen (14) days. The Seller shall correct genuine construction defects within a reasonable time. Keys are handed only to the Buyer in person or to a Representative appointed under clause 15.

## 13. Transfer of Title

Within ninety (90) days after the Purchase Price is paid in full, the Seller shall deliver the documents needed to register the transfer, or the lawful form of holding under clause 4, and shall co-operate with the land registry and the Commissioner for Lands until registration is complete.

## 14. Taxes, Fees and Costs

Unless Schedule 2 says otherwise:

- the Buyer pays the stamp duty, registration and transfer fees, and the government fees payable by a buyer under the law;
- the Seller pays the taxes payable by a seller on the sale;
- each Party pays its own legal and advisory fees; and
- from Handover, the Buyer pays land rent, property rates, utility bills and service charges for the Property.

## 15. Representative in Tanzania

The Buyer may appoint a Representative to act for the Buyer in Tanzania (for example at inspection, Handover or registration) by a written power of attorney, signed and certified as the law requires.

The Seller shall deal with a Representative only after the Diaspora Desk has received and verified the power of attorney. The Representative may not receive refunds and may not change the Official Accounts or the Buyer's contact details. The Seller is not responsible for the acts of a Representative within the authority the Buyer has given.

## 16. Communication, Electronic Signature and Records

- The Portal and the e-mail address in clause 1 are the official channels between the Parties. The Buyer shall keep their contact details up to date in the Portal or through the Diaspora Desk.
- The Buyer may sign this Agreement electronically in the Portal by confirming the key terms, typing their full name and entering their password. The Seller records the date, time, internet address and a digital fingerprint of the exact text signed. The Parties agree that this electronic signature is valid and binding, in accordance with the Electronic Transactions Act, 2015 of Tanzania.
- Where the law requires a document signed by hand (for example for registration of title), the Buyer shall sign it personally or through a Representative when asked.
- The Seller's records in the Portal of payments, receipts, notices and signatures are evidence of what they show, unless shown to be wrong.

## 17. The Seller's Assurances

The Seller confirms that it owns, or has the right to sell, the Property; that the Property is free of any mortgage, charge or claim not disclosed to the Buyer in writing; and that it has, or will obtain, the approvals required to develop the Property.

## 18. The Buyer's Assurances and Source of Funds

The Buyer confirms that the money used to pay under this Agreement comes from lawful sources. The Seller may ask for reasonable evidence of the source of funds, as required by the anti-money-laundering laws of Tanzania. If the evidence is not provided or is not satisfactory, the Seller may decline further payments and end this Agreement, refunding the amounts paid in full under clause 9 unless the law requires otherwise.

## 19. Personal Data

The Seller processes the Buyer's personal data, including identity documents, only to verify the Buyer, perform this Agreement, meet its legal obligations and keep the Buyer informed, in accordance with the Personal Data Protection Act, 2022 of Tanzania. Identity documents are seen only by the Diaspora Desk, the Legal Department and, where needed, the Finance team. The Buyer may ask to see and correct their data through the Diaspora Desk.

## 20. Transfer of this Agreement

The Buyer may not transfer this Agreement or resell the Property before Handover without the Seller's written consent, which shall not be unreasonably refused. The Seller may charge a reasonable administration fee for a transfer it approves.

## 21. Events Beyond Control

Neither Party is liable for a delay or failure caused by events beyond its reasonable control, such as natural disasters, war, epidemics, or acts of government. The affected Party shall inform the other promptly, and the time for performance is extended by the period of the delay.

## 22. Notices

Notices under this Agreement shall be in writing and sent by e-mail to the addresses in clause 1 and posted in the Portal. A notice is received on the next Business Day after it is sent.

## 23. Disputes

The Parties shall first try to settle any dispute amicably, through the Diaspora Desk and then the Seller's management, within thirty (30) days. A dispute not settled in that time shall be referred to arbitration in Dar es Salaam, in English, under the Arbitration Act of Tanzania, unless the Parties agree to go to the courts of Tanzania. Nothing prevents a Party from asking a court for urgent relief.

## 24. Governing Law and Language

This Agreement is governed by the laws of the United Republic of Tanzania. It is written in English. The Diaspora Desk can explain it in Kiswahili; if there is any difference, the English text prevails.

## 25. General

This Agreement, with its Schedules, is the entire agreement between the Parties about the Property and replaces any earlier understanding. A change is valid only if made in writing and accepted by both Parties, including by acceptance in the Portal. If any clause is found invalid, the rest of the Agreement remains in force. A delay in enforcing a right is not a waiver of it.

## 26. Schedules

The Schedules form part of this Agreement:

- Schedule 1: The Property (clause 3).
- Schedule 2: Payment plan and Official Accounts (clauses 6 and 7). The current schedule is always shown in the Portal.
- Schedule 3: Form of ownership for the Buyer (clause 4). Nationality as verified by the Seller's Legal Department: {{CLIENT_NATIONALITY}}.

## Schedule 2: Payment Plan

- Purchase Price: TZS {{FINAL_PRICE}}
- Deposit on signing: TZS {{DEPOSIT}}
- Balance: {{INSTALLMENT_COUNT}} installment(s), {{PAYMENT_FREQUENCY}}, first due {{FIRST_DUE_DATE}}
- Reference for every payment: {{CONTRACT_NUMBER}}
- Official Accounts: as shown in the MKUYU Diaspora Portal under Payments.

## Schedule 3: Form of Ownership

> To be completed by the Seller's Legal Department before this Agreement is sent to the Buyer.

- Buyer's nationality (verified): {{CLIENT_NATIONALITY}}
- Country of residence: {{CLIENT_RESIDENCE}}
- Form of holding: ______________________________________________

## Signatures

Signed for and on behalf of {{COMPANY_NAME}} (the "Seller"):

Name: ______________________________   Signature: ______________________   Date: ____________

Approved by Legal: {{LAWYER_SIGNATURE}}

Signed by the Buyer, {{CLIENT_NAME}}:

> Signed electronically in the MKUYU Diaspora Portal under clause 16. The date, time, internet address and document fingerprint are recorded by the Seller and shown on the Electronic Signature Record kept with this Agreement.`;

// A lease to a customer living abroad: the standard lease plus the diaspora terms.
const DIASPORA_LEASE_TERMS = `## 10. Diaspora Terms

The Tenant, a national of {{CLIENT_NATIONALITY}} residing in {{CLIENT_RESIDENCE}}, enters into this Lease remotely through the MKUYU Diaspora Portal. Accordingly:

- Rent and the deposit are paid only to the Landlord's accounts in its own registered name, as shown in the Portal, quoting {{CONTRACT_NUMBER}}. No payment to a staff member, agent or relative counts as payment to the Landlord. International transfer and conversion costs are borne by the Tenant; a payment counts for the Tanzanian Shillings credited.
- The Landlord never changes its accounts by e-mail or telephone alone; the Tenant shall confirm any new account in the Portal or with the Diaspora Desk first.
- The Tenant may appoint a representative in Tanzania by a written power of attorney, verified by the Diaspora Desk before the Landlord deals with them. Refunds are paid only to an account in the Tenant's own name.
- The Tenant may sign this Lease electronically in the Portal by confirming its key terms, typing their full name and entering their password; the Landlord records the date, time, internet address and a fingerprint of the text signed. The Parties agree this signature is binding under the Electronic Transactions Act, 2015 of Tanzania.
- The Portal and the Tenant's e-mail are the official channels for notices. Personal data and identity documents are handled under the Personal Data Protection Act, 2022 of Tanzania.

`;

export const DIASPORA_AGREEMENTS = {
  buy: { title: "Diaspora Sale Agreement", clientRole: "Buyer", companyRole: "Seller", summary: "MKUYU sells a property to a customer living abroad", body: DIASPORA_SALE },
  rent: {
    title: "Diaspora Lease Agreement", clientRole: "Tenant", companyRole: "Landlord", summary: "MKUYU lets a property to a customer living abroad",
    body: AGREEMENTS.rent.body.replace("# Lease Agreement", "# Diaspora Lease Agreement").replace("## Signatures", `${DIASPORA_LEASE_TERMS}## Signatures`)
      .replace(/Signed by the Tenant, \{\{CLIENT_NAME\}\}:\n\nName: [^\n]*/, "Signed by the Tenant, {{CLIENT_NAME}}:\n\n> Signed electronically in the MKUYU Diaspora Portal under clause 10. The date, time, internet address and document fingerprint are recorded by the Landlord."),
  },
};

/** The agreement for a deal type and channel ("diaspora" uses the diaspora wording). */
export function agreementForChannel(dealType, channel) {
  if (channel === "diaspora" && DIASPORA_AGREEMENTS[dealType]) return DIASPORA_AGREEMENTS[dealType];
  return agreementFor(dealType);
}
