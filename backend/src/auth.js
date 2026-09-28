import crypto from "node:crypto";
import { query, queryOne } from "./db.js";
import { provisionSystemAdministrator } from "./org/rbac.js";

const SESSION_DAYS = 7;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString().replace("T", " ").slice(0, 19);
  await query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [hashToken(token), userId, expiresAt]);
  return { token, expires_at: expiresAt };
}

function tokenFromRequest(req) {
  const header = req.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

async function publicUser(user) {
  const roles = (await query("SELECT r.id, r.name, r.rank FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.rank DESC, r.name", [user.id])).rows;
  const departments = (await query("SELECT d.id, d.name FROM user_departments ud JOIN departments d ON d.id = ud.department_id WHERE ud.user_id = $1 ORDER BY d.name", [user.id])).rows;
  return { id: user.id, email: user.email, display_name: user.display_name, role: user.role, roles, departments };
}

async function requireAuth(req, res, next) {
  try {
    const token = tokenFromRequest(req);
    if (!token) return res.status(401).json({ error: "sign in required" });
    const result = await query(`SELECT u.* FROM sessions s
                             JOIN users u ON u.id = s.user_id
                             WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.active = TRUE`, [hashToken(token)]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "session expired" });
    req.user = user;
    req.token = token;
    next();
  } catch (error) { next(error); }
}

export {
  hashPassword,
  verifyPassword,
  hashToken,
  createSession,
  tokenFromRequest,
  publicUser,
  requireAuth,
};
