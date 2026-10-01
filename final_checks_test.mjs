// ---------------------------------------------------------------------------
// Final checks: the public Sell flow, the Buy/Rent/Sell contract type, and
// Finance payment approval.
//
//   Visitor (no login) -> POST /public/sell -> Sell request for Sales
//   -> handed to Customer Service -> outcome -> Sales accepts -> Seller Client
//   -> Sell contract (deal_type "sell")
//   Payment recorded -> "pending" -> approved by another Finance user only.
// ---------------------------------------------------------------------------
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { closeDatabase, query } from "./backend/src/db.js";
import { demoPasswordFor, legacyPasswordFor } from "./backend/src/org/demoCredentials.js";

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ label: "final-checks", port: 3232 });
const base = server.base;
const tag = Date.now().toString(36);

async function call(path, { method = "GET", body, token, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const signIn = async (email, password) => (await call("/auth/login", { method: "POST", body: { email, password } })).body.token;

try {
  const admin = await signIn("admin@mkuyu.local", legacyPasswordFor("admin@mkuyu.local"));
  const md = await signIn("md@mkuyu.local", legacyPasswordFor("md@mkuyu.local"));
  const roles = (await call("/org/roles", { token: admin })).body;
  const roleId = (name) => roles.find((r) => r.name === name).id;
  const make = async (name, email, role) => {
    await call("/org/users", { method: "POST", token: admin, body: { display_name: name, email, password: "TempPass#2026", role_ids: [roleId(role)] } });
    return signIn(email, "TempPass#2026");
  };
  const sales = await make(`Sales FC ${tag}`, `sales.fc.${tag}@test.mkuyu.local`, "Sales & Marketing Officer");
  const cs = await make(`CS FC ${tag}`, `cs.fc.${tag}@test.mkuyu.local`, "Customer Service Officer");
  const financeA = await make(`Finance A FC ${tag}`, `fin.a.${tag}@test.mkuyu.local`, "Finance Officer");
  const financeB = await make(`Finance B FC ${tag}`, `fin.b.${tag}@test.mkuyu.local`, "Finance Officer");
  check(Boolean(sales && cs && financeA && financeB), "created Sales, Customer Service and two Finance officers");

  console.log("\n=== CHECK 01: Sell from the public website (no login) ===");
  const phone = `+255 75${String(Date.now()).slice(-7)}`;
  const good = { name: "Owner FC", phone, email: `owner.${tag}@example.com`, preferred_contact: "whatsapp", property_type: "house", location: "Mbezi Beach, Dar es Salaam", area: 450, bedrooms: 4, asking_price: 350000000, title_deed: "yes", message: "Family house with garden." };
  check((await call("/public/sell", { method: "POST", body: { ...good, property_type: "castle" } })).status === 400, "an unknown property type is refused");
  check((await call("/public/sell", { method: "POST", body: { ...good, location: "" } })).status === 400, "a submission without a location is refused");
  check((await call("/public/sell", { method: "POST", body: { ...good, asking_price: -5 } })).status === 400, "a negative asking price is refused");
  const before = Number((await query("SELECT COUNT(*) FROM leads")).rows[0].count);
  const bot = await call("/public/sell", { method: "POST", body: { ...good, website: "spam" } });
  check(bot.status === 201 && Number((await query("SELECT COUNT(*) FROM leads")).rows[0].count) === before, "a bot filling the hidden field gets a quiet 'ok' and no lead");
  const sent = await call("/public/sell", { method: "POST", body: good, headers: { Origin: "http://localhost:5500" } });
  check(sent.status === 201 && /^W-\d+$/.test(sent.body.reference), `the public site submits a property without logging in (${sent.body.reference})`);
  const leadId = Number(sent.body.reference.slice(2));
  const lead = (await query("SELECT * FROM leads WHERE id=$1", [leadId])).rows[0];
  check(lead?.service === "sell" && lead?.source === "website" && Number(lead?.budget) === 350000000 && lead?.sell_details?.location === good.location && lead?.sell_details?.property_type === "house", "it is stored as a Sell request with the property details and asking price");
  check(Number((await query("SELECT COUNT(*) FROM clients WHERE LOWER(email)=LOWER($1)", [good.email])).rows[0].count) === 0, "no client or account is created by submitting");
  const requests = (await call("/org/requests", { token: sales })).body;
  const row = requests.find((r) => r.id === leadId);
  check(row && row.service === "sell" && row.sell_details?.bedrooms === 4, "Sales sees it under Requests, as Sell, with the details");

  const csUser = (await call("/org/tasks/assignees?department=CUSTOMER%20SERVICE", { token: sales })).body.find((u) => u.display_name === `CS FC ${tag}`);
  const salesMe = (await call("/org/me", { token: sales })).body.user;
  const task = await call("/org/tasks", { method: "POST", token: sales, body: { title: "Contact Owner FC (sell request)", assigned_to: csUser.id, reviewer_id: salesMe.id, priority: "high" } });
  check((await call(`/org/requests/${leadId}/handed-off`, { method: "POST", token: sales, body: { task_id: task.body.id } })).status === 200, "Sales hands the Sell request to Customer Service");
  const when = new Date(Date.now() + 3 * 86400000); when.setUTCHours(8, 0, 0, 0);
  check((await call(`/org/tasks/${task.body.id}/outcome`, { method: "POST", token: cs, body: { outcome: "appointment", appointment_at: when.toISOString(), appointment_type: "viewing", note: "Site visit agreed" } })).status === 200, "Customer Service contacts the owner and reports a site visit");
  await call(`/org/tasks/${task.body.id}/actions`, { method: "POST", token: sales, body: { action: "begin_review" } });
  check((await call(`/org/tasks/${task.body.id}/actions`, { method: "POST", token: sales, body: { action: "approve" } })).status === 200, "Sales accepts");
  const accepted = (await call("/org/requests", { token: sales })).body.find((r) => r.id === leadId);
  const client = (await query("SELECT client_type FROM clients WHERE id=$1", [accepted?.client_id])).rows[0];
  check(client?.client_type === "seller", `the owner becomes a Seller Client (${client?.client_type})`);

  console.log("\n=== CHECK 02: contract type Buy / Rent / Sell ===");
  const project = (await call("/projects", { method: "POST", token: md, body: { name: `FC ${tag}` } })).body;
  const noType = await call("/contracts", { method: "POST", token: md, body: { project_id: project.id, client_name: "No Type", contract_type: "new", value: 1000 } });
  check(noType.status === 400 && /Buy, Rent or Sell/.test(noType.body.error || ""), "a contract without a type is refused");
  check((await call("/contracts", { method: "POST", token: md, body: { project_id: project.id, client_name: "Bad Type", contract_type: "new", deal_type: "lease", value: 1000 } })).status === 400, "an unknown type is refused");
  const created = {};
  for (const type of ["buy", "rent", "sell"]) {
    const r = await call("/contracts", { method: "POST", token: md, body: { project_id: project.id, client_name: `FC ${type}`, client_id: type === "sell" ? accepted.client_id : undefined, contract_type: "new", deal_type: type, value: 5000000 } });
    created[type] = r.body;
    check(r.status === 201 && r.body.deal_type === type, `a ${type.toUpperCase()} contract is created and keeps its type`);
  }
  check((await call(`/contracts/${created.sell.id}`, { token: md })).body.deal_type === "sell", "the type is read back later");
  const edited = await call(`/contracts/${created.rent.id}`, { method: "PUT", token: md, body: { notes: "edited" } });
  check(edited.status === 200 && edited.body.deal_type === "rent", "editing a contract keeps its type");

  console.log("\n=== CHECK 05: Finance approves payments ===");
  const pay = await call("/payments", { method: "POST", token: financeA, body: { contract_id: created.buy.id, amount: 250000, paid_at: "2026-09-30", method: "bank", reference: `FC-${tag}` } });
  check(pay.status === 201 && pay.body.status === "pending", "a recorded payment starts as pending");
  check((await call(`/payments/${pay.body.id}/approve`, { method: "POST", token: financeA, body: {} })).status === 403, "the person who recorded it cannot approve it");
  check((await call(`/payments/${pay.body.id}/approve`, { method: "POST", token: sales, body: {} })).status === 403, "Sales cannot approve payments");
  check((await call(`/payments/${pay.body.id}/approve`, { method: "POST", token: md, body: {} })).status === 403, "the MD (not Finance) cannot approve payments");
  check((await call(`/payments/${pay.body.id}/approve`, { method: "POST", token: admin, body: {} })).status === 403, "the System Administrator cannot approve payments");
  const approved = await call(`/payments/${pay.body.id}/approve`, { method: "POST", token: financeB, body: {} });
  check(approved.status === 200 && approved.body.status === "approved" && approved.body.approved_by_name === `Finance B FC ${tag}`, "another Finance officer approves it");
  check((await call(`/payments/${pay.body.id}/approve`, { method: "POST", token: financeB, body: {} })).status === 409, "an approved payment cannot be approved again");
  const changed = await call(`/payments/${pay.body.id}`, { method: "PUT", token: financeA, body: { amount: 300000 } });
  check(changed.status === 200 && changed.body.status === "pending", "changing an approved payment sends it back for approval");
  check(Number((await query("SELECT COUNT(*) FROM audit_logs WHERE action='payment_approved' AND record_id=$1", [String(pay.body.id)])).rows[0].count) === 1, "the approval is in the audit log");
  void demoPasswordFor;
} catch (error) {
  failures += 1;
  console.error(error);
}

console.log(`\n${failures ? `${failures} FINAL CHECK(S) FAILED` : "FINAL_CHECKS_ALL_PASSED"}`);
if (failures) process.exitCode = 1;
await closeDatabase();
await server.stop();
