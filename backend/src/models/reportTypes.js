// Report catalogue: single source of truth for report names and applicable filters.
// The frontend renders filters dynamically from GET /api/v1/reports/types.
// `financial: true` marks reports that expose money, so they require the
// `view_financial` permission and are hidden from staff that lack it.
export const FINANCIAL_REPORT_TYPE_IDS = new Set(["income", "payments", "debt", "overdue", "installments", "summary", "properties", "projects", "contracts"]);

export function reportTypeIsFinancial(id) {
  return FINANCIAL_REPORT_TYPE_IDS.has(id);
}
export const REPORT_TYPES = [
  {
    id: "income", label: "Income Report",
    description: "Actual recorded payments with totals and breakdowns.",
    filters: ["project", "date_from", "date_to", "method", "client"],
  },
  {
    id: "clients", label: "Client Report",
    description: "Clients with contacts, contracts, paid and outstanding amounts.",
    filters: ["project", "status"],
    status_label: "Client status",
    status_values: [
      { value: "lead", label: "Lead" }, { value: "active", label: "Active" }, { value: "inactive", label: "Inactive" },
    ],
  },
  {
    id: "properties", label: "Property Report",
    description: "Inventory with project, location, price and status.",
    filters: ["project", "status"],
    status_label: "Property status",
    status_values: [
      { value: "available", label: "Available" }, { value: "reserved", label: "Reserved" },
      { value: "sold", label: "Sold" }, { value: "leased", label: "Leased" },
    ],
  },
  {
    id: "projects", label: "Project Report",
    description: "Project summary with counts, contract value, payments and outstanding.",
    filters: ["status"],
    status_label: "Project status",
    status_values: [{ value: "active", label: "Active" }, { value: "archived", label: "Archived" }],
  },
  {
    id: "contracts", label: "Contract Report",
    description: "Contracts with installments, paid and outstanding amounts.",
    filters: ["project", "status", "date_from", "date_to", "client"],
    status_label: "Contract status",
    status_values: [
      { value: "active", label: "Active" }, { value: "closed", label: "Closed" }, { value: "cancelled", label: "Cancelled" },
    ],
    date_field: "start date",
  },
  {
    id: "payments", label: "Payment Report",
    description: "Every recorded payment with method, reference and totals.",
    filters: ["project", "date_from", "date_to", "method", "client"],
  },
  {
    id: "debt", label: "Debt / Outstanding Report",
    description: "Installment balances with due dates and clear status labels.",
    filters: ["project", "status", "client"],
    status_label: "Payment status",
    status_values: [
      { value: "pending", label: "Pending" }, { value: "paid", label: "Paid" }, { value: "overdue", label: "Overdue" },
    ],
  },
  {
    id: "overdue", label: "Overdue Report",
    description: "Installments past their due date, with days overdue.",
    filters: ["project", "client"],
  },
  {
    id: "installments", label: "Installment / Payment Schedule Report",
    description: "Full payment schedules with paid and outstanding per installment.",
    filters: ["project", "status", "date_from", "date_to", "client"],
    status_label: "Payment status",
    status_values: [
      { value: "pending", label: "Pending" }, { value: "paid", label: "Paid" }, { value: "overdue", label: "Overdue" },
    ],
    date_field: "due date",
  },
  {
    id: "followups", label: "Follow-up Report",
    description: "Client follow-ups with contact details and next follow-up dates.",
    filters: ["project", "date_from", "date_to", "status"],
    status_label: "Follow-up status",
    status_values: [
      { value: "scheduled", label: "Scheduled" }, { value: "completed", label: "Completed" }, { value: "cancelled", label: "Cancelled" },
    ],
    date_field: "follow-up date",
  },
  {
    id: "documents", label: "Documents Report",
    description: "Document register with categories, links and upload dates.",
    filters: ["project", "status", "date_from", "date_to"],
    status_label: "Document status",
    status_values: [
      { value: "pending", label: "Pending" }, { value: "approved", label: "Approved" }, { value: "archived", label: "Archived" },
    ],
    date_field: "upload date",
  },
  {
    id: "summary", label: "Date-range Summary Report",
    description: "Key totals for a period: income, contracts, debts, activity.",
    filters: ["date_from", "date_to"],
  },
];

export const REPORT_TYPE_IDS = new Set(REPORT_TYPES.map((entry) => entry.id));
export const REPORT_FILTERS = new Set(["project", "date_from", "date_to", "status", "method", "client"]);
export const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "bank", label: "Bank transfer" },
  { value: "mobile", label: "Mobile money" },
  { value: "card", label: "Card" },
  { value: "other", label: "Other" },
];

export function reportTypeDef(id) {
  return REPORT_TYPES.find((entry) => entry.id === id) || null;
}

export function reportTypeLabel(id) {
  return reportTypeDef(id)?.label || id;
}
