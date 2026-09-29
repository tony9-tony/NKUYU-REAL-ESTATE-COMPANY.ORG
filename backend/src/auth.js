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

// ---------------------------------------------------------------------------
// PORTAL BOUNDARY
//
// The sign-in screen offers two portals. Which one an account may open is NOT a
// new permission and NOT a new role: it is the account's own `users.role`, the
// same column every existing admin gate already reads (`requireAdmin()`,
// `accessForUser()`, the `/org` administration routes). Deriving the portal
// from that column keeps one source of truth, so nothing here can drift away
// from the authorization model or weaken it.
//
//     portal "staff" -> role 'staff'      portal "admin" -> role 'admin'
//
// A client that claims a portal its account does not belong to is refused, and
// the refusal cannot be side-stepped by calling the API directly or by editing
// the request: the check runs against the account the password authenticated.
// ---------------------------------------------------------------------------
const STAFF_PORTAL = "staff";
const ADMIN_PORTAL = "admin";

/** The portal an account is entitled to, straight from its role. */
function portalForUser(user) {
  return user?.role === "admin" ? ADMIN_PORTAL : STAFF_PORTAL;
}

function portalError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * Confirms the account may enter the portal it asked for, and returns the
 * portal that was actually granted.
 *
 * `requested` is optional. A caller that sends nothing - which is every
 * pre-existing script and test, none of which know about portals - is given its
 * own portal, exactly the outcome it had before the portal existed. An explicit
 * claim must match the account, or the login is refused.
 *
 * Call this only AFTER the password has been verified: the refusal names the
 * account's portal, which must never be learnable without the credential.
 */
function resolvePortal(requested, user) {
  const own = portalForUser(user);
  if (requested === undefined || requested === null || requested === "") return own;
  const asked = String(requested).trim().toLowerCase();
  if (asked !== STAFF_PORTAL && asked !== ADMIN_PORTAL) {
    throw portalError(400, 'portal must be either "staff" or "admin"');
  }
  if (asked !== own) {
    throw portalError(403, own === ADMIN_PORTAL
      ? "These credentials belong to an Admin account. Please use Admin Portal."
      : "These credentials belong to a Staff account. Please use Staff Portal.");
  }
  return asked;
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
  portalForUser,
  resolvePortal,
};
