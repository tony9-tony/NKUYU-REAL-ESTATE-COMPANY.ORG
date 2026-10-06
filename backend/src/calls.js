// Video calls between a diaspora customer and the Diaspora Desk.
//
// Each call is a private Jitsi room (free, no account for the guest) with a long
// random name. One side rings, the other answers in the portal / in the system,
// and both open the same room. Rooms are only ever shown to the two people
// involved. Set JITSI_URL in .env to use your own Jitsi server instead.
import crypto from "node:crypto";
import { query, queryOne } from "./db.js";
import { broadcastChange } from "./live.js";

const RING_MS = 60 * 1000;
const MAX_CALL_MS = 3 * 60 * 60 * 1000;
const base = () => String(process.env.JITSI_URL || "https://meet.jit.si").trim().replace(/\/+$/, "");

export const newRoom = () => `MKUYU-${crypto.randomBytes(12).toString("hex")}`;
export const roomUrl = (room, name) => `${base()}/${room}#config.prejoinConfig.enabled=false&userInfo.displayName=${encodeURIComponent(JSON.stringify(String(name || "MKUYU")))}`;

/**
 * Closes a call and leaves one line in the chat: how long it lasted, or that it was
 * missed / declined. `clientId` limits it to that customer's calls (customer side);
 * `decline` says the person being called refused it.
 */
export async function finishCall(callId, { clientId = null, decline = false } = {}) {
  const call = await queryOne("SELECT * FROM video_calls WHERE id=$1 AND status IN ('ringing','active') AND ($2::int IS NULL OR client_id=$2)", [callId, clientId]);
  if (!call) return false;
  const outcome = call.status === "active" ? "ended" : decline ? "declined" : "missed";
  const done = await query("UPDATE video_calls SET status=$2, ended_at=NOW() WHERE id=$1 AND status=$3 RETURNING id", [call.id, outcome, call.status]);
  if (!done.rows.length) return false;
  const minutes = call.answered_at ? Math.max(1, Math.round((Date.now() - new Date(call.answered_at).getTime()) / 60000)) : 0;
  const body = outcome === "ended" ? `📹 Video call · ${minutes} min` : outcome === "declined" ? "📹 Video call declined" : "📹 Missed video call";
  await query("INSERT INTO customer_messages (client_id, sender, staff_user_id, body) VALUES ($1,$2,$3,$4)", [call.client_id, call.started_by, call.started_by === "staff" ? call.staff_user_id : null, body]);
  broadcastChange("diaspora");
  return true;
}

/** The call that is still going on for this customer (ringing for a minute, active for 3 hours); stale ones are closed. */
export async function currentCall(clientId) {
  const stale = (await query(
    `SELECT id FROM video_calls WHERE client_id=$1 AND ((status='ringing' AND created_at < NOW() - ($2 || ' milliseconds')::interval) OR (status='active' AND answered_at < NOW() - ($3 || ' milliseconds')::interval))`,
    [clientId, String(RING_MS), String(MAX_CALL_MS)])).rows;
  for (const row of stale) await finishCall(row.id);
  return queryOne("SELECT c.*, u.display_name AS staff_name FROM video_calls c LEFT JOIN users u ON u.id=c.staff_user_id WHERE c.client_id=$1 AND c.status IN ('ringing','active') ORDER BY c.id DESC LIMIT 1", [clientId]);
}

/** Customers ringing the desk right now (for the desk's banner on any page). */
export async function callsRingingDesk(orgId, deskName) {
  const rows = (await query(
    `SELECT v.id, v.room, v.client_id, c.name AS client_name FROM video_calls v JOIN clients c ON c.id=v.client_id
      WHERE v.status='ringing' AND v.started_by='customer' AND c.organization_id=$1 AND v.created_at > NOW() - ($2 || ' milliseconds')::interval ORDER BY v.id DESC LIMIT 5`, [orgId, String(RING_MS)])).rows;
  return rows.map((r) => ({ id: r.id, client_id: r.client_id, client_name: r.client_name, url: roomUrl(r.room, deskName) }));
}

/** What a participant is shown. "side" is who is looking. */
export function callView(call, side, names) {
  if (!call) return null;
  return { id: call.id, by: call.started_by, status: call.status, mine: call.started_by === side, who: call.started_by === "staff" ? (call.staff_name || names.desk) : names.customer,
    url: roomUrl(call.room, side === "staff" ? names.desk : names.customer), at: call.created_at };
}
