// ---------------------------------------------------------------------------
// The handwritten fix list (1 October 2026).
//
//   01  Finance (Accountant / Finance Officer) SEES projects and properties but
//       cannot change them, and cannot create or generate contracts.
//   02  Customer Service sees properties read-only too.
//   03  Deleting a contract: the MD and Legal always; Sales only before
//       approval; nobody else (Finance, the System Administrator).
//   04  A Contact-page message goes to Customer Service, appears under
//       Requests, and only Customer Service marks it answered.
//   05  Generate contract: the type decides the agreement (Sale Agreement /
//       Lease Agreement / Property Sale Mandate), the title deed is printed,
//       and the wording is placed on the default letterhead template.
//   06  Finance reads the reminders that fall due soon; Sales does not.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { closeDatabase, query } from "./backend/src/db.js";
import { legacyPasswordFor } from "./backend/src/org/demoCredentials.js";

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ label: "handwritten-fixes", port: 3233 });
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

const createdTemplates = [];
let md;
try {
  const admin = await signIn("admin@mkuyu.local", legacyPasswordFor("admin@mkuyu.local"));
  md = await signIn("md@mkuyu.local", legacyPasswordFor("md@mkuyu.local"));
  const roles = (await call("/org/roles", { token: admin })).body;
  const roleId = (name) => roles.find((r) => r.name === name).id;
  const make = async (name, email, role) => {
    await call("/org/users", { method: "POST", token: admin, body: { display_name: name, email, password: "TempPass#2026", role_ids: [roleId(role)] } });
    return signIn(email, "TempPass#2026");
  };
  const sales = await make(`Sales HW ${tag}`, `sales.hw.${tag}@test.mkuyu.local`, "Sales & Marketing Officer");
  const legal = await make(`Legal HW ${tag}`, `legal.hw.${tag}@test.mkuyu.local`, "Legal Officer");
  const accountant = await make(`Accountant HW ${tag}`, `acc.hw.${tag}@test.mkuyu.local`, "Accountant");
  const finance = await make(`Finance HW ${tag}`, `fin.hw.${tag}@test.mkuyu.local`, "Finance Officer");
  const cs = await make(`CS HW ${tag}`, `cs.hw.${tag}@test.mkuyu.local`, "Customer Service Officer");
  check(Boolean(sales && legal && accountant && finance && cs), "created Sales, Legal, Accountant, Finance and Customer Service users");

  const project = (await call("/projects", { method: "POST", token: sales, body: { name: `HW Project ${tag}` } })).body;
  const property = await call("/properties", { method: "POST", token: sales, body: { project_id: project.id, name: `HW Villa ${tag}`, property_type: "villa", price: 250000000, location: "Mbezi Beach", area: 640 } });
  check(property.status === 201, "Sales creates a project and a property");
  // Land and commercial property have no bedrooms or bathrooms; homes do.
  const plot = await call("/properties", { method: "POST", token: sales, body: { project_id: project.id, name: `HW Plot ${tag}`, property_type: "land", price: 30000000, location: "Kigamboni", area: 600, bedrooms: 3, bathrooms: 2 } });
  check(plot.status === 201 && Number(plot.body.bedrooms) === 0 && Number(plot.body.bathrooms) === 0 && Number(plot.body.area) === 600, "a plot of land is saved with its price and size, and no bedrooms or bathrooms");
  const shop = await call("/properties", { method: "POST", token: sales, body: { project_id: project.id, name: `HW Shop ${tag}`, property_type: "commercial", price: 80000000, location: "Kariakoo", area: 150, bedrooms: 1 } });
  check(shop.status === 201 && Number(shop.body.bedrooms) === 0, "commercial property is saved with no bedrooms");
  const flat = await call("/properties", { method: "POST", token: sales, body: { project_id: project.id, name: `HW Penthouse ${tag}`, property_type: "penthouse", price: 400000000, location: "Masaki", area: 220, bedrooms: 3, bathrooms: 3 } });
  check(flat.status === 201 && Number(flat.body.bedrooms) === 3 && Number(flat.body.bathrooms) === 3, "a penthouse keeps its bedrooms and bathrooms");

  console.log("\n=== CHECK 01: Finance sees projects and properties, never changes them ===");
  for (const [who, token] of [["the Accountant", accountant], ["the Finance Officer", finance]]) {
    const me = (await call("/org/me", { token })).body;
    check(me.modules.includes("projects") && me.modules.includes("properties"), `${who} has Projects and Properties in the menu`);
    check(me.readonly_modules.includes("projects") && me.readonly_modules.includes("properties"), `${who} holds them read-only`);
    check((await call("/projects", { token })).status === 200, `${who} reads projects`);
    check((await call("/properties", { token })).status === 200, `${who} reads properties`);
    check((await call(`/properties/${property.body.id}/images`, { token })).status === 200, `${who} sees a property's photos`);
    check((await call("/projects", { method: "POST", token, body: { name: `Finance project ${tag}` } })).status === 403, `${who} cannot create a project`);
    check((await call(`/projects/${project.id}`, { method: "PUT", token, body: { name: "Renamed" } })).status === 403, `${who} cannot edit a project`);
    check((await call(`/properties/${property.body.id}`, { method: "PUT", token, body: { price: 1 } })).status === 403, `${who} cannot edit a property`);
    check((await call(`/properties/${property.body.id}`, { method: "DELETE", token })).status === 403, `${who} cannot delete a property`);
    const contract = await call("/contracts", { method: "POST", token, body: { project_id: project.id, client_name: "Finance made", contract_type: "new", deal_type: "buy", value: 1000 } });
    check(contract.status === 403, `${who} cannot create a contract (${contract.status})`);
    const generated = await call("/contracts/generate", { method: "POST", token, body: { project_id: project.id, property_id: property.body.id, client_name: "Finance made", deal_type: "buy", original_price: 1000, start_date: "2026-10-01", agreement_duration: 12 } });
    check(generated.status === 403, `${who} cannot generate a contract (${generated.status})`);
  }

  console.log("\n=== CHECK 02: Customer Service sees properties read-only ===");
  check((await call("/properties", { token: cs })).status === 200, "Customer Service reads properties");
  check((await call("/properties", { method: "POST", token: cs, body: { name: "CS villa", location: "Dar", price: 1 } })).status === 403, "Customer Service cannot create a property");

  console.log("\n=== CHECK 03: who may delete a contract ===");
  const newContract = async (token, name) => (await call("/contracts", { method: "POST", token, body: { project_id: project.id, property_id: property.body.id, client_name: `${name} ${tag}`, contract_type: "new", deal_type: "buy", value: 5000 } })).body;
  const draft = await newContract(sales, "Sales draft");
  check([403, 404].includes((await call(`/contracts/${draft.id}`, { method: "DELETE", token: finance })).status), "Finance cannot delete a contract");
  check((await call(`/contracts/${draft.id}`, { method: "DELETE", token: accountant })).status === 403, "the Accountant (who sees every contract) cannot delete one");
  check((await call(`/contracts/${draft.id}`, { method: "DELETE", token: admin })).status === 403, "the System Administrator cannot delete a contract");
  check((await call(`/contracts/${draft.id}`, { method: "DELETE", token: sales })).status === 200, "Sales deletes its own contract before approval");

  const approvedDeal = await newContract(sales, "Approved deal");
  check((await call(`/contracts/${approvedDeal.id}/transition`, { method: "POST", token: sales, body: { action: "submit" } })).status === 200, "Sales submits a contract to Legal");
  check((await call(`/contracts/${approvedDeal.id}/transition`, { method: "POST", token: legal, body: { action: "legal_approve" } })).status === 409, "Legal cannot approve without starting the review");
  check((await call(`/contracts/${approvedDeal.id}/transition`, { method: "POST", token: legal, body: { action: "start_review" } })).status === 200, "Legal starts the review");
  check((await call(`/contracts/${approvedDeal.id}/transition`, { method: "POST", token: legal, body: { action: "legal_approve" } })).status === 200, "Legal approves it");
  const refused = await call(`/contracts/${approvedDeal.id}`, { method: "DELETE", token: sales });
  check(refused.status === 403 && /before it is approved/.test(refused.body.error || ""), `Sales may no longer delete it once approved (${refused.status})`);
  check(!/administrator/i.test(refused.body.error || ""), "the refusal no longer says an administrator may delete contracts");
  check((await call(`/contracts/${approvedDeal.id}`, { method: "DELETE", token: legal })).status === 200, "Legal deletes an approved contract");
  const mdContract = await newContract(md, "MD deal");
  check((await call(`/contracts/${mdContract.id}`, { method: "DELETE", token: md })).status === 200, "the MD deletes a contract");

  console.log("\n=== CHECK 04: Contact-page messages go to Customer Service ===");
  const sent = await call("/public/enquiries", { method: "POST", body: { name: "Visitor HW", phone: `+255 71${String(Date.now()).slice(-7)}`, email: `visitor.${tag}@example.com`, topic: "general", preferred_contact: "email", message: "Do you have offices in Arusha?" }, headers: { Origin: "http://localhost:5500" } });
  check(sent.status === 201, `the Contact page sends a message without logging in (${sent.body.reference})`);
  const messageId = Number(String(sent.body.reference).slice(2));
  const stored = (await query("SELECT l.source, d.name AS department FROM leads l LEFT JOIN departments d ON d.id=l.department_id WHERE l.id=$1", [messageId])).rows[0];
  check(stored?.source === "website-contact" && stored?.department === "CUSTOMER SERVICE", "the message belongs to Customer Service");
  const csRequests = (await call("/org/requests", { token: cs })).body;
  check(Array.isArray(csRequests) && csRequests.some((row) => row.id === messageId), "Customer Service sees it under Requests");
  check((await call(`/org/requests/${messageId}/answer`, { method: "POST", token: sales, body: { note: "Answered" } })).status === 403, "Sales does not answer Customer Service's messages");
  check((await call(`/org/requests/${messageId}/answer`, { method: "POST", token: cs, body: { note: "" } })).status === 400, "an answer needs a note");
  const answered = await call(`/org/requests/${messageId}/answer`, { method: "POST", token: cs, body: { note: "Emailed our Arusha office address." } });
  check(answered.status === 200 && answered.body.outcome === "answered", "Customer Service marks it answered");

  console.log("\n=== CHECK 05: the type decides the agreement, placed on the template ===");
  // One live deal per property and type, so every generated contract gets its own villa.
  let villaSeq = 0;
  // The first contract uses the main villa (later checks rely on it being on a contract).
  const freshVilla = async () => villaSeq++ === 0 ? property.body.id : (await call("/properties", { method: "POST", token: sales, body: { project_id: project.id, name: `HW Villa ${tag} ${villaSeq}`, property_type: "villa", price: 250000000, location: "Mbezi Beach", area: 640 } })).body.id;
  const generate = async (type, extra = {}) => call("/contracts/generate", { method: "POST", token: sales, body: { project_id: project.id, property_id: await freshVilla(), client_name: `Client ${type} ${tag}`, deal_type: type, original_price: 120000000, discount_pct: 5, start_date: "2026-10-01", agreement_duration: 12, title_deed_number: "CT-45821", ...extra } });
  const expected = { buy: "Sale Agreement", rent: "Lease Agreement", sell: "Property Sale Mandate" };
  for (const [type, title] of Object.entries(expected)) {
    const result = await generate(type, { template_document_id: "" });
    const document = result.body.document || {};
    const text = (await query("SELECT body_text FROM documents WHERE id=$1", [document.id])).rows[0]?.body_text || "";
    check(result.status === 201 && document.title === title, `${type}: the ${title} is generated (${result.status})`);
    check(text.includes("CT-45821") && text.includes("640 square metres") && /Parties and Introduction/.test(text), `${type}: it has the introduction, the title deed and the property size`);
    check(!/\{\{\s*(?!LAWYER_SIGNATURE)[A-Z_]+\s*\}\}/.test(text), `${type}: no placeholder is left unfilled`);
    check(result.body.template?.letterhead === true, `${type}: it is placed on the MKUYU letterhead`);
    // "Open contract" shows the contract on its template, page by page.
    const preview = await call(`/contracts/${result.body.contract?.id}/preview`, { token: sales });
    check(preview.status === 200 && preview.body.header.includes("MKUYU") && preview.body.header.includes(title) && /data-field="NUMPAGES"/.test(preview.body.footer) && preview.body.blocks.some((block) => block.includes(title.toUpperCase())), `${type}: Open contract shows it on the letterhead, with the page header and footer`);
    check(!preview.body.blocks.join("").includes("<script"), `${type}: the preview carries no script`);
  }
  check((await call(`/contracts/${draft.id}/preview`, { token: sales })).status === 404, "a deleted contract has no preview");
  check((await call("/contracts/generate", { method: "POST", token: sales, body: { project_id: project.id, property_id: property.body.id, client_name: "No type", original_price: 1000, start_date: "2026-10-01", agreement_duration: 12 } })).status === 400, "a contract without a type is refused");

  // A full-wording template written for Buy cannot be used for a Rent contract.
  const buyOnly = await call("/contract-templates", { method: "POST", token: md, body: { title: `Buy only ${tag}`, body_text: "# Sale\n\n{{CLIENT_NAME}} buys {{PROPERTY_NAME}}.", deal_type: "buy" } });
  check(buyOnly.status === 201, "the MD adds a template for Buy contracts only");
  createdTemplates.push(buyOnly.body.id);
  const mismatch = await generate("rent", { template_document_id: buyOnly.body.id });
  check(mismatch.status === 400 && /for buy contracts/.test(mismatch.body.error || ""), "a Buy template is refused for a Rent contract");
  check((await call("/contract-templates", { method: "POST", token: md, body: { title: "Bad type", body_text: "x {{CLIENT_NAME}}", deal_type: "barter" } })).status === 400, "an unknown template type is refused");

  // A default LETTERHEAD template: every type's wording goes where it says {{CONTRACT_BODY}}.
  const letterhead = await call("/contract-templates", { method: "POST", token: md, body: { title: `Letterhead ${tag}`, body_text: "MKUYU REAL ESTATE LTD · P.O. Box 1 · Dar es Salaam\n\n{{CONTRACT_BODY}}\n\nMKUYU · Registered office, Dar es Salaam", is_default: true } });
  check(letterhead.status === 201, "the MD adds a letterhead template and makes it the default");
  createdTemplates.push(letterhead.body.id);
  const listed = (await call("/contract-templates", { token: sales })).body.find((t) => t.id === letterhead.body.id);
  check(listed?.letterhead === true && listed?.deal_type === null, "the template list marks it a letterhead for any type");
  const onLetterhead = await generate("sell");
  const letterText = (await query("SELECT body_text FROM documents WHERE id=$1", [onLetterhead.body.document?.id])).rows[0]?.body_text || "";
  check(onLetterhead.status === 201 && onLetterhead.body.template?.id === letterhead.body.id, "a new contract uses the default letterhead automatically");
  check(letterText.startsWith("MKUYU REAL ESTATE LTD") && letterText.includes("# Property Sale Mandate") && letterText.trim().endsWith("Registered office, Dar es Salaam"), "the Sell mandate is written inside the letterhead");
  check(onLetterhead.body.document?.title === "Property Sale Mandate", "the document is named after the agreement, not the letterhead");

  console.log("\n=== CHECK 07: Customer Service's report reaches Sales ===");
  const salesMe = (await call("/org/me", { token: sales })).body.user;
  const csUser = (await call("/org/tasks/assignees?department=CUSTOMER%20SERVICE", { token: sales })).body.find((u) => u.display_name === `CS HW ${tag}`);
  check(Boolean(csUser), "Sales can hand work to the Customer Service officer");
  // (a) A Contact-page message handed to Customer Service.
  const question = await call("/public/enquiries", { method: "POST", body: { name: "Visitor Report", phone: `+255 72${String(Date.now()).slice(-7)}`, topic: "general", preferred_contact: "phone", message: "When can I visit the office?" }, headers: { Origin: "http://localhost:5500" } });
  const questionId = Number(String(question.body.reference).slice(2));
  const msgTask = await call("/org/tasks", { method: "POST", token: sales, body: { title: "Contact Visitor Report", description: `Website enquiry.\n\nPlease contact the customer and report back. (Lead W-${questionId})`, assigned_to: csUser.id, reviewer_id: salesMe.id, priority: "high" } });
  check((await call(`/org/requests/${questionId}/handed-off`, { method: "POST", token: sales, body: { task_id: msgTask.body.id } })).status === 200, "Sales hands a Contact-page message to Customer Service");
  const act = (token, taskId, action, comment) => call(`/org/tasks/${taskId}/actions`, { method: "POST", token, body: { action, ...(comment ? { comment } : {}) } });
  check((await act(cs, msgTask.body.id, "start")).status === 200, "Customer Service starts the task");
  check((await act(cs, msgTask.body.id, "submit")).status === 400, "Customer Service cannot send it back without a report");
  const reportText = "Called him. He will visit the office on Monday 5 October at 2 pm to discuss the price and the contract.";
  check((await act(cs, msgTask.body.id, "submit", reportText)).status === 200, "Customer Service writes the report and submits it");
  const seen = (await call(`/org/tasks/${msgTask.body.id}`, { token: sales })).body;
  check(seen.report === reportText, "Sales opens the task and the report is on it");
  const inbox = (await call("/org/tasks?box=needs_review", { token: sales })).body;
  check(inbox.some((t) => t.id === msgTask.body.id && t.report === reportText), "the report is in Sales's review list");
  const msgRow = (await call("/org/requests", { token: sales })).body.find((r) => r.id === questionId);
  check(msgRow?.task_report === reportText && msgRow?.task_status === "submitted", "the report shows on the message under Requests");
  check((await act(sales, msgTask.body.id, "begin_review")).status === 200 && (await act(sales, msgTask.body.id, "approve")).status === 200, "Sales accepts the report");
  const answeredRow = (await call("/org/requests", { token: sales })).body.find((r) => r.id === questionId);
  check(answeredRow?.outcome === "answered" && answeredRow?.outcome_note === reportText, "the message is answered, with Customer Service's report kept as the answer");
  // After approving the report, Sales arranges the appointment the customer agreed.
  const monday = new Date(Date.now() + 5 * 86400000); monday.setUTCHours(11, 0, 0, 0);
  check((await call(`/org/requests/${questionId}/appointment`, { method: "POST", token: cs, body: { starts_at: monday.toISOString(), appointment_type: "meeting" } })).status === 403, "Customer Service does not book Sales's appointment");
  check((await call(`/org/requests/${questionId}/appointment`, { method: "POST", token: sales, body: { starts_at: "2020-01-01T10:00:00Z", appointment_type: "meeting" } })).status === 400, "an appointment in the past is refused");
  const arranged = await call(`/org/requests/${questionId}/appointment`, { method: "POST", token: sales, body: { starts_at: monday.toISOString(), appointment_type: "meeting", note: "Discuss the price and the contract" } });
  check(arranged.status === 201 && arranged.body.appointment_id && arranged.body.client_id, "Sales arranges the agreed appointment");
  const booked = (await call("/appointments", { token: sales })).body;
  const bookedRow = (Array.isArray(booked) ? booked : booked.data || []).find((a) => a.id === arranged.body.appointment_id);
  check(bookedRow && new Date(bookedRow.starts_at).getTime() === monday.getTime() && bookedRow.appointment_type === "meeting" && /Discuss the price/.test(bookedRow.notes || "") && /Monday 5 October/.test(bookedRow.notes || ""), "it is on the Appointments page, at that time, with the note and Customer Service's report");
  const later = new Date(monday.getTime() + 2 * 3600000);
  const moved = await call(`/org/requests/${questionId}/appointment`, { method: "POST", token: sales, body: { starts_at: later.toISOString(), appointment_type: "meeting" } });
  check(moved.status === 200 && moved.body.appointment_id === arranged.body.appointment_id, "arranging again moves the same appointment (no duplicate)");
  // Legal sees every appointment, read only.
  const legalMe = (await call("/org/me", { token: legal })).body;
  check(legalMe.modules.includes("appointments") && legalMe.readonly_modules.includes("appointments"), "Legal has Appointments in the menu, read only");
  const legalList = (await call("/appointments", { token: legal })).body;
  check((Array.isArray(legalList) ? legalList : legalList.data || []).some((a) => a.id === arranged.body.appointment_id), "Legal sees the appointment Sales arranged");
  check((await call(`/appointments/${arranged.body.appointment_id}`, { token: legal })).status === 200, "Legal can open it");
  check((await call(`/appointments/${arranged.body.appointment_id}`, { method: "PUT", token: legal, body: { title: "Changed by Legal" } })).status === 403, "Legal cannot edit an appointment");
  check((await call(`/appointments/${arranged.body.appointment_id}`, { method: "DELETE", token: legal })).status === 403, "Legal cannot delete an appointment");
  check((await call("/appointments", { method: "POST", token: legal, body: { title: "Legal booking", client_id: arranged.body.client_id, appointment_type: "meeting", starts_at: monday.toISOString() } })).status === 403, "Legal cannot create an appointment");
  check((await call(`/org/requests/${questionId}/appointment`, { method: "POST", token: legal, body: { starts_at: monday.toISOString() } })).status === 403, "Legal cannot arrange an appointment");
  const notYet = await call("/public/enquiries", { method: "POST", body: { name: "Early Visitor", phone: `+255 76${String(Date.now()).slice(-7)}`, topic: "general", preferred_contact: "phone", message: "Hi" }, headers: { Origin: "http://localhost:5500" } });
  check((await call(`/org/requests/${Number(String(notYet.body.reference).slice(2))}/appointment`, { method: "POST", token: sales, body: { starts_at: monday.toISOString() } })).status === 409, "an appointment waits until Customer Service's report is approved");

  // (b) A Buy request: the outcome must carry a note, and the note reaches Sales.
  const published = await call("/properties", { method: "POST", token: sales, body: { project_id: project.id, name: `Listed ${tag}`, property_type: "house", price: 90000000, location: "Arusha", area: 120, offer_buy: 1, public_listing: 1 } });
  const buyRequest = await call("/public/requests", { method: "POST", body: { property: published.body.id, service: "buy", name: "Buyer Report", phone: `+255 73${String(Date.now()).slice(-7)}`, budget: 85000000, preferred_contact: "phone" }, headers: { Origin: "http://localhost:5500" } });
  const buyId = Number(String(buyRequest.body.reference).slice(2));
  check(buyRequest.status === 201, "a visitor asks to buy a published property");
  const buyTask = await call("/org/tasks", { method: "POST", token: sales, body: { title: "Contact Buyer Report", assigned_to: csUser.id, reviewer_id: salesMe.id, priority: "high" } });
  await call(`/org/requests/${buyId}/handed-off`, { method: "POST", token: sales, body: { task_id: buyTask.body.id } });
  const noNote = await call(`/org/tasks/${buyTask.body.id}/outcome`, { method: "POST", token: cs, body: { outcome: "interested" } });
  check(noNote.status === 400 && /note for Sales/.test(noNote.body.error || ""), "an outcome without a note for Sales is refused");
  const buyNote = "Interested, wants a 10% discount and to pay in 12 months.";
  check((await call(`/org/tasks/${buyTask.body.id}/outcome`, { method: "POST", token: cs, body: { outcome: "interested", note: buyNote } })).status === 200, "Customer Service reports the outcome with a note");
  const buySeen = (await call(`/org/tasks/${buyTask.body.id}`, { token: sales })).body;
  check(buySeen.request_outcome_note === buyNote && String(buySeen.report || "").includes(buyNote), "Sales sees the note on the task");
  const buyRow = (await call("/org/requests", { token: sales })).body.find((r) => r.id === buyId);
  check(buyRow?.outcome_note === buyNote, "Sales sees the note on the request");

  console.log("\n=== CHECK 08: property status, several photos, delete ===");
  // Status from the "⋯" menu: a status-only update.
  const listing = await call("/properties", { method: "POST", token: sales, body: { project_id: project.id, name: `HW Status ${tag}`, property_type: "villa", price: 300000000, location: "Mbezi", area: 500, bedrooms: 4 } });
  for (const status of ["reserved", "sold", "leased", "available"]) {
    const changed = await call(`/properties/${listing.body.id}`, { method: "PUT", token: sales, body: { status } });
    check(changed.status === 200 && changed.body.status === status && changed.body.name === `HW Status ${tag}` && Number(changed.body.bedrooms) === 4, `Sales marks the property ${status} (nothing else changes)`);
  }
  check((await call(`/properties/${listing.body.id}`, { method: "PUT", token: finance, body: { status: "sold" } })).status === 403, "Finance cannot change a property's status");
  // Several photos on one property.
  const png = fs.readFileSync(new URL("./frontend/assets/brand/mkuyu-logo-192.png", import.meta.url));
  const upload = async (token, propertyId, name) => {
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), name);
    const response = await fetch(`${base}/properties/${propertyId}/images`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const uploads = [];
  for (const name of ["front.png", "kitchen.png", "garden.png"]) uploads.push(await upload(sales, listing.body.id, name));
  check(uploads.every((u) => u.status === 201), "Sales adds three photos to one property");
  const photos = (await call(`/properties/${listing.body.id}/images`, { token: sales })).body;
  check(photos.length === 3, `the property has all three photos (${photos.length})`);
  check((await call(`/properties/${listing.body.id}/images/${photos[1].id}`, { method: "DELETE", token: sales })).status === 200, "Sales removes one photo");
  check((await call(`/properties/${listing.body.id}/images`, { token: sales })).body.length === 2, "two photos remain");
  check((await call(`/properties/${listing.body.id}/images/${photos[0].id}`, { method: "DELETE", token: finance })).status === 403, "Finance cannot remove photos");
  // The public website sees every photo of a published property, in order.
  await call(`/properties/${listing.body.id}`, { method: "PUT", token: sales, body: { offer_buy: 1, public_listing: 1 } });
  const publicView = await call(`/public/properties/${listing.body.id}`, { headers: { Origin: "http://localhost:5500" } });
  check(publicView.status === 200 && publicView.body.photos.length === 2, `the website gets both photos for its slider (${publicView.body.photos?.length})`);
  // Delete: Sales may delete a listing no contract names; not one on a contract.
  check((await call(`/properties/${listing.body.id}`, { method: "DELETE", token: finance })).status === 403, "Finance cannot delete a property");
  check((await call(`/properties/${listing.body.id}`, { method: "DELETE", token: sales })).status === 200, "Sales deletes a property no contract names");
  check((await call(`/properties/${listing.body.id}`, { token: sales })).status === 404, "the deleted property is gone");
  const onContract = await call(`/properties/${property.body.id}`, { method: "DELETE", token: sales });
  check(onContract.status === 409 && /mark it sold or rented/.test(onContract.body.error || ""), "a property on a contract cannot be deleted: mark it sold or rented instead");
  check((await call(`/properties/${property.body.id}`, { method: "DELETE", token: md })).status === 409, "not even by the MD");

  console.log("\n=== CHECK 09: sale and rent states, on the website per category ===");
  const both = await call("/properties", { method: "POST", token: sales, body: { project_id: project.id, name: `HW Both ${tag}`, property_type: "house", price: 250000000, rent_price: 2500000, location: "Mikocheni", area: 300, bedrooms: 3, offer_buy: 1, offer_rent: 1, public_listing: 1 } });
  check(both.status === 201 && both.body.sale_status === "available" && both.body.rent_status === "available", "a property offered for sale and rent starts open in both");
  const pub = async (service) => (await call(`/public/properties${service ? `?service=${service}` : ""}`, { headers: { Origin: "http://localhost:5500" } })).body.find((p) => p.id === both.body.id);
  const rented = await call(`/properties/${both.body.id}`, { method: "PUT", token: sales, body: { rent_status: "rented" } });
  check(rented.status === 200 && rented.body.rent_status === "rented" && rented.body.sale_status === "available" && rented.body.status === "available", "marked rented: closed for rent, still for sale");
  const onRent = await pub("rent");
  const onBuy = await pub("buy");
  check(onRent?.availability?.rent === "rented", "the website's Rent page lists it as RENTED");
  check(onBuy?.availability?.buy === "available", "the website's Buy page still offers it for sale");
  const req = (service) => call("/public/requests", { method: "POST", body: { property: both.body.id, service, name: "Visitor Both", phone: `+255 74${String(Date.now()).slice(-7)}`, budget: 1000, preferred_contact: "phone" }, headers: { Origin: "http://localhost:5500" } });
  check((await req("rent")).status === 409, "a rent request is refused while it is rented");
  check((await req("buy")).status === 201, "a buy request is still accepted");
  const sold = await call(`/properties/${both.body.id}`, { method: "PUT", token: sales, body: { sale_status: "sold" } });
  check(sold.body.sale_status === "sold" && sold.body.status === "sold", "then sold too: closed in both, overall Sold");
  check((await pub("buy"))?.availability?.buy === "sold", "the Buy page lists it as SOLD (it stays on the page)");
  const reopened = await call(`/properties/${both.body.id}`, { method: "PUT", token: sales, body: { sale_status: "available", rent_status: "available" } });
  check(reopened.body.status === "available", "opening both again makes it available");
  const together = await call(`/properties/${both.body.id}`, { method: "PUT", token: sales, body: { sale_status: "sold", rent_status: "rented" } });
  check(together.body.sale_status === "sold" && together.body.rent_status === "rented" && together.body.status === "sold", "Mark as sold and rented (both) closes both at once");
  check((await call(`/properties/${both.body.id}`, { method: "PUT", token: sales, body: { sale_status: "rented" } })).status === 400, "a sale state cannot be 'rented'");
  const saleOnly = await call("/properties", { method: "POST", token: sales, body: { project_id: project.id, name: `HW Sale ${tag}`, property_type: "land", price: 50000000, location: "Bagamoyo", area: 900, offer_buy: 1, public_listing: 1 } });
  const saleOnlyReserved = await call(`/properties/${saleOnly.body.id}`, { method: "PUT", token: sales, body: { sale_status: "reserved" } });
  check(saleOnlyReserved.body.status === "reserved", "a sale-only property marked reserved is reserved overall");
  const formSold = await call(`/properties/${saleOnly.body.id}`, { method: "PUT", token: sales, body: { status: "sold" } });
  check(formSold.body.sale_status === "sold" && formSold.body.status === "sold", "choosing Sold in the edit form marks the sale as sold");

  console.log("\n=== CHECK 10: Rent has no project ===");
  // Two leases need two properties (one live lease per property).
  const leaseHome = async (n) => (await call("/properties", { method: "POST", token: sales, body: { project_id: project.id, name: `HW Lease ${n} ${tag}`, property_type: "house", price: 90000000, location: "Mikocheni", area: 300, offer_rent: 1, rent_price: 2500000 } })).body.id;
  const lease = await call("/contracts/generate", { method: "POST", token: sales, body: { project_id: project.id, property_id: await leaseHome("A"), client_name: `Tenant ${tag}`, deal_type: "rent", original_price: 30000000, start_date: "2026-11-01", agreement_duration: 12, template_document_id: "" } });
  check(lease.status === 201 && lease.body.contract?.project_id === null, `a Rent contract is saved without a project (${lease.status})`);
  const leaseText = (await query("SELECT body_text FROM documents WHERE id=$1", [lease.body.document?.id])).rows[0]?.body_text || "";
  check(leaseText.includes("# Lease Agreement") && !/Project:/.test(leaseText), "the Lease Agreement names the property, not a project");
  const leaseNoProject = await call("/contracts/generate", { method: "POST", token: sales, body: { property_id: await leaseHome("B"), client_name: `Tenant B ${tag}`, deal_type: "rent", original_price: 30000000, start_date: "2026-11-01", agreement_duration: 12, template_document_id: "" } });
  check(leaseNoProject.status === 201, "a Rent contract needs no project at all");
  check((await call("/contracts", { token: sales })).body.some((c) => c.id === leaseNoProject.body.contract?.id), "a contract without a project still shows in the register");
  check((await call("/contracts/generate", { method: "POST", token: sales, body: { property_id: both.body.id, client_name: "Buyer NP", deal_type: "buy", original_price: 1000, start_date: "2026-11-01", agreement_duration: 12 } })).status === 400, "a Sale still needs its project");
  const rentProjects = await call("/public/projects?service=rent", { headers: { Origin: "http://localhost:5500" } });
  check(rentProjects.status === 200 && rentProjects.body.every((p) => p.services.includes("rent")), "projects listed for rent all have a home to rent");
  const allProjects = (await call("/public/projects", { headers: { Origin: "http://localhost:5500" } })).body;
  check(allProjects.every((p) => p.services.length >= 1 && p.services.every((s) => ["buy", "rent"].includes(s))), "every project on the website says whether it is to rent, to buy or both");

  console.log("\n=== CHECK 11: changes reach open screens live ===");
  const listen = async (token, ms = 4000) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/live`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    const reader = response.body.getReader();
    const events = [];
    const done = (async () => {
      let buffer = "";
      try {
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          buffer += new TextDecoder().decode(value);
          for (const match of buffer.matchAll(/event: change\ndata: (\{[^\n]*\})/g)) events.push(JSON.parse(match[1]).area);
          buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
        }
      } catch { /* aborted */ }
    })();
    return { status: response.status, events, stop: async () => { controller.abort(); await done; } };
  };
  const salesLive = await listen(sales);
  const csLive = await listen(cs);
  check(salesLive.status === 200, "a signed-in screen opens the live stream");
  check((await fetch(`${base}/live`)).status === 401, "the live stream needs a signed-in user");
  await call("/public/enquiries", { method: "POST", body: { name: "Live Visitor", phone: `+255 75${String(Date.now()).slice(-7)}`, topic: "general", preferred_contact: "phone", message: "Hello live" }, headers: { Origin: "http://localhost:5500" } });
  await call(`/properties/${both.body.id}`, { method: "PUT", token: sales, body: { rent_status: "available" } });
  await call("/contracts", { method: "POST", token: sales, body: { project_id: project.id, client_name: `Live ${tag}`, contract_type: "new", deal_type: "buy", value: 100 } });
  await new Promise((resolve) => setTimeout(resolve, 600));
  await salesLive.stop();
  await csLive.stop();
  check(salesLive.events.includes("requests"), "a website message is announced to Sales at once");
  check(salesLive.events.includes("properties") && salesLive.events.includes("contracts"), "property and contract changes are announced");
  check(csLive.events.includes("requests") && !csLive.events.includes("contracts"), "Customer Service hears about requests but not contracts (no Contracts module)");

  console.log("\n=== CHECK 12: the MD follows requests but does not hand them over ===");
  const mdRequest = await call("/public/enquiries", { method: "POST", body: { name: "MD Watch", phone: `+255 77${String(Date.now()).slice(-7)}`, topic: "general", preferred_contact: "phone", message: "Question for MKUYU" }, headers: { Origin: "http://localhost:5500" } });
  const mdRequestId = Number(String(mdRequest.body.reference).slice(2));
  const mdTask = await call("/org/tasks", { method: "POST", token: md, body: { title: "MD hand-off attempt", assigned_to: csUser.id, priority: "high" } });
  const mdHandOff = await call(`/org/requests/${mdRequestId}/handed-off`, { method: "POST", token: md, body: { task_id: mdTask.body.id } });
  check(mdHandOff.status === 403 && /Sales hands requests/.test(mdHandOff.body.error || ""), "the MD cannot hand a request to Customer Service");
  const salesTask = await call("/org/tasks", { method: "POST", token: sales, body: { title: "Contact MD Watch", assigned_to: csUser.id, reviewer_id: salesMe.id, priority: "high" } });
  check((await call(`/org/requests/${mdRequestId}/handed-off`, { method: "POST", token: sales, body: { task_id: salesTask.body.id } })).status === 200, "Sales hands it over");
  const mdSees = (await call("/org/requests", { token: md })).body.find((r) => r.id === mdRequestId);
  check(mdSees?.task_id === salesTask.body.id && mdSees?.task_assignee === `CS HW ${tag}`, "the MD sees who in Customer Service has it");
  await act(cs, salesTask.body.id, "start");
  await act(cs, salesTask.body.id, "submit", "Customer will call back on Friday.");
  const mdTaskView = (await call(`/org/tasks/${salesTask.body.id}`, { token: md })).body;
  check(mdTaskView.report === "Customer will call back on Friday.", "the MD reads Customer Service's report");
  check(!(mdTaskView.available_actions || []).some((a) => ["approve", "cancel", "begin_review"].includes(a)), "the MD is offered no approve or cancel on it");
  check((await act(md, salesTask.body.id, "cancel")).status === 403, "the MD cannot cancel Sales's hand-off");
  check((await act(md, salesTask.body.id, "approve")).status === 403, "the MD cannot approve the report (Sales reviews it)");
  check((await call(`/org/requests/${mdRequestId}/appointment`, { method: "POST", token: md, body: { starts_at: monday.toISOString() } })).status === 403, "the MD cannot arrange the appointment");

  console.log("\n=== CHECK 13: only Sales and the MD approve 'Become a client' ===");
  const samePhone = `+255 78${String(Date.now()).slice(-7)}`;
  const firstMsg = await call("/public/enquiries", { method: "POST", body: { name: "Client One", phone: samePhone, topic: "general", preferred_contact: "phone", message: "First" }, headers: { Origin: "http://localhost:5500" } });
  const firstId = Number(String(firstMsg.body.reference).slice(2));
  check((await call(`/org/leads/${firstId}/convert`, { method: "POST", token: cs, body: {} })).status === 403, "Customer Service cannot approve a client");
  const viaMd = await call(`/org/leads/${firstId}/convert`, { method: "POST", token: md, body: {} });
  check(viaMd.status === 201 && viaMd.body.name === "Client One", "the MD approves the customer as a client");
  const mdApproved = (await call("/org/requests", { token: sales })).body.find((r) => r.id === firstId);
  check(mdApproved?.client_id === viaMd.body.id && mdApproved?.client_name === "Client One" && /Joseph|MD|Mwakalinga|Director/i.test(String(mdApproved?.converted_by_name || "")) !== false && mdApproved?.converted_by_name, "Sales sees it is a client, and who approved it");
  const secondMsg = await call("/public/enquiries", { method: "POST", body: { name: "Client Two", phone: samePhone, topic: "general", preferred_contact: "phone", message: "Second" }, headers: { Origin: "http://localhost:5500" } });
  const secondId = Number(String(secondMsg.body.reference).slice(2));
  const secondRow = (await call("/org/requests", { token: sales })).body.find((r) => r.id === secondId);
  check(secondRow?.existing_client_id === viaMd.body.id, "a second request with the same phone is matched to that client");
  const asNew = await call(`/org/leads/${secondId}/convert`, { method: "POST", token: sales, body: { mode: "new" } });
  check(asNew.status === 201 && asNew.body.id !== viaMd.body.id && asNew.body.name === "Client Two", "Sales can say it is a different person: a new client is made");
  const thirdMsg = await call("/public/enquiries", { method: "POST", body: { name: "Client One again", phone: samePhone, topic: "general", preferred_contact: "phone", message: "Third" }, headers: { Origin: "http://localhost:5500" } });
  const thirdId = Number(String(thirdMsg.body.reference).slice(2));
  const linked = await call(`/org/leads/${thirdId}/convert`, { method: "POST", token: sales, body: { mode: "existing" } });
  check(linked.status === 200 && [viaMd.body.id, asNew.body.id].includes(linked.body.id), "or the same person: linked to the existing client, no duplicate");
  check((await call(`/org/leads/${thirdId}/convert`, { method: "POST", token: sales, body: {} })).status === 409, "a request cannot become a client twice");

  console.log("\n=== CHECK 06: Finance is reminded before payments fall due ===");
  check((await call("/reminders/upcoming?days=14", { token: accountant })).status === 200, "the Accountant reads reminders falling due soon");
  check((await call("/reminders", { token: finance })).status === 200, "the Finance Officer reads reminders due now");
  check((await call("/reminders/upcoming?days=14", { token: sales })).status === 403, "Sales does not see payment reminders");
} catch (error) {
  failures += 1;
  console.error(error);
} finally {
  // Leave the shared test database as other suites expect it: no default template.
  for (const id of createdTemplates) {
    await query("UPDATE documents SET is_default_template=FALSE WHERE id=$1", [id]).catch(() => {});
  }
  // The staff this suite made (and earlier runs made) are switched off, so they
  // never crowd the people lists that other suites read.
  await query("UPDATE users SET active=FALSE WHERE email LIKE '%.hw.%@test.mkuyu.local'").catch(() => {});
}

console.log(`\n${failures ? `${failures} HANDWRITTEN FIX CHECK(S) FAILED` : "HANDWRITTEN_FIXES_ALL_PASSED"}`);
if (failures) process.exitCode = 1;
await closeDatabase();
await server.stop();
