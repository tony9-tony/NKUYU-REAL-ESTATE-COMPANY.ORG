// Video calls between a diaspora customer and the Diaspora Desk.
//
// Each call is a private Jitsi room (free, no account for the guest) with a long
// random name. One side rings, the other answers in the portal / in the system,
// and both open the same room. Rooms are only ever shown to the two people
// involved. Set JITSI_URL in .env to use your own Jitsi server instead.
import crypto from "node:crypto";
import { query, queryOne } from "./db.js";

const RING_MS = 60 * 1000;
const MAX_CALL_MS = 3 * 60 * 60 * 1000;
const base = () => String(process.env.JITSI_URL || "https://meet.jit.si").trim().replace(/\/+$/, "");

export const newRoom = () => `MKUYU-${crypto.randomBytes(12).toString("hex")}`;
export const roomUrl = (room, name) => `${base()}/${room}#config.prejoinConfig.enabled=false&userInfo.displayName=${encodeURIComponent(JSON.stringify(String(name || "MKUYU")))}`;

/** The call that is still going on for this customer (ringing for a minute, active for 3 hours); stale ones are closed. */
export async function currentCall(clientId) {
  await query("UPDATE video_calls SET status='missed', ended_at=NOW() WHERE client_id=$1 AND status='ringing' AND created_at < NOW() - ($2 || ' milliseconds')::interval", [clientId, String(RING_MS)]);
  await query("UPDATE video_calls SET status='ended', ended_at=NOW() WHERE client_id=$1 AND status='active' AND answered_at < NOW() - ($2 || ' milliseconds')::interval", [clientId, String(MAX_CALL_MS)]);
  return queryOne("SELECT c.*, u.display_name AS staff_name FROM video_calls c LEFT JOIN users u ON u.id=c.staff_user_id WHERE c.client_id=$1 AND c.status IN ('ringing','active') ORDER BY c.id DESC LIMIT 1", [clientId]);
}

/** What a participant is shown. "side" is who is looking. */
export function callView(call, side, names) {
  if (!call) return null;
  return { id: call.id, by: call.started_by, status: call.status, mine: call.started_by === side, who: call.started_by === "staff" ? (call.staff_name || names.desk) : names.customer,
    url: roomUrl(call.room, side === "staff" ? names.desk : names.customer), at: call.created_at };
}
