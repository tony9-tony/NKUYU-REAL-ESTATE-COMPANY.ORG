// The diaspora customer portal API, mounted at /api/v1/customer BEFORE the
// staff login, with its own accounts and sessions.
//
// Who can sign in: only a client marked diaspora (clients.is_diaspora) whom
// Sales has invited (customer_accounts). Domestic clients have no portal.
// How: a 6-digit code sent to their e-mail, valid 10 minutes, 5 tries; no
// passwords to forget or leak. The session is an HttpOnly cookie scoped to
// /api/v1/customer, so it is never sent to the staff API and never readable
// by page scripts.
//
// What they see: ONLY their own contracts (contracts.client_id = their client),
// with payments, installments, receipts, the signed contract and construction
// progress of their project. Every file endpoint re-checks that ownership.
import { Router } from "express";
import crypto from "node:crypto";
import PDFDocument from "pdfkit";
import { query, queryOne } from "../db.js";
import { mailConfigured, sendMail } from "../mail.js";
import { recordVerificationEvent } from "../notify/diasporaNotices.js";
import { callView, currentCall, finishCall, newRoom } from "../calls.js";
import { broadcastChange } from "../live.js";
import { clearTyping, DELETE_ALL_WINDOW_MS, EDIT_WINDOW_MS, isTyping, REACTIONS, setTyping } from "../typing.js";
import { receiptCoverage, writeReceiptPdf } from "../payments/notices.js";
import { documentUploadsDir, progressUploadsDir, resolveStoredFile, safeDisplayFilename } from "../uploads.js";
import { isHttps, isProduction, readCookie } from "../security.js";
import { hashPassword, verifyPassword } from "../auth.js";
import { COUNTRIES, countryByCode, countryFromPhone, internationalDigits, phoneMatchesResidence } from "../customer/countries.js";
import { documentExtensions, uploadDocumentFile, validateUploadedFile, cleanupUploadedFile, uploadProfileImageFile, profileUploadsDir, profileImageExtensions, removeStoredFile } from "../uploads.js";

const router = Router();
export const CUSTOMER_COOKIE = "mkuyu_customer";
export const CUSTOMER_HEADER = "x-mkuyu-customer";
const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const SESSION_HOURS = Number(process.env.CUSTOMER_SESSION_HOURS || 24);
// Lets the automated tests read the code that would have been e-mailed. Only
// ever filled on the isolated test database.
export const testCodes = new Map();
const testMode = () => process.env.MKUYU_IS_TEST_DATABASE === "1";

const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const codeHash = (accountId, code) => hash(`${accountId}:${code}`);
const normalEmail = (value) => String(value || "").trim().toLowerCase().slice(0, 200);
const validEmail = (value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// ---- Abuse limits (per process; enough for one server) --------------------
const hits = new Map();
function tooMany(key, limit, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return list.length > limit;
}
const clientIp = (req) => req.ip || req.socket?.remoteAddress || "?";

// ---- CSRF: a state-changing call must come from the website's own script ---
function requireHeader(req) {
  if (req.get(CUSTOMER_HEADER) !== "1") throw new HttpError(403, "request refused");
}

function setCookie(req, res, token, maxAgeMs) {
  const parts = [`${CUSTOMER_COOKIE}=${encodeURIComponent(token)}`, "Path=/api/v1/customer", "HttpOnly", "SameSite=Lax"];
  if (isHttps(req) || isProduction()) parts.push("Secure");
  parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  res.append("Set-Cookie", parts.join("; "));
}
function clearCookie(req, res) {
  const parts = [`${CUSTOMER_COOKIE}=`, "Path=/api/v1/customer", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isHttps(req) || isProduction()) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

/** The account a sign-in may use: invited or active, client still diaspora. */
async function signInAccount(email) {
  return queryOne(
    `SELECT ca.id, ca.client_id, ca.email, ca.status, cl.name FROM customer_accounts ca JOIN clients cl ON cl.id=ca.client_id
      WHERE lower(ca.email)=$1 AND ca.status IN ('invited','active') AND cl.is_diaspora = TRUE`, [email]);
}

/** Resolves the signed-in customer from the cookie, or answers 401. */
async function requireCustomer(req, res, next) {
  try {
    const token = readCookie(req, CUSTOMER_COOKIE);
    if (!token || token.length > 200) return res.status(401).json({ error: "please sign in" });
    const row = await queryOne(
      `SELECT s.id AS session_id, ca.id, ca.client_id, ca.email, ca.photo_stored_name, ca.photo_mime, cl.name, cl.country, cl.verification_status, cl.verification_note, cl.citizenship_confirmed_at, cl.notify_email
         FROM customer_sessions s JOIN customer_accounts ca ON ca.id=s.account_id JOIN clients cl ON cl.id=ca.client_id
        WHERE s.token_hash=$1 AND s.expires_at > NOW() AND ca.status='active' AND cl.is_diaspora = TRUE`, [hash(token)]);
    if (!row) { clearCookie(req, res); return res.status(401).json({ error: "please sign in" }); }
    req.customer = row;
    query("UPDATE customer_sessions SET last_seen_at=NOW() WHERE id=$1", [row.session_id]).catch(() => {});
    res.setHeader("Cache-Control", "no-store");
    next();
  } catch (error) { next(error); }
}

// ---- Sign in ----------------------------------------------------------------
const GENERIC = "If this e-mail belongs to a MKUYU diaspora customer, a code to set your password is on its way. It is valid for 10 minutes.";

router.post("/auth/request-code", route(async (req, res) => {
  requireHeader(req);
  const email = normalEmail(req.body?.email);
  if (!validEmail(email)) throw new HttpError(400, "Enter the e-mail address MKUYU has for you.");
  if (tooMany(`ip:${clientIp(req)}`, 20, 15 * 60 * 1000) || tooMany(`mail:${email}`, 5, 15 * 60 * 1000)) {
    throw new HttpError(429, "Too many codes requested. Please wait 15 minutes and try again.");
  }
  const account = await signInAccount(email);
  // The same answer whether or not the address is known, so the form cannot
  // be used to find out who is a MKUYU customer.
  if (!account) {
    // Development only: say in the server window WHY no code was made (the
    // browser still gets the same answer, so nothing leaks to visitors).
    if (!isProduction()) {
      const why = await queryOne(`SELECT cl.name, cl.is_diaspora, ca.status FROM clients cl LEFT JOIN customer_accounts ca ON ca.client_id=cl.id
        WHERE lower(cl.email)=$1 OR lower(ca.email)=$1 ORDER BY ca.id NULLS LAST LIMIT 1`, [email]).catch(() => null);
      const reason = !why ? "no client has this e-mail"
        : !why.is_diaspora ? `client "${why.name}" is not ticked as Diaspora client`
        : !why.status ? `client "${why.name}" has not been invited (press "Invite to the portal")`
        : why.status === "disabled" ? `client "${why.name}" has a disabled portal (invite again)`
        : "the e-mail on the invitation differs from this one";
      console.log(`[customer portal] code requested for ${email}: NO code sent, ${reason}`);
    }
    return res.json({ ok: true, message: GENERIC });
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  await query("UPDATE customer_login_codes SET used_at=NOW() WHERE account_id=$1 AND used_at IS NULL", [account.id]);
  await query("INSERT INTO customer_login_codes (account_id, code_hash, expires_at) VALUES ($1,$2,NOW() + ($3 || ' minutes')::interval)",
    [account.id, codeHash(account.id, code), String(CODE_MINUTES)]);
  if (testMode()) testCodes.set(email, code);
  // The code goes ONLY to the customer's e-mail. It is never printed or logged.
  if (!mailConfigured()) {
    console.warn(`[customer portal] sign-in code for ${account.email} NOT sent: e-mail is not set up (SMTP_HOST / MAIL_FROM in .env)`);
  } else {
    // Not awaited: the customer is answered at once and the e-mail follows.
    sendMail({
      to: account.email,
      subject: `MKUYU password code: ${code}`,
      text: `Dear ${account.name},\n\nYour code to set a new MKUYU password is ${code}\n\nIt is valid for ${CODE_MINUTES} minutes. If you did not ask for it, ignore this e-mail; your password stays as it is.\n\nMKUYU Africa`,
      kind: "customer_code",
    }).then((sent) => {
      if (!sent.sent) console.warn(`[customer portal] sign-in code e-mail to ${account.email} failed: ${sent.error}`);
    }).catch(() => { /* sendMail never throws; nothing to do */ });
  }
  res.json({ ok: true, message: GENERIC });
}));

// There is no sign-in by code: customers sign in with username/e-mail and
// password. The code from /auth/request-code only resets (or, for a customer
// MKUYU invited, first sets) the password at /auth/reset-password.

router.post("/auth/logout", route(async (req, res) => {
  requireHeader(req);
  const token = readCookie(req, CUSTOMER_COOKIE);
  if (token) await query("DELETE FROM customer_sessions WHERE token_hash=$1", [hash(token)]);
  clearCookie(req, res);
  res.json({ ok: true });
}));

router.get("/me", requireCustomer, route(async (req, res) => {
  res.json({ name: req.customer.name, email: req.customer.email, country: req.customer.country || null, photo_url: photoUrl(req.customer), verification: verificationState(req.customer) });
}));


// ---- The customer's own profile picture ---------------------------------------
const photoUrl = (c) => (c.photo_stored_name ? `/customer/profile/photo?v=${encodeURIComponent(c.photo_stored_name.slice(0, 12))}` : null);
router.get("/profile/photo", requireCustomer, route(async (req, res) => {
  const full = resolveStoredFile(profileUploadsDir, req.customer.photo_stored_name);
  if (!full) throw new HttpError(404, "No profile picture");
  fileHeaders(res, req.customer.photo_mime, "profile-photo", false);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.sendFile(full);
}));
router.post("/profile/photo", requireCustomer, (req, res, next) => {
  if (req.get(CUSTOMER_HEADER) !== "1") return res.status(403).json({ error: "request refused" });
  uploadProfileImageFile(req, res, (error) => (error ? next(error) : next()));
}, route(async (req, res) => {
  try {
    if (tooMany(`photo:${req.customer.id}`, 10, 60 * 60 * 1000)) throw new HttpError(429, "Too many uploads. Please wait a little.");
    const info = validateUploadedFile(req.file, profileImageExtensions);
    const old = req.customer.photo_stored_name;
    await query("UPDATE customer_accounts SET photo_stored_name=$1, photo_mime=$2 WHERE id=$3", [info.storedName, info.mimeType, req.customer.id]);
    if (old && old !== info.storedName) removeStoredFile(profileUploadsDir, old);
    res.json({ photo_url: photoUrl({ photo_stored_name: info.storedName }) });
  } catch (error) { cleanupUploadedFile(req.file); throw error; }
}));
router.delete("/profile/photo", requireCustomer, route(async (req, res) => {
  if (req.get(CUSTOMER_HEADER) !== "1") throw new HttpError(403, "request refused");
  const old = req.customer.photo_stored_name;
  await query("UPDATE customer_accounts SET photo_stored_name=NULL, photo_mime=NULL WHERE id=$1", [req.customer.id]);
  if (old) removeStoredFile(profileUploadsDir, old);
  res.json({ photo_url: null });
}));

// ---- Shared: the desk, sessions, code checks ----------------------------------
const DESK = "DIASPORA DESK";
const SALES = "SALES, MARKETING & OPERATIONS";
const departmentId = async (orgId, name) => (await queryOne("SELECT id FROM departments WHERE organization_id=$1 AND name=$2", [orgId, name]))?.id || null;
const orgId = async () => (await queryOne("SELECT id FROM organizations ORDER BY id LIMIT 1"))?.id || null;

/**
 * The desk member a new diaspora customer is introduced to: the active member
 * with the fewest diaspora customers. A contact person only; the whole desk
 * shares the queue and anyone on it may serve the customer.
 */
async function pickDeskOfficer(org) {
  return (await queryOne(
    `SELECT u.id FROM users u JOIN user_departments ud ON ud.user_id=u.id JOIN departments d ON d.id=ud.department_id
      WHERE d.organization_id=$1 AND d.name=$2 AND u.active=TRUE
      ORDER BY (SELECT COUNT(*) FROM clients c WHERE c.diaspora_officer_id=u.id), u.id LIMIT 1`, [org, DESK]))?.id || null;
}

async function startSession(req, res, accountId) {
  const token = crypto.randomBytes(32).toString("hex");
  const maxAge = Math.max(1, SESSION_HOURS) * 60 * 60 * 1000;
  await query("INSERT INTO customer_sessions (token_hash, account_id, expires_at) VALUES ($1,$2,NOW() + ($3 || ' milliseconds')::interval)", [hash(token), accountId, String(maxAge)]);
  await query("DELETE FROM customer_sessions WHERE account_id=$1 AND expires_at < NOW()", [accountId]);
  await query("UPDATE customer_accounts SET status='active', activated_at=COALESCE(activated_at, NOW()), last_login_at=NOW() WHERE id=$1", [accountId]);
  setCookie(req, res, token, maxAge);
}

/** Checks a login code for an account; burns it after 5 wrong tries. */
async function checkLoginCode(accountId, code) {
  const pending = await queryOne(
    `UPDATE customer_login_codes SET attempts = attempts + 1
      WHERE id = (SELECT id FROM customer_login_codes WHERE account_id=$1 AND used_at IS NULL AND expires_at > NOW() ORDER BY id DESC LIMIT 1)
      RETURNING id, code_hash, attempts`, [accountId]);
  if (!pending || pending.attempts > MAX_ATTEMPTS) return false;
  const expected = Buffer.from(pending.code_hash, "hex");
  const given = Buffer.from(codeHash(accountId, code), "hex");
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    if (pending.attempts >= MAX_ATTEMPTS) await query("UPDATE customer_login_codes SET used_at=NOW() WHERE id=$1", [pending.id]);
    return false;
  }
  await query("UPDATE customer_login_codes SET used_at=NOW() WHERE id=$1", [pending.id]);
  return true;
}

const strongEnough = (password) => typeof password === "string" && password.length >= 8 && password.length <= 128 && /[A-Za-z]/.test(password) && /\d/.test(password);
const PASSWORD_RULE = "Use at least 8 characters with letters and numbers.";

/**
 * Sends a code e-mail WITHOUT making the visitor wait for it. Talking to Gmail
 * takes several seconds; the customer is told at once to check their inbox and
 * the e-mail follows a moment later. Failures are still written to the server
 * window and to email_log. Answering at the same speed whether or not the
 * e-mail exists also keeps these forms from revealing who is a customer.
 */
function mailCodeInBackground(to, subject, text) {
  mailCode(to, subject, text).catch((error) => console.warn(`[customer portal] e-mail to ${to} failed: ${error?.message || error}`));
}

async function mailCode(to, subject, text) {
  if (!mailConfigured()) {
    console.warn(`[customer portal] e-mail to ${to} NOT sent: e-mail is not set up (SMTP_HOST / MAIL_FROM in .env)`);
    return false;
  }
  const sent = await sendMail({ to, subject, text, kind: "customer_code" });
  if (!sent.sent) console.warn(`[customer portal] e-mail to ${to} failed: ${sent.error}`);
  return sent.sent;
}

// ---- Self sign-up --------------------------------------------------------------
// Anyone may sign up. Where they LIVE decides who serves them: Tanzania goes to
// Sales as a lead (no account: customers at home need none); abroad becomes a
// diaspora customer of the Diaspora Desk with a portal account. The e-mail is
// proved with a 6-digit code before anything is created.
router.get("/countries", (req, res) => res.json(COUNTRIES.map(([code, name, dial]) => ({ code, name, dial }))));

const SIGNUP_SENT = "We have sent a 6-digit code to your e-mail. Enter it to finish signing up (valid for 10 minutes).";

router.post("/auth/signup", route(async (req, res) => {
  requireHeader(req);
  const body = req.body || {};
  const name = String(body.name || "").trim().replace(/\s+/g, " ").slice(0, 120);
  const email = normalEmail(body.email);
  const residence = countryByCode(body.residence);
  const nationality = countryByCode(body.nationality) || (String(body.nationality || "").toUpperCase() === "OTHER" ? { code: "OTHER", name: String(body.nationality_other || "Other").trim().slice(0, 80) || "Other" } : null);
  const phone = internationalDigits(body.phone);
  const username = String(body.username || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(username)) throw new HttpError(400, "Choose a username of 3 to 30 letters or numbers (dots, dashes and underscores allowed).");
  if (await queryOne("SELECT 1 FROM customer_accounts WHERE lower(username)=$1", [username])) throw new HttpError(409, "That username is taken. Choose another one.");
  if (name.length < 3 || !name.includes(" ")) throw new HttpError(400, "Enter your full name (first and last name).");
  if (!validEmail(email)) throw new HttpError(400, "Enter a valid e-mail address.");
  if (!phone) throw new HttpError(400, "Enter your phone number with the country code, for example +971 50 123 4567.");
  if (!residence) throw new HttpError(400, "Choose the country where you live.");
  if (!nationality) throw new HttpError(400, "Choose your nationality.");
  if (!strongEnough(body.password)) throw new HttpError(400, PASSWORD_RULE);
  if (body.accept !== true) throw new HttpError(400, "Please accept that MKUYU may contact you and check your documents.");
  if (tooMany(`signup-ip:${clientIp(req)}`, 10, 60 * 60 * 1000) || tooMany(`signup:${email}`, 4, 60 * 60 * 1000)) throw new HttpError(429, "Too many sign-up attempts. Please wait an hour and try again.");
  const existing = await queryOne("SELECT status FROM customer_accounts WHERE lower(email)=$1 AND status <> 'disabled'", [email]);
  if (existing) {
    // Same answer as a new sign-up; the e-mail itself tells the owner.
    mailCodeInBackground(email, "Your MKUYU account", "Someone (hopefully you) tried to sign up with this e-mail, but you already have a MKUYU diaspora account.\n\nOpen the website, choose Diaspora login and sign in, or use 'Forgot password'.\n\nMKUYU Africa");
    return res.json({ ok: true, message: SIGNUP_SENT });
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const phoneCountry = countryFromPhone(phone);
  const details = { name, email, username, phone: `+${phone}`, residence: residence.code, residence_name: residence.name,
    nationality: nationality.code, nationality_name: nationality.name, phone_country: phoneCountry?.name || null,
    residence_check: phoneMatchesResidence(phoneCountry, residence.code) ? "ok" : "check" };
  await query("UPDATE customer_signups SET used_at=NOW() WHERE lower(email)=$1 AND used_at IS NULL", [email]);
  await query("INSERT INTO customer_signups (email, details, password_hash, code_hash, expires_at) VALUES ($1,$2,$3,$4,NOW() + ($5 || ' minutes')::interval)",
    [email, details, hashPassword(body.password), hash(`signup:${email}:${code}`), String(CODE_MINUTES)]);
  if (testMode()) testCodes.set(`signup:${email}`, code);
  mailCodeInBackground(email, `MKUYU sign-up code: ${code}`, `Dear ${name},\n\nYour MKUYU sign-up code is ${code}\n\nIt is valid for ${CODE_MINUTES} minutes. If you did not sign up, ignore this e-mail.\n\nMKUYU Africa`);
  res.json({ ok: true, message: SIGNUP_SENT });
}));

router.post("/auth/signup/verify", route(async (req, res) => {
  requireHeader(req);
  const email = normalEmail(req.body?.email);
  const code = String(req.body?.code || "").replace(/\D/g, "");
  if (!validEmail(email) || code.length !== 6) throw new HttpError(400, "Enter your e-mail and the 6-digit code.");
  if (tooMany(`signup-verify-ip:${clientIp(req)}`, 30, 15 * 60 * 1000)) throw new HttpError(429, "Too many attempts. Please wait 15 minutes.");
  const wrong = new HttpError(401, "That code is not correct or has expired. Sign up again to get a new one.");
  const pending = await queryOne(
    `UPDATE customer_signups SET attempts = attempts + 1
      WHERE id = (SELECT id FROM customer_signups WHERE lower(email)=$1 AND used_at IS NULL AND expires_at > NOW() ORDER BY id DESC LIMIT 1)
      RETURNING id, details, password_hash, code_hash, attempts`, [email]);
  if (!pending || pending.attempts > MAX_ATTEMPTS) throw wrong;
  const expected = Buffer.from(pending.code_hash, "hex");
  const given = Buffer.from(hash(`signup:${email}:${code}`), "hex");
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    if (pending.attempts >= MAX_ATTEMPTS) await query("UPDATE customer_signups SET used_at=NOW() WHERE id=$1", [pending.id]);
    throw wrong;
  }
  await query("UPDATE customer_signups SET used_at=NOW() WHERE id=$1", [pending.id]);
  testCodes.delete(`signup:${email}`);
  const d = pending.details;
  const org = await orgId();

  // Lives in Tanzania: a normal customer for Sales. No account.
  if (d.residence === "TZ") {
    const sales = await departmentId(org, SALES);
    await query(
      `INSERT INTO leads (organization_id, name, email, phone, source, status, notes, preferred_contact, department_id, visibility)
       VALUES ($1,$2,$3,$4,'website-signup','new',$5,'phone',$6,'department')`,
      [org, d.name, d.email, d.phone, `Signed up on the website and lives in Tanzania (nationality: ${d.nationality_name}). Sales to contact.`, sales]);
    return res.json({ route: "sales", message: "Thank you. You live in Tanzania, so you do not need an online account: a MKUYU sales officer will call you shortly." });
  }

  // Lives abroad: a diaspora customer of the Diaspora Desk.
  const disabled = await queryOne("SELECT id FROM customer_accounts WHERE lower(email)=$1 AND status='disabled'", [email]);
  if (disabled) throw new HttpError(403, "This e-mail cannot be used for the portal. Please contact MKUYU.");
  if (await queryOne("SELECT id FROM customer_accounts WHERE lower(email)=$1", [email])) throw new HttpError(409, "You already have an account. Use Diaspora login.");
  const desk = await departmentId(org, DESK);
  const officer = await pickDeskOfficer(org);
  const known = await queryOne("SELECT id, verification_status FROM clients WHERE lower(email)=$1 AND organization_id=$2 ORDER BY id LIMIT 1", [email, org]);
  let clientId;
  if (known) {
    // Already a MKUYU client (added by staff, so already trusted): move them to the desk.
    clientId = known.id;
    await query(`UPDATE clients SET is_diaspora=TRUE, country=$2, residence_code=$3, nationality=$4, phone_country=$5, residence_check=$6,
        phone=COALESCE(NULLIF(phone,''), $7), diaspora_officer_id=COALESCE(diaspora_officer_id, $8), department_id=$9, visibility='department' WHERE id=$1`,
      [clientId, d.residence_name, d.residence, d.nationality_name, d.phone_country, d.residence_check, d.phone, officer, desk]);
  } else {
    clientId = (await queryOne(
      `INSERT INTO clients (organization_id, name, email, phone, client_type, status, notes, is_diaspora, country, residence_code, nationality, phone_country,
          residence_check, verification_status, diaspora_officer_id, owner_id, department_id, visibility)
       VALUES ($1,$2,$3,$4,'buyer','lead',$5,TRUE,$6,$7,$8,$9,$10,'unverified',$11,$11,$12,'department') RETURNING id`,
      [org, d.name, d.email, d.phone, "Signed up on the website (Diaspora).", d.residence_name, d.residence, d.nationality_name, d.phone_country, d.residence_check, officer, desk])).id;
  }
  if (d.username && await queryOne("SELECT 1 FROM customer_accounts WHERE lower(username)=$1", [d.username])) throw new HttpError(409, "That username was taken meanwhile. Sign up again with another one.");
  const account = await queryOne("INSERT INTO customer_accounts (client_id, email, username, status, password_hash) VALUES ($1,$2,$3,'active',$4) RETURNING id", [clientId, email, d.username || null, pending.password_hash]);
  await startSession(req, res, account.id);
  res.json({ route: "portal", customer: { name: d.name, email } });
}));

// ---- Password sign-in and reset --------------------------------------------------
router.post("/auth/login", route(async (req, res) => {
  requireHeader(req);
  // "identifier" is the username or the e-mail; "email" is still accepted.
  const email = String(req.body?.identifier ?? req.body?.email ?? "").trim().toLowerCase().slice(0, 200);
  const password = String(req.body?.password || "");
  if (!email || !password) throw new HttpError(400, "Enter your username or e-mail, and your password.");
  if (tooMany(`login-ip:${clientIp(req)}`, 30, 15 * 60 * 1000) || tooMany(`login:${email}`, 8, 15 * 60 * 1000)) throw new HttpError(429, "Too many attempts. Please wait 15 minutes or use 'Forgot password'.");
  const account = await queryOne(
    `SELECT ca.id, ca.password_hash, ca.email, cl.name FROM customer_accounts ca JOIN clients cl ON cl.id=ca.client_id
      WHERE (lower(ca.email)=$1 OR lower(ca.username)=$1) AND ca.status IN ('invited','active') AND cl.is_diaspora=TRUE`, [email]);
  // The same work and answer whether the e-mail is unknown or the password wrong.
  const ok = verifyPassword(password, account?.password_hash || "scrypt$00$00");
  if (!account || !account.password_hash || !ok) throw new HttpError(401, "Username / e-mail or password is not correct.");
  await startSession(req, res, account.id);
  res.json({ customer: { name: account.name, email: account.email } });
}));

// Forgot password: ask for a code (POST /auth/request-code), then set a new one.
router.post("/auth/reset-password", route(async (req, res) => {
  requireHeader(req);
  const email = normalEmail(req.body?.email);
  const code = String(req.body?.code || "").replace(/\D/g, "");
  if (!validEmail(email) || code.length !== 6) throw new HttpError(400, "Enter your e-mail and the 6-digit code.");
  if (!strongEnough(req.body?.password)) throw new HttpError(400, PASSWORD_RULE);
  if (tooMany(`verify-ip:${clientIp(req)}`, 30, 15 * 60 * 1000)) throw new HttpError(429, "Too many attempts. Please wait 15 minutes.");
  const account = await signInAccount(email);
  if (!account || !await checkLoginCode(account.id, code)) throw new HttpError(401, "That code is not correct or has expired. Ask for a new one.");
  await query("UPDATE customer_accounts SET password_hash=$1 WHERE id=$2", [hashPassword(req.body.password), account.id]);
  await query("DELETE FROM customer_sessions WHERE account_id=$1", [account.id]);
  await startSession(req, res, account.id);
  res.json({ customer: { name: account.name, email: account.email } });
}));

// ---- The portal ---------------------------------------------------------------
const VISIBLE = "('submitted','under_review','changes_requested','legal_approved','pending_management_approval','approved','customer_pending','active','completed')";
const fmtDate = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};
const STATUS_TEXT = {
  submitted: "Agreement being prepared", under_review: "Agreement being prepared", changes_requested: "Agreement being prepared",
  legal_approved: "Agreement being prepared", pending_management_approval: "Agreement being prepared",
  approved: "Ready for your signature", customer_pending: "Ready for your signature", active: "Contract active", completed: "Completed",
};

/** Four customer-facing steps; the internal approval steps are one "being prepared". */
function stagesFor(contract) {
  const order = ["prepared", "sign", "active", "completed"];
  const at = ["approved", "customer_pending"].includes(contract.status) ? 1 : contract.status === "active" ? 2 : contract.status === "completed" ? 3 : 0;
  const labels = ["Agreement prepared by MKUYU", "You sign the agreement", "Contract active · payments", contract.deal_type === "rent" ? "Tenancy completed" : "Fully paid · handover"];
  const dates = [fmtDate(contract.management_approved_at || contract.legal_reviewed_at), fmtDate(contract.customer_signed_at), fmtDate(contract.customer_signed_at), null];
  return order.map((key, index) => ({
    label: labels[index],
    state: index < at || (index === at && contract.status === "completed") ? "done" : index === at ? "current" : "upcoming",
    date: index < at || (index === at && contract.status === "completed") ? dates[index] : null,
  }));
}

async function ownContracts(clientId) {
  return (await query(
    `SELECT c.id, c.contract_number, c.status, c.deal_type, c.value, c.project_id, c.property_id, c.customer_signed_at, c.legal_reviewed_at,
            c.management_approved_at, c.signed_document_id, c.start_date, c.end_date, c.channel, c.customer_accepted_at, c.customer_accepted_name, c.generated_document_id, c.transfer_stage, c.transfer_note, c.transfer_updated_at,
            p.legal_status, p.title_deed_no, p.title_deed_kind, p.legal_note, p.legal_checked_at,
            pr.progress_pct, pr.expected_completion,
            p.name AS property_name, p.location, p.property_type, pr.name AS project_name, pr.location AS project_location,
            (SELECT pi.id FROM property_images pi WHERE pi.property_id=p.id ORDER BY pi.id LIMIT 1) AS photo_id
       FROM contracts c LEFT JOIN properties p ON p.id=c.property_id LEFT JOIN projects pr ON pr.id=c.project_id
      WHERE c.client_id=$1 AND c.status IN ${VISIBLE} ORDER BY c.id DESC`, [clientId])).rows;
}

async function paymentsFor(contract) {
  const installments = (await query(
    `SELECT d.id, d.notes, d.due_date, d.amount,
            COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.status='approved' WHERE pa.debt_id=d.id),0) AS paid
       FROM debts d WHERE d.contract_id=$1 ORDER BY d.due_date NULLS LAST, d.id`, [contract.id])).rows;
  const history = (await query(
    `SELECT id, amount, paid_at, method, reference, receipt_number FROM payments WHERE contract_id=$1 AND status='approved' ORDER BY paid_at, id`, [contract.id])).rows;
  const refunded = Number((await queryOne("SELECT COALESCE(SUM(amount),0) AS s FROM refunds WHERE contract_id=$1 AND status='approved'", [contract.id]))?.s || 0);
  const paid = history.reduce((sum, row) => sum + Number(row.amount), 0) - refunded;
  const total = Number(contract.value || 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = installments.map((d, index) => {
    const left = Math.max(0, Number(d.amount) - Number(d.paid));
    const due = d.due_date ? new Date(d.due_date) : null;
    const status = left <= 0 ? "paid" : due && due < today ? "overdue" : Number(d.paid) > 0 ? "partial" : "pending";
    return { label: d.notes || (index === 0 ? "Deposit" : `Installment ${index}`), due: fmtDate(d.due_date) || "—", amount: Number(d.amount), left, status, due_raw: due };
  });
  const next = rows.find((row) => row.left > 0);
  return {
    currency: "TZS", total, paid: Math.max(0, paid), balance: Math.max(0, Math.round((total - paid) * 100) / 100),
    next_due: next ? { amount: next.left, date: next.due } : null,
    installments: rows.map(({ due_raw, ...row }) => row),
    history: history.map((p) => ({ date: fmtDate(p.paid_at), amount: Number(p.amount), method: p.method, reference: p.reference,
      receipt: Boolean(p.receipt_number), receipt_number: p.receipt_number || null, receipt_url: p.receipt_number ? `/customer/receipts/${p.id}` : null })),
  };
}

async function updatesFor(contract) {
  if (!contract.project_id) return [];
  const updates = (await query(
    `SELECT u.id, u.title, u.note, u.update_date FROM construction_updates u
      WHERE u.project_id=$1 AND (u.property_id IS NULL OR u.property_id=$2) ORDER BY u.update_date DESC, u.id DESC LIMIT 24`,
    [contract.project_id, contract.property_id || 0])).rows;
  if (!updates.length) return [];
  const images = (await query("SELECT id, update_id FROM construction_update_images WHERE update_id = ANY($1::int[]) ORDER BY id", [updates.map((u) => u.id)])).rows;
  return updates.map((u) => ({ id: u.id, title: u.title, note: u.note, date: fmtDate(u.update_date),
    photos: images.filter((i) => i.update_id === u.id).map((i) => ({ url: `/customer/progress-photos/${i.id}` })) }));
}


const LEGAL_TEXT = { not_checked: "Legal has not checked this property yet", in_review: "Legal is reviewing this property", verified: "Title verified by MKUYU Legal", issues: "Legal has a note about this property" };
const TRANSFER_STEPS = [["documents", "Transfer documents prepared"], ["tax_clearance", "Tax clearance"], ["registry", "Land registry"], ["transferred", "Transferred to you"]];

/** What Legal has checked on the property the customer is buying. */
function legalFor(c) {
  if (!c.property_id) return null;
  return { status: c.legal_status || "not_checked", label: LEGAL_TEXT[c.legal_status] || LEGAL_TEXT.not_checked,
    deed_no: c.title_deed_no || null, deed_kind: c.title_deed_kind || null, note: c.legal_note || null, checked: fmtDate(c.legal_checked_at) };
}
/** Ownership transfer after a sale: the four registry steps and where they stand. */
function transferFor(c) {
  if ((c.deal_type && c.deal_type !== "buy") || !["active", "completed"].includes(c.status)) return null;
  const at = TRANSFER_STEPS.findIndex(([key]) => key === c.transfer_stage);
  const done = c.transfer_stage === "transferred";
  return { stage: c.transfer_stage, note: c.transfer_note || null, updated: fmtDate(c.transfer_updated_at),
    steps: TRANSFER_STEPS.map(([, label], i) => ({ label, state: done || i < at ? "done" : i === at ? "current" : "upcoming" })) };
}
/** The project's building stages and overall progress, when MKUYU keeps them. */
async function projectFor(c) {
  if (!c.project_id) return null;
  const stages = (await query("SELECT title, status, done_date, planned_date FROM project_stages WHERE project_id=$1 ORDER BY position, id", [c.project_id])).rows;
  if (!stages.length && c.progress_pct === null) return null;
  const derived = stages.length ? Math.round(stages.reduce((sum, st) => sum + (st.status === "done" ? 1 : st.status === "current" ? 0.5 : 0), 0) / stages.length * 100) : null;
  return { name: c.project_name || "", progress_pct: c.progress_pct ?? derived, expected: fmtDate(c.expected_completion),
    stages: stages.map((st) => ({ title: st.title, state: st.status === "done" ? "done" : st.status === "current" ? "current" : "upcoming", date: fmtDate(st.status === "done" ? st.done_date : st.planned_date) })) };
}

/** The customer's whole way from verification to keys, with the step they are on. */
function journeyFor({ verified, requests, contracts }) {
  const signed = contracts.some((c) => ["active", "completed"].includes(c.status));
  const paid = contracts.some((c) => c.status === "completed");
  const bought = contracts.filter((c) => !c.deal_type || c.deal_type === "buy");
  const transferred = bought.length > 0 && bought.some((c) => c.transfer_stage === "transferred");
  const done = [verified, requests > 0 || contracts.length > 0, requests > 1 || contracts.length > 0, signed, paid, transferred, transferred && paid];
  const labels = ["Verify your identity", "Choose a property", "Meet our team", "Sign your agreement", "Pay for your property", "Ownership transferred to you", "Handover"];
  const advice = ["Upload your passport and proof of residence under Verify my identity.", "Browse the properties and press Request on the one you like.", "Our team contacts you to arrange a viewing or video meeting.",
    "We prepare your agreement; you read and sign it in the portal.", "Pay by the agreed installments; every receipt appears in your portal.", "MKUYU Legal completes the transfer with the land registry.", "You receive your keys and documents."];
  const current = done.findIndex((d) => !d);
  return { steps: labels.map((label, i) => ({ key: i + 1, label, state: done[i] ? "done" : i === current ? "current" : "upcoming" })), next: current === -1 ? "Everything is complete. Welcome home." : advice[current] };
}

/** Where the customer's identity check stands, in their words. NULL = added by staff. */
const VERIFY_TEXT = {
  unverified: "Upload your passport and proof of where you live so MKUYU can verify you.",
  submitted: "Documents received. Our Diaspora Desk is checking them.",
  desk_checked: "Documents received. Our Diaspora Desk is completing the check.",
  rejected: "We could not verify your documents. Please read the note and upload them again.",
  verified: "Verified.",
};
function verificationState(customer) {
  const status = customer.verification_status || "verified";
  // Staff-added customers (NULL) were checked by MKUYU in person.
  const nationalityConfirmed = !customer.verification_status || Boolean(customer.citizenship_confirmed_at);
  return { status, verified: status === "verified", nationality_confirmed: status === "verified" && nationalityConfirmed,
    message: VERIFY_TEXT[status] || "", note: status === "rejected" ? customer.verification_note || null : null };
}

router.get("/portal", requireCustomer, route(async (req, res) => {
  const verification = verificationState(req.customer);
  // Contracts, money and documents only after MKUYU has verified who they are.
  const contracts = verification.verified ? await ownContracts(req.customer.client_id) : [];
  const services = { buy: [], rent: [], sell: [] };
  for (const c of contracts) {
    const key = ["rent", "sell"].includes(c.deal_type) ? c.deal_type : "buy";
    const documents = [];
    if (c.signed_document_id) documents.push({ name: `Signed agreement ${c.contract_number || ""}`.trim(), kind: "Contract", url: `/customer/contracts/${c.id}/signed` });
    const payments = await paymentsFor(c);
    for (const p of payments.history) if (p.receipt_url) documents.push({ name: `Receipt ${p.receipt_number}`, kind: "Receipt", url: p.receipt_url });
    services[key].push({
      id: c.contract_number || `#${c.id}`,
      property: { title: c.property_name || c.project_name || "Your property", location: c.location || c.project_location || "", type: c.property_type || "",
        photo: c.photo_id ? { url: `/customer/property-photos/${c.photo_id}` } : null },
      status: STATUS_TEXT[c.status] || c.status,
      stages: stagesFor(c),
      contract: { number: c.contract_number || `#${c.id}`, status: STATUS_TEXT[c.status] || c.status, signed: fmtDate(c.customer_signed_at) },
      ...(key === "rent" ? { rental: { start: fmtDate(c.start_date) || "—", end: fmtDate(c.end_date) || "—", period: "" } } : {}),
      ownership: key === "buy" ? "Ownership transfer follows completion of payment, as set out in your contract." : null,
      legal: legalFor(c), transfer: transferFor(c), project: await projectFor(c),
      payments: ["approved", "customer_pending", "active", "completed"].includes(c.status) ? payments : null,
      updates: await updatesFor(c),
      // A diaspora agreement waiting for the customer's electronic signature.
      signing: c.channel === "diaspora" && ["customer_pending", "active", "completed"].includes(c.status)
        ? { contract_id: c.id, required: c.status === "customer_pending" && !c.customer_accepted_at, signed_at: c.customer_accepted_at ? fmtDate(c.customer_accepted_at) : null, signed_name: c.customer_accepted_name || null }
        : null,
      documents,
    });
  }
  const contact = { phone: process.env.MKUYU_CONTACT_PHONE || null, email: process.env.MKUYU_CONTACT_EMAIL || null, whatsapp: process.env.MKUYU_CONTACT_WHATSAPP || process.env.MKUYU_CONTACT_PHONE || null };
  // Who on the Diaspora Desk knows this customer (contact person; the whole desk can help).
  const desk = await queryOne(`SELECT u.display_name AS name FROM clients c LEFT JOIN users u ON u.id=c.diaspora_officer_id WHERE c.id=$1`, [req.customer.client_id]);
  const unread = await queryOne("SELECT COUNT(*)::int AS n FROM customer_messages WHERE client_id=$1 AND sender='staff' AND read_at IS NULL", [req.customer.client_id]);
  const requests = await queryOne(`SELECT COUNT(*)::int AS n FROM leads WHERE client_id=$1 AND source='diaspora-portal' AND status NOT IN ('lost','closed')`, [req.customer.client_id]);
  res.json({ customer: { name: req.customer.name, email: req.customer.email, country: req.customer.country || null, photo_url: photoUrl(req.customer) }, contact, services, verification,
    diaspora: true, desk: { name: desk?.name || null }, requests_open: requests?.n || 0, messages_unread: unread?.n || 0,
    journey: journeyFor({ verified: verification.verified, requests: requests?.n || 0, contracts }),
    prefs: { notify_email: req.customer.notify_email !== false } });
}));

// ---- Requests from inside the portal ------------------------------------------
// A signed-in diaspora customer asks to buy or rent a published property with
// one click: name, e-mail, phone and country come from their client record, so
// they never fill them in again. It lands under Requests for Sales, marked
// Diaspora and already linked to the client.
const SERVICES = new Set(["buy", "rent"]);
const CONTACT = new Set(["email", "whatsapp", "phone"]);
const REQUEST_TEXT = { new: "Received · our Diaspora Desk will contact you", handed_off: "Our customer team is contacting you", contacted: "Contacted", appointment: "Meeting / viewing arranged", converted: "Moving to an agreement", lost: "Closed", closed: "Closed" };

router.post("/preferences", requireCustomer, route(async (req, res) => {
  requireHeader(req);
  const on = req.body?.notify_email !== false;
  await query("UPDATE clients SET notify_email=$2 WHERE id=$1", [req.customer.client_id, on]);
  res.json({ ok: true, notify_email: on });
}));


// ---- Video calls ------------------------------------------------------------------
router.post("/calls", requireCustomer, route(async (req, res) => {
  requireHeader(req);
  if (tooMany(`call:${req.customer.client_id}`, 6, 10 * 60 * 1000)) throw new HttpError(429, "Please wait a little before calling again.");
  const existing = await currentCall(req.customer.client_id);
  if (!existing) {
    await query("INSERT INTO video_calls (client_id, started_by, room) VALUES ($1,'customer',$2)", [req.customer.client_id, newRoom()]);
    await query("INSERT INTO customer_messages (client_id, sender, body) VALUES ($1,'customer','📹 Video call: I would like to talk')", [req.customer.client_id]);
    broadcastChange("diaspora");
    if (mailConfigured()) {
      query(`SELECT DISTINCT u.email FROM users u JOIN user_departments ud ON ud.user_id=u.id JOIN departments d ON d.id=ud.department_id
              WHERE d.name='DIASPORA DESK' AND d.active=TRUE AND u.email IS NOT NULL AND u.email <> ''`)
        .then(({ rows }) => Promise.all(rows.map((r) => sendMail({ to: r.email, subject: `MKUYU: ${req.customer.name} is calling`,
          text: `${req.customer.name} pressed Video call in the portal and is waiting.\n\nOpen the system → Diaspora messages to join.\n\nMKUYU Africa`, kind: "call" }).catch(() => {}))))
        .catch(() => {});
    }
  }
  res.status(201).json({ call: callView(await currentCall(req.customer.client_id), "customer", { desk: "Diaspora Desk", customer: req.customer.name }) });
}));
router.post("/calls/:id/answer", requireCustomer, route(async (req, res) => {
  requireHeader(req);
  const done = await query("UPDATE video_calls SET status='active', answered_at=NOW() WHERE id=$1 AND client_id=$2 AND status='ringing' AND started_by='staff' RETURNING id", [idParam(req.params.id), req.customer.client_id]);
  if (!done.rows.length) throw new HttpError(409, "The call has ended.");
  broadcastChange("diaspora");
  res.json({ ok: true });
}));
router.post("/calls/:id/end", requireCustomer, route(async (req, res) => {
  requireHeader(req);
  await finishCall(idParam(req.params.id), { clientId: req.customer.client_id, decline: req.body?.decline === true });
  res.json({ ok: true });
}));


router.get("/requests", requireCustomer, route(async (req, res) => {
  const rows = (await query(
    `SELECT l.id, l.service, l.status, l.budget, l.created_at, l.appointment_at, p.id AS property_id, p.name AS property_name, p.location
       FROM leads l LEFT JOIN properties p ON p.id=l.property_id
      WHERE l.client_id=$1 AND l.source='diaspora-portal' ORDER BY l.id DESC LIMIT 50`, [req.customer.client_id])).rows;
  res.json(rows.map((r) => ({ reference: `D-${r.id}`, property_id: r.property_id, property: r.property_name || "Property", location: r.location || "",
    service: r.service, budget: r.budget === null ? null : Number(r.budget), date: fmtDate(r.created_at),
    status: r.appointment_at ? `Meeting / viewing on ${fmtDate(r.appointment_at)}` : (REQUEST_TEXT[r.status] || "In progress") })));
}));

router.post("/requests", requireCustomer, route(async (req, res) => {
  requireHeader(req);
  // Diaspora customers are served only once MKUYU has verified who they are.
  // Checked here on the server, so it cannot be skipped from the browser.
  if (!verificationState(req.customer).verified) {
    throw new HttpError(403, "Please verify your identity first. Upload your passport and proof of residence under Verify my identity; once MKUYU confirms them you can request any property.");
  }
  const service = String(req.body?.service || "");
  if (!SERVICES.has(service)) throw new HttpError(400, "Choose whether you want to buy or rent.");
  const propertyId = Number(req.body?.property_id);
  if (!Number.isSafeInteger(propertyId) || propertyId < 1) throw new HttpError(400, "Choose a property.");
  const budgetRaw = req.body?.budget;
  const budget = budgetRaw === undefined || budgetRaw === null || budgetRaw === "" ? null : Number(budgetRaw);
  if (budget !== null && (!Number.isFinite(budget) || budget <= 0 || budget > 1e13)) throw new HttpError(400, "Enter your budget in TZS, or leave it empty.");
  const message = String(req.body?.message || "").trim().slice(0, 1500);
  const preferred = CONTACT.has(req.body?.preferred_contact) ? req.body.preferred_contact : "email";
  if (tooMany(`req:${req.customer.client_id}`, 10, 60 * 60 * 1000)) throw new HttpError(429, "You have sent many requests in the last hour. Please wait a little.");
  const property = await queryOne(
    `SELECT p.id, p.name, p.offer_buy, p.offer_rent, p.sale_status, p.rent_status, p.floor, p.unit_number, pr.name AS project_name
       FROM properties p LEFT JOIN projects pr ON pr.id=p.project_id
      WHERE p.id=$1 AND p.public_listing AND p.public_listing_status='approved'`, [propertyId]);
  if (!property) throw new HttpError(404, "This property is not available.");
  const { openToBuy } = await import("../models/propertyStatus.js");
  const offered = service === "rent" ? property.offer_rent : openToBuy(property);
  const state = service === "rent" ? property.rent_status : property.sale_status;
  if (!offered || (state || "available") !== "available") throw new HttpError(409, `This property is no longer open to ${service}.`);
  const open = await queryOne(`SELECT id FROM leads WHERE client_id=$1 AND property_id=$2 AND service=$3 AND source='diaspora-portal' AND status NOT IN ('lost','closed')`,
    [req.customer.client_id, property.id, service]);
  if (open) throw new HttpError(409, `You already asked about this property (reference D-${open.id}). Our team will contact you.`);
  const client = await queryOne("SELECT id, organization_id, name, email, phone, country, diaspora_officer_id FROM clients WHERE id=$1", [req.customer.client_id]);
  const desk = await departmentId(client.organization_id, DESK);
  const unit = property.unit_number ? ` · unit ${property.unit_number}${property.floor !== null && property.floor !== undefined ? `, floor ${property.floor}` : ""}${property.project_name ? `, ${property.project_name}` : ""}` : "";
  const notes = [`DIASPORA customer${client.country ? ` (${client.country})` : ""}, signed in to the portal: requests to ${service === "rent" ? "RENT" : "BUY"} "${property.name}"${unit}.`,
    `Preferred contact: ${preferred}.`, message].filter(Boolean).join("\n\n");
  const lead = await queryOne(
    `INSERT INTO leads (organization_id, client_id, name, email, phone, source, status, notes, budget, service, property_id, preferred_contact, assigned_to, owner_id, department_id, visibility)
     VALUES ($1,$2,$3,$4,$5,'diaspora-portal','new',$6,$7,$8,$9,$10,$11,$11,$12,$13) RETURNING id`,
    [client.organization_id, client.id, client.name, client.email, client.phone, notes, budget, service, property.id, preferred, client.diaspora_officer_id, desk, desk ? "department" : "organization"]);
  broadcastChange("requests");
  broadcastChange("diaspora");
  // The Diaspora Desk is told by e-mail as well, at once.
  if (mailConfigured()) {
    query(`SELECT DISTINCT u.email FROM users u JOIN user_departments ud ON ud.user_id=u.id JOIN departments d ON d.id=ud.department_id
            WHERE d.name='DIASPORA DESK' AND d.active=TRUE AND u.email IS NOT NULL AND u.email <> ''`)
      .then(({ rows }) => Promise.all(rows.map((r) => sendMail({ to: r.email, subject: `MKUYU: ${client.name} wants to ${service === "rent" ? "rent" : "buy"} ${property.name}`,
        text: `${client.name}${client.country ? ` (${client.country})` : ""} asked to ${service === "rent" ? "rent" : "buy"} "${property.name}" from the portal.\n\n${message ? `${message}\n\n` : ""}Open the system → Diaspora requests.\n\nMKUYU Africa`, kind: "request" }).catch(() => {}))))
      .catch(() => {});
  }
  res.status(201).json({ reference: `D-${lead.id}`, message: "Request received. Our Diaspora Desk will contact you, usually within one working day." });
}));

// ---- The agreement: read it, then sign it electronically ------------------------
// The text is the generated agreement Legal approved (documents.body_text). Its
// SHA-256 fingerprint is shown to the customer and must be sent back when
// signing, so the signature is tied to exactly the text they read.
const SIGN_CONFIRMATIONS = {
  read: "I have read the whole agreement, including the Schedules.",
  payments: "I will pay only to MKUYU's Official Accounts in its own name, quoting the contract number, never to a person.",
  ownership: "I understand clause 4 on my nationality and the form in which I will hold the property.",
  default: "I understand the late payment, termination and refund terms (clauses 8 to 10).",
  esign: "I agree that typing my full name and my password here is my legal signature.",
};

async function agreementFor(clientId, contractId) {
  const row = await queryOne(
    `SELECT c.id, c.contract_number, c.status, c.channel, c.customer_accepted_at, c.customer_accepted_name, d.body_text, d.title
       FROM contracts c LEFT JOIN documents d ON d.id=c.generated_document_id AND d.contract_id=c.id
      WHERE c.id=$1 AND c.client_id=$2 AND c.status IN ('customer_pending','active','completed')`, [contractId, clientId]);
  if (!row || !row.body_text) return null;
  return { ...row, fingerprint: hash(row.body_text) };
}

router.get("/contracts/:id/agreement", requireCustomer, route(async (req, res) => {
  if (!verificationState(req.customer).verified) throw new HttpError(403, "Your identity must be verified first.");
  const a = await agreementFor(req.customer.client_id, idParam(req.params.id));
  if (!a) throw new HttpError(404, "The agreement is not available yet.");
  res.json({ title: a.title || "Agreement", contract_number: a.contract_number, text: a.body_text, fingerprint: a.fingerprint,
    can_sign: a.channel === "diaspora" && a.status === "customer_pending" && !a.customer_accepted_at && verificationState(req.customer).nationality_confirmed,
    waiting_for_legal: !verificationState(req.customer).nationality_confirmed,
    signed_at: a.customer_accepted_at ? fmtDate(a.customer_accepted_at) : null, signed_name: a.customer_accepted_name, confirmations: SIGN_CONFIRMATIONS });
}));

router.post("/contracts/:id/sign", requireCustomer, route(async (req, res) => {
  requireHeader(req);
  if (!verificationState(req.customer).verified) throw new HttpError(403, "Your identity must be verified first.");
  // Nationality decides what MKUYU may offer, so Legal confirms it before any signature.
  if (!verificationState(req.customer).nationality_confirmed) throw new HttpError(403, "MKUYU's Legal team is confirming your nationality. You can sign as soon as they have; we will e-mail you.");
  if (tooMany(`sign:${req.customer.client_id}`, 10, 60 * 60 * 1000)) throw new HttpError(429, "Too many attempts. Please wait and try again.");
  const contractId = idParam(req.params.id);
  const a = await agreementFor(req.customer.client_id, contractId);
  if (!a || a.channel !== "diaspora") throw new HttpError(404, "Agreement not found.");
  if (a.customer_accepted_at) throw new HttpError(409, "You have already signed this agreement.");
  if (a.status !== "customer_pending") throw new HttpError(409, "This agreement is not waiting for your signature.");
  if (String(req.body?.fingerprint || "") !== a.fingerprint) throw new HttpError(409, "The agreement has changed since you opened it. Please read the current version and sign again.");
  const given = req.body?.confirmations || {};
  if (!Object.keys(SIGN_CONFIRMATIONS).every((key) => given[key] === true)) throw new HttpError(400, "Tick every confirmation before signing.");
  const clean = (v) => String(v || "").trim().replace(/\s+/g, " ").toLowerCase();
  const typed = String(req.body?.full_name || "").trim().replace(/\s+/g, " ").slice(0, 160);
  const client = await queryOne("SELECT name FROM clients WHERE id=$1", [req.customer.client_id]);
  if (clean(typed) !== clean(client.name)) throw new HttpError(400, `Type your full name exactly as in the agreement: ${client.name}.`);
  const account = await queryOne("SELECT password_hash FROM customer_accounts WHERE id=$1", [req.customer.id]);
  if (!account?.password_hash || !verifyPassword(String(req.body?.password || ""), account.password_hash)) throw new HttpError(401, "Your password is not correct.");
  const updated = await queryOne(
    `UPDATE contracts SET customer_accepted_at=NOW(), customer_accepted_name=$2, customer_accepted_ip=$3, customer_accepted_agent=$4,
            customer_accepted_hash=$5, customer_accepted_text=$6
      WHERE id=$1 AND customer_accepted_at IS NULL AND status='customer_pending' RETURNING customer_accepted_at`,
    [contractId, typed, clientIp(req), String(req.get("user-agent") || "").slice(0, 300), a.fingerprint, a.body_text]);
  if (!updated) throw new HttpError(409, "This agreement could not be signed. Please refresh.");
  await query("INSERT INTO audit_logs (organization_id, user_id, action, module, record_id, details_json) SELECT organization_id, NULL, 'contract_customer_esigned', 'contract', $1, $2::jsonb FROM contracts WHERE id=$3",
    [String(contractId), JSON.stringify({ name: typed, ip: clientIp(req), fingerprint: a.fingerprint, account_id: req.customer.id }), contractId]);
  if (mailConfigured()) {
    sendMail({ to: req.customer.email, subject: `MKUYU: you signed ${a.contract_number}`,
      text: `Dear ${client.name},\n\nYou signed ${a.title || "the agreement"} ${a.contract_number} electronically in the MKUYU Diaspora Portal on ${updated.customer_accepted_at.toISOString().replace("T", " ").slice(0, 16)} UTC.\n\nDocument fingerprint (SHA-256): ${a.fingerprint}\n\nNext: pay the deposit to MKUYU's Official Account shown in the portal, quoting ${a.contract_number}. Once Finance confirms it, MKUYU's Legal team records your signature and the contract becomes active.\n\nIf you did not sign this, contact the Diaspora Desk immediately.\n\nMKUYU Africa`,
      kind: "contract_esigned" }).catch(() => {});
  }
  res.json({ ok: true, signed_at: fmtDate(updated.customer_accepted_at), fingerprint: a.fingerprint });
}));

// ---- Identity documents (self sign-ups) ------------------------------------------
const DOC_KINDS = { passport: "Passport (photo page) or NIDA", selfie: "Selfie holding your passport open at the photo page (recommended)", residence: "Proof of residence abroad (visa, residence card or permit)", other: "Other supporting document" };

router.get("/verification", requireCustomer, route(async (req, res) => {
  const docs = (await query(`SELECT id, category, original_filename, uploaded_at, to_char(expires_on,'YYYY-MM-DD') AS expires_on FROM documents WHERE client_id=$1 AND category LIKE 'kyc_%' AND status <> 'superseded' ORDER BY id DESC`, [req.customer.client_id])).rows;
  const events = (await query("SELECT action, note, created_at FROM verification_events WHERE client_id=$1 ORDER BY id DESC LIMIT 30", [req.customer.client_id])).rows;
  const EVENT_TEXT = { documents_submitted: "You sent documents", verify: "MKUYU verified your identity", reject: "Documents sent back to you", revoke: "Verification removed", confirm_citizenship: "Nationality confirmed", desk_ok: "Checked by the Diaspora Desk", expiry_reminder: "Reminder: a document is about to expire" };
  res.json({ ...verificationState(req.customer), kinds: DOC_KINDS,
    history: events.map((e) => ({ text: EVENT_TEXT[e.action] || e.action, note: ["reject", "revoke", "expiry_reminder"].includes(e.action) ? e.note : null, date: fmtDate(e.created_at) })),
    documents: docs.map((d) => ({ kind: d.category.slice(4), name: d.original_filename, date: fmtDate(d.uploaded_at), expires_on: d.expires_on })) });
}));

router.post("/verification/documents", requireCustomer, (req, res, next) => {
  // The header is checked before the file is read, so a foreign page cannot upload.
  if (req.get(CUSTOMER_HEADER) !== "1") return res.status(403).json({ error: "request refused" });
  uploadDocumentFile(req, res, (error) => (error ? next(error) : next()));
}, route(async (req, res) => {
  try {
    const kind = String(req.body?.kind || "");
    if (!DOC_KINDS[kind]) throw new HttpError(400, "Choose which document this is.");
    if (["verified"].includes(req.customer.verification_status || "verified")) throw new HttpError(409, "You are already verified.");
    if (tooMany(`docs:${req.customer.client_id}`, 20, 60 * 60 * 1000)) throw new HttpError(429, "Too many uploads. Please wait a little.");
    // Passports must say when they expire; a document that has already expired is refused.
    const expiresRaw = String(req.body?.expires_on || "").trim();
    let expiresOn = null;
    if (expiresRaw) {
      const parsed = /^\d{4}-\d{2}-\d{2}$/.test(expiresRaw) ? new Date(`${expiresRaw}T00:00:00Z`) : null;
      if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== expiresRaw) throw new HttpError(400, "Enter the expiry date as shown on the document.");
      if (parsed.getTime() < Date.now() - 24 * 60 * 60 * 1000) throw new HttpError(400, "This document has already expired. Please upload one that is still valid.");
      expiresOn = expiresRaw;
    } else if (kind === "passport") throw new HttpError(400, "Enter the passport's expiry date.");
    const info = validateUploadedFile(req.file, documentExtensions);
    const client = await queryOne("SELECT organization_id, department_id FROM clients WHERE id=$1", [req.customer.client_id]);
    // One current document per kind: a new upload replaces the old one, which
    // stays on file (marked superseded) but leaves the Desk's list.
    await query("UPDATE documents SET status='superseded' WHERE client_id=$1 AND category=$2 AND status <> 'superseded'", [req.customer.client_id, `kyc_${kind}`]);
    await query(
      `INSERT INTO documents (organization_id, client_id, title, category, status, original_filename, stored_name, file_size, mime_type, uploaded_at, department_id, visibility, expires_on)
       VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,NOW(),$9,'department',$10)`,
      [client.organization_id, req.customer.client_id, `${DOC_KINDS[kind]} · ${req.customer.name}`, `kyc_${kind}`, info.displayName, info.storedName, info.size, info.mimeType, client.department_id, expiresOn]);
    // The first document puts the customer in the Diaspora Desk's queue at
    // once; the desk sees which document is still missing and verifies when
    // both are in (or sends back asking for the other one).
    const moved = await query("UPDATE clients SET verification_status='submitted', verification_note=NULL WHERE id=$1 AND verification_status IN ('unverified','rejected') RETURNING id", [req.customer.client_id]);
    // Tell the Diaspora Desk by e-mail once, when the customer first enters the queue.
    if (moved.rows.length && mailConfigured()) {
      query(`SELECT DISTINCT u.email FROM users u JOIN user_departments ud ON ud.user_id=u.id JOIN departments d ON d.id=ud.department_id
              WHERE d.name='DIASPORA DESK' AND d.active=TRUE AND u.email IS NOT NULL AND u.email <> ''`)
        .then(({ rows }) => Promise.all(rows.map((r) => sendMail({ to: r.email, subject: "MKUYU: a diaspora customer sent documents",
          text: `${req.customer.name} has uploaded identity documents and is waiting to be verified.\n\nOpen the system → Diaspora verification.\n\nMKUYU Africa`, kind: "kyc" }).catch(() => {}))))
        .catch(() => {});
    }
    await recordVerificationEvent(req.customer.client_id, null, "documents_submitted", DOC_KINDS[kind]);
    // Open Diaspora Desk screens refresh by themselves.
    broadcastChange("diaspora");
    const now = await queryOne("SELECT verification_status, verification_note FROM clients WHERE id=$1", [req.customer.client_id]);
    res.status(201).json(verificationState({ ...req.customer, ...now }));
  } catch (error) { cleanupUploadedFile(req.file); throw error; }
}));

// ---- Files: each one re-checks that it belongs to this customer -------------
const fileHeaders = (res, mime, filename, download) => {
  res.setHeader("Content-Type", mime || "application/octet-stream");
  res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${safeDisplayFilename(filename, "file").replace(/"/g, "")}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
};
const idParam = (value) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(404, "not found"); return n; };

// ---- Messages with the Diaspora Desk --------------------------------------------
const MESSAGE_SELECT = `SELECT m.*, u.display_name AS staff_name, r.body AS reply_body, r.sender AS reply_sender, r.deleted_at AS reply_deleted, ru.display_name AS reply_staff_name
    FROM customer_messages m LEFT JOIN users u ON u.id=m.staff_user_id
    LEFT JOIN customer_messages r ON r.id=m.reply_to LEFT JOIN users ru ON ru.id=r.staff_user_id`;
// Seen from the customer's side: "me" is the customer, "desk" the other party.
const messageRow = (m) => ({
  id: m.id, from: m.sender, name: m.sender === "staff" ? (m.staff_name || "Diaspora Desk") : "You", body: m.deleted_at ? "" : m.body, at: m.created_at,
  deleted: Boolean(m.deleted_at), edited: Boolean(m.edited_at) && !m.deleted_at,
  read: Boolean(m.read_at), delivered: Boolean(m.delivered_at || m.read_at),
  reactions: { me: m.reaction_customer || null, desk: m.reaction_staff || null },
  reply: m.reply_to && m.reply_body ? { id: m.reply_to, from: m.reply_sender, name: m.reply_sender === "staff" ? (m.reply_staff_name || "Diaspora Desk") : "You", body: m.reply_deleted ? "" : String(m.reply_body).slice(0, 140), deleted: Boolean(m.reply_deleted) } : null,
});
const messageState = (m) => ({ id: m.id, body: m.deleted_at ? "" : m.body, deleted: Boolean(m.deleted_at), edited: Boolean(m.edited_at) && !m.deleted_at, read: Boolean(m.read_at), delivered: Boolean(m.delivered_at || m.read_at), reactions: { me: m.reaction_customer || null, desk: m.reaction_staff || null } });

router.get("/messages", requireCustomer, route(async (req, res) => {
  const rows = (await query(`${MESSAGE_SELECT} WHERE m.client_id=$1 AND NOT m.hidden_customer ORDER BY m.id DESC LIMIT 200`, [req.customer.client_id])).rows.reverse();
  // Opening the conversation marks the desk's replies as delivered and read.
  const seen = await query("UPDATE customer_messages SET read_at=NOW(), delivered_at=COALESCE(delivered_at, NOW()) WHERE client_id=$1 AND sender='staff' AND read_at IS NULL", [req.customer.client_id]);
  if (seen.rowCount) broadcastChange("diaspora");
  res.json({ messages: rows.map(messageRow), reactions: REACTIONS });
}));

// Light check the open portal makes every few seconds: what is new since the last
// message the page has, the current state (seen, reactions) of recent messages,
// whether the desk is typing, and how many replies are waiting. "peek" counts
// without marking as read.
router.get("/messages/poll", requireCustomer, route(async (req, res) => {
  const clientId = req.customer.client_id;
  const after = Math.max(0, Number.parseInt(req.query.after, 10) || 0);
  const peek = req.query.peek === "1";
  // The page has the desk's messages the moment it receives them: delivered.
  const delivered = await query("UPDATE customer_messages SET delivered_at=NOW() WHERE client_id=$1 AND sender='staff' AND delivered_at IS NULL", [clientId]);
  const fresh = (await query(`${MESSAGE_SELECT} WHERE m.client_id=$1 AND NOT m.hidden_customer AND m.id > $2 ORDER BY m.id LIMIT 100`, [clientId, after])).rows;
  const recent = (await query("SELECT id, body, edited_at, deleted_at, read_at, delivered_at, reaction_customer, reaction_staff FROM customer_messages WHERE client_id=$1 AND NOT hidden_customer ORDER BY id DESC LIMIT 100", [clientId])).rows;
  const seen = peek ? null : await query("UPDATE customer_messages SET read_at=NOW() WHERE client_id=$1 AND sender='staff' AND read_at IS NULL", [clientId]);
  // The desk's open page learns at once that its messages were delivered or read.
  if (delivered.rowCount || seen?.rowCount) broadcastChange("diaspora");
  const unread = peek ? (await queryOne("SELECT COUNT(*)::int AS n FROM customer_messages WHERE client_id=$1 AND sender='staff' AND read_at IS NULL", [clientId]))?.n || 0 : 0;
  const call = callView(await currentCall(clientId), "customer", { desk: "Diaspora Desk", customer: req.customer.name });
  res.json({ messages: fresh.map(messageRow), state: recent.map(messageState), typing: isTyping(clientId, "staff"), unread, call });
}));

router.post("/messages/typing", requireCustomer, (req, res) => {
  if (req.get(CUSTOMER_HEADER) !== "1") return res.status(403).json({ error: "request refused" });
  setTyping(req.customer.client_id, "customer");
  res.json({ ok: true });
});

router.post("/messages/react", requireCustomer, route(async (req, res) => {
  if (req.get(CUSTOMER_HEADER) !== "1") throw new HttpError(403, "request refused");
  const id = Number.parseInt(req.body?.message_id, 10);
  const emoji = req.body?.emoji ? String(req.body.emoji) : null;
  if (!Number.isSafeInteger(id)) throw new HttpError(400, "Choose a message.");
  if (emoji && !REACTIONS.includes(emoji)) throw new HttpError(400, "That reaction is not available.");
  const done = await query("UPDATE customer_messages SET reaction_customer=$3 WHERE id=$1 AND client_id=$2 RETURNING id", [id, req.customer.client_id, emoji]);
  if (!done.rows.length) throw new HttpError(404, "Message not found.");
  broadcastChange("diaspora");
  res.json({ ok: true });
}));

router.post("/messages/:id/edit", requireCustomer, route(async (req, res) => {
  if (req.get(CUSTOMER_HEADER) !== "1") throw new HttpError(403, "request refused");
  const id = idParam(req.params.id);
  const body = String(req.body?.body || "").replace(/\r\n/g, "\n").trim();
  if (!body) throw new HttpError(400, "A message cannot be empty. Delete it instead.");
  if (body.length > 2000) throw new HttpError(400, "Please keep the message under 2000 characters.");
  const m = await queryOne("SELECT id, created_at, deleted_at FROM customer_messages WHERE id=$1 AND client_id=$2 AND sender='customer'", [id, req.customer.client_id]);
  if (!m || m.deleted_at) throw new HttpError(404, "Message not found.");
  if (Date.now() - new Date(m.created_at).getTime() > EDIT_WINDOW_MS) throw new HttpError(409, "A message can be edited for 15 minutes after it is sent.");
  await query("UPDATE customer_messages SET body=$3, edited_at=NOW() WHERE id=$1 AND client_id=$2", [id, req.customer.client_id, body]);
  broadcastChange("diaspora");
  const row = (await query(`${MESSAGE_SELECT} WHERE m.id=$1`, [id])).rows[0];
  res.json({ message: messageRow(row) });
}));

router.post("/messages/:id/delete", requireCustomer, route(async (req, res) => {
  if (req.get(CUSTOMER_HEADER) !== "1") throw new HttpError(403, "request refused");
  const id = idParam(req.params.id);
  const scope = req.body?.scope === "all" ? "all" : "me";
  const m = await queryOne("SELECT id, sender, created_at, deleted_at FROM customer_messages WHERE id=$1 AND client_id=$2", [id, req.customer.client_id]);
  if (!m) throw new HttpError(404, "Message not found.");
  if (scope === "all") {
    if (m.sender !== "customer") throw new HttpError(403, "You can delete for everyone only the messages you sent.");
    if (Date.now() - new Date(m.created_at).getTime() > DELETE_ALL_WINDOW_MS) throw new HttpError(409, "A message can be deleted for everyone within 48 hours of sending.");
    await query("UPDATE customer_messages SET deleted_at=COALESCE(deleted_at, NOW()), reaction_customer=NULL, reaction_staff=NULL WHERE id=$1", [id]);
    broadcastChange("diaspora");
  } else {
    await query("UPDATE customer_messages SET hidden_customer=TRUE WHERE id=$1", [id]);
  }
  res.json({ ok: true });
}));

router.post("/messages", requireCustomer, (req, res, next) => {
  if (req.get(CUSTOMER_HEADER) !== "1") return res.status(403).json({ error: "request refused" });
  next();
}, route(async (req, res) => {
  const body = String(req.body?.body || "").replace(/\r\n/g, "\n").trim();
  if (!body) throw new HttpError(400, "Write your message first.");
  if (body.length > 2000) throw new HttpError(400, "Please keep the message under 2000 characters.");
  if (tooMany(`msg:${req.customer.client_id}`, 40, 60 * 60 * 1000)) throw new HttpError(429, "Too many messages. Please wait a little.");
  let replyTo = null;
  if (req.body?.reply_to) {
    const target = await queryOne("SELECT id FROM customer_messages WHERE id=$1 AND client_id=$2", [Number.parseInt(req.body.reply_to, 10) || 0, req.customer.client_id]);
    replyTo = target?.id || null;
  }
  const inserted = (await query("INSERT INTO customer_messages (client_id, sender, body, reply_to) VALUES ($1,'customer',$2,$3) RETURNING id", [req.customer.client_id, body, replyTo])).rows[0];
  clearTyping(req.customer.client_id, "customer");
  const row = (await query(`${MESSAGE_SELECT} WHERE m.id=$1`, [inserted.id])).rows[0];
  broadcastChange("diaspora");
  // The desk is e-mailed for the first unanswered message only, so a long chat is not a long list of e-mails.
  const earlier = await queryOne("SELECT COUNT(*)::int AS n FROM customer_messages WHERE client_id=$1 AND sender='customer' AND id<$2 AND id > COALESCE((SELECT MAX(id) FROM customer_messages WHERE client_id=$1 AND sender='staff'), 0)", [req.customer.client_id, row.id]);
  if (!earlier?.n && mailConfigured()) {
    query(`SELECT DISTINCT u.email FROM users u JOIN user_departments ud ON ud.user_id=u.id JOIN departments d ON d.id=ud.department_id
            WHERE d.name='DIASPORA DESK' AND d.active=TRUE AND u.email IS NOT NULL AND u.email <> ''`)
      .then(({ rows }) => Promise.all(rows.map((r) => sendMail({ to: r.email, subject: `MKUYU: new message from ${req.customer.name}`,
        text: `${req.customer.name} wrote to the Diaspora Desk in the portal:\n\n${body.slice(0, 500)}\n\nOpen the system → Diaspora messages to reply.\n\nMKUYU Africa`, kind: "message" }).catch(() => {}))))
      .catch(() => {});
  }
  res.status(201).json({ message: messageRow(row) });
}));

router.get("/receipts/:id", requireCustomer, route(async (req, res) => {
  const payment = await queryOne(
    `SELECT p.*, ab.display_name AS approved_by_name, d.notes AS installment_notes FROM payments p
       JOIN contracts c ON c.id=p.contract_id LEFT JOIN users ab ON ab.id=p.approved_by LEFT JOIN debts d ON d.id=p.debt_id
      WHERE p.id=$1 AND c.client_id=$2 AND c.status IN ${VISIBLE} AND p.status='approved' AND p.receipt_number IS NOT NULL`, [idParam(req.params.id), req.customer.client_id]);
  if (!payment) throw new HttpError(404, "Receipt not found");
  const contract = await queryOne(`SELECT c.id, c.contract_number, pr.name AS property_name, o.name AS org_name FROM contracts c
    LEFT JOIN properties pr ON pr.id=c.property_id LEFT JOIN organizations o ON o.id=c.organization_id WHERE c.id=$1`, [payment.contract_id]);
  fileHeaders(res, "application/pdf", `${payment.receipt_number}.pdf`, true);
  const doc = new PDFDocument({ size: "A5", margin: 40 });
  doc.pipe(res);
  writeReceiptPdf(doc, payment, contract, contract.org_name, await receiptCoverage(payment.id));
  doc.end();
}));

router.get("/contracts/:id/signed", requireCustomer, route(async (req, res) => {
  const row = await queryOne(
    `SELECT d.stored_name, d.mime_type, d.original_filename, c.contract_number FROM contracts c JOIN documents d ON d.id=c.signed_document_id
      WHERE c.id=$1 AND c.client_id=$2 AND c.status IN ${VISIBLE}`, [idParam(req.params.id), req.customer.client_id]);
  const full = row && resolveStoredFile(documentUploadsDir, row.stored_name);
  if (!full) throw new HttpError(404, "Document not found");
  fileHeaders(res, row.mime_type, row.original_filename || `${row.contract_number}-signed`, true);
  res.sendFile(full);
}));

router.get("/progress-photos/:id", requireCustomer, route(async (req, res) => {
  const row = await queryOne(
    `SELECT i.stored_name, i.mime_type, i.original_filename FROM construction_update_images i JOIN construction_updates u ON u.id=i.update_id
      WHERE i.id=$1 AND EXISTS (SELECT 1 FROM contracts c WHERE c.client_id=$2 AND c.status IN ${VISIBLE} AND c.project_id=u.project_id
                                AND (u.property_id IS NULL OR u.property_id=c.property_id))`, [idParam(req.params.id), req.customer.client_id]);
  const full = row && resolveStoredFile(progressUploadsDir, row.stored_name);
  if (!full) throw new HttpError(404, "Photo not found");
  fileHeaders(res, row.mime_type, row.original_filename || "photo", false);
  res.sendFile(full);
}));

router.get("/property-photos/:id", requireCustomer, route(async (req, res) => {
  const { propertyUploadsDir } = await import("../uploads.js");
  const row = await queryOne(
    `SELECT i.stored_name, i.mime_type, i.original_filename FROM property_images i
      WHERE i.id=$1 AND EXISTS (SELECT 1 FROM contracts c WHERE c.client_id=$2 AND c.status IN ${VISIBLE} AND c.property_id=i.property_id)`,
    [idParam(req.params.id), req.customer.client_id]);
  const full = row && resolveStoredFile(propertyUploadsDir, row.stored_name);
  if (!full) throw new HttpError(404, "Photo not found");
  fileHeaders(res, row.mime_type, row.original_filename || "photo", false);
  res.sendFile(full);
}));

// Any other /customer path ends HERE. It must never fall through to the staff
// API (whose login check would answer with a confusing staff error, for
// example "missing CSRF protection" when a staff cookie is in the browser).
router.use((req, res) => res.status(404).json({ error: "This page of the customer portal does not exist. If MKUYU has just updated the system, the server may need a restart." }));

// Errors: a safe message for the customer, the detail in the server log.
router.use((error, req, res, next) => {
  const status = Number(error.status) || 500;
  if (status >= 500) { console.error(`customer API ${req.method} ${req.originalUrl}:`, error?.stack || error); return res.status(500).json({ error: "Something went wrong. Please try again." }); }
  res.status(status).json({ error: error.message });
});

export default router;
