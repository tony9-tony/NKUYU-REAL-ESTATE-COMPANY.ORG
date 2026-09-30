// ---------------------------------------------------------------------------
// HTTP security helpers: environment, rate limiting, security headers, the
// session cookie and its CSRF guard. One module so every rule lives in one
// place and server.js / the routes only wire them in.
// ---------------------------------------------------------------------------

/** Production is opt-in (NODE_ENV=production); anything else is development. */
export function isProduction() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

// ---- Rate limiting ---------------------------------------------------------
// A fixed-window counter per key, kept in memory. MKUYU runs as one Node
// process, so this is shared by every request; a multi-process deployment
// would need a shared store (noted in the security report).

const buckets = new Map();

/**
 * Counts a hit against `key` and reports whether it is over `limit` within
 * `windowMs`. Returns { limited, retryAfter } (retryAfter in seconds).
 */
export function hit(key, limit, windowMs, now = Date.now()) {
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  return { limited: bucket.count > limit, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
}

/** Whether `key` is currently over `limit`, without counting a hit. */
export function isLimited(key, limit, now = Date.now()) {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) return { limited: false, retryAfter: 0 };
  return { limited: bucket.count >= limit, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
}

export function resetLimit(key) {
  buckets.delete(key);
}

// Old buckets are swept so the map cannot grow without bound.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 60000);
sweeper.unref?.();

export function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

/** Express middleware: at most `limit` requests per IP per window for this route group. */
export function rateLimit({ name, limit, windowMs, message = "Too many requests. Please wait a moment and try again." }) {
  return (req, res, next) => {
    const result = hit(`${name}:${clientIp(req)}`, limit, windowMs);
    if (!result.limited) return next();
    res.set("Retry-After", String(result.retryAfter));
    return res.status(429).json({ error: message });
  };
}

// ---- Login lockout (MK-02) --------------------------------------------------
// Failed sign-ins are counted per (IP, email) and per IP. A person who mistypes
// a password a few times is not locked out for long; a script trying many
// passwords or many accounts is stopped.
export const LOGIN_FAILURES_PER_ACCOUNT = 5;
export const LOGIN_FAILURES_PER_IP = 30;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export function loginBlocked(req, email) {
  const ip = clientIp(req);
  const account = isLimited(`login:${ip}:${String(email).toLowerCase()}`, LOGIN_FAILURES_PER_ACCOUNT);
  if (account.limited) return account;
  return isLimited(`login-ip:${ip}`, LOGIN_FAILURES_PER_IP);
}

export function recordLoginFailure(req, email) {
  const ip = clientIp(req);
  hit(`login:${ip}:${String(email).toLowerCase()}`, LOGIN_FAILURES_PER_ACCOUNT, LOGIN_WINDOW_MS);
  hit(`login-ip:${ip}`, LOGIN_FAILURES_PER_IP, LOGIN_WINDOW_MS);
}

export function recordLoginSuccess(req, email) {
  resetLimit(`login:${clientIp(req)}:${String(email).toLowerCase()}`);
}

// ---- Security headers (MK-04) ----------------------------------------------
// The staff app loads its own script and stylesheet, Google Fonts, and draws
// pictures from data:/blob: URLs; it uses inline style attributes, so styles
// keep 'unsafe-inline' (scripts do not). HSTS is sent only when the request
// actually arrived over HTTPS, so a plain-HTTP local install is not broken.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function isHttps(req) {
  return req.secure || String(req.get("x-forwarded-proto") || "").split(",")[0].trim() === "https";
}

export function securityHeaders() {
  return (req, res, next) => {
    res.set("Content-Security-Policy", CSP);
    res.set("X-Frame-Options", "DENY");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "strict-origin-when-cross-origin");
    res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
    res.set("Cross-Origin-Opener-Policy", "same-origin");
    if (isHttps(req)) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  };
}

// ---- Session cookie + CSRF (MK-05) ------------------------------------------
export const SESSION_COOKIE = "mkuyu_session";
export const CSRF_HEADER = "x-mkuyu-csrf";

export function readCookie(req, name) {
  const header = req.get("cookie") || "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

/** HttpOnly, SameSite=Strict, scoped to the API; Secure whenever the request is HTTPS. */
export function setSessionCookie(req, res, token, maxAgeMs = null) {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, "Path=/api", "HttpOnly", "SameSite=Strict"];
  if (isHttps(req) || isProduction()) parts.push("Secure");
  if (maxAgeMs) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  res.append("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(req, res) {
  const parts = [`${SESSION_COOKIE}=`, "Path=/api", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (isHttps(req) || isProduction()) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

/**
 * A request authenticated by the cookie that changes state must prove it came
 * from the MKUYU page itself: it carries the custom header (which a foreign
 * page cannot add without a CORS pre-flight this server refuses) and, when the
 * browser sends one, an Origin matching the host it was sent to.
 */
export function csrfOk(req) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  if (req.get(CSRF_HEADER) !== "1") return false;
  const origin = req.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === req.get("host"); } catch { return false; }
}
