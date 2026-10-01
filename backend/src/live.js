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

const clients = new Set();
const HEARTBEAT_MS = 25000;

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
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders?.();
  res.write("retry: 5000\n\n");
  const client = { res, access: req.access };
  clients.add(client);
  const beat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, HEARTBEAT_MS);
  beat.unref?.();
  req.on("close", () => { clearInterval(beat); clients.delete(client); });
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
      res.on("finish", () => { if (res.statusCode < 400) broadcastChange(areaForPath(path)); });
    }
    next();
  };
}

export function liveClientCount() {
  return clients.size;
}
