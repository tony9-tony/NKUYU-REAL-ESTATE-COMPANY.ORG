// Owner selling test: the owner listing steps are enforced by the server.
//   - the stages go in order and none can be skipped
//   - only Legal (Legal Officer) marks the title and documents checked
//   - the Managing Director signs EVERY sell mandate, never one they agreed
//   - every offer is presented in writing before the owner's decision
//   - 7 days without an owner update = overdue (and a reminder task)
// Run: npm run test:owner-listings
import { query, queryOne, closeDatabase } from "./backend/src/db.js";
import { assertTestDatabase, startIsolatedServer } from "./test_support/harness.mjs";
import { runMigrations } from "./backend/src/migrate.js";
import { hashPassword } from "./backend/src/auth.js";
import {
  OWNER_LISTING_STAGES, OWNER_UPDATE_DAYS, STANDARD_COMMISSION_SETTING,
  canMoveListing, commissionBelowStandard, isUpdateOverdue, listingActionsFor,
} from "./backend/src/sales/ownerListing.js";
import { chaseOverdueOwnerUpdates } from "./backend/src/sales/ownerListingStore.js";

await assertTestDatabase("owner_listing_test");
// The test drives the reminder itself, so the server's own timer stays off.
process.env.HANDOFF_WATCH = "0";

const PASSWORD = "OwnerListing123!";
const stamp = Date.now();
let failures = 0;
const check = (condition, label) => {
  if (condition) console.log(`ok    ${label}`);
  else { failures += 1; console.log(`FAIL  ${label}`); }
};
const section = (title) => console.log(`\n=== ${title} ===`);

// ---- 1. The rules on their own --------------------------------------------------
section("1. stage order and the 7-day rule (pure rules)");
check(OWNER_LISTING_STAGES.join(",") === "received,visit_booked,valued,documents_checked,mandate_signed,listed,under_offer,sold,withdrawn", "the stages are in the agreed order");
for (let i = 0; i < 7; i += 1) {
  check(canMoveListing(OWNER_LISTING_STAGES[i], OWNER_LISTING_STAGES[i + 1]), `${OWNER_LISTING_STAGES[i]} -> ${OWNER_LISTING_STAGES[i + 1]} is allowed`);
}
check(!canMoveListing("received", "valued"), "a valuation cannot skip the visit");
check(!canMoveListing("valued", "mandate_signed"), "a mandate cannot skip the Legal check");
check(!canMoveListing("documents_checked", "listed"), "a listing cannot skip the MD's signature");
check(!canMoveListing("listed", "sold"), "a sale needs an accepted offer first");
check(!canMoveListing("sold", "withdrawn") && !canMoveListing("withdrawn", "received"), "sold and withdrawn are final");
check(!listingActionsFor({ stage: "valued" }, 1, { canManage: true }).includes("check_documents"), "the Property Officer is never offered the document check");
check(listingActionsFor({ stage: "valued" }, 1, { canCheck: true }).includes("check_documents"), "Legal is offered the document check");
check(!listingActionsFor({ stage: "documents_checked", mandate_status: "awaiting_md", mandate_agreed_by: 7 }, 7, { canManage: true, canSign: true }).includes("sign_mandate"), "nobody is offered to sign a mandate they agreed");
check(commissionBelowStandard(2.5, 3) && !commissionBelowStandard(3, 3), "commission below the standard rate is flagged");
const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();
check(OWNER_UPDATE_DAYS === 7, "the update rule is 7 days");
check(!isUpdateOverdue({ stage: "listed", created_at: daysAgo(6.5) }), "6 days without an update is not yet overdue");
check(isUpdateOverdue({ stage: "listed", created_at: daysAgo(7.1) }), "7 days without an update is overdue");
check(!isUpdateOverdue({ stage: "listed", created_at: daysAgo(30), last_update_at: daysAgo(2) }), "a recent update clears it");
check(!isUpdateOverdue({ stage: "sold", created_at: daysAgo(30) }), "a sold listing is never overdue");

// ---- 2. The real API ----------------------------------------------------------
await runMigrations({ seedDemo: false });
const org = (await queryOne("SELECT id FROM organizations ORDER BY id LIMIT 1")).id;
const PEOPLE = [
  { key: "officer", role: "Property Officer", department: "SALES, MARKETING & OPERATIONS" },
  { key: "officer2", role: "Property Officer", department: "SALES, MARKETING & OPERATIONS" },
  { key: "sales", role: "Sales Officer", department: "SALES, MARKETING & OPERATIONS" },
  { key: "manager", role: "Department Manager", department: "SALES, MARKETING & OPERATIONS" },
  { key: "legal", role: "Legal Officer", department: "LEGAL" },
  { key: "legal_manager", role: "Legal Manager", department: "LEGAL" },
  { key: "director", role: "Managing Director", department: "MANAGEMENT" },
];
const users = {};
for (const person of PEOPLE) {
  const email = `owner.${person.key}.${stamp}@mkuyu.local`;
  const user = await queryOne("INSERT INTO users (organization_id,email,password_hash,display_name,role) VALUES ($1,$2,$3,$4,'staff') RETURNING id", [org, email, hashPassword(PASSWORD), `Owner Test ${person.key} ${stamp}`]);
  const role = await queryOne("SELECT id FROM roles WHERE organization_id=$1 AND name=$2", [org, person.role]);
  const department = await queryOne("SELECT id FROM departments WHERE organization_id=$1 AND name=$2", [org, person.department]);
  await query("INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)", [user.id, role.id]);
  await query("INSERT INTO user_departments (user_id, department_id) VALUES ($1,$2)", [user.id, department.id]);
  users[person.key] = { id: user.id, email };
}
const adminEmail = `owner.admin.${stamp}@mkuyu.local`;
const admin = await queryOne("INSERT INTO users (organization_id,email,password_hash,display_name,role) VALUES ($1,$2,$3,$4,'admin') RETURNING id", [org, adminEmail, hashPassword(PASSWORD), `Owner Test admin ${stamp}`]);
users.admin = { id: admin.id, email: adminEmail };
const savedSetting = await queryOne("SELECT setting_value FROM settings WHERE organization_id=$1 AND setting_key=$2", [org, STANDARD_COMMISSION_SETTING]);

const server = await startIsolatedServer({ port: Number(process.env.OWNER_TEST_PORT || 3196), label: "owner_listing_test" });
const tokens = {};
async function call(path, { as, method = "GET", body } = {}) {
  const headers = { Authorization: `Bearer ${tokens[as]}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${server.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (response.status >= 500) console.log(`  HTTP ${response.status} ${method} ${path}`, JSON.stringify(payload));
  return { status: response.status, body: payload };
}
const ymd = (offsetDays = 0) => { const d = new Date(Date.now() + offsetDays * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

try {
  for (const [key, user] of Object.entries(users)) {
    const res = await fetch(`${server.base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: user.email, password: PASSWORD }) });
    tokens[key] = (await res.json()).token;
  }
  const L = "/org/owner-listings";
  const newListing = async (as, name, extra = {}) => call(L, { as, method: "POST", body: { owner_name: `Owner Test ${name} ${stamp}`, owner_phone: "+255700000001", property_type: "House", location: "Mbezi, Dar es Salaam", ...extra } });

  section("2. who may see owner listings");
  check((await call(L, { as: "sales" })).status === 403, "a Sales Officer cannot open owner listings");
  check((await call(L, { as: "admin" })).status === 403, "the administrator account holds no owner-listing business");
  check((await call(L, { as: "officer" })).status === 200, "the Property Officer can");
  check((await call(L, { as: "legal" })).status === 200, "Legal can (to check titles)");
  check((await call(L, { as: "director" })).status === 200, "the MD can");
  check((await newListing("legal", "ByLegal")).status === 403, "Legal cannot open a listing");

  section("3. the stages go in order");
  let res = await newListing("officer", "One");
  check(res.status === 201 && res.body.stage === "received", "the Property Officer opens a listing at Received");
  check(Number(res.body.officer_id) === users.officer.id, "the officer who opened it is its Property Officer");
  const one = res.body.id;
  res = await call(`${L}/${one}/valuation`, { as: "officer", method: "POST", body: { price_low: 100000000, price_high: 120000000, note: "Good house", visit_date: ymd() } });
  check(res.status === 409, "a valuation before the visit is refused");
  res = await call(`${L}/${one}/visit`, { as: "officer", method: "POST", body: { visit_at: `${ymd(1)}T10:00` } });
  check(res.status === 200 && res.body.stage === "visit_booked", "the visit is booked");
  res = await call(`${L}/${one}/documents`, { as: "legal", method: "POST", body: { title_deed_number: "CT-1", owner_identity_confirmed: true, owner_authority_confirmed: true } });
  check(res.status === 409, "Legal cannot check documents before the valuation");
  res = await call(`${L}/${one}/valuation`, { as: "officer", method: "POST", body: { price_low: 130000000, price_high: 120000000, note: "x", visit_date: ymd() } });
  check(res.status === 400, "a price range with high below low is refused");
  res = await call(`${L}/${one}/valuation`, { as: "officer", method: "POST", body: { price_low: 100000000, price_high: 120000000, note: "Three bedrooms, good roads, title in owner's name.", visit_date: ymd() } });
  check(res.status === 200 && res.body.stage === "valued" && Number(res.body.price_high) === 120000000, "the valuation records the range and moves to Valued");
  res = await call(`${L}/${one}/mandate`, { as: "officer", method: "POST", body: { mandate_price: 115000000, commission_percent: 3, mandate_end_date: ymd(90) } });
  check(res.status === 409, "no mandate before Legal has checked the documents");

  section("4. only Legal marks the documents checked");
  const docs = { title_deed_number: `CT-${stamp}`, owner_identity_confirmed: true, owner_authority_confirmed: true, note: "Checked at the Land Registry." };
  check((await call(`${L}/${one}/documents`, { as: "officer", method: "POST", body: docs })).status === 403, "the Property Officer cannot mark the documents checked");
  check((await call(`${L}/${one}/documents`, { as: "manager", method: "POST", body: docs })).status === 403, "the Sales Department Manager cannot either");
  check((await call(`${L}/${one}/documents`, { as: "director", method: "POST", body: docs })).status === 403, "the MD cannot either");
  check((await call(`${L}/${one}/documents`, { as: "legal_manager", method: "POST", body: docs })).status === 403, "the Legal Manager cannot (Legal Officer only, as designed)");
  res = await call(`${L}/${one}/documents`, { as: "legal", method: "POST", body: { ...docs, owner_authority_confirmed: false } });
  check(res.status === 400, "the step is refused unless identity AND authority to sell are confirmed");
  res = await call(`${L}/${one}/documents`, { as: "legal", method: "POST", body: docs });
  check(res.status === 200 && res.body.stage === "documents_checked" && res.body.title_deed_number === docs.title_deed_number, "the Legal Officer records the title deed and moves it to Documents checked");
  check(Number(res.body.documents_checked_by) === users.legal.id, "the check records who did it");

  section("5. the MD signs every sell mandate");
  res = await call(`${L}/${one}/mandate`, { as: "officer", method: "POST", body: { mandate_price: 115000000, commission_percent: 3, mandate_end_date: ymd(90) } });
  check(res.status === 200 && res.body.mandate_status === "awaiting_md" && res.body.stage === "documents_checked", "a mandate at the standard rate still waits for the MD");
  check(res.body.commission_below_standard === false, "3% is the standard rate");
  check((await call(`${L}/${one}/listed`, { as: "officer", method: "POST", body: {} })).status === 409, "an unsigned mandate cannot be listed");
  check((await call(`${L}/${one}/mandate/sign`, { as: "officer", method: "POST" })).status === 403, "the Property Officer cannot sign the mandate");
  check((await call(`${L}/${one}/mandate/sign`, { as: "manager", method: "POST" })).status === 403, "the Sales Department Manager cannot sign it");
  res = await call(`${L}/${one}/mandate/sign`, { as: "director", method: "POST" });
  check(res.status === 200 && res.body.stage === "mandate_signed" && res.body.mandate_status === "signed" && Number(res.body.mandate_signed_by) === users.director.id, "the MD signs it and the listing moves to Mandate signed");

  res = await newListing("officer", "Two");
  const two = res.body.id;
  await call(`${L}/${two}/visit`, { as: "officer", method: "POST", body: { visit_at: `${ymd(1)}T09:00` } });
  await call(`${L}/${two}/valuation`, { as: "officer", method: "POST", body: { price_low: 50000000, price_high: 60000000, note: "Plot", visit_date: ymd() } });
  await call(`${L}/${two}/documents`, { as: "legal", method: "POST", body: docs });
  res = await call(`${L}/${two}/mandate`, { as: "officer", method: "POST", body: { mandate_price: 58000000, commission_percent: 2, mandate_end_date: ymd(60) } });
  check(res.status === 200 && res.body.commission_below_standard === true, "a 2% commission is flagged below the standard rate");
  res = await call(`${L}/${two}/mandate/return`, { as: "director", method: "POST", body: { reason: "2% is too low; agree 3%." } });
  check(res.status === 200 && res.body.mandate_status === "returned", "the MD can send a mandate back with a reason");
  res = await call(`${L}/${two}/mandate`, { as: "director", method: "POST", body: { mandate_price: 58000000, commission_percent: 2.5, mandate_end_date: ymd(60) } });
  check(res.status === 200 && Number(res.body.mandate_agreed_by) === users.director.id, "the MD may agree a mandate with an owner");
  res = await call(`${L}/${two}/mandate/sign`, { as: "director", method: "POST" });
  check(res.status === 409, "but nobody signs a mandate they agreed themselves");
  check(!res.body.available_actions, "the refusal is an error, not a signed listing");

  section("6. offers are presented in writing before the owner decides");
  res = await call(`${L}/${one}/offers`, { as: "officer", method: "POST", body: { buyer_name: "Buyer A", amount: 100000000 } });
  check(res.status === 409, "offers wait until the property is listed");
  res = await call(`${L}/${one}/listed`, { as: "officer", method: "POST", body: {} });
  check(res.status === 200 && res.body.stage === "listed", "the signed listing is listed");
  res = await call(`${L}/${one}/offers`, { as: "officer", method: "POST", body: { buyer_name: "Buyer A", buyer_phone: "+255711000000", amount: 100000000, offered_on: ymd() } });
  check(res.status === 201, "the Property Officer records an offer");
  let detail = await call(`${L}/${one}`, { as: "officer" });
  const offerA = detail.body.offers?.[0];
  check(offerA && offerA.available_actions.includes("present_offer"), "a new offer must be presented first");
  res = await call(`${L}/${one}/offers/${offerA.id}/decision`, { as: "officer", method: "POST", body: { decision: "accepted" } });
  check(res.status === 409, "no decision before the offer is presented to the owner");
  res = await call(`${L}/${one}/offers/${offerA.id}/present`, { as: "officer", method: "POST", body: { presented_how: "phone" } });
  check(res.status === 400, "a phone call does not count as presenting in writing");
  res = await call(`${L}/${one}/offers/${offerA.id}/present`, { as: "officer", method: "POST", body: { presented_how: "whatsapp", presented_on: ymd() } });
  check(res.status === 200, "the offer is presented by WhatsApp");
  res = await call(`${L}/${one}/offers/${offerA.id}/decision`, { as: "officer", method: "POST", body: { decision: "countered", decision_date: ymd() } });
  check(res.status === 400, "a counter needs the owner's counter price");
  res = await call(`${L}/${one}/offers/${offerA.id}/decision`, { as: "officer", method: "POST", body: { decision: "accepted", decision_date: ymd() } });
  check(res.status === 200 && res.body.stage === "under_offer", "the owner accepts and the listing moves to Under offer");
  await call(`${L}/${one}/offers`, { as: "officer", method: "POST", body: { buyer_name: "Buyer B", amount: 105000000 } });
  detail = await call(`${L}/${one}`, { as: "officer" });
  const offerB = detail.body.offers.find((offer) => offer.buyer_name === "Buyer B");
  await call(`${L}/${one}/offers/${offerB.id}/present`, { as: "officer", method: "POST", body: { presented_how: "email" } });
  res = await call(`${L}/${one}/offers/${offerB.id}/decision`, { as: "officer", method: "POST", body: { decision: "accepted" } });
  check(res.status === 409, "a second offer cannot be accepted while one stands");
  res = await call(`${L}/${one}/sold`, { as: "officer", method: "POST", body: {} });
  check(res.status === 200 && res.body.stage === "sold" && Number(res.body.sold_price) === 100000000, "the sale is recorded at the accepted price");

  section("7. weekly owner update: 7 days = overdue");
  res = await newListing("officer", "Three");
  const three = res.body.id;
  await query("UPDATE owner_listings SET created_at = NOW() - INTERVAL '6 days' WHERE id=$1", [three]);
  let list = await call(`${L}?active=1`, { as: "officer" });
  check(list.body.find((row) => row.id === three)?.update_overdue === false, "6 days without an update: not overdue");
  await query("UPDATE owner_listings SET created_at = NOW() - INTERVAL '8 days' WHERE id=$1", [three]);
  list = await call(`${L}?overdue=1`, { as: "officer" });
  check(list.body.some((row) => row.id === three && row.update_overdue && row.days_since_update >= 7), "8 days without an update: overdue");
  let summary = await call(`${L}/summary`, { as: "officer" });
  check(summary.body.mine_overdue >= 1, "it counts on the Property Officer's \"Your work today\"");
  check((await call(`${L}/summary`, { as: "officer2" })).body.mine_overdue === 0, "another officer's own count is separate");
  summary = await call(`${L}/summary`, { as: "director" });
  check(summary.body.overdue >= 1, "the MD sees the overdue count");
  const before = (await call("/org/tasks/attention", { as: "officer" })).body.mine || 0;
  await chaseOverdueOwnerUpdates();
  const reminder = await queryOne("SELECT t.* FROM owner_listings o JOIN tasks t ON t.id=o.reminder_task_id WHERE o.id=$1", [three]);
  check(reminder && reminder.priority === "urgent" && Number(reminder.assigned_to) === users.officer.id, "the reminder is an urgent task for the Property Officer (same pattern as hand-off reminders)");
  check(((await call("/org/tasks/attention", { as: "officer" })).body.mine || 0) === before + 1, "it shows on the officer's Assignments badge");
  await chaseOverdueOwnerUpdates();
  check(Number((await queryOne("SELECT COUNT(*)::int AS n FROM tasks WHERE title LIKE $1", [`%Owner Test Three ${stamp}%`])).n) === 1, "running the reminder again does not create a second task");
  check((await call(`${L}/${three}/updates`, { as: "legal", method: "POST", body: { channel: "phone", note: "x" } })).status === 403, "only owner-listing staff log updates");
  check((await call(`${L}/${three}/updates`, { as: "officer", method: "POST", body: { channel: "pigeon", note: "x" } })).status === 400, "the channel must be a real one");
  res = await call(`${L}/${three}/updates`, { as: "officer", method: "POST", body: { channel: "whatsapp", note: "Two viewings booked this week.", sent_on: ymd() } });
  check(res.status === 201 && res.body.update_overdue === false && res.body.days_since_update === 0, "logging an update clears overdue");
  const closed = await queryOne("SELECT status FROM tasks WHERE id=$1", [reminder?.id || 0]);
  check(closed?.status === "completed", "and closes the reminder task");

  section("8. audit, officer and the standard rate");
  const audited = (await query("SELECT action FROM audit_logs WHERE module='owner_listing' AND record_id=$1", [String(one)])).rows.map((row) => row.action);
  for (const action of ["owner_listing_created", "owner_listing_visit_booked", "owner_listing_valued", "owner_listing_documents_checked", "owner_listing_mandate_agreed", "owner_listing_mandate_signed", "owner_listing_listed", "owner_listing_offer_recorded", "owner_listing_offer_presented", "owner_listing_offer_decided", "owner_listing_sold"]) {
    check(audited.includes(action), `audit log has ${action}`);
  }
  check((await call(`${L}/${three}/officer`, { as: "officer", method: "POST", body: { officer_id: users.sales.id } })).status === 400, "a listing can only be given to someone who runs owner listings");
  res = await call(`${L}/${three}/officer`, { as: "manager", method: "POST", body: { officer_id: users.officer2.id } });
  check(res.status === 200 && Number(res.body.officer_id) === users.officer2.id, "the Sales manager gives a listing to another Property Officer");
  check((await call(`${L}/settings`, { as: "officer", method: "PUT", body: { standard_commission: 2 } })).status === 403, "the Property Officer cannot change the standard rate");
  res = await call(`${L}/settings`, { as: "director", method: "PUT", body: { standard_commission: 4 } });
  check(res.status === 200 && (await call(`${L}/settings`, { as: "officer" })).body.standard_commission === 4, "the MD sets the standard commission rate");
  res = await call(`${L}/${three}/withdraw`, { as: "officer", method: "POST", body: { reason: "Owner changed their mind." } });
  check(res.status === 200 && res.body.stage === "withdrawn", "a listing can be withdrawn with a reason");
  check((await call(`${L}/${three}/visit`, { as: "officer", method: "POST", body: { visit_at: `${ymd(1)}T10:00` } })).status === 409, "a withdrawn listing is closed");

  section("9. an accepted website Sell request opens its listing");
  const lead = await queryOne(
    `INSERT INTO leads (organization_id, name, phone, source, status, service, sell_details, owner_id, created_by, visibility)
     VALUES ($1,$2,'+255700000002','website','new','sell',$3::jsonb,$4,$4,'organization') RETURNING id`,
    [org, `Owner Test Seller ${stamp}`, JSON.stringify({ property_type: "Land / plot", location: "Kibaha", asking_price: 30000000 }), users.sales.id]);
  res = await call(`/org/leads/${lead.id}/convert`, { as: "sales", method: "POST", body: { mode: "new" } });
  check(res.status === 201 && res.body.client_type === "seller", "Sales accepts the seller as a client");
  const opened = await queryOne("SELECT * FROM owner_listings WHERE lead_id=$1", [lead.id]);
  check(opened && opened.stage === "received" && opened.location === "Kibaha" && Number(opened.client_id) === Number(res.body.id), "the owner listing opens at Received with the seller's details");
} finally {
  await server.stop();
  // Clean up everything this run created.
  const ids = Object.values(users).map((user) => user.id);
  const listingIds = (await query("SELECT id, reminder_task_id FROM owner_listings WHERE owner_name LIKE $1", [`Owner Test %${stamp}`])).rows;
  await query("DELETE FROM tasks WHERE title LIKE $1", [`Weekly update due: Owner Test %${stamp}`]).catch(() => {});
  await query("DELETE FROM audit_logs WHERE module='owner_listing' AND record_id = ANY($1::text[])", [listingIds.map((row) => String(row.id))]).catch(() => {});
  await query("DELETE FROM owner_listings WHERE owner_name LIKE $1", [`Owner Test %${stamp}`]).catch(() => {});
  await query("DELETE FROM clients WHERE name LIKE $1", [`Owner Test %${stamp}`]).catch(() => {});
  await query("DELETE FROM leads WHERE name LIKE $1", [`Owner Test %${stamp}`]).catch(() => {});
  await query("DELETE FROM audit_logs WHERE user_id = ANY($1::int[])", [ids]).catch(() => {});
  await query("DELETE FROM users WHERE id = ANY($1::int[])", [ids]).catch(() => {});
  if (savedSetting) await query("UPDATE settings SET setting_value=$3 WHERE organization_id=$1 AND setting_key=$2", [org, STANDARD_COMMISSION_SETTING, savedSetting.setting_value]).catch(() => {});
  else await query("DELETE FROM settings WHERE organization_id=$1 AND setting_key=$2", [org, STANDARD_COMMISSION_SETTING]).catch(() => {});
  await closeDatabase().catch(() => {});
}

console.log(failures ? `\nOWNER_LISTING_FAILURES: ${failures}` : "\nOWNER_LISTING_ALL_PASSED");
process.exit(failures ? 1 : 0);
