// Who is typing right now in a diaspora conversation. Kept in memory only:
// a typing hint matters for a few seconds and is worth nothing after a restart.
const TTL_MS = 6000;
const seen = new Map(); // `${clientId}:${side}` -> time of the last keystroke report

export function setTyping(clientId, side) {
  seen.set(`${clientId}:${side}`, Date.now());
  if (seen.size > 2000) for (const [key, at] of seen) if (Date.now() - at > TTL_MS) seen.delete(key);
}

export function isTyping(clientId, side) {
  const at = seen.get(`${clientId}:${side}`);
  return Boolean(at) && Date.now() - at < TTL_MS;
}

export function clearTyping(clientId, side) {
  seen.delete(`${clientId}:${side}`);
}

export const REACTIONS = ["👍", "❤️", "😂", "😮", "🙏", "✅"];

/** A message can be edited for 15 minutes and withdrawn for everyone for 48 hours after it is sent. */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;
export const DELETE_ALL_WINDOW_MS = 48 * 60 * 60 * 1000;
