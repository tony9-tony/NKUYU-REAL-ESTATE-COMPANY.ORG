// Outgoing SMS through a Tanzanian gateway, with no extra package (Node's own
// fetch). Settings in .env:
//
//   SMS_PROVIDER=log        (default) nothing leaves the server: each SMS is only
//                           written to notification_log as "test", so staff can
//                           see exactly what customers WOULD receive.
//   SMS_PROVIDER=nextsms    NEXTSMS_USERNAME / NEXTSMS_PASSWORD
//                           (NEXTSMS_TEST=1 uses NextSMS's free test endpoint)
//   SMS_PROVIDER=beem       BEEM_API_KEY / BEEM_SECRET_KEY
//   SMS_PROVIDER=off        no SMS at all, nothing logged
//   SMS_SENDER_ID=MKUYU     the registered sender name (TCRA)
//
// A provider chosen without its credentials falls back to "log", so a half-done
// setup can never fail payments or throw: sendSms() never throws.

const PROVIDERS = new Set(["log", "nextsms", "beem", "off"]);

export function smsSettings(env = process.env) {
  let provider = String(env.SMS_PROVIDER || "log").trim().toLowerCase();
  if (!PROVIDERS.has(provider)) provider = "log";
  let missing = null;
  if (provider === "nextsms" && !(env.NEXTSMS_USERNAME && env.NEXTSMS_PASSWORD)) missing = "NEXTSMS_USERNAME / NEXTSMS_PASSWORD";
  if (provider === "beem" && !(env.BEEM_API_KEY && env.BEEM_SECRET_KEY)) missing = "BEEM_API_KEY / BEEM_SECRET_KEY";
  return {
    requested: provider,
    provider: missing ? "log" : provider,
    missing,
    live: !missing && (provider === "nextsms" || provider === "beem"),
    enabled: provider !== "off",
    senderId: String(env.SMS_SENDER_ID || "MKUYU").trim().slice(0, 11) || "MKUYU",
    nextsmsTest: env.NEXTSMS_TEST === "1",
  };
}

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

async function postJson(url, headers, body, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { ok: response.ok, status: response.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends one SMS. `to` must already be 255XXXXXXXXX (see smsNumber()).
 * Returns { status: "sent" | "test" | "failed" | "off", error?, ref? }.
 */
export async function sendSms(to, text, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const settings = smsSettings(env);
  if (!settings.enabled) return { status: "off" };
  if (!/^255[67]\d{8}$/.test(String(to || ""))) return { status: "failed", error: "no valid Tanzanian mobile number" };
  if (!settings.live) return { status: "test", provider: "log" };
  try {
    if (settings.provider === "nextsms") {
      const url = settings.nextsmsTest
        ? "https://messaging-service.co.tz/api/sms/v1/test/text/single"
        : "https://messaging-service.co.tz/api/sms/v1/text/single";
      const reply = await postJson(url, { Authorization: basic(env.NEXTSMS_USERNAME, env.NEXTSMS_PASSWORD) },
        { from: settings.senderId, to, text }, fetchImpl);
      const message = reply.json?.messages?.[0];
      const group = message?.status?.groupName;
      if (!reply.ok || (group && /REJECTED|UNDELIVERABLE|EXPIRED/i.test(group))) {
        return { status: "failed", provider: "nextsms", error: `NextSMS ${reply.status}: ${message?.status?.description || reply.json?.message || reply.text.slice(0, 200)}` };
      }
      return { status: settings.nextsmsTest ? "test" : "sent", provider: "nextsms", ref: message?.messageId ? String(message.messageId) : null };
    }
    if (settings.provider === "beem") {
      const reply = await postJson("https://apisms.beem.africa/v1/send", { Authorization: basic(env.BEEM_API_KEY, env.BEEM_SECRET_KEY) },
        { source_addr: settings.senderId, encoding: 0, schedule_time: "", message: text, recipients: [{ recipient_id: 1, dest_addr: to }] }, fetchImpl);
      if (!reply.ok || reply.json?.successful === false) {
        return { status: "failed", provider: "beem", error: `Beem ${reply.status}: ${reply.json?.message || reply.text.slice(0, 200)}` };
      }
      return { status: "sent", provider: "beem", ref: reply.json?.request_id ? String(reply.json.request_id) : null };
    }
  } catch (error) {
    return { status: "failed", provider: settings.provider, error: error.name === "AbortError" ? "the SMS gateway did not answer in time" : error.message };
  }
  return { status: "failed", error: "unknown SMS provider" };
}
