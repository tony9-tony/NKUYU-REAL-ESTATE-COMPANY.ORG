// Customer SMS notices: wording, phone numbers, stages, listing rules and the
// gateway calls. No database and no network (the gateway is a fake fetch), so
// it runs anywhere: `npm run test:notices`.
import assert from "node:assert/strict";
import { smsText, emailText, smsNumber, money, shortDate, dueSoonStage, overdueStage, parseOffsets, inQuietHours, listingAnnouncement, smsParts } from "./backend/src/notify/messages.js";
import { sendSms, smsSettings } from "./backend/src/notify/sms.js";

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed += 1; console.log(`ok  ${name}`); } catch (error) { console.error(`FAIL ${name}\n     ${error.message}`); process.exitCode = 1; } };

await test("phone numbers become 255XXXXXXXXX", () => {
  assert.equal(smsNumber("0712 345 678"), "255712345678");
  assert.equal(smsNumber("+255 754-123-456"), "255754123456");
  assert.equal(smsNumber("255683000111"), "255683000111");
  assert.equal(smsNumber("712345678"), "255712345678");
  assert.equal(smsNumber("+254712345678"), null, "a Kenyan number is not texted");
  assert.equal(smsNumber("0222123456"), null, "a landline is not texted");
  assert.equal(smsNumber(""), null);
});

await test("money and dates", () => {
  assert.equal(money(1250000), "TZS 1,250,000");
  assert.equal(money("500000.40"), "TZS 500,000");
  assert.equal(shortDate("2026-11-05"), "05/11/2026");
});

await test("payment received: amount, receipt, balance, next installment", () => {
  const text = smsText("payment_received", { contract: "MK-C-000012", amount: 500000, receipt: "RCT-2026-000031", balance: 4500000, next: { amount: 500000, due_date: "2026-11-05" } }, "sw");
  assert.match(text, /^MKUYU: Tumepokea malipo yako ya TZS 500,000 \(Risiti RCT-2026-000031\) kwa mkataba MK-C-000012\./);
  assert.match(text, /Salio: TZS 4,500,000\./);
  assert.match(text, /Awamu ijayo: TZS 500,000 tarehe 05\/11\/2026\./);
  assert.equal(smsParts(text), 1, `one SMS, not ${text.length} characters`);
});

await test("fully paid congratulates by first name", () => {
  const text = smsText("fully_paid", { name: "Asha Juma Mrisho", contract: "MK-C-000012", property: "Villa 4, Kigamboni", total: 85000000 }, "sw");
  assert.match(text, /Hongera Asha!/);
  assert.match(text, /TZS 85,000,000/);
});

await test("due soon: days left, and TODAY", () => {
  assert.match(smsText("due_soon", { contract: "MK-C-1", amount: 300000, due_date: "2026-10-12", days: 7 }, "sw"), /tarehe 12\/10\/2026, siku 7 zijazo\./);
  assert.match(smsText("due_soon", { contract: "MK-C-1", amount: 300000, due_date: "2026-10-05", days: 0 }, "sw"), /LEO 05\/10\/2026/);
  assert.match(smsText("due_soon", { contract: "MK-C-1", amount: 300000, due_date: "2026-10-06", days: 1 }, "en"), /in 1 day\./);
  assert.equal(smsParts(smsText("due_soon", { contract: "MK-C-000012", amount: 12500000, due_date: "2026-10-12", days: 7 }, "sw")), 1, "a reminder is one SMS");
});

await test("overdue names the contact phone when set", () => {
  assert.match(smsText("overdue", { contract: "MK-C-9", amount: 1200000, days: 14, phone: "0712 000 000" }, "sw"), /limechelewa siku 14\. Tafadhali lipa mapema au piga 0712 000 000\./);
  assert.match(smsText("overdue", { contract: "MK-C-9", amount: 1200000, days: 1 }, "en"), /1 day late\. Please pay soon or contact us\./);
});

await test("new listing: sale vs rent, link, stop line", () => {
  const sale = smsText("new_listing", { property: "Masaki Apartment 3B", location: "Masaki", service: "buy", price: 450000000, link: "https://mkuyu.co.tz/property.html?id=7" }, "sw");
  assert.match(sale, /Inauzwa sasa! Masaki Apartment 3B, Masaki\. Bei: TZS 450,000,000\. https:\/\/mkuyu\.co\.tz\/property\.html\?id=7/);
  assert.match(sale, /Kuacha kupokea matangazo/);
  assert.match(smsText("new_listing", { property: "Flat 2", service: "rent", price: 900000, period: "month" }, "sw"), /Inapangishwa sasa!.*kwa mwezi/);
  assert.ok(smsParts(smsText("new_listing", { property: "X".repeat(200), location: "Y".repeat(200), service: "buy", price: 1, link: "https://mkuyu.co.tz/property.html?id=123456" }, "sw")) <= 2, "long names are clipped");
});

await test("e-mail copy has a greeting and no company prefix", () => {
  const mail = emailText("fully_paid", { company: "MKUYU", name: "Asha Juma", contract: "MK-C-1", total: 10 }, "sw");
  assert.equal(mail.subject, "MKUYU: Umekamilisha malipo yote");
  assert.match(mail.text, /^Ndugu Asha Juma,\n\nHongera Asha!/);
});

await test("due-soon stage: one per window, never every missed one", () => {
  const offsets = [7, 3, 0];
  assert.equal(dueSoonStage(7, offsets), 7);
  assert.equal(dueSoonStage(5, offsets), 7);
  assert.equal(dueSoonStage(3, offsets), 3);
  assert.equal(dueSoonStage(2, offsets), 3);
  assert.equal(dueSoonStage(0, offsets), 0);
  assert.equal(dueSoonStage(8, offsets), null);
  assert.equal(dueSoonStage(-1, offsets), null);
});

await test("overdue stage: 1, 7, 14, 30, then monthly", () => {
  const offsets = [1, 7, 14, 30];
  assert.equal(overdueStage(0, offsets), null);
  assert.equal(overdueStage(1, offsets), "d1");
  assert.equal(overdueStage(6, offsets), "d1");
  assert.equal(overdueStage(7, offsets), "d7");
  assert.equal(overdueStage(29, offsets), "d14");
  assert.equal(overdueStage(30, offsets), "d30");
  assert.equal(overdueStage(59, offsets), "d30");
  assert.equal(overdueStage(60, offsets), "m60");
  assert.equal(overdueStage(95, offsets), "m90");
});

await test("offsets and quiet hours", () => {
  assert.deepEqual(parseOffsets("7, 3,0,x,-1", [1]), [7, 3, 0]);
  assert.deepEqual(parseOffsets("", [1, 7]), [1, 7]);
  assert.equal(inQuietHours(21, "20-8"), true);
  assert.equal(inQuietHours(3, "20-8"), true);
  assert.equal(inQuietHours(8, "20-8"), false);
  assert.equal(inQuietHours(14, "20-8"), false);
  assert.equal(inQuietHours(14, "off"), false);
});

await test("listing announcement only when a listing newly opens", () => {
  const open = { public_listing: true, public_listing_status: "approved", offer_buy: true, sale_status: "available" };
  assert.equal(listingAnnouncement({}, open), "buy", "new and published");
  assert.equal(listingAnnouncement({ ...open, public_listing: false }, open), "buy", "just published");
  assert.equal(listingAnnouncement(open, { ...open, price: 2 }), null, "a plain edit announces nothing");
  assert.equal(listingAnnouncement({ ...open, sale_status: "reserved" }, open), "buy", "available again after a cancelled sale");
  assert.equal(listingAnnouncement({}, { ...open, public_listing: false }), null, "not published");
  assert.equal(listingAnnouncement({}, { ...open, sale_status: "sold" }), null, "sold");
  const rent = { public_listing: true, public_listing_status: "approved", offer_rent: true, rent_status: "available" };
  assert.equal(listingAnnouncement({}, rent), "rent");
  assert.equal(listingAnnouncement({ ...rent, rent_status: "rented" }, rent), "rent");
});

await test("settings: no account means test mode, never an error", () => {
  assert.equal(smsSettings({}).provider, "log");
  assert.equal(smsSettings({}).live, false);
  const half = smsSettings({ SMS_PROVIDER: "nextsms", NEXTSMS_USERNAME: "u" });
  assert.equal(half.provider, "log");
  assert.match(half.missing, /NEXTSMS_PASSWORD/);
  assert.equal(smsSettings({ SMS_PROVIDER: "off" }).enabled, false);
  assert.equal(smsSettings({ SMS_SENDER_ID: "MKUYU-REAL-ESTATE" }).senderId.length, 11);
});

const fakeFetch = (reply, seen) => async (url, options) => {
  seen.push({ url, options, body: JSON.parse(options.body) });
  return { ok: reply.ok !== false, status: reply.status || 200, text: async () => JSON.stringify(reply.json) };
};

await test("log mode sends nothing", async () => {
  const seen = [];
  const result = await sendSms("255712345678", "hi", { env: {}, fetchImpl: fakeFetch({ json: {} }, seen) });
  assert.equal(result.status, "test");
  assert.equal(seen.length, 0);
});

await test("NextSMS: URL, basic auth, body", async () => {
  const seen = [];
  const env = { SMS_PROVIDER: "nextsms", NEXTSMS_USERNAME: "mkuyu", NEXTSMS_PASSWORD: "secret", SMS_SENDER_ID: "MKUYU" };
  const result = await sendSms("255712345678", "Habari", { env, fetchImpl: fakeFetch({ json: { messages: [{ to: "255712345678", status: { groupName: "PENDING" }, messageId: 99 }] } }, seen) });
  assert.equal(result.status, "sent");
  assert.equal(result.ref, "99");
  assert.equal(seen[0].url, "https://messaging-service.co.tz/api/sms/v1/text/single");
  assert.equal(seen[0].options.headers.Authorization, `Basic ${Buffer.from("mkuyu:secret").toString("base64")}`);
  assert.deepEqual(seen[0].body, { from: "MKUYU", to: "255712345678", text: "Habari" });
});

await test("NextSMS test endpoint and a rejected message", async () => {
  const seen = [];
  const env = { SMS_PROVIDER: "nextsms", NEXTSMS_USERNAME: "u", NEXTSMS_PASSWORD: "p", NEXTSMS_TEST: "1" };
  const ok = await sendSms("255712345678", "x", { env, fetchImpl: fakeFetch({ json: { messages: [{ status: { groupName: "PENDING" } }] } }, seen) });
  assert.equal(ok.status, "test");
  assert.match(seen[0].url, /\/test\/text\/single$/);
  const bad = await sendSms("255712345678", "x", { env, fetchImpl: fakeFetch({ json: { messages: [{ status: { groupName: "REJECTED", description: "Not enough credits" } }] } }, []) });
  assert.equal(bad.status, "failed");
  assert.match(bad.error, /Not enough credits/);
});

await test("Beem: body shape and HTTP failure", async () => {
  const seen = [];
  const env = { SMS_PROVIDER: "beem", BEEM_API_KEY: "k", BEEM_SECRET_KEY: "s" };
  const ok = await sendSms("255754000111", "Habari", { env, fetchImpl: fakeFetch({ json: { successful: true, request_id: 5 } }, seen) });
  assert.equal(ok.status, "sent");
  assert.equal(seen[0].url, "https://apisms.beem.africa/v1/send");
  assert.deepEqual(seen[0].body.recipients, [{ recipient_id: 1, dest_addr: "255754000111" }]);
  assert.equal(seen[0].body.source_addr, "MKUYU");
  const bad = await sendSms("255754000111", "x", { env, fetchImpl: fakeFetch({ ok: false, status: 401, json: { message: "Invalid api key" } }, []) });
  assert.equal(bad.status, "failed");
  assert.match(bad.error, /401.*Invalid api key/);
});

await test("a gateway that throws is a failed SMS, not a crash", async () => {
  const env = { SMS_PROVIDER: "beem", BEEM_API_KEY: "k", BEEM_SECRET_KEY: "s" };
  const result = await sendSms("255754000111", "x", { env, fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); } });
  assert.equal(result.status, "failed");
  assert.match(result.error, /ENOTFOUND/);
  assert.equal((await sendSms("0712", "x", { env })).status, "failed", "bad number");
  assert.equal((await sendSms("255712345678", "x", { env: { SMS_PROVIDER: "off" } })).status, "off");
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
