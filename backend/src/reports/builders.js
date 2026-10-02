import { query } from "../db.js";
import { organizationId } from "../org/rbac.js";
import { currentAccess, scopeCondition } from "../org/access.js";
import { can } from "../org/rbac.js";
import { reportTypeDef, reportTypeIsFinancial, PAYMENT_METHODS } from "../models/reportTypes.js";

export function money(value) { return Math.round((Number(value) || 0) * 100) / 100; }
const text = (key, label) => ({ key, label, kind: "text" });
const num = (key, label) => ({ key, label, kind: "money" });
const dateCol = (key, label) => ({ key, label, kind: "date" });
const intCol = (key, label) => ({ key, label, kind: "int" });

export function parseFilters(type, raw = {}) {
  const def = reportTypeDef(type);
  if (!def) throw new Error("Unknown report type");
  const filters = {};
  if (def.filters.includes("project") && raw.project) filters.project = Number(raw.project);
  if (def.filters.includes("date_from") && raw.date_from) filters.date_from = String(raw.date_from);
  if (def.filters.includes("date_to") && raw.date_to) filters.date_to = String(raw.date_to);
  if (def.filters.includes("status") && raw.status) {
    if (!def.status_values?.some((entry) => entry.value === raw.status)) throw new Error("status filter is invalid for this report");
    filters.status = raw.status;
  }
  if (def.filters.includes("method") && raw.method) {
    if (!PAYMENT_METHODS.some((entry) => entry.value === raw.method)) throw new Error("method filter is invalid");
    filters.method = raw.method;
  }
  if (def.filters.includes("client") && raw.client) filters.client = String(raw.client).slice(0, 80);
  if (filters.date_from && filters.date_to && filters.date_from > filters.date_to) throw new Error("date_from cannot be after date_to");
  return filters;
}

function filtersSql(filters, fields, parameterOffset = 1) {
  const values = [];
  const parts = [];
  const add = (column, value) => { values.push(value); return `${column}=$${parameterOffset + values.length}`; };
  if (filters.project && fields.project) parts.push(add(fields.project, filters.project));
  if (filters.status && fields.status) parts.push(add(fields.status, filters.status));
  if (filters.client && fields.client) parts.push(add(`(${fields.client}) ILIKE`, `%${filters.client}%`));
  if (filters.method && fields.method) parts.push(add(fields.method, filters.method));
  if (filters.date_from && fields.date) { values.push(filters.date_from); parts.push(`${fields.date}>=$${parameterOffset + values.length}`); }
  if (filters.date_to && fields.date) { values.push(filters.date_to); parts.push(`${fields.date}<=$${parameterOffset + values.length}${filters.date_to.length === 10 ? " + INTERVAL '1 day' - INTERVAL '1 second'" : ""}`); }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", values };
}

async function buildRows(type, filters) {
  const orgId = await organizationId();
  const access = currentAccess();
  const values = [orgId];
  const scope = (alias, entity) => scopeCondition(alias, entity, access, values);
  let sql;
  let columns;
  let fields;
  let order = "1";
  if (["income", "payments"].includes(type)) {
    const contractScope = scope("c", "contract");
    const projectScope = scope("pr", "project");
    const paymentScope = scope("p", "payment");
    // Income counts confirmed money only; the payments register shows every
    // payment with its approval state so pending and reversed ones stay visible.
    sql = `SELECT p.paid_at,p.client_name,p.amount,p.method,p.reference,p.status,pr.name AS project_name
      FROM payments p JOIN contracts c ON c.id=p.contract_id AND c.organization_id=$1 AND ${contractScope}
      LEFT JOIN projects pr ON pr.id=c.project_id AND pr.organization_id=$1 AND ${projectScope}
      WHERE p.organization_id=$1 AND ${paymentScope}${type === "income" ? " AND p.status='approved'" : ""}`;
    columns = [dateCol("paid_at", "Payment date"), text("client_name", "Client"), text("project_name", "Project"), num("amount", "Amount"), text("method", "Method"), text("reference", "Reference")];
    if (type === "payments") columns.push(text("status", "Approval"));
    fields = { project: "c.project_id", client: "p.client_name", method: "p.method", date: "p.paid_at" }; order = "p.paid_at DESC";
  } else if (["debt", "overdue", "installments"].includes(type)) {
    const contractScope = scope("c", "contract");
    const projectScope = scope("pr", "project");
    const paymentScope = scope("pmt", "payment");
    const debtScope = scope("d", "debt");
    sql = `SELECT d.due_date,d.client_name,d.amount,d.status,pr.name AS project_name,
      COALESCE((SELECT SUM(pmt.amount) FROM payments pmt WHERE pmt.debt_id=d.id AND pmt.organization_id=$1 AND pmt.status='approved' AND ${paymentScope}),0) AS paid_amount
      FROM debts d JOIN contracts c ON c.id=d.contract_id AND c.organization_id=$1 AND ${contractScope}
      LEFT JOIN projects pr ON pr.id=c.project_id AND pr.organization_id=$1 AND ${projectScope}
      WHERE d.organization_id=$1 AND ${debtScope}`;
    if (type === "overdue") sql += " AND d.status <> 'paid' AND d.due_date < CURRENT_DATE";
    columns = [dateCol("due_date", "Due date"), text("client_name", "Client"), text("project_name", "Project"), num("amount", "Amount"), num("paid_amount", "Paid"), text("status", "Status")];
    fields = { project: "c.project_id", status: "d.status", client: "d.client_name", date: "d.due_date" }; order = "d.due_date ASC";
  } else if (type === "clients") {
    const projectScope = scope("pr", "project");
    const clientScope = scope("c", "client");
    sql = `SELECT c.name,c.email,c.phone,c.client_type,c.status,pr.name AS project_name
      FROM clients c LEFT JOIN projects pr ON pr.id=c.project_id AND pr.organization_id=$1 AND ${projectScope}
      WHERE c.organization_id=$1 AND ${clientScope}`;
    columns = [text("name", "Client"), text("email", "Email"), text("phone", "Phone"), text("client_type", "Type"), text("status", "Status"), text("project_name", "Project")];
    fields = { project: "c.project_id", status: "c.status", client: "c.name", date: "c.created_at" }; order = "c.name ASC";
  } else if (type === "properties") {
    const projectScope = scope("pr", "project");
    const propertyScope = scope("p", "property");
    sql = `SELECT p.name,p.property_type,p.status,p.price,p.location,p.area,pr.name AS project_name
      FROM properties p LEFT JOIN projects pr ON pr.id=p.project_id AND pr.organization_id=$1 AND ${projectScope}
      WHERE p.organization_id=$1 AND ${propertyScope}`;
    columns = [text("name", "Property"), text("property_type", "Type"), text("status", "Status"), num("price", "Price"), text("location", "Location"), num("area", "Area"), text("project_name", "Project")];
    fields = { project: "p.project_id", status: "p.status", date: "p.created_at" }; order = "p.name ASC";
  }
  else if (type === "projects") {
    const contractScope = scope("c", "contract");
    const projectScope = scope("p", "project");
    sql = `SELECT p.name,p.status,COUNT(DISTINCT c.id)::int AS contracts,COALESCE(SUM(c.value),0) AS contract_value
      FROM projects p LEFT JOIN contracts c ON c.organization_id=$1 AND c.project_id=p.id AND ${contractScope}
      WHERE p.organization_id=$1 AND ${projectScope} GROUP BY p.id,p.name,p.status`;
    columns = [text("name", "Project"), text("status", "Status"), intCol("contracts", "Contracts"), num("contract_value", "Contract value")];
    fields = { status: "p.status", date: "p.created_at" }; order = "p.name ASC";
  } else if (type === "contracts") {
    const projectScope = scope("pr", "project");
    const contractScope = scope("c", "contract");
    sql = `SELECT c.client_name,c.contract_type,c.status,c.value,c.start_date,c.end_date,pr.name AS project_name
      FROM contracts c LEFT JOIN projects pr ON pr.id=c.project_id AND pr.organization_id=$1 AND ${projectScope}
      WHERE c.organization_id=$1 AND ${contractScope}`;
    columns = [text("client_name", "Client"), text("contract_type", "Type"), text("status", "Status"), num("value", "Value"), dateCol("start_date", "Start"), dateCol("end_date", "End"), text("project_name", "Project")];
    fields = { project: "c.project_id", status: "c.status", client: "c.client_name", date: "c.start_date" }; order = "c.created_at DESC";
  } else if (type === "followups") {
    const leadScope = scope("l", "lead");
    const clientScope = scope("c", "client");
    const followUpScope = scope("f", "follow_up");
    sql = `SELECT f.due_at,f.follow_up_type,f.status,f.outcome,f.notes,l.name AS lead_name,c.name AS client_name
      FROM follow_ups f
      LEFT JOIN leads l ON l.id=f.lead_id AND l.organization_id=$1 AND ${leadScope}
      LEFT JOIN clients c ON c.id=f.client_id AND c.organization_id=$1 AND ${clientScope}
      WHERE f.organization_id=$1 AND ${followUpScope}`;
    columns = [dateCol("due_at", "Due"), text("follow_up_type", "Type"), text("status", "Status"), text("outcome", "Outcome"), text("lead_name", "Lead"), text("client_name", "Client")];
    fields = { project: "c.project_id", status: "f.status", client: "COALESCE(l.name,c.name)", date: "f.due_at" }; order = "f.due_at ASC";
  } else if (type === "documents") {
    const projectScope = scope("pr", "project");
    const documentScope = scope("d", "document");
    sql = `SELECT d.title,d.category,d.status,d.uploaded_at,d.original_filename,pr.name AS project_name
      FROM documents d LEFT JOIN projects pr ON pr.id=d.project_id AND pr.organization_id=$1 AND ${projectScope}
      WHERE d.organization_id=$1 AND ${documentScope}`;
    columns = [text("title", "Title"), text("category", "Category"), text("status", "Status"), dateCol("uploaded_at", "Uploaded"), text("original_filename", "File"), text("project_name", "Project")];
    fields = { project: "d.project_id", status: "d.status", date: "d.uploaded_at" }; order = "d.created_at DESC";
  } else {
    const paymentScope = scope("p", "payment");
    sql = `SELECT 'Income' AS metric,COUNT(p.id)::int AS count,COALESCE(SUM(p.amount),0) AS amount,'Recorded payments' AS note
      FROM payments p WHERE p.organization_id=$1 AND p.status='approved' AND ${paymentScope}`;
    columns = [text("metric", "Metric"), intCol("count", "Count"), num("amount", "Amount"), text("note", "Notes")]; fields = { date: "p.paid_at" };
  }
  const filtered = filtersSql(filters, fields, values.length);
  const result = await query(`${sql}${filtered.sql} ORDER BY ${order}`, [...values, ...filtered.values]);
  const numericKeys = ["amount", "price", "value", "area", "contract_value", "paid_amount"];
  const rows = result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "string" && /^\d+(\.\d+)?$/.test(value) && numericKeys.includes(key) ? money(value) : value])));
  return { columns, rows, totals: [{ label: "Rows", value: rows.length, kind: "int" }] };
}

export async function buildReport(type, filters) {
  const def = reportTypeDef(type);
  if (!def) throw new Error("Unknown report type");
  if (reportTypeIsFinancial(type) && !can(currentAccess(), "view_financial")) throw new Error("financial reports require the view_financial permission");
  const result = await buildRows(type, filters || {});
  return { brand: "MKUYU", brand_sub: "Real Estate Management System", type, title: def.label, description: def.description, filters_text: "Report filters applied", generated_at: new Date().toISOString(), row_count: result.rows.length, ...result };
}

