import { query } from "../db.js";
import { organizationId } from "./rbac.js";

export async function audit(req, action, module, recordId = null, details = null) {
  const orgId = await organizationId();
  await query("INSERT INTO audit_logs (organization_id, user_id, action, module, record_id, details_json) VALUES ($1, $2, $3, $4, $5, $6::jsonb)", [orgId, req.user?.id || null, action, module, recordId === null ? null : String(recordId), details ? JSON.stringify(details) : null]);
}

export function auditMiddleware(action, module) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = async (body) => {
      if (res.statusCode < 400) await audit(req, action, module, body?.id ?? req.params?.id ?? null);
      return originalJson(body);
    };
    next();
  };
}