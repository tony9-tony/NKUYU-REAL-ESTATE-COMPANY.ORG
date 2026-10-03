// ---------------------------------------------------------------------------
// Public website API and the website-lead hand-off.
//
//   Sales Officer → Internal MKUYU System → /api/v1/public/* → public website
//   Visitor request → Lead for Sales → Sales assigns Customer Service
//
// Proves: the Sales Officer offers a property for Rent, Buy or both and
// publishes it directly; the public API returns only published records with
// only public fields; sold/rented homes leave the listings; pictures are served
// only while published; projects are categories derived from their published
// properties; a visitor's Rent/Buy request (no login) becomes a Lead with its
// details; spam guards work; Sales may hand a lead to Customer Service but not
// to other departments; and the staff API is still closed without a login.
// ---------------------------------------------------------------------------
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { closeDatabase, query } from "./backend/src/db.js";
import { legacyPasswordFor } from "./backend/src/org/demoCredentials.js";

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ label: "public-api", port: 3217 });
const base = server.base;
let token = "";

async function call(path, { method = "GET", body, auth = true, headers = {}, as } = {}) {
  const bearer = as ?? (auth ? token : "");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, body: await response.json().catch(() => ({})) };
}
const signIn = async (email, password = legacyPasswordFor(email)) => (await call("/auth/login", { method: "POST", auth: false, body: { email, password } })).body.token;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
async function upload(path) {
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), "photo.png");
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const publicList = async (q = "") => (await call(`/public/properties${q}`, { auth: false })).body;
const tag = Date.now().toString(36);

try {
  console.log("=== the Sales Officer publishes ===");
  token = await signIn("sales@demo.mkuyu.local");
  check(Boolean(token), "signed in as a Sales officer");

  const project = await call("/projects", { method: "POST", body: { name: `Hillside ${tag}` } });
  check(project.status === 201, `created a project as a plain category (${project.status})`);

  const draft = await call("/properties", { method: "POST", body: { project_id: project.body.id, name: `Villa ${tag}`, property_type: "villa", status: "available", price: 185000000, location: "Dar es Salaam", area: 240, bedrooms: 3, bathrooms: 2 } });
  check(draft.status === 201 && draft.body.public_listing === false, "a new property is NOT published by default");
  const id = draft.body.id;
  check(!(await publicList()).some((p) => p.id === id), "an unpublished property is not in the public listings");
  check(!(await call("/public/projects", { auth: false })).body.some((p) => p.slug === String(project.body.id)), "a project with no published homes is not on the website");

  check((await call(`/properties/${id}`, { method: "PUT", body: { public_listing: 1 } })).status === 400, "publishing with no Rent/Buy choice is refused");
  check((await call(`/properties/${id}`, { method: "PUT", body: { public_listing: 1, offer_rent: 1 } })).status === 400, "offering to rent without a rent price is refused");
  const noSale = await call("/properties", { method: "POST", body: { name: `Plot ${tag}`, property_type: "land", status: "available", price: 0, location: "Pwani", offer_buy: 1, public_listing: 1 } });
  check(noSale.status === 400, "offering to buy without a sale price is refused");

  const published = await call(`/properties/${id}`, { method: "PUT", body: {
    offer_buy: 1, offer_rent: 1, rent_price: 2800000, rent_period: "month",
    summary: "Three-bedroom villa with a garden.", features: "Private garden\nBackup power\n", public_listing: 1,
  } });
  check(published.status === 200 && published.body.public_listing === true && published.body.public_listing_status === "approved", "published directly, no approval step");
  check((await upload(`/properties/${id}/images`)).status === 201, "uploaded a property photo");

  console.log("\n=== what the public website receives ===");
  const listed = (await publicList()).find((p) => p.id === id);
  check(Boolean(listed), "the published property is in /public/properties");
  check(listed && JSON.stringify(listed.services) === JSON.stringify(["rent", "buy"]), `services are rent + buy (${listed?.services})`);
  check(listed?.price.sale === 185000000 && listed?.price.rent?.amount === 2800000 && listed?.price.rent?.period === "month", "sale and rent prices come through");
  check(listed?.type === "Villa" && listed?.status === "available" && listed?.bedrooms === 3, "type, status and rooms come through");
  check(listed?.project?.name === `Hillside ${tag}`, "its project (category) is named");
  check(JSON.stringify(listed?.features) === JSON.stringify(["Private garden", "Backup power"]), "features arrive as a list");
  const forbidden = ["owner_id", "created_by", "department_id", "visibility", "sector", "organization_id", "public_listing_status"];
  check(listed && forbidden.every((key) => !(key in listed)), "no internal or ownership fields are exposed");
  check((await publicList("?service=rent")).some((p) => p.id === id) && (await publicList("?service=buy")).some((p) => p.id === id), "listed under both Rent and Buy");
  check((await call("/public/properties?service=lease", { auth: false })).status === 400, "an unknown service is rejected");
  const photoUrl = listed?.photos?.[0]?.url;
  const picture = await fetch(photoUrl);
  check(picture.status === 200 && picture.headers.get("content-type") === "image/png", `the photo is served without a login (${picture.status})`);

  console.log("\n=== projects are categories derived from their homes ===");
  const projects = (await call("/public/projects", { auth: false })).body;
  const publicProject = projects.find((p) => p.slug === String(project.body.id));
  // A project offers what its open homes offer: this home is to rent and to buy.
  check(Boolean(publicProject) && JSON.stringify(publicProject.services) === JSON.stringify(["buy", "rent"]), "the project appears with the services its homes are offered for");
  check((await call("/public/projects?service=rent", { auth: false })).body.some((p) => p.slug === String(project.body.id)), "a project with a home to rent is listed for rent");
  check(publicProject?.location === "Dar es Salaam" && publicProject?.photos?.length === 1, "location and cover photo come from its homes");
  check((await call("/projects/1/images", { auth: true })).status === 404, "projects have no photo endpoints of their own");

  console.log("\n=== a visitor requests a property (no login) ===");
  const request = (body) => call("/public/requests", { method: "POST", auth: false, body });
  const good = { property: id, service: "buy", name: "Asha Test", phone: "+255 712 000 111", email: "asha@example.com", budget: 190000000, preferred_contact: "whatsapp", message: "Can I view on Saturday?" };
  const sent = await request(good);
  check(sent.status === 201 && /^W-\d+$/.test(sent.body.reference), `request accepted with a reference (${sent.body.reference})`);
  const lead = (await query("SELECT * FROM leads WHERE id=$1", [Number(sent.body.reference.slice(2))])).rows[0];
  check(lead?.source === "website" && lead?.service === "buy" && Number(lead?.property_id) === id, "it became a website Lead for that property and service");
  check(lead?.phone === good.phone && lead?.email === good.email && Number(lead?.budget) === good.budget && lead?.preferred_contact === "whatsapp", "name, phone, email, budget and contact means are recorded");
  check(lead?.status === "new" && lead?.notes.includes(`Villa ${tag}`) && lead?.notes.includes("Saturday"), "the lead notes name the property and keep the message");
  check((await request({ ...good, phone: "12" })).status === 400, "a bad phone number is refused");
  check((await request({ ...good, budget: "" })).status === 400, "a missing budget is refused");
  check((await request({ ...good, name: "" })).status === 400, "a missing name is refused");
  check((await request({ ...good, email: "", preferred_contact: "email" })).status === 400, "choosing email without an email is refused");
  check((await request({ ...good, property: 999999 })).status === 404, "an unknown property is refused");
  const beforeBot = Number((await query("SELECT COUNT(*) FROM leads")).rows[0].count);
  const bot = await request({ ...good, website: "http://spam.example" });
  const afterBot = Number((await query("SELECT COUNT(*) FROM leads")).rows[0].count);
  check(bot.status === 201 && afterBot === beforeBot, "a bot filling the hidden field gets a quiet 'ok' and no lead");
  let limited = 0;
  for (let i = 0; i < 6; i += 1) if ((await request({ ...good, phone: "+255 799 555 000" })).status === 429) limited += 1;
  check(limited >= 1, `the same phone flooding requests is slowed down (${limited} refused)`);
  await call(`/properties/${id}`, { method: "PUT", body: { status: "sold" } });
  check((await request({ ...good, phone: "+255 700 111 222" })).status === 409, "a request for a sold property is refused");

  console.log("\n=== the website follows the property's real status ===");
  // Sold and rented properties stay on the website, marked for their category.
  const soldRow = (await publicList()).find((p) => p.id === id);
  check(soldRow?.availability?.buy === "sold", "a SOLD property stays listed, marked sold on the Buy side");
  const soldDetail = await call(`/public/properties/${id}`, { auth: false });
  check(soldDetail.status === 200 && soldDetail.body.availability?.buy === "sold", "an old link still explains that it is sold");
  await call(`/properties/${id}`, { method: "PUT", body: { status: "leased" } });
  check((await call(`/public/properties/${id}`, { auth: false })).body.availability?.rent === "rented", "leased is shown to the public as 'rented' on the Rent side");
  await call(`/properties/${id}`, { method: "PUT", body: { status: "available", offer_rent: 0 } });
  check(!(await publicList("?service=rent")).some((p) => p.id === id) && (await publicList("?service=buy")).some((p) => p.id === id), "unticking Rent removes it from Rent only");
  await call(`/properties/${id}`, { method: "PUT", body: { public_listing: 0 } });
  check((await call(`/public/properties/${id}`, { auth: false })).status === 404, "an unpublished property is not found publicly");
  check((await fetch(photoUrl)).status === 404, "its photo is no longer served");

  console.log("\n=== contact enquiries ===");
  const enquiry = await call("/public/enquiries", { method: "POST", auth: false, body: { name: "Juma", phone: "0713 222 333", email: "", topic: "diaspora", message: "I live abroad." } });
  check(enquiry.status === 201, `an enquiry is accepted (${enquiry.status})`);
  const enquiryLead = (await query("SELECT * FROM leads WHERE id=$1", [Number(enquiry.body.reference.slice(2))])).rows[0];
  check(enquiryLead?.source === "website-contact" && enquiryLead?.notes.includes("Diaspora"), "it became a website-contact Lead with its topic");
  check((await call("/public/enquiries", { method: "POST", auth: false, body: { name: "Juma", phone: "0713 222 333", message: "" } })).status === 400, "an empty message is refused");

  console.log("\n=== Sales hands a lead to Customer Service ===");
  const admin = await signIn("admin@mkuyu.local");
  const roles = (await call("/org/roles", { as: admin })).body;
  const departments = (await call("/org/departments", { as: admin })).body;
  const roleId = (name) => roles.find((r) => r.name === name).id;
  const deptId = (name) => departments.find((d) => d.name === name).id;
  const salesEmail = `sales.officer.${tag}@test.mkuyu.local`;
  const created = await call("/org/users", { method: "POST", as: admin, body: { display_name: "Sales Officer", email: salesEmail, password: "TempPass#2026", role_ids: [roleId("Sales & Marketing Officer")], department_ids: [deptId("SALES, MARKETING & OPERATIONS")] } });
  check(created.status === 201, "created a Sales & Marketing Officer");
  const officer = await signIn(salesEmail, "TempPass#2026");
  const assignees = (await call("/org/tasks/assignees", { as: officer })).body;
  const csId = (await query("SELECT id FROM users WHERE email='cs@demo.mkuyu.local'")).rows[0].id;
  const financeId = (await query("SELECT id FROM users WHERE email='finance@demo.mkuyu.local'")).rows[0].id;
  check(assignees.some((u) => u.id === csId), "Customer Service staff are offered as assignees");
  check(!assignees.some((u) => u.id === financeId), "Finance staff are not offered");
  const handoff = await call("/org/tasks", { method: "POST", as: officer, body: { title: "Contact Asha Test (buy request)", description: `Lead ${sent.body.reference}`, assigned_to: csId, priority: "high" } });
  check(handoff.status === 201, `Sales assigns the lead to Customer Service (${handoff.status})`);
  const toFinance = await call("/org/tasks", { method: "POST", as: officer, body: { title: "x", assigned_to: financeId } });
  check(toFinance.status === 403, `Sales cannot assign work to Finance (${toFinance.status})`);
  const cs = await signIn("cs@demo.mkuyu.local");
  const csTasks = (await call("/org/tasks?box=mine", { as: cs })).body;
  check(csTasks.some((t) => t.id === handoff.body.id), "Customer Service sees the assignment in their Assignments");

  console.log("\n=== Requests: one request followed from arrival to client ===");
  const leadId = Number(sent.body.reference.slice(2));
  const stageOf = async () => (await call("/org/requests", { as: officer })).body.find((r) => r.id === leadId);
  const requests = (await call("/org/requests", { as: officer })).body;
  check(Array.isArray(requests) && requests.some((r) => r.id === leadId), "the website request is listed under Requests");
  // Requests holds website requests and Contact-page messages (the latter for
  // Customer Service to answer), never leads typed in by staff.
  check(requests.every((r) => ["website", "website-contact"].includes(r.source)), "Requests holds only website requests and Contact-page messages");
  check((await stageOf())?.property_name === `Villa ${tag}` && !(await stageOf())?.task_id, "it names the property and has no hand-off yet");
  const officerId = created.body.id;
  const task = await call("/org/tasks", { method: "POST", as: officer, body: { title: "Contact Asha Test (buy request)", assigned_to: csId, reviewer_id: officerId, priority: "high" } });
  check(task.status === 201, `assigned Customer Service with Sales as reviewer (${task.status})`);
  check((await call(`/org/requests/${leadId}/handed-off`, { method: "POST", as: officer, body: { task_id: 999999 } })).status === 400, "a hand-off cannot point at an unknown task");
  // A Contact-page message is followed under Requests too, so it may be handed
  // to Customer Service - still only to a real task the caller assigned.
  check((await call(`/org/requests/${enquiryLead.id}/handed-off`, { method: "POST", as: officer, body: { task_id: 999999 } })).status === 400, "a Contact-page message can be handed off, but only to a real task");
  const csOnly = (await call("/org/tasks/assignees?department=CUSTOMER%20SERVICE", { as: officer })).body;
  const csMembers = (await query("SELECT ud.user_id FROM user_departments ud JOIN departments d ON d.id=ud.department_id WHERE d.name='CUSTOMER SERVICE'")).rows.map((r) => Number(r.user_id));
  check(csOnly.length > 0 && csOnly.some((u) => u.id === csId), "the hand-off list offers Customer Service staff");
  check(csOnly.every((u) => csMembers.includes(Number(u.id))), `the hand-off list offers ONLY Customer Service staff (${csOnly.map((u) => u.display_name).join(", ")})`);
  check(!csOnly.some((u) => u.id === officerId), "the Sales officer is not offered to themselves");
  const salesColleague = (await query("SELECT id FROM users WHERE email='sales@demo.mkuyu.local'")).rows[0].id;
  const wrong = await call("/org/tasks", { method: "POST", as: officer, body: { title: "Wrong person", assigned_to: salesColleague } });
  check(wrong.status === 201, "(a task to a Sales colleague can still be assigned as ordinary work)");
  check((await call(`/org/requests/${leadId}/handed-off`, { method: "POST", as: officer, body: { task_id: wrong.body.id } })).status === 400, "a request cannot be handed to someone outside Customer Service");
  const linked = await call(`/org/requests/${leadId}/handed-off`, { method: "POST", as: officer, body: { task_id: task.body.id } });
  check(linked.status === 200 && linked.body.status === "handed_off", `the request is tied to its Customer Service task (${linked.status})`);
  let row = await stageOf();
  check(row?.task_status === "assigned" && row?.task_assignee && Number(row?.task_assignee_id) === Number(csId), "Requests shows who in Customer Service has it");
  const act = (who, action) => call(`/org/tasks/${task.body.id}/actions`, { method: "POST", as: who, body: { action } });
  check((await act(cs, "start")).status === 200, "Customer Service starts the task");
  check((await act(cs, "submit")).status === 400, "a customer request cannot be submitted without its outcome report");
  check((await call(`/org/tasks/${task.body.id}/outcome`, { method: "POST", as: cs, body: { outcome: "interested", note: "Will visit next month" } })).status === 200, "Customer Service contacts the customer and reports back");
  check((await stageOf())?.task_status === "submitted", "Requests shows the report waiting for Sales");
  check((await act(officer, "begin_review")).status === 200 && (await act(officer, "approve")).status === 200, "Sales reviews and approves the report");
  check((await stageOf())?.task_status === "approved", "Requests shows the customer as contacted");
  const client = await call(`/org/leads/${leadId}/convert`, { method: "POST", as: officer, body: {} });
  check([200, 201].includes(client.status), `Sales converts the request into a client (${client.status})`);
  row = await stageOf();
  check(Number(row?.client_id) === Number(client.body.id), "Requests shows it became a client");
  check((await call(`/org/requests/${leadId}/handed-off`, { method: "POST", as: officer, body: { task_id: task.body.id } })).status === 409, "a request that is already a client cannot be handed off again");
  check((await call("/org/requests", { as: await signIn("finance@demo.mkuyu.local") })).status === 403, "staff without the Leads module (Finance) cannot read Requests");

  console.log("\n=== a returning customer is recognised ===");
  const tailPhone = `+255 74${String(Date.now()).slice(-7)}`;
  const firstVisit = await call("/public/requests", { method: "POST", auth: false, body: { property: (await call("/properties", { method: "POST", body: { name: `Repeat ${tag}`, property_type: "house", status: "available", price: 50000000, location: "Arusha", area: 100, offer_buy: 1, public_listing: 1 } })).body.id, service: "buy", name: "Repeat Customer", phone: tailPhone, email: `repeat.${tag}@example.com`, budget: 45000000, preferred_contact: "phone" } });
  const firstId = Number(firstVisit.body.reference.slice(2));
  let firstRow = (await call("/org/requests", { as: officer })).body.find((r) => r.id === firstId);
  check(firstRow && !firstRow.existing_client_id && !firstRow.client_id, "a first-time customer is a plain new request (not a client)");
  const madeClient = await call(`/org/leads/${firstId}/convert`, { method: "POST", as: officer, body: {} });
  check(madeClient.status === 201, "the first request is converted into a client");
  const repeatProperty = (await call("/properties", { method: "POST", body: { name: `Repeat Two ${tag}`, property_type: "house", status: "available", price: 60000000, location: "Arusha", area: 110, offer_buy: 1, public_listing: 1 } })).body.id;
  const again = await call("/public/requests", { method: "POST", auth: false, body: { property: repeatProperty, service: "buy", name: "Repeat Customer", phone: "07" + tailPhone.slice(-8), email: "", budget: 55000000, preferred_contact: "phone" } });
  const againId = Number(again.body.reference.slice(2));
  const againRow = (await call("/org/requests", { as: officer })).body.find((r) => r.id === againId);
  check(Number(againRow?.existing_client_id) === Number(madeClient.body.id) && !againRow?.client_id && !againRow?.task_id, "the same customer requesting again (same phone, other format) is shown as an existing client, still waiting for hand-off");
  const clientsBefore = Number((await query("SELECT COUNT(*) FROM clients WHERE right(regexp_replace(phone,'\\D','','g'),9)=$1", [tailPhone.replace(/\D/g, "").slice(-9)])).rows[0].count);
  const reuse = await call(`/org/leads/${againId}/convert`, { method: "POST", as: officer, body: {} });
  const clientsAfter = Number((await query("SELECT COUNT(*) FROM clients WHERE right(regexp_replace(phone,'\\D','','g'),9)=$1", [tailPhone.replace(/\D/g, "").slice(-9)])).rows[0].count);
  check(reuse.status === 200 && Number(reuse.body.id) === Number(madeClient.body.id) && clientsAfter === clientsBefore, "converting the repeat request reuses the existing client: no duplicate client record");
  check((await call(`/org/leads/${againId}/convert`, { method: "POST", as: officer, body: {} })).status === 409, "a request cannot be converted twice");

  console.log("\n=== Customer Service reports the outcome back to Sales ===");
  const home = await call("/properties", { method: "POST", body: { project_id: project.body.id, name: `Flat ${tag}`, property_type: "apartment", status: "available", price: 90000000, location: "Dar es Salaam", area: 90, bedrooms: 2, bathrooms: 1, offer_buy: 1, public_listing: 1 } });
  check(home.status === 201, "a second home is published for the outcome checks");
  const newRequest = async (name, phone) => {
    const r = await call("/public/requests", { method: "POST", auth: false, body: { property: home.body.id, service: "buy", name, phone, email: "", budget: 80000000, preferred_contact: "phone", message: "" } });
    return Number(r.body.reference.slice(2));
  };
  const handOff = async (requestId) => {
    const t = await call("/org/tasks", { method: "POST", as: officer, body: { title: "Contact customer", assigned_to: csId, reviewer_id: officerId, priority: "high" } });
    await call(`/org/requests/${requestId}/handed-off`, { method: "POST", as: officer, body: { task_id: t.body.id } });
    return t.body.id;
  };
  const rowOf = async (requestId) => (await call("/org/requests", { as: officer })).body.find((r) => r.id === requestId);
  const outcome = (taskId, body, who = cs) => call(`/org/tasks/${taskId}/outcome`, { method: "POST", as: who, body });
  const approve = async (taskId) => { await call(`/org/tasks/${taskId}/actions`, { method: "POST", as: officer, body: { action: "begin_review" } }); return call(`/org/tasks/${taskId}/actions`, { method: "POST", as: officer, body: { action: "approve" } }); };

  // Appointment arranged
  const r1 = await newRequest("Outcome Appointment", "+255 713 100 001");
  const t1 = await handOff(r1);
  const csTask = (await call("/org/tasks?box=mine", { as: cs })).body.find((t) => t.id === t1);
  check(Number(csTask?.request_id) === r1 && csTask?.request_customer === "Outcome Appointment", "Customer Service sees which customer request the task is");
  check((await outcome(t1, { outcome: "appointment", note: "Wants Saturday" }, officer)).status === 403, "only the Customer Service officer given the task can report its outcome");
  check((await outcome(t1, { outcome: "appointment" })).status === 400, "an appointment needs a date and time");
  check((await outcome(t1, { outcome: "appointment", appointment_at: "2020-01-01T10:00:00Z" })).status === 400, "an appointment in the past is refused");
  const when = new Date(Date.now() + 3 * 86400000); when.setUTCHours(8, 0, 0, 0);
  const sentOutcome = await outcome(t1, { outcome: "appointment", appointment_at: when.toISOString(), appointment_type: "viewing", note: "Wants to view with spouse" });
  check(sentOutcome.status === 200 && sentOutcome.body.status === "submitted", `one step reports the outcome and submits the task, even before 'Start' (${sentOutcome.status}, ${sentOutcome.body.status})`);
  check((await call("/org/tasks/attention", { as: officer })).body.review >= 1, "Sales is notified: the report counts in Sales's review badge");
  let row1 = await rowOf(r1);
  check(row1?.outcome === "appointment" && row1?.task_status === "submitted" && !row1?.appointment_id, "Requests shows the reported appointment, waiting for Sales");
  const detail1 = (await call(`/org/tasks/${t1}`, { as: officer })).body;
  check(detail1.request_outcome === "appointment" && (detail1.comments || []).some((c) => c.body.includes("Appointment arranged")), "the task keeps the outcome as its submission comment (history)");
  check((await outcome(t1, { outcome: "declined", note: "x" })).status === 409, "an outcome cannot be reported twice");
  check((await approve(t1)).status === 200, "Sales approves the report");
  row1 = await rowOf(r1);
  const appt = row1?.appointment_id ? (await query("SELECT * FROM appointments WHERE id=$1", [row1.appointment_id])).rows[0] : null;
  check(Boolean(appt) && appt.appointment_type === "viewing" && new Date(appt.starts_at).getTime() === when.getTime() && Number(appt.property_id) === home.body.id, "approval books the appointment in Appointments, for that property and time");
  check(Boolean(row1?.client_id) && Number(appt?.client_id) === Number(row1.client_id), "and registers the customer as a client");
  const apptList = (await call("/appointments", { as: officer })).body;
  check((Array.isArray(apptList) ? apptList : apptList?.data || []).some((a) => a.id === appt?.id), "the Sales officer can see the booked appointment");

  // Declined
  const r2 = await newRequest("Outcome Declined", "+255 713 100 002");
  const t2 = await handOff(r2);
  check((await outcome(t2, { outcome: "declined" })).status === 400, "'declined' needs the reason");
  check((await outcome(t2, { outcome: "declined", note: "Bought elsewhere" })).status === 200, "Customer Service reports that the customer declined");
  await approve(t2);
  const row2 = await rowOf(r2);
  check(row2?.status === "closed" && !row2?.client_id && !row2?.appointment_id, "after approval the request is closed, with no client or appointment created");

  // Unreachable, then handed off again
  const r3 = await newRequest("Outcome Unreachable", "+255 713 100 003");
  const t3 = await handOff(r3);
  check((await outcome(t3, { outcome: "unreachable", note: "No answer twice" })).status === 200, "Customer Service reports the customer could not be reached");
  await approve(t3);
  check((await rowOf(r3))?.status === "unreachable", "after approval the request is marked not reached");
  const t3b = await handOff(r3);
  const row3 = await rowOf(r3);
  check(Number(row3?.task_id) === t3b && !row3?.outcome && row3?.task_status === "assigned", "Sales can hand it off again, starting fresh");
  check((await outcome(t3b, { outcome: "maybe" })).status === 400, "an unknown outcome is refused");
  check((await outcome(t3b, { outcome: "interested", note: "Call back next week" })).status === 200, "the new attempt reports 'interested'");

  console.log("\n=== Assignments: every task reaches its person ===");
  const people = ["cs@demo.mkuyu.local", "finance@demo.mkuyu.local", "sales@demo.mkuyu.local"];
  const adminAssignees = (await call("/org/tasks/assignees", { as: admin })).body;
  check(adminAssignees.every((u) => Array.isArray(u.departments)), "every assignee comes with their departments (for the Department picker)");
  const csDept = departments.find((d) => d.name === "CUSTOMER SERVICE").id;
  check(adminAssignees.filter((u) => u.departments.some((d) => d.id === csDept)).every((u) => csMembers.includes(Number(u.id))), "choosing Customer Service offers only its members");
  const sent2 = [];
  for (const email of people) {
    const uid = (await query("SELECT id FROM users WHERE email=$1", [email])).rows[0].id;
    const t = await call("/org/tasks", { method: "POST", as: admin, body: { title: `Delivery check ${tag} for ${email}`, assigned_to: uid, priority: "medium" } });
    check(t.status === 201, `the admin assigns a task to ${email} (${t.status})`);
    sent2.push({ email, id: t.body.id });
  }
  for (const { email, id: taskId } of sent2) {
    const who = await signIn(email);
    const mine = (await call("/org/tasks?box=mine", { as: who })).body;
    const attention = (await call("/org/tasks/attention", { as: who })).body;
    check(mine.some((t) => t.id === taskId) && attention.mine >= 1, `${email} really receives it: in My tasks and in the attention count`);
    const others = sent2.filter((x) => x.email !== email).map((x) => x.id);
    check(!mine.some((t) => others.includes(t.id)), `${email} does not receive other people's tasks`);
  }
  const all = (await call("/org/tasks?box=all", { as: admin })).body;
  check(sent2.every((x) => all.some((t) => t.id === x.id)), "All assignments shows every task to the admin");
  const officerAll = (await call("/org/tasks?box=all", { as: officer })).body;
  check(officerAll.some((t) => t.id === task.body.id) && !officerAll.some((t) => t.id === sent2[1].id), "a Sales officer's All assignments shows their work, not Finance's");
  check((await call("/org/tasks?box=everything", { as: admin })).status === 400, "an unknown box is refused");
  const reviewers = (await call("/org/tasks/reviewers", { as: officer })).body;
  check(Array.isArray(reviewers) && reviewers.every((u) => Array.isArray(u.departments)), "reviewers come with their departments, so the form can keep them to the chosen department");
  const detail = (await call(`/org/tasks/${sent2[0].id}`, { as: admin })).body;
  const assignedEntry = (detail.history || []).find((h) => h.action === "task_assigned");
  check(Boolean(assignedEntry) && assignedEntry.actor_name && assignedEntry.assignee_name, `the task history keeps who assigned it and to whom (${assignedEntry?.actor_name} -> ${assignedEntry?.assignee_name})`);
  const csAttention = (await call("/org/tasks/attention", { as: await signIn("cs@demo.mkuyu.local") })).body;
  check(csAttention.total >= 1, `the assignee's notification badge counts the new task (${csAttention.total})`);

  console.log("\n=== boundaries ===");
  const cors = await call("/public/properties", { auth: false, headers: { Origin: "http://localhost:5500" } });
  check(cors.status === 200 && cors.headers.get("access-control-allow-origin") === "http://localhost:5500", "the public website's origin may read the public API");
  const corsPost = await call("/public/requests", { method: "POST", auth: false, headers: { Origin: "http://localhost:5500" }, body: { ...good, phone: "+255 788 000 999" } });
  check(corsPost.headers.get("access-control-allow-origin") === "http://localhost:5500", "the website's origin may send a request");
  const crossWrite = await call("/properties", { method: "POST", body: { name: "x" }, headers: { Origin: "http://evil.example" } });
  check(crossWrite.status === 403, `a cross-origin write to the staff API is refused (${crossWrite.status})`);
  check((await call("/properties", { auth: false })).status === 401, "the staff API still requires a login");
} catch (error) {
  failures += 1;
  console.error(error);
}

console.log(`\n${failures ? `${failures} PUBLIC API CHECK(S) FAILED` : "PUBLIC_API_ALL_PASSED"}`);
if (failures) process.exitCode = 1;
await closeDatabase();
await server.stop();
