// ---------------------------------------------------------------------------
// Live updates.
//
// Every signed-in screen keeps one open connection (Server-Sent Events) to
// GET /api/v1/live. Whenever something is changed - a website request
// arrives, a task is reported, a contract moves, a payment is recorded - the
// server tells the connected screens WHICH AREA changed (never the data
// itself); each screen then re-reads what it shows, through the normal
// permission-checked API, and redraws. Nobody has to refresh the page.
//
// A screen is only told about areas its user may open, so the stream reveals
// nothing about modules outside their role.
// ---------------------------------------------------------------------------
import { canReadModule, PATH_MODULES } from "./org/rbac.js";
import { hashToken } from "./auth.js";
import { queryOne } from "./db.js";

const clients = new Set();
const HEARTBEAT_MS = 25000;
const MAX_STREAMS_PER_USER = 10;

/** The area a write touched, from its path ("/contracts/12/transition" -> "contracts"). */
export function areaForPath(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  if (!parts.length) return null;
  if (parts[0] === "auth" || parts[0] === "profile") return null;
  if (parts[0] === "public") return "requests";            // a visitor's request, sell form or message
  if (parts[0] === "org") return parts[1] === "requests" || parts[1] === "leads" ? "requests" : parts[1] || "org";
  if (parts[0] === "contract-templates") return "contracts";
  return parts[0];
}

/** May this connection be told about `area`? */
function mayHear(access, area) {
  const module = PATH_MODULES[area];
  if (!module) return true; // tasks, requests, org: everyone may receive work
  return canReadModule(access, module);
}

export function liveStream(req, res) {
  // One person has a handful of tabs at most; refusing more keeps a script
  // from holding hundreds of open connections.
  const userId = req.user?.id;
  const open = [...clients].filter((client) => client.userId === userId).length;
  if (open >= MAX_STREAMS_PER_USER) return res.status(429).json({ error: "too many live connections" });
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders?.();
  res.write("retry: 5000\n\n");
  const client = { res, access: req.access, userId };
  clients.add(client);
  const tokenHash = req.token ? hashToken(req.token) : null;
  const close = () => { clearInterval(beat); clients.delete(client); };
  // The heartbeat also re-checks the session: after sign-out, a password reset,
  // a role change or deactivation the stream ends instead of living on with an
  // old picture of the person's access.
  const beat = setInterval(async () => {
    try {
      const alive = tokenHash && await queryOne(
        `SELECT 1 AS ok FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.active = TRUE`, [tokenHash]);
      if (!alive) { close(); res.end(); return; }
      res.write(": ping\n\n");
    } catch { /* closed or database hiccup: the next beat tries again */ }
  }, HEARTBEAT_MS);
  beat.unref?.();
  req.on("close", close);
}

export function broadcastChange(area) {
  if (!area || !clients.size) return;
  const payload = `event: change\ndata: ${JSON.stringify({ area, at: Date.now() })}\n\n`;
  for (const client of clients) {
    if (!mayHear(client.access, area)) continue;
    try { client.res.write(payload); } catch { clients.delete(client); }
  }
}

/** Express middleware: after every successful write, announce its area. */
export function announceWrites() {
  return (req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      // originalUrl: req.path is rewritten inside nested routers (/org/...).
      const path = String(req.originalUrl || req.url).split("?")[0].replace(/^\/api\/v1/, "");
      // "typing…" hints are sent every couple of seconds and change nothing stored: they must not refresh every open screen.
      if (!/\/typing$/.test(path)) res.on("finish", () => { if (res.statusCode < 400) broadcastChange(areaForPath(path)); });
    }
    next();
  };
}

export function liveClientCount() {
  return clients.size;
}
