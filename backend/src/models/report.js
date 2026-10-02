import { query, queryOne } from "../db.js";
import { organizationId } from "../org/rbac.js";
import { can, clearRecordShares, currentAccess, OWNERSHIP_COLUMNS, ownershipValues, scopeCondition } from "../org/access.js";

const ENTITY = "report";
const select = "SELECT r.*, p.name AS project_name FROM reports r LEFT JOIN projects p ON p.id=r.project_id";

// Condition builders receive the shared parameter array so a single query can mix
// fixed filters with the record-scope predicate.
const eq = (column, value) => (values) => { values.push(value); return `${column} = $${values.length}`; };
const ge = (column, value) => (values) => { values.push(value); return `${column} >= $${values.length}`; };
const raw = (sql) => () => sql;

async function scopedRows(sql, alias, entity, { values = [], conditions = [], suffix = "" } = {}) {
  const access = await currentAccess();
  const all = [await organizationId(), ...values];
  const scope = scopeCondition(alias, entity, access, all, { read: true });
  const where = [`${alias}.organization_id = $1`, scope, ...conditions.map((condition) => condition(all))];
  return (await query(`${sql} WHERE ${where.join(" AND ")}${suffix}`, all)).rows;
}

async function scopedAggregate(table, alias, entity, conditions = [], sum = null) {
  const columns = `COUNT(*)::int AS count${sum ? `, COALESCE(SUM(${sum}), 0) AS total` : ""}`;
  const rows = await scopedRows(`SELECT ${columns} FROM ${table} ${alias}`, alias, entity, { conditions });
  return rows[0] || { count: 0, total: 0 };
}

const money = (row) => Number((row && row.total) || 0);
const byNewest = (rows) => [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || Number(b.id) - Number(a.id));

// Builds one scoped scalar subquery. The dashboard assembles a dozen of these
// into a single statement, so it costs one round trip instead of a dozen.
function scopedScalar({ table, alias, entity, access, values, conditions = [], extraFrom = "", aggregate = "COUNT(*)::int" }) {
  const scope = scopeCondition(alias, entity, access, values, { read: true });
  const filters = conditions.map((condition) => condition(values));
  return `(SELECT ${aggregate} FROM ${table} ${alias} ${extraFrom} WHERE ${alias}.organization_id = $1 AND ${scope}${filters.length ? ` AND ${filters.join(" AND ")}` : ""})`;
}

export const Report = {
  /**
   * Dashboard summary. Operational counters are always scoped to the caller.
   * Monetary counters are only produced for callers holding `view_financial`,
   * so a sales dashboard can never receive balance or income figures.
   *
   * Every counter travels in one statement: a single round trip per dashboard.
   */
  async summary() {
    const access = await currentAccess();
    const financial = can(access, "view_financial");
    const values = [await organizationId()];
    const columns = [];
    const add = (name, options) => columns.push(`${scopedScalar({ ...options, access, values })} AS ${name}`);
    const addMoney = (name, options) => {
      add(`${name}_count`, options);
      add(`${name}_total`, { ...options, aggregate: `COALESCE(SUM(${options.sum}), 0)` });
    };

    const newContracts = { table: "contracts", alias: "c", entity: "contract", conditions: [eq("c.contract_type", "new"), eq("c.status", "active")], sum: "c.value" };
    const terminalContracts = { table: "contracts", alias: "c", entity: "contract", conditions: [eq("c.contract_type", "terminal")], sum: "c.value" };
    add("active_projects", { table: "projects", alias: "p", entity: "project", conditions: [eq("p.status", "active")] });
    add("contracts_total", { table: "contracts", alias: "c", entity: "contract" });
    add("contracts_new_count", newContracts);
    add("contracts_terminal_count", terminalContracts);
    if (financial) {
      add("contracts_new_total", { ...newContracts, aggregate: `COALESCE(SUM(${newContracts.sum}), 0)` });
      add("contracts_terminal_total", { ...terminalContracts, aggregate: `COALESCE(SUM(${terminalContracts.sum}), 0)` });
    }
    add("properties_available", { table: "properties", alias: "p", entity: "property", conditions: [eq("p.status", "available")] });
    add("clients_active", { table: "clients", alias: "c", entity: "client", conditions: [eq("c.status", "active")] });
    add("appointments_scheduled", { table: "appointments", alias: "a", entity: "appointment", conditions: [eq("a.status", "scheduled")] });
    add("documents_pending", { table: "documents", alias: "d", entity: "document", conditions: [eq("d.status", "pending")] });

    const summary = {
      financial,
      active_projects: 0,
      contracts_total: 0,
      contracts_new: { count: 0, total: null },
      contracts_terminal: { count: 0, total: null },
      properties_available: 0,
      clients_active: 0,
      appointments_scheduled: 0,
      documents_pending: 0,
      debts_pending: null,
      debts_overdue: null,
      debts_paid: null,
      income_all: null,
      income_30d: null,
    };

    if (financial) {
      addMoney("debts_pending", { table: "debts", alias: "d", entity: "debt", conditions: [eq("d.status", "pending")], sum: "d.amount" });
      addMoney("debts_overdue", { table: "debts", alias: "d", entity: "debt", conditions: [raw("d.status <> 'paid'"), raw("d.due_date < CURRENT_DATE")], sum: "d.amount" });
      addMoney("debts_paid", { table: "debts", alias: "d", entity: "debt", conditions: [eq("d.status", "paid")], sum: "d.amount" });
      // Income is money a second Finance person has confirmed; pending and reversed
      // payments are claims or corrections, not income.
      addMoney("income_all", { table: "payments", alias: "p", entity: "payment", conditions: [eq("p.status", "approved")], sum: "p.amount" });
      addMoney("income_30d", { table: "payments", alias: "p", entity: "payment", conditions: [eq("p.status", "approved"), ge("p.paid_at", new Date(Date.now() - 30 * 86400000).toISOString())], sum: "p.amount" });
    }

    const row = await queryOne(`SELECT ${columns.join(", ")} FROM (SELECT 1) AS anchor`, values);
    const count = (key) => Number(row[key] || 0);
    const total = (key) => Number(row[key] || 0);
    summary.active_projects = count("active_projects");
    summary.contracts_total = count("contracts_total");
    summary.contracts_new = { count: count("contracts_new_count"), total: financial ? total("contracts_new_total") : null };
    summary.contracts_terminal = { count: count("contracts_terminal_count"), total: financial ? total("contracts_terminal_total") : null };
    summary.properties_available = count("properties_available");
    summary.clients_active = count("clients_active");
    summary.appointments_scheduled = count("appointments_scheduled");
    summary.documents_pending = count("documents_pending");
    if (financial) {
      summary.debts_pending = { count: count("debts_pending_count"), total: total("debts_pending_total") };
      summary.debts_overdue = { count: count("debts_overdue_count"), total: total("debts_overdue_total") };
      summary.debts_paid = { count: count("debts_paid_count"), total: total("debts_paid_total") };
      summary.income_all = { count: count("income_all_count"), total: total("income_all_total") };
      summary.income_30d = { count: count("income_30d_count"), total: total("income_30d_total") };
    }
    return summary;
  },
  /**
   * Per-project rollup for the dashboard chart. Each figure is a LATERAL
   * subquery so the whole rollup is one statement instead of six.
   */
  async byProject() {
    const access = await currentAccess();
    const financial = can(access, "view_financial");
    const values = [await organizationId()];
    const projects = scopeCondition("p", "project", access, values);
    // lateral(alias, entity, extraFrom, projectAlias, aggregate, conditions)
    const lateral = (alias, entity, extraFrom, projectAlias, aggregate, conditions = []) => {
      const scope = scopeCondition(alias, entity, access, values);
      const filters = conditions.map((condition) => condition(values));
      return `LEFT JOIN LATERAL (SELECT ${aggregate} FROM ${table} ${alias} ${extraFrom} WHERE ${alias}.organization_id = $1 AND ${projectAlias}.project_id = p.id AND ${scope}${filters.length ? ` AND ${filters.join(" AND ")}` : ""}) ${alias}_agg ON TRUE`;
    };
    let table = "contracts";
    const contractValue = financial ? "COALESCE(SUM(c.value),0) AS contract_value" : "NULL::numeric AS contract_value";
    const contractJoin = lateral("c", "contract", "", "c", `COUNT(*) FILTER (WHERE c.contract_type='new')::int AS new_contracts, COUNT(*) FILTER (WHERE c.contract_type='terminal')::int AS terminal_contracts, ${contractValue}`);
    table = "properties";
    const propertyJoin = lateral("p2", "property", "", "p2", "COUNT(*)::int AS properties");
    table = "clients";
    const clientJoin = lateral("c2", "client", "", "c2", "COUNT(*)::int AS clients");
    table = "appointments";
    const appointmentJoin = lateral("a", "appointment", "", "a", "COUNT(*)::int AS appointments", [eq("a.status", "scheduled")]);
    table = "documents";
    const documentJoin = lateral("d", "document", "", "d", "COUNT(*)::int AS documents", [eq("d.status", "pending")]);
    const debtJoin = financial
      ? (() => { table = "debts"; return lateral("d2", "debt", "JOIN contracts c2 ON c2.id = d2.contract_id", "c2", "COUNT(*)::int AS open_debts", [eq("d2.status", "pending")]); })()
      : "";
    const rows = await query(
      `SELECT p.id, p.name, COALESCE(c_agg.new_contracts,0) AS new_contracts, COALESCE(c_agg.terminal_contracts,0) AS terminal_contracts, ${financial ? "COALESCE(c_agg.contract_value,0)" : "NULL::numeric"} AS contract_value, ${financial ? "COALESCE(d2_agg.open_debts,0)" : "NULL::int"} AS open_debts, COALESCE(p2_agg.properties,0) AS properties, COALESCE(c2_agg.clients,0) AS clients, COALESCE(a_agg.appointments,0) AS appointments, COALESCE(d_agg.documents,0) AS documents
       FROM projects p
       ${contractJoin} ${propertyJoin} ${clientJoin} ${appointmentJoin} ${documentJoin} ${debtJoin}
       WHERE p.organization_id = $1 AND ${projects}
       ORDER BY p.name`,
      values,
    );
    return rows.rows;
  },

  newContracts() { return scopedRows(select, "r", ENTITY, { conditions: [eq("r.report_type", "new_contract")] }).then(byNewest); },
  terminalContracts() { return scopedRows(select, "r", ENTITY, { conditions: [eq("r.report_type", "terminal_contract")] }).then(byNewest); },

  async history(filters = {}) {
    const conditions = [];
    if (filters.projectId) conditions.push(eq("r.project_id", filters.projectId));
    if (filters.source) conditions.push(eq("r.source", filters.source));
    if (filters.reportType) conditions.push(eq("r.report_type", filters.reportType));
    if (filters.search) conditions.push((values) => { values.push(`%${filters.search}%`); return `(r.title ILIKE $${values.length} OR COALESCE(r.original_filename,'') ILIKE $${values.length})`; });
    if (filters.from) conditions.push(ge("r.created_at", filters.from));
    if (filters.to) conditions.push((values) => { values.push(`${filters.to} 23:59:59`); return `r.created_at <= $${values.length}`; });
    const rows = await scopedRows(select, "r", ENTITY, { conditions, suffix: " LIMIT 250" });
    return byNewest(rows);
  },

  async get(id) {
    const values = [id, await organizationId()];
    const access = await currentAccess();
    return queryOne(`${select} WHERE r.id=$1 AND r.organization_id=$2 AND ${scopeCondition("r", ENTITY, access, values)}`, values);
  },

  async create(data) {
    const access = await currentAccess();
    const values = [await organizationId(), data.title, data.report_type, data.source || "generated", data.project_id || null, data.description || null, data.filters_json || null, data.file_format || null, data.original_filename || null, data.stored_name || null, data.file_size || null, data.mime_type || null];
    ownershipValues(values, access);
    const row = await queryOne(`INSERT INTO reports(organization_id,title,report_type,source,project_id,description,filters_json,file_format,original_filename,stored_name,file_size,mime_type,${OWNERSHIP_COLUMNS}) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`, values);
    return this.get(row.id);
  },

  async remove(id) {
    const access = await currentAccess();
    const values = [id, await organizationId()];
    const scope = scopeCondition("r", ENTITY, access, values);
    const result = await query(`DELETE FROM reports r WHERE r.id=$1 AND r.organization_id=$2 AND ${scope}`, values);
    if (result.rowCount) await clearRecordShares(ENTITY, id);
    return result;
  },
};


