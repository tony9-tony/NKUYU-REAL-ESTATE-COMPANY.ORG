import { query, queryOne } from "../db.js";

// The workspace is single-tenant: the organization row never changes at runtime.
// Caching it removes one query from every single model call.
let organizationIdCache;
export async function organizationId() {
  if (organizationIdCache === undefined) {
    const row = await queryOne("SELECT id FROM organizations ORDER BY id LIMIT 1");
    organizationIdCache = row ? row.id : null;
  }
  return organizationIdCache;
}

export function clearOrganizationCache() {
  organizationIdCache = undefined;
}

// Permission predicates over a resolved access profile. Kept here (rather than in
// access.js) so the middleware can use them without a circular import.
export function can(access, permission) {
  if (!access) return true;
  if (access.isAdmin) return true;
  return access.permissions.includes(permission);
}

export function canAccessModule(access, module) {
  if (!access) return true;
  if (access.isAdmin) return true;
  return access.permissions.includes(`access_${module}`);
}

export async function provisionSystemAdministrator(userId) {
  const orgId = await organizationId();
  const role = await queryOne("SELECT id FROM roles WHERE organization_id = $1 AND name = 'System Administrator'", [orgId]);
  if (!role) return;
  await query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, role.id]);
  const department = await queryOne("SELECT id FROM departments WHERE organization_id = $1 AND name = 'IT / System Administration'", [orgId]);
  if (department) await query("INSERT INTO user_departments (user_id, department_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, department.id]);
}

export async function hasPermission(userId, permission) {
  return Boolean(await queryOne("SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id JOIN role_permissions rp ON rp.role_id = r.id JOIN permissions p ON p.id = rp.permission_id WHERE u.id = $1 AND u.active = TRUE AND r.active = TRUE AND p.permission_key = $2 LIMIT 1", [userId, permission]));
}

// The access profile is resolved once per request by accessMiddleware, so every
// permission decision below is a plain in-memory check. The database fallback
// only runs if a route is ever mounted before the middleware.
function grantedAll(req, permissions) {
  if (req.access) return permissions.every((permission) => can(req.access, permission));
  return null;
}

async function resolveGrant(req, permissions) {
  const cached = grantedAll(req, permissions);
  if (cached !== null) return cached;
  for (const permission of permissions) {
    if (!await hasPermission(req.user.id, permission)) return false;
  }
  return true;
}

export function requirePermission(permission) {
  return async (req, res, next) => {
    try {
      if (!await resolveGrant(req, [permission])) return res.status(403).json({ error: "permission denied", permission });
      next();
    } catch (error) { next(error); }
  };
}

export function requireAdmin() {
  return (req, res, next) => req.user?.role === "admin" ? next() : res.status(403).json({ error: "administrator access required" });
}

export async function permissionKeys(userId) {
  return (await query("SELECT DISTINCT p.permission_key FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id JOIN permissions p ON p.id = rp.permission_id WHERE ur.user_id = $1 ORDER BY p.permission_key", [userId])).rows.map((row) => row.permission_key);
}

// First path segment -> module key. Every business endpoint sits behind
// `access_<module>` plus the method permission (view/create/edit/delete).
export const PATH_MODULES = {
  projects: "projects",
  properties: "properties",
  clients: "clients",
  contracts: "contracts",
  documents: "documents",
  appointments: "appointments",
  debts: "debts",
  payments: "payments",
  reminders: "reminders",
  reports: "reports",
  leads: "leads",
  "follow-ups": "follow_ups",
};

// Modules that only carry monetary data. Reading them needs `view_financial`
// on top of the module access and the method permission.
export const FINANCIAL_MODULES = new Set(["debts", "payments", "reminders"]);

export function moduleForPath(path = "") {
  const segment = String(path).split("/").filter(Boolean)[0] || "";
  return PATH_MODULES[segment] || null;
}

export async function hasAnyPermission(userId, permissions) {
  if (!permissions.length) return true;
  const rows = await query("SELECT DISTINCT p.permission_key FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN role_permissions rp ON rp.role_id = r.id JOIN permissions p ON p.id = rp.permission_id WHERE ur.user_id = $1 AND r.active = TRUE AND p.permission_key = ANY($2::text[])", [userId, permissions]);
  return rows.rows.length === permissions.length;
}

export function requireModuleAccess(module) {
  return async (req, res, next) => {
    try {
      const permission = `access_${module}`;
      if (!await resolveGrant(req, [permission])) return res.status(403).json({ error: "permission denied", permission });
      next();
    } catch (error) { next(error); }
  };
}

// Oversight views are for people who actually oversee: a record-level staff
// member must not read organization-wide counters just because they can see
// reports.
export function requireScope(...scopes) {
  return (req, res, next) => {
    const access = req.access;
    if (access?.isAdmin || scopes.includes(access?.scope)) return next();
    return res.status(403).json({ error: "scope denied", required_scope: scopes });
  };
}

export function requirePermissionForMethod() {
  return async (req, res, next) => {
    try {
      const read = req.method === "GET" || req.method === "HEAD";
      const methodPermission = read ? "view" : req.method === "POST" ? "create" : req.method === "PUT" || req.method === "PATCH" ? "edit" : req.method === "DELETE" ? "delete" : "view";
      const module = moduleForPath(req.path);
      const required = new Set();
      if (module) required.add(`access_${module}`);
      // Report reads are gated by `view_reports` rather than the generic `view`.
      if (module === "reports") required.add(read ? "view_reports" : methodPermission);
      else required.add(methodPermission);
      if (module && FINANCIAL_MODULES.has(module)) required.add("view_financial");
      const permissions = [...required];
      if (!await resolveGrant(req, permissions)) return res.status(403).json({ error: "permission denied", permission: permissions.find((permission) => !can(req.access, permission)) || permissions[0] });
      next();
    } catch (error) { next(error); }
  };
}