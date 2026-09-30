import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runMigrations } from "./migrate.js";
import { ensureUploadDirs } from "./uploads.js";
import apiRoutes from "./routes/api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

const app = express();
const PORT = process.env.PORT || 3003;
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
  // The public website's API may be called from any origin (the public site is
  // served separately). It carries no credentials: reads return only what the
  // Sales Officer has published, and the only writes are a visitor's request
  // or enquiry, which become Leads.
  const url = String(request.originalUrl || request.url);
  const publicRead = ["GET", "HEAD", "OPTIONS"].includes(request.method) && url.startsWith("/api/v1/public/");
  const publicWrite = request.method === "POST" && /^\/api\/v1\/public\/(requests|enquiries)(\?|$)/.test(url);
  if (publicRead || publicWrite) {
    return callback(null, { origin: true, credentials: false });
  }
  const refused = new Error("origin is not allowed");
  refused.status = 403;
  return callback(refused);
}));
app.use(express.json({ limit: "1mb" }));

// Serve static frontend
const frontendDir = path.resolve(__dirname, "..", "..", "frontend");
app.use(express.static(frontendDir));

// API
app.use("/api/v1", apiRoutes);

app.use((error, req, res, next) => {
  if (req.path.startsWith("/api")) {
    const status = error.status || 500;
    return res.status(status).json({ error: status >= 500 ? "internal server error" : error.message });
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
  });
}

// Importing the app for integration tests must not unexpectedly claim a port.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) startServer();

export { app, startServer };
