import crypto from "node:crypto";
import { query, queryOne } from "./db.js";
import { provisionSystemAdministrator } from "./org/rbac.js";
import { SESSION_COOKIE, csrfOk, readCookie, setSessionCookie } from "./security.js";

// Session lifetime (MK-06). "Remember me" keeps a session for at most 7 days,
// otherwise 12 hours; either way it ends after 8 hours without use, and a
// browser session's token is replaced every 12 hours while in use.
const REMEMBER_MS = 7 * 86400000;
const SHORT_MS = 12 * 3600000;
const IDLE_MS = 8 * 3600000;
const ROTATE_MS = 12 * 3600000;
const TOUCH_MS = 5 * 60000;

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

async function createSession(userId, { remember = true, expiresAt = null } = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  const lifetime = remember ? REMEMBER_MS : SHORT_MS;
  const expires = expiresAt ? new Date(expiresAt) : new Date(Date.now() + lifetime);
  await query("INSERT INTO sessions (token_hash, user_id, expires_at, remember, last_seen_at) VALUES ($1, $2, $3, $4, NOW())", [hashToken(token), userId, expires.toISOString(), remember]);
  return { token, expires_at: expires.toISOString().replace("T", " ").slice(0, 19), max_age_ms: remember ? Math.max(0, expires.getTime() - Date.now()) : null };
}

/** The session token: a Bearer header (API clients, tests) or the HttpOnly cookie (the browser app). */
function tokenFromRequest(req) {
  const header = req.get("authorization") || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim() || null;
  return readCookie(req, SESSION_COOKIE);
}

function viaCookie(req) {
  return !String(req.get("authorization") || "").startsWith("Bearer ") && Boolean(readCookie(req, SESSION_COOKIE));
}

async function publicUser(user) {
  const roles = (await query("SELECT r.id, r.name, r.rank FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.rank DESC, r.name", [user.id])).rows;
  const departments = (await query("SELECT d.id, d.name FROM user_departments ud JOIN departments d ON d.id = ud.department_id WHERE ud.user_id = $1 ORDER BY d.name", [user.id])).rows;
  return {
    id: user.id, email: user.email, display_name: user.display_name, role: user.role, roles, departments,
    // Presence flags only; the images are served by /org/users/:id/photo and
    // /org/me/signature, never inlined.
    has_photo: Boolean(user.photo_stored_name),
    has_signature: Boolean(user.signature_stored_name),
    signature_title: user.signature_title || null,
  };
}

async function requireAuth(req, res, next) {
  try {
    const token = tokenFromRequest(req);
    if (!token) return res.status(401).json({ error: "sign in required" });
    const cookie = viaCookie(req);
    // CSRF: a cookie-authenticated change must come from the MKUYU page itself.
    if (cookie && !csrfOk(req)) return res.status(403).json({ error: "request refused (missing CSRF protection)" });
    const result = await query(`SELECT u.*, s.id AS session_row_id, s.remember AS session_remember, s.expires_at AS session_expires_at,
                                    s.created_at AS session_created_at, s.last_seen_at AS session_last_seen_at
                             FROM sessions s
                             JOIN users u ON u.id = s.user_id
                             WHERE s.token_hash = $1 AND s.expires_at > NOW()
                               AND COALESCE(s.last_seen_at, s.created_at) > NOW() - ($2::int * INTERVAL '1 millisecond')
                               AND u.active = TRUE`, [hashToken(token), IDLE_MS]);
    const row = result.rows[0];
    if (!row) return res.status(401).json({ error: "session expired" });
    const { session_row_id: sessionId, session_remember: remember, session_expires_at: expiresAt, session_created_at: createdAt, session_last_seen_at: lastSeen, ...user } = row;
    const now = Date.now();
    if (cookie && now - new Date(createdAt).getTime() > ROTATE_MS) {
      // Rotation: a long-lived browser session gets a fresh token; the old one dies.
      const fresh = await createSession(user.id, { remember, expiresAt });
      await query("DELETE FROM sessions WHERE id = $1", [sessionId]);
      setSessionCookie(req, res, fresh.token, fresh.max_age_ms);
      req.token = fresh.token;
    } else {
      if (!lastSeen || now - new Date(lastSeen).getTime() > TOUCH_MS) await query("UPDATE sessions SET last_seen_at = NOW() WHERE id = $1", [sessionId]);
      req.token = token;
    }
    req.user = user;
    next();
  } catch (error) { next(error); }
}

/** Ends every session of a user (password reset, role change, deactivation). */
async function revokeUserSessions(userId) {
  await query("DELETE FROM sessions WHERE user_id = $1", [userId]);
}

export {
  hashPassword,
  verifyPassword,
  hashToken,
  createSession,
  revokeUserSessions,
  tokenFromRequest,
  publicUser,
  requireAuth,
  portalForUser,
  resolvePortal,
};
