import express from "express";
import cors from "cors";
import compression from "compression";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runMigrations } from "./migrate.js";
import { ensureUploadDirs } from "./uploads.js";
import { startAutoBackups } from "./backups.js";
import { startExpiryReminders } from "./notify/diasporaNotices.js";
import { startDueReminders } from "./payments/notices.js";
import { startCustomerNotices } from "./notify/customerNotices.js";
import apiRoutes from "./routes/api.js";
import { isProduction, rateLimit, securityHeaders } from "./security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

const app = express();
const PORT = process.env.PORT || 3003;
// Forwarded headers are trusted only from explicitly configured proxy IPs or
// CIDRs. A client that can reach the app directly must not choose its own IP.
const trustedProxies = String(process.env.TRUST_PROXY || "").split(",").map((value) => value.trim()).filter(Boolean);
app.set("trust proxy", trustedProxies.length ? trustedProxies : false);
app.disable("x-powered-by");
app.use(securityHeaders());
// Load: gzip every text response (app.js 440 KB -> ~100 KB, JSON lists shrink
// the same way). The live update stream is excluded: it must not be buffered.
app.use(compression({
  threshold: 1024,
  filter: (req, res) => !String(res.getHeader("Content-Type") || "").includes("text/event-stream") && compression.filter(req, res),
}));
// Load: a request slower than this is written to the server log, so a
// struggling screen or query shows up before people complain.
const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS || 1500);
app.use("/api", (req, res, next) => {
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms >= SLOW_REQUEST_MS && !req.originalUrl.includes("/live")) console.warn(`[slow] ${req.method} ${req.originalUrl.split("?")[0]} ${Math.round(ms)} ms (status ${res.statusCode})`);
  });
  next();
});

// MK-08: the public website's origins. Only these may call the public API
// from a browser. PUBLIC_SITE_ORIGINS in .env lists the real site (comma
// separated, include the Diaspora Portal site too); in development the local preview addresses are allowed too.
const DEV_PUBLIC_ORIGINS = ["http://localhost:5500", "http://127.0.0.1:5500", "http://localhost:5600", "http://127.0.0.1:5600"]; // 5500 = Tanzania website, 5600 = Diaspora Portal
const publicSiteOrigins = [
  ...String(process.env.PUBLIC_SITE_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean),
  ...(isProduction() ? [] : DEV_PUBLIC_ORIGINS),
];
// Explicitly allowed CROSS-origin callers. The default is empty on purpose: this
// same process serves the frontend (static files plus the SPA fallback), so a
// browser reaching the API through it is always same-origin, and that case is
// handled below without needing a hostname in this list.
const corsOrigins = String(process.env.CORS_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);

// A request is same-origin when the browser's Origin host matches the host the
// request was actually addressed to. This is what makes the app work on any
// hostname - localhost, a LAN address, or a tunnel such as ngrok - without
// reconfiguring anything, and it is not a relaxation: a genuine third-party
// page on another domain sends an Origin that cannot match `req.headers.host`,
// so it is still refused.
const isSameOrigin = (origin, request) => {
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
};

// A cross-origin request that is neither same-origin nor listed is refused with
// 403 and a readable reason. It used to be `callback(new Error(...))`, which
// fell through to the generic handler and surfaced to the browser as an opaque
// 500 "internal server error" - making a configuration problem look like a
// server fault.
app.use(cors((request, callback) => {
  const origin = request.headers.origin;
  // No Origin header: not a browser cross-origin request (curl, health checks,
  // server-to-server). Nothing to negotiate.
  if (!origin || corsOrigins.includes("*") || corsOrigins.includes(origin) || isSameOrigin(origin, request)) {
    return callback(null, { origin: true });
  }
  // The public website (served separately) may read what the Sales Officer
  // has published and send a visitor's request, enquiry or sell submission.
  // Only its own origins are allowed, and never with credentials.
  const url = String(request.originalUrl || request.url);
  // The diaspora customer portal on the public website: its own cookie
  // session, so it is the one public path allowed WITH credentials, and only
  // from the website's own origins.
  if (url.startsWith("/api/v1/customer/") && publicSiteOrigins.includes(origin)) {
    return callback(null, { origin: true, credentials: true });
  }
  const publicRead = ["GET", "HEAD", "OPTIONS"].includes(request.method) && url.startsWith("/api/v1/public/");
  const publicWrite = request.method === "POST" && /^\/api\/v1\/public\/(requests|enquiries|sell|chat)(\?|$)/.test(url);
  if ((publicRead || publicWrite) && publicSiteOrigins.includes(origin)) {
    return callback(null, { origin: true, credentials: false });
  }
  const refused = new Error("origin is not allowed");
  refused.status = 403;
  return callback(refused);
}));
// Abuse protection for the public API as a whole (per client address); the
// request/enquiry/sell routes add their own tighter per-phone limits.
app.use("/api/v1/public", rateLimit({ name: "public", limit: 300, windowMs: 60 * 1000 }));
app.use("/api/v1/customer", rateLimit({ name: "customer", limit: 120, windowMs: 60 * 1000 }));
// Load: a ceiling for the staff API per client address, far above normal use
// (a busy screen makes a few requests a second) but enough to stop a runaway
// script or a stuck browser tab from flooding the server.
app.use("/api/v1", rateLimit({ name: "api", limit: Number(process.env.API_RATE_LIMIT_PER_MIN || 3000), windowMs: 60 * 1000 }));
app.use(express.json({ limit: "1mb" }));

// Serve static frontend
const frontendDir = path.resolve(__dirname, "..", "..", "frontend");
// Load: images and brand files never change in place, so browsers keep them
// for a week. app.js / app.css stay revalidated (ETag) so a new release shows
// at once.
app.use("/assets", express.static(path.join(frontendDir, "assets"), { maxAge: "7d" }));
app.use(express.static(frontendDir));

// API
app.use("/api/v1", apiRoutes);

// MK-11: clients get a safe message; the detail stays in the server log.
app.use((error, req, res, next) => {
  if (req.path.startsWith("/api")) {
    // A malformed JSON body is the client's mistake, but the parser's own text
    // (positions, tokens) is not something to echo back.
    if (error.type === "entity.parse.failed") return res.status(400).json({ error: "the request body is not valid JSON" });
    if (error.type === "entity.too.large") return res.status(413).json({ error: "the request is too large" });
    const status = Number(error.status || error.statusCode) || 500;
    if (status >= 500 || !error.status) {
      console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} failed:`, error?.stack || error);
      return res.status(500).json({ error: "internal server error" });
    }
    return res.status(status).json({ error: error.message });
  }
  next(error);
});

// SPA fallback: serve index.html for non-asset routes
app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ error: "not found" });
  res.sendFile(path.join(frontendDir, "index.html"));
});

// A stray rejected promise must never take the whole workspace offline. Log it
// and keep serving; every request handler already funnels its own errors.
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection:", reason instanceof Error ? reason.stack || reason.message : reason);
});
process.on("uncaughtException", (error) => {
  console.error("uncaught exception:", error?.stack || error);
});

await runMigrations();
// Pre-open the connection pool and pay the first-execution cost of the heavy
// dashboard queries at boot. The first workspace request otherwise pays for
// connection setup plus query planning (measured ~400 ms cold vs ~25 ms warm).
{
  const { pool } = await import("./db.js");
  const warmStarted = Date.now();
  // Fill the pool so the first workspace burst never opens connections itself.
  await Promise.all(Array.from({ length: pool.options.max }, () => pool.query("SELECT 1")));
  try {
    const { Report } = await import("./models/report.js");
    const { accessForUser, runWithAccess } = await import("./org/access.js");
    await Promise.all([Report.summary(), Report.byProject()]);
    // Staff requests use a different (scope-filtered) query text, so PostgreSQL
    // plans it separately. Warm that plan too, otherwise the first staff member
    // to sign in pays the full planning cost.
    const staff = (await pool.query("SELECT * FROM users WHERE active = TRUE AND role = 'staff' ORDER BY id LIMIT 1")).rows[0];
    if (staff) {
      const access = await accessForUser(staff);
      await runWithAccess(access, () => Promise.all([Report.summary(), Report.byProject()]));
    }
  } catch (error) {
    console.warn("dashboard warmup skipped:", error.message);
  }
  console.log(`Database and dashboard warmed in ${Date.now() - warmStarted} ms`);
  // The pool is kept open for the life of the process, but a periodic probe
  // restores the connection (and warms the cache) after a database restart or
  // a network drop, so the next user never pays for it.
  const keepAlive = setInterval(() => {
    pool.query("SELECT 1").catch(() => { /* the pool reconnects on the next query */ });
  }, 30000);
  keepAlive.unref();
}
// Intentionally no seed() on startup — demo data is only inserted via `npm run seed`.
ensureUploadDirs();

function startServer(port = PORT) {
  return app.listen(port, () => {
    console.log(`MKUYU — Real Estate Management System running at http://localhost:${port}`);
    // One automatic database backup a day (see backups.js; AUTO_BACKUP=0 turns it off).
    startAutoBackups();
    // Payment reminders by e-mail (see payments/notices.js; needs SMTP in .env).
    startDueReminders();
    // Customer SMS: installment reminders and overdue notices (notify/customerNotices.js).
    startCustomerNotices();
    // Diaspora customers are asked for a new passport 30 days before it expires.
    startExpiryReminders();
  });
}

// Importing the app for integration tests must not unexpectedly claim a port.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) startServer();

export { app, startServer };
