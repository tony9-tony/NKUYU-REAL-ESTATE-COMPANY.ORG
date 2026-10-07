// ---------------------------------------------------------------------------
// MKUYU duty catalogue.
//
// Department -> Role -> Duty -> Permission -> Access scope
//
// `role_permissions` stays the single enforced source of truth that the request
// middleware reads. Duties are the declared responsibilities that justify those
// permissions, which lets the access matrix be checked in BOTH directions:
//
//   * a duty whose permissions the role does not hold  -> cannot do its job
//   * a role permission no duty justifies              -> power without a job
//
// The check functions at the bottom are exercised by the access-matrix test and
// by GET /org/access-matrix.
// ---------------------------------------------------------------------------

/** Permissions that grant system administration rather than business work. */
export const SYSTEM_PERMISSIONS = new Set([
  "manage_users", "manage_roles", "manage_permissions", "manage_settings",
]);

/**
 * Permissions that decide the contract lifecycle.
 *
 * Most have a single owning department. `request_changes` is different: Legal
 * raises corrections, Finance raises corrections to the payment terms, Sales
 * answers a submission, and the MD may send a contract back. What nobody else
 * gets is `approve_legal`, `validate_finance` and `approve_management`.
 */
export const CONTRACT_OWNERSHIP = {
  submit_contract: ["SALES, MARKETING & OPERATIONS", "DIASPORA DESK"],
  review_legal: ["LEGAL"],
  request_changes: ["LEGAL", "FINANCE & ACCOUNTS", "SALES, MARKETING & OPERATIONS", "MANAGEMENT", "DIASPORA DESK"],
  approve_legal: ["LEGAL"],
  validate_finance: ["FINANCE & ACCOUNTS"],
  approve_management: ["MANAGEMENT"],
};

/**
 * Owner selling decision points (see sales/ownerListing.js). The owner side
 * belongs to Sales (Property Officer, Department Manager) and the MD; only
 * Legal checks the title, and only the MD signs the mandate.
 */
export const OWNER_LISTING_OWNERSHIP = {
  run_owner_listings: ["SALES, MARKETING & OPERATIONS", "MANAGEMENT"],
  check_owner_documents: ["LEGAL"],
  sign_sell_mandate: ["MANAGEMENT"],
};

/**
 * Customer invoices (see payments/customerPayments.js). Finance accepts the
 * money; raising invoices may move to Sales later.
 */
export const CUSTOMER_PAYMENT_OWNERSHIP = {
  set_payment_requests: ["FINANCE & ACCOUNTS", "SALES, MARKETING & OPERATIONS"],
  edit_payment_accounts: ["FINANCE & ACCOUNTS"],
  confirm_customer_payments: ["FINANCE & ACCOUNTS"],
};

/** The only department permitted to hold system-administration permissions. */
export const SYSTEM_ADMIN_DEPARTMENT = "ICT & ADMINISTRATION";

/**
 * The department each role belongs to. This is a property of the role's design,
 * not of who happens to hold it today, so ownership rules must be policed
 * against this rather than against current post-holders.
 */
export const ROLE_HOME_DEPARTMENT = {
  "System Administrator": SYSTEM_ADMIN_DEPARTMENT,
  ICTO: SYSTEM_ADMIN_DEPARTMENT,
  "Administration & IT Support Officer": SYSTEM_ADMIN_DEPARTMENT,
  "Managing Director": "MANAGEMENT",
  "Legal Manager": "LEGAL",
  "Legal Officer": "LEGAL",
  "Finance Manager": "FINANCE & ACCOUNTS",
  "Finance Officer": "FINANCE & ACCOUNTS",
  "Department Manager": "SALES, MARKETING & OPERATIONS",
  "Sales, Marketing & Operations Officer": "SALES, MARKETING & OPERATIONS",
  "Sales Officer": "SALES, MARKETING & OPERATIONS",
  "Marketing Officer": "SALES, MARKETING & OPERATIONS",
  "Property Officer": "SALES, MARKETING & OPERATIONS",
  "Customer Service Manager": "CUSTOMER SERVICE",
  "Customer Service Officer": "CUSTOMER SERVICE",
  "Diaspora Desk Manager": "DIASPORA DESK",
  "Diaspora Desk Officer": "DIASPORA DESK",
  "Staff Member": "CUSTOMER SERVICE",
  "Sales & Marketing Officer": "SALES, MARKETING & OPERATIONS",
  Accountant: "FINANCE & ACCOUNTS",
  "ICT Officer": SYSTEM_ADMIN_DEPARTMENT,
};

/**
 * The role a new member gets when added straight from a department ("Add staff"
 * on the Departments page): the department's officer-level role. MANAGEMENT has
 * none on purpose - its only role is the Managing Director, which must never be
 * handed out by default. A department not listed here uses DEFAULT_STAFF_ROLE.
 */
export const DEPARTMENT_DEFAULT_ROLE = {
  [SYSTEM_ADMIN_DEPARTMENT]: "Administration & IT Support Officer",
  LEGAL: "Legal Officer",
  "FINANCE & ACCOUNTS": "Finance Officer",
  "SALES, MARKETING & OPERATIONS": "Sales, Marketing & Operations Officer",
  "CUSTOMER SERVICE": "Customer Service Officer",
  "DIASPORA DESK": "Diaspora Desk Officer",
  MANAGEMENT: null,
};
export const DEFAULT_STAFF_ROLE = "Staff Member";

/**
 * Departments nobody is added to with "Add staff" on the Departments page: the
 * MD's department and the system administrators'. Their members are set on the
 * Staff page with a deliberately chosen role.
 */
export const STAFF_LOCKED_DEPARTMENTS = new Set(["MANAGEMENT", SYSTEM_ADMIN_DEPARTMENT]);

/**
 * Cross-department hand-offs a department-scoped assigner may make, on top of
 * assigning within their own department. Sales hands website leads to
 * Customer Service, who contact the customer. Nothing else crosses a
 * department line without organization scope.
 */
export const TASK_HANDOFF = {
  "SALES, MARKETING & OPERATIONS": ["CUSTOMER SERVICE"],
  // The Diaspora Desk runs diaspora requests like Sales runs Tanzanian ones: Customer Service calls the customer.
  "DIASPORA DESK": ["CUSTOMER SERVICE"],
};

/** Placeholder roles being retired, mapped to the role that absorbs members. */
export const ROLE_REPLACEMENTS = {
  "Sales and Marketing Officer": "Sales, Marketing & Operations Officer",
  Supervisor: "Department Manager",
};

/** role name -> duties. Each duty lists the permissions needed to perform it. */
export const ROLE_DUTIES = {
  "System Administrator": [
    { key: "system_administration", label: "Administer the system", description: "Owns users, roles, permissions and organization settings.", permissions: ["manage_users", "manage_roles", "manage_permissions", "manage_settings", "view", "create", "edit", "delete"] },
    { key: "audit_accountability", label: "Maintain audit accountability", description: "Keeps the audit trail and backup discipline intact, and holds the only unrestricted view of it.", permissions: ["view", "view_reports", "view_audit", "export"] },
    { key: "business_oversight", label: "Unrestricted business oversight", description: "Break-glass access to every module when the system is misconfigured.", permissions: ["access_projects", "access_properties", "access_clients", "access_leads", "access_contracts", "access_documents", "access_appointments", "access_debts", "access_payments", "access_reminders", "access_reports", "access_follow_ups", "approve", "view_financial", "submit_contract", "review_legal", "request_changes", "approve_legal", "validate_finance", "approve_management"] },
    { key: "task_assignment_administration", label: "Administer task assignment", description: "Break-glass: may assign and review organization-wide when the configured authority is unavailable.", permissions: ["assign_tasks", "review_tasks"] },
    { key: "contract_templates", label: "Maintain contract templates", description: "Uploads the Word templates contracts are generated on and chooses the default.", permissions: ["upload_contract_templates"] },
  ],
  "Managing Director": [
    { key: "business_direction", label: "Set business direction", description: "Owns strategy across every business module.", permissions: ["access_projects", "access_properties", "access_clients", "access_leads", "access_contracts", "access_documents", "access_appointments", "access_follow_ups", "view", "create", "edit", "delete", "approve", "view_reports", "export"] },
    { key: "management_approval", label: "Approve contracts on behalf of management", description: "The MD decision point. Does not review or rewrite legal terms.", permissions: ["approve_management", "request_changes", "access_reports"] },
    { key: "work_assignment", label: "Assign organization work", description: "Directs work to any department and gives the final decision on work routed up to management.", permissions: ["assign_tasks", "review_tasks"] },
    { key: "financial_oversight", label: "Oversee financial performance", description: "Sees income, outstanding balances and financial reporting, and which customers have paid their invoices.", permissions: ["access_debts", "access_payments", "access_reminders", "view_financial", "view_reports", "export", "view_customer_payments"] },
    { key: "management_reporting", label: "Receive management reporting", description: "Reviews organization-wide performance across departments.", permissions: ["view_reports", "export"] },
    { key: "contract_templates", label: "Maintain contract templates", description: "Uploads the Word templates contracts are generated on and chooses the default.", permissions: ["upload_contract_templates"] },
    { key: "sell_mandate_signature", label: "Sign every sell mandate", description: "A sell mandate (listing price, commission, end date) counts only once the MD signs it, and never one the MD agreed personally. May also act on owner listings and sets the standard commission rate.", permissions: ["sign_sell_mandate", "run_owner_listings"] },
  ],
  "ICTO": [
    { key: "account_administration", label: "Manage staff accounts", description: "Creates, activates and deactivates staff accounts.", permissions: ["manage_users", "view"] },
    { key: "role_and_permission_design", label: "Design roles and permissions", description: "Defines what each role may do, in consultation with management.", permissions: ["manage_roles", "manage_permissions", "view"] },
    { key: "system_settings", label: "Maintain system settings", description: "Owns organization configuration and security settings.", permissions: ["manage_settings", "view"] },
    { key: "security_and_audit", label: "Own security and audit logs", description: "Reads the system audit trail to investigate access and security incidents. Read-only: it grants no ability to change, delete or decide anything.", permissions: ["view_audit", "view_reports"] },
    { key: "technical_support", label: "Provide technical support", description: "Resolves incidents for staff. Deliberately holds no business authority.", permissions: ["view"] },
    { key: "contract_templates", label: "Maintain contract templates", description: "Uploads the Word templates contracts are generated on and chooses the default.", permissions: ["upload_contract_templates"] },
  ],
  "Administration & IT Support Officer": [
    { key: "staff_support", label: "Provide staff support", description: "First-line help for accounts, access requests and device issues.", permissions: ["view"] },
    { key: "staff_records", label: "Maintain staff records", description: "Keeps staff records accurate and support requests logged.", permissions: ["manage_users", "view"] },
    { key: "reporting", label: "Report on support activity", description: "Summarises support load and incidents for management.", permissions: ["view_reports", "export"] },
  ],
  "Legal Manager": [
    { key: "contract_ownership", label: "Own the contract record", description: "Legal holds the final record and its revision history.", permissions: ["access_contracts", "view", "create", "edit", "delete"] },
    { key: "legal_review", label: "Review and approve contracts", description: "Prepares, reviews and approves contracts from the legal perspective.", permissions: ["review_legal", "approve_legal", "request_changes", "approve"] },
    { key: "legal_documents", label: "Manage legal documents", description: "Owns agreements, titles and legal attachments on the contract, and the Word templates contracts are generated on.", permissions: ["access_documents", "view", "create", "edit", "delete", "upload_contract_templates"] },
    { key: "party_verification", label: "Verify the parties on a contract", description: "Confirms the client, project and property named before the contract is signed, and follows the appointments Sales arranges with customers. Sees projects, properties and appointments; never changes them.", permissions: ["access_clients", "view_projects", "view_properties", "view_appointments", "view"] },
    { key: "contract_lifecycle_control", label: "Control the contract lifecycle", description: "Releases the approved contract to the customer and records the signature.", permissions: ["approve_legal", "access_contracts"] },
    { key: "legal_team_leadership", label: "Supervise the legal desk", description: "Reviews legal work and escalates to management when required.", permissions: ["request_changes", "access_reports", "view_reports"] },
    { key: "work_assignment", label: "Assign work within the legal desk", description: "Hands work to legal staff and reviews what they submit. Cannot assign outside the department.", permissions: ["assign_tasks", "review_tasks"] },
    { key: "legal_reporting", label: "Report on the legal register", description: "Exports the contract register and its history for management.", permissions: ["access_reports", "view_reports", "export"] },
  ],
  "Legal Officer": [
    { key: "contract_preparation", label: "Prepare contracts", description: "Drafts agreements and clauses from the approved commercial terms.", permissions: ["access_contracts", "view", "create", "edit", "delete"] },
    { key: "legal_review", label: "Review contracts", description: "Checks clauses, verifies legality and raises corrections.", permissions: ["review_legal", "request_changes", "access_contracts", "view"] },
    { key: "legal_approval", label: "Approve contracts legally", description: "Gives or withholds legal approval. Sole owner of this permission outside administrators.", permissions: ["approve_legal", "approve"] },
    { key: "legal_documents", label: "Manage legal documents", description: "Attaches and maintains agreements, titles and legal records. Before a sell mandate, checks the seller's title deed and confirms the owner's identity and authority to sell; only Legal marks that step, never the Property Officer.", permissions: ["access_documents", "view", "create", "edit", "check_owner_documents"] },
    { key: "revision_history", label: "Maintain contract history", description: "Keeps revisions, clauses and the final record traceable.", permissions: ["access_contracts", "access_reports", "view", "view_reports"] },
    { key: "customer_verification", label: "Verify customer and project detail", description: "Confirms the parties and property named on the contract. Sees projects and properties, never changes them.", permissions: ["access_clients", "view_projects", "view_properties", "view"] },
    { key: "appointment_awareness", label: "Follow customer appointments", description: "Sees every appointment Sales arranges with a customer, to prepare the contract in time. Read only: never arranges, edits or cancels one.", permissions: ["view_appointments", "view"] },
    { key: "contract_templates", label: "Maintain contract templates", description: "Uploads the Word templates contracts are generated on and chooses the default.", permissions: ["upload_contract_templates"] },  ],
  "Finance Manager": [
    { key: "financial_operations", label: "Run day-to-day finance", description: "Owns payments, installments, receipts and the collection register.", permissions: ["access_debts", "access_payments", "access_reminders", "view", "create", "edit", "delete", "view_financial"] },
    { key: "financial_term_validation", label: "Validate contract financial terms", description: "Confirms price, deposit, payment plan, installments and due dates.", permissions: ["validate_finance", "request_changes", "access_contracts", "access_clients"] },
    { key: "collections_management", label: "Manage collections", description: "Chases arrears, raises overdue balances and records payments. Keeps MKUYU's payment details that customers see, raises an invoice on an accepted request before the contract, and checks each customer's proof against MKUYU's statement: accepts it with the amount received (final, the receipt is issued) or rejects it with a reason.", permissions: ["access_debts", "access_payments", "access_follow_ups", "access_reminders", "view", "create", "edit", "view_financial", "set_payment_requests", "edit_payment_accounts", "confirm_customer_payments"] },
    { key: "finance_reporting", label: "Produce finance reporting", description: "Publishes income, debt and collection reporting for management.", permissions: ["access_reports", "view_reports", "export", "view_financial"] },
    { key: "finance_team_leadership", label: "Supervise the finance desk", description: "Reviews and approves finance work within the department.", permissions: ["approve", "view", "edit", "access_reports"] },
    { key: "deal_context", label: "See the deal behind the money", description: "Looks up the project and property a contract or payment belongs to. Read only: never creates, edits or deletes them, and never generates contracts.", permissions: ["view_projects", "view_properties", "view"] },
    { key: "work_assignment", label: "Assign work within the finance desk", description: "Hands work to finance staff and reviews what they submit. Cannot assign outside the department.", permissions: ["assign_tasks", "review_tasks"] },
    { key: "appointment_awareness", label: "Follow customer appointments", description: "Sees every customer appointment and whether it is still scheduled or done, so payments can be expected. Read only: never books, edits or closes one.", permissions: ["view_appointments", "view"] },
  ],
  "Finance Officer": [
    { key: "payment_recording", label: "Record payments and receipts", description: "Logs money received and attaches receipts.", permissions: ["access_payments", "access_debts", "view", "create", "edit", "view_financial"] },
    { key: "installment_tracking", label: "Track installments and due dates", description: "Maintains the installment register and payment reminders.", permissions: ["access_debts", "access_reminders", "view", "create", "edit", "view_financial"] },
    { key: "financial_term_validation", label: "Validate contract financial terms", description: "Confirms payment plans match the approved price.", permissions: ["validate_finance", "request_changes", "access_contracts", "access_clients"] },
    { key: "client_balance_service", label: "Answer client balance questions", description: "Responds to customers on what they owe and when.", permissions: ["access_clients", "view", "view_financial"] },
    { key: "deal_context", label: "See the deal behind the money", description: "Looks up the project and property a contract or payment belongs to. Read only: never creates, edits or deletes them, and never generates contracts.", permissions: ["view_projects", "view_properties", "view"] },
    { key: "finance_reporting", label: "Report on collections", description: "Reports income and outstanding balances for the finance desk.", permissions: ["access_reports", "view_reports"] },
    { key: "appointment_awareness", label: "Follow customer appointments", description: "Sees every customer appointment and whether it is still scheduled or done, so payments can be expected. Read only: never books, edits or closes one.", permissions: ["view_appointments", "view"] },
  ],
  "Department Manager": [
    { key: "department_operations", label: "Run departmental operations", description: "Creates, edits and reviews records across the department's modules.", permissions: ["access_projects", "access_properties", "access_clients", "access_leads", "access_appointments", "access_documents", "access_follow_ups", "view", "create", "edit", "approve", "view_reports"] },
    { key: "team_supervision", label: "Supervise the department team", description: "Reviews team output and removes records that are no longer valid.", permissions: ["delete", "view", "edit"] },
    { key: "department_reporting", label: "Report on department performance", description: "Turns departmental activity into management reporting.", permissions: ["access_reports", "view_reports", "export"] },
    { key: "deal_initiation_supervision", label: "Supervise deal initiation", description: "Ensures deals are raised correctly and submitted to Legal. Does not approve them.", permissions: ["submit_contract", "request_changes", "access_contracts"] },
    { key: "work_assignment", label: "Assign work within the department", description: "Hands work to department staff and reviews what they submit. Cannot assign outside the department.", permissions: ["assign_tasks", "review_tasks"] },
    { key: "owner_selling_supervision", label: "Supervise owner selling", description: "May act on any owner listing and give it to a Property Officer. Cannot check the title (Legal) or sign the mandate (MD).", permissions: ["run_owner_listings"] },  ],
  "Sales, Marketing & Operations Officer": [
    { key: "deal_initiation", label: "Initiate the deal", description: "Creates the customer, property and project detail a contract needs.", permissions: ["access_clients", "access_properties", "access_projects", "view", "create", "edit"] },
    { key: "contract_submission", label: "Submit the deal to Legal", description: "Starts the contract lifecycle. Does not approve it.", permissions: ["submit_contract", "access_contracts", "request_changes"] },
    { key: "lead_management", label: "Manage leads and enquiries", description: "Captures, qualifies and converts enquiries into clients.", permissions: ["access_leads", "view", "create", "edit"] },
    { key: "viewings_and_appointments", label: "Coordinate viewings and appointments", description: "Schedules site visits, calls and inspections with customers.", permissions: ["access_appointments", "view", "create", "edit"] },
    { key: "marketing_material", label: "Maintain marketing and listing material", description: "Keeps property listings and supporting documents current.", permissions: ["access_documents", "view", "create", "edit"] },
    { key: "customer_follow_up", label: "Follow up on customers", description: "Schedules and closes follow-ups so deals do not go cold.", permissions: ["access_follow_ups", "view", "create", "edit"] },
    { key: "sales_reporting", label: "Report on sales activity", description: "Reports pipeline and conversion for management.", permissions: ["access_reports", "view_reports"] },
    { key: "contract_templates", label: "Maintain contract templates", description: "Uploads the Word templates contracts are generated on and chooses the default.", permissions: ["upload_contract_templates"] },
  ],
  "Sales Officer": [
    { key: "deal_initiation", label: "Initiate the deal", description: "Creates the customer, property and project detail a contract needs.", permissions: ["access_clients", "access_properties", "access_projects", "view", "create", "edit"] },
    { key: "contract_submission", label: "Submit the deal to Legal", description: "Starts the contract lifecycle. Does not approve it.", permissions: ["submit_contract", "access_contracts"] },
    { key: "lead_management", label: "Manage leads and enquiries", description: "Captures, qualifies and converts enquiries into clients.", permissions: ["access_leads", "view", "create", "edit"] },
    { key: "viewings_and_appointments", label: "Coordinate viewings and appointments", description: "Schedules site visits, calls and inspections with customers.", permissions: ["access_appointments", "view", "create", "edit"] },
    { key: "customer_follow_up", label: "Follow up on customers", description: "Schedules and closes follow-ups so deals do not go cold.", permissions: ["access_follow_ups", "view", "create", "edit"] },
    { key: "sales_reporting", label: "Report on sales activity", description: "Reports pipeline and conversion for management.", permissions: ["access_reports", "view_reports"] },
    { key: "contract_templates", label: "Maintain contract templates", description: "Uploads the Word templates contracts are generated on and chooses the default.", permissions: ["upload_contract_templates"] },
  ],
  "Marketing Officer": [
    { key: "lead_generation", label: "Generate leads", description: "Runs campaigns and captures enquiries from the market.", permissions: ["access_leads", "view", "create", "edit"] },
    { key: "listing_preparation", label: "Prepare property listings", description: "Prepares marketing-ready property and project detail.", permissions: ["access_properties", "access_projects", "view", "create", "edit"] },
    { key: "marketing_material", label: "Maintain marketing material", description: "Keeps brochures, photos and campaign documents current.", permissions: ["access_documents", "view", "create", "edit"] },
    { key: "viewings_and_appointments", label: "Coordinate viewings", description: "Schedules site visits and inspections with prospective buyers.", permissions: ["access_appointments", "view", "create", "edit"] },
    { key: "client_records", label: "Maintain client records", description: "Keeps the customer record accurate for campaigns and follow-up.", permissions: ["access_clients", "view", "create", "edit"] },
    { key: "marketing_reporting", label: "Report on marketing activity", description: "Reports lead volume and conversion for management.", permissions: ["access_reports", "view_reports"] },
  ],
  "Property Officer": [
    { key: "estate_inventory", label: "Maintain the estate inventory", description: "Adds, prices and classifies properties.", permissions: ["access_properties", "access_projects", "view", "create", "edit"] },
    { key: "listing_and_availability", label: "Manage listing status", description: "Marks properties available, reserved, sold or leased.", permissions: ["access_properties", "edit", "view"] },
    { key: "viewings_and_inspections", label: "Coordinate viewings and inspections", description: "Hosts site visits and records inspection outcomes.", permissions: ["access_appointments", "view", "create", "edit"] },
    { key: "property_documents", label: "Maintain property documents", description: "Attaches titles, permits and plans to the property.", permissions: ["access_documents", "view", "create", "edit"] },
    { key: "customer_coordination", label: "Coordinate with customers", description: "Answers property availability questions raised by sales and customer service.", permissions: ["access_clients", "view"] },
    { key: "owner_selling", label: "Run owner selling", description: "Visits and values the owner's property, agrees the sell mandate and commission with the owner (the MD signs it), records every offer and presents it to the owner in writing, and sends every owner an update at least once a week.", permissions: ["run_owner_listings"] },
  ],
  "Customer Service Manager": [
    { key: "customer_service_leadership", label: "Supervise the customer service desk", description: "Reviews service quality, workload and outstanding customer commitments.", permissions: ["access_clients", "access_appointments", "access_leads", "access_follow_ups", "view", "create", "edit", "approve"] },
    { key: "work_assignment", label: "Assign work within the service desk", description: "Hands work to service staff and reviews what they submit. Cannot assign outside the department.", permissions: ["assign_tasks", "review_tasks"] },
    { key: "service_quality", label: "Own service quality", description: "Removes or corrects records that misrepresent a customer commitment.", permissions: ["delete", "view", "edit"] },
    { key: "escalation_management", label: "Manage escalations", description: "Routes contract questions to Legal and property questions to the property desk. Sees properties read-only; deliberately no contract module access.", permissions: ["view_properties", "view"] },
    { key: "customer_reporting", label: "Report on customer service", description: "Reports response times, follow-up completion and enquiry volume.", permissions: ["access_reports", "view_reports", "export"] },
  ],
  "Customer Service Officer": [
    { key: "customer_communication", label: "Communicate with customers", description: "Answers customer questions and keeps them informed.", permissions: ["access_clients", "view", "create", "edit"] },
    { key: "inquiry_and_lead_handling", label: "Handle incoming enquiries", description: "Captures customer enquiries and routes them to the right desk.", permissions: ["access_leads", "view", "create", "edit"] },
    { key: "appointment_coordination", label: "Coordinate appointments", description: "Books and confirms viewings, calls and inspections.", permissions: ["access_appointments", "view", "create", "edit"] },
    { key: "signing_follow_up", label: "Follow up on contract signing", description: "Chases signatures. Escalates contract questions to Legal rather than answering them.", permissions: ["access_follow_ups", "view", "create", "edit"] },
    { key: "property_enquiry", label: "Handle property enquiries", description: "Answers availability and viewing questions on estate. Sees properties read-only.", permissions: ["view_properties", "view"] },
    { key: "service_reporting", label: "Report on service activity", description: "Reports enquiry volume and follow-up completion to the desk manager.", permissions: ["access_reports", "view_reports"] },
  ],
  "Diaspora Desk Manager": [
    { key: "diaspora_contracts", label: "Prepare diaspora contracts", description: "Prepares the Diaspora Sale or Lease Agreement for a verified customer and submits it to Legal; answers Legal's corrections. Never approves it.", permissions: ["submit_contract", "access_contracts", "request_changes"] },
    { key: "diaspora_desk_leadership", label: "Run the diaspora desk", description: "Keeps the shared queue of diaspora customers moving: who is waiting, what is overdue, who follows up.", permissions: ["access_clients", "access_leads", "view", "create", "edit", "approve"] },
    { key: "work_assignment", label: "Assign work within the desk", description: "Hands work to desk officers and reviews it. The desk is one shared queue; assignment is for follow-up, not ownership.", permissions: ["assign_tasks", "review_tasks"] },
    { key: "diaspora_records_quality", label: "Keep diaspora records correct", description: "Corrects or removes wrong customer records, requests and follow-ups.", permissions: ["delete", "edit", "view"] },
    { key: "diaspora_document_check", label: "First check of identity documents", description: "Checks that the passport and proof of residence match what the customer declared, before Legal verifies citizenship.", permissions: ["access_documents", "access_clients", "view", "edit"] },
    { key: "diaspora_meetings", label: "Arrange calls and viewings", description: "Books calls (by the customer's time zone) and viewings for family or agents on site.", permissions: ["access_appointments", "access_follow_ups", "view", "create", "edit"] },
    { key: "diaspora_property_answers", label: "Answer property questions", description: "Sees projects and properties read-only to answer availability and construction questions.", permissions: ["view_properties", "view_projects", "view"] },
    { key: "diaspora_reporting", label: "Report on the diaspora desk", description: "Reports sign-ups, requests, verification and conversion to management.", permissions: ["access_reports", "view_reports", "export"] },
  ],
  "Diaspora Desk Officer": [
    { key: "lead_handoff", label: "Hand diaspora requests to Customer Service", description: "Receives requests from the diaspora portal and assigns Customer Service to contact the customer by the means they chose, then reviews the outcome. May assign within the desk and to Customer Service only.", permissions: ["access_leads", "assign_tasks", "review_tasks"] },
    { key: "diaspora_contracts", label: "Prepare diaspora contracts", description: "Prepares the Diaspora Sale or Lease Agreement for a verified customer and submits it to Legal; answers Legal's corrections. Never approves it.", permissions: ["submit_contract", "access_contracts", "request_changes"] },
    { key: "diaspora_customer_service", label: "Serve diaspora customers", description: "Works the shared queue: answers sign-ups and portal requests by the customer's chosen channel.", permissions: ["access_clients", "access_leads", "view", "create", "edit"] },
    { key: "diaspora_document_check", label: "First check of identity documents", description: "Checks that the passport and proof of residence match what the customer declared, before Legal verifies citizenship.", permissions: ["access_documents", "access_clients", "view", "edit"] },
    { key: "diaspora_meetings", label: "Arrange calls and viewings", description: "Books calls (by the customer's time zone) and viewings for family or agents on site.", permissions: ["access_appointments", "access_follow_ups", "view", "create", "edit"] },
    { key: "diaspora_property_answers", label: "Answer property questions", description: "Sees projects and properties read-only to answer availability and construction questions.", permissions: ["view_properties", "view_projects", "view"] },
    { key: "diaspora_reporting", label: "Report desk activity", description: "Reports their follow-ups to the desk manager.", permissions: ["access_reports", "view_reports"] },
  ],
  "Staff Member": [
    { key: "customer_records", label: "Maintain customer records", description: "Keeps basic contact and relationship data accurate.", permissions: ["access_clients", "view", "create", "edit"] },
    { key: "appointment_coordination", label: "Coordinate appointments", description: "Books and confirms appointments on behalf of the office.", permissions: ["access_appointments", "view", "create", "edit"] },
  ],
  "Sales & Marketing Officer": [
    { key: "deal_initiation", label: "Initiate the deal", description: "Creates the customer, property and project detail a contract needs.", permissions: ["access_clients", "access_properties", "access_projects", "view", "create", "edit"] },
    { key: "contract_submission", label: "Create and submit contracts", description: "Starts the contract lifecycle and answers Legal's corrections. Does not approve it.", permissions: ["submit_contract", "access_contracts", "request_changes"] },
    { key: "lead_management", label: "Manage leads and enquiries", description: "Captures, qualifies and converts enquiries into clients.", permissions: ["access_leads", "view", "create", "edit"] },
    { key: "property_listings", label: "Maintain property listings and photos", description: "Keeps prices, photos, documents and availability current, and removes listings that are no longer valid.", permissions: ["access_properties", "access_documents", "view", "create", "edit", "delete"] },
    { key: "viewings_and_follow_up", label: "Run viewings and follow-ups", description: "Schedules site visits and closes follow-ups so deals do not go cold.", permissions: ["access_appointments", "access_follow_ups", "view", "create", "edit"] },
    { key: "sales_reporting", label: "Report on sales activity", description: "Reports pipeline and conversion for the MD.", permissions: ["access_reports", "view_reports", "export"] },
    { key: "contract_templates", label: "Maintain contract templates", description: "Uploads the Word templates contracts are generated on and chooses the default.", permissions: ["upload_contract_templates"] },
    { key: "lead_handoff", label: "Hand website leads to Customer Service", description: "Receives Rent/Buy requests from the website and assigns Customer Service to contact the customer by the means they chose, then reviews the outcome. May assign within Sales and to Customer Service only.", permissions: ["access_leads", "assign_tasks", "review_tasks"] },
  ],
  "Accountant": [
    { key: "payment_recording", label: "Record deposits and payments", description: "Logs money received, attaches receipts and corrects mistaken entries.", permissions: ["access_payments", "access_debts", "view", "create", "edit", "delete", "view_financial"] },
    { key: "installment_tracking", label: "Track installments and due dates", description: "Maintains the installment register and payment reminders.", permissions: ["access_debts", "access_reminders", "view", "create", "edit", "view_financial"] },
    { key: "financial_term_validation", label: "Check the money on contracts", description: "Confirms price, deposit, payment plan and due dates before the MD approves.", permissions: ["validate_finance", "request_changes", "access_contracts", "access_clients"] },
    { key: "overdue_follow_up", label: "Follow up overdue balances", description: "Chases arrears and records what the customer promised.", permissions: ["access_debts", "access_follow_ups", "view", "create", "edit", "view_financial"] },
    { key: "deal_context", label: "See the deal behind the money", description: "Looks up the project and property a contract or payment belongs to. Read only: never creates, edits or deletes them, and never generates contracts.", permissions: ["view_projects", "view_properties", "view"] },
    { key: "finance_reporting", label: "Report on income and balances", description: "Reports income, debt and collections for the MD.", permissions: ["access_reports", "view_reports", "export", "view_financial"] },
    { key: "appointment_awareness", label: "Follow customer appointments", description: "Sees every customer appointment and whether it is still scheduled or done, so payments can be expected. Read only: never books, edits or closes one.", permissions: ["view_appointments", "view"] },
  ],
  "ICT Officer": [
    { key: "account_administration", label: "Manage staff accounts", description: "Creates, activates and deactivates staff accounts and handles access requests.", permissions: ["manage_users", "view"] },
    { key: "role_and_permission_design", label: "Design roles and permissions", description: "Defines what each role may do, in consultation with the MD.", permissions: ["manage_roles", "manage_permissions", "view"] },
    { key: "system_settings", label: "Maintain system settings and backups", description: "Owns organization configuration, security settings and backup discipline.", permissions: ["manage_settings", "view"] },
    { key: "security_and_audit", label: "Own security and audit logs", description: "Reads the system audit trail to investigate access and security incidents. Read-only.", permissions: ["view_audit", "view_reports"] },
    { key: "technical_support", label: "Provide technical support", description: "Resolves device and system issues for staff. Deliberately holds no business authority.", permissions: ["view"] },
    { key: "contract_templates", label: "Maintain contract templates", description: "Uploads the Word templates contracts are generated on and chooses the default.", permissions: ["upload_contract_templates"] },
  ],
};
/**
 * The whole organization as a department -> role -> duty tree.
 *
 * Reads from ROLE_HOME_DEPARTMENT and ROLE_DUTIES (the same declarations the
 * access-matrix audit uses) rather than re-deriving anything, so this view and
 * the enforcement cannot disagree about who owns what.
 *
 * `permissionLabels` turns bare permission keys into the human wording stored in
 * the permissions table, so the UI never has to show `approve_legal`.
 */
export function departmentDutyTree(permissionLabels = new Map()) {
  const departments = new Map();
  const add = (name) => {
    if (!departments.has(name)) departments.set(name, { name, roles: [], dutyCount: 0 });
    return departments.get(name);
  };
  for (const [role, department] of Object.entries(ROLE_HOME_DEPARTMENT)) {
    add(department);
  }
  for (const [role, department] of Object.entries(ROLE_HOME_DEPARTMENT)) {
    const duties = (ROLE_DUTIES[role] || []).map((duty) => ({
      key: duty.key,
      label: duty.label,
      description: duty.description,
      permissions: duty.permissions,
      permissionLabels: duty.permissions.map((key) => ({ key, label: permissionLabels.get(key) || key })),
      // A duty is an approval duty when it carries a contract-lifecycle
      // permission - those are the ones that actually move a contract forward,
      // so the UI can single them out from routine duties.
      approvalDuty: duty.permissions.some((permission) => permission in CONTRACT_OWNERSHIP),
    }));
    const entry = add(department);
    entry.roles.push({ role, duties, dutyCount: duties.length });
    entry.dutyCount += duties.length;
  }
  // Highest authority first, so MANAGEMENT leads and ICT & ADMINISTRATION trails.
  const order = ["MANAGEMENT", "FINANCE & ACCOUNTS", "SALES, MARKETING & OPERATIONS", "DIASPORA DESK", "LEGAL", "CUSTOMER SERVICE", "ICT & ADMINISTRATION"];
  return [...departments.values()]
    .sort((a, b) => {
      const left = order.indexOf(a.name);
      const right = order.indexOf(b.name);
      return (left === -1 ? order.length : left) - (right === -1 ? order.length : right) || a.name.localeCompare(b.name);
    })
    .map((entry) => ({ ...entry, roles: entry.roles.sort((a, b) => a.role.localeCompare(b.role)) }));
}

// ---------------------------------------------------------------------------
// Consistency checks. These are the "both directions" audit the access matrix
// needs, written as pure functions so the test can assert them directly and
// GET /org/access-matrix can surface the same result.
// ---------------------------------------------------------------------------

/** Flatten the catalogue into per-role duty/permission relationships. */
export function dutyMatrix(roles) {
  const entries = [];
  for (const role of roles) {
    for (const duty of ROLE_DUTIES[role] || []) {
      entries.push({ role, duty: duty.key, label: duty.label, description: duty.description, permissions: duty.permissions });
    }
  }
  return entries;
}

/**
 * Duty <-> permission consistency for one role.
 *
 * missingPermission     - duties the role holds permissions for but cannot perform
 * unjustifiedPermission - role powers that no declared duty accounts for
 */
export function checkRoleDuties(roleName, rolePermissions, duties) {
  const held = new Set(rolePermissions);
  const missingPermission = [];
  const justified = new Set();
  for (const duty of duties || []) {
    const missing = duty.permissions.filter((permission) => !held.has(permission));
    duty.permissions.forEach((permission) => justified.add(permission));
    if (missing.length) missingPermission.push({ duty: duty.key, label: duty.label, missing });
  }
  const unjustifiedPermission = [...held].filter((permission) => !justified.has(permission)).sort();
  return { missingPermission, unjustifiedPermission };
}

/**
 * Contract ownership. Every lifecycle permission must be held only by roles
 * belonging to the department responsible for it. This is what stops the MD,
 * ICT or a line manager from acquiring legal or financial authority.
 */
export function checkContractOwnership(rolesByName, ownership = { ...CONTRACT_OWNERSHIP, ...OWNER_LISTING_OWNERSHIP, ...CUSTOMER_PAYMENT_OWNERSHIP }) {
  const violations = [];
  for (const [permission, owners] of Object.entries(ownership)) {
    for (const role of Object.values(rolesByName)) {
      if (!role.permissions.includes(permission)) continue;
      // The System Administrator is the documented break-glass superuser.
      if (role.name === "System Administrator") continue;
      if (!owners.includes(role.department)) {
        violations.push({ permission, role: role.name, roleDepartment: role.department, expectedDepartments: owners });
      }
    }
  }
  return violations;
}

/** Only ICT roles may hold system administration, and the MD never may. */
export function checkNoSystemAdminLeak(rolesByName) {
  const violations = [];
  for (const role of Object.values(rolesByName)) {
    if (role.name === "System Administrator") continue;
    if (role.department === SYSTEM_ADMIN_DEPARTMENT) continue;
    const held = [...SYSTEM_PERMISSIONS].filter((permission) => role.permissions.includes(permission));
    if (held.length) violations.push({ role: role.name, department: role.department, holds: held });
  }
  return violations;
}

/**
 * Financial modules are gated on `view_financial`, so holding `access_debts` or
 * `access_payments` without it grants nothing: a permission with no effect.
 */
export function checkDeadPermissions(rolesByName) {
  const dead = [];
  for (const role of Object.values(rolesByName)) {
    for (const module of ["debts", "payments", "reminders"]) {
      if (role.permissions.includes(`access_${module}`) && !role.permissions.includes("view_financial")) {
        dead.push({ role: role.name, permission: `access_${module}`, reason: "needs view_financial to be usable" });
      }
    }
  }
  return dead;
}
