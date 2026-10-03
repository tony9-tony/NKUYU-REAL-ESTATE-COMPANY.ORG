// Buildings: a project with floors and numbered units, each unit offered to
// rent, to buy or both, shown on the website floor by floor.
import { demoPasswordFor } from "./backend/src/org/demoCredentials.js";

const { startIsolatedServer, prepareTestDatabase } = await import("./test_support/harness.mjs");
await prepareTestDatabase();
const { closeDatabase, queryOne } = await import("./backend/src/db.js");
const server = await startIsolatedServer({ label: "buildings", port: 3237 });
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };
async function call(path, { token, method = "GET", body } = {}) {
  const r = await fetch(server.base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const login = async (email) => (await call("/auth/login", { method: "POST", body: { email, password: demoPasswordFor(email) } })).body.token;

try {
  const md = await login("md@demo.mkuyu.local");
  const sales = await login("sales@demo.mkuyu.local");
  const name = `Test Tower ${Date.now()}`;
  const project = await call("/projects", { token: md, method: "POST", body: { name, kind: "building", location: "Upanga, Dar es Salaam" } });
  check(project.status === 201 && project.body.kind === "building" && project.body.location === "Upanga, Dar es Salaam", "a project can be a building with a location");
  const bad = await call("/projects", { token: md, method: "POST", body: { name: "x", kind: "castle" } });
  check(bad.status === 400, "an unknown project kind is refused");
  const pid = project.body.id;

  const unit = (unit_number, floor, extra = {}) => call("/properties", { token: sales, method: "POST", body: { project_id: pid, name: `${name} · ${unit_number}`, property_type: "apartment", price: 150000000, location: "Upanga", area: 90, bedrooms: 2, floor, unit_number, public_listing: true, offer_buy: true, offer_rent: true, rent_price: 1500000, ...extra } });
  const u101 = await unit("101", 1);
  check(u101.status === 201 && u101.body.floor === 1 && u101.body.unit_number === "101", "a unit keeps its floor and unit number");
  const rentOnly = await unit("G01", 0, { offer_buy: false, price: 0 });
  check(rentOnly.status === 201 && rentOnly.body.floor === 0, "a ground-floor unit can be offered to rent only");
  const saleOnly = await unit("201", 2, { offer_rent: false, rent_price: null });
  check(saleOnly.status === 201, "a unit can be offered to buy only");
  check((await unit("101", 1)).status === 409, "the same unit number cannot be used twice in one project");
  check((await unit(" 101 ", 3)).status === 409, "unit numbers are compared without spaces");
  check((await unit("102", 2.5)).status === 400, "a floor must be a whole number");
  check((await unit("<b>", 1)).status === 400, "a unit number with odd characters is refused");
  const edit = await call(`/properties/${saleOnly.body.id}`, { token: sales, method: "PUT", body: { unit_number: "101" } });
  check(edit.status === 409, "editing a unit onto a taken number is refused");
  const keep = await call(`/properties/${u101.body.id}`, { token: sales, method: "PUT", body: { price: 155000000 } });
  check(keep.status === 200 && keep.body.unit_number === "101" && keep.body.floor === 1, "an edit that leaves the number alone keeps it");

  // Website
  const rentSide = (await call("/public/projects?service=rent")).body;
  const ours = rentSide.find((entry) => entry.name === name);
  check(Boolean(ours) && ours.kind === "building" && ours.services.includes("rent") && ours.services.includes("buy"), "a building with units to rent appears on the Rent side");
  const detail = await call(`/public/projects/${pid}`);
  check(detail.status === 200 && detail.body.properties.length === 3, "the project page lists its published units");
  check(detail.body.properties.map((u) => u.floor).join(",") === "0,1,2", "units come ordered by floor");
  check(detail.body.properties.every((u) => "unit" in u && "floor" in u) && !JSON.stringify(detail.body).includes("owner_id"), "units carry floor and unit number, and nothing internal");
  check((await call("/public/projects/999999")).status === 404, "an unknown project is not found");

  // A unit offered for both, once rented, leaves the Buy side until the rent ends.
  await call(`/properties/${u101.body.id}`, { token: sales, method: "PUT", body: { rent_status: "rented" } });
  const buySide = (await call("/public/properties?service=buy")).body;
  check(!buySide.some((p) => p.id === u101.body.id), "a rented unit is not listed to buy");
  const rentedUnit = (await call(`/public/projects/${pid}`)).body.properties.find((p) => p.id === u101.body.id);
  check(rentedUnit && JSON.stringify(rentedUnit.services) === JSON.stringify(["rent"]) && rentedUnit.availability.buy === null && rentedUnit.availability.rent === "rented", "the rented unit shows as rented, with no sale offer");
  const buyRequest = await call("/public/requests", { method: "POST", body: { property: String(u101.body.id), service: "buy", name: "Late Buyer", phone: "+255700111222", budget: 150000000, preferred_contact: "phone" } });
  check(buyRequest.status === 409, "a buy request for a rented unit is refused");
  const staffView = (await call(`/properties/${u101.body.id}`, { token: sales })).body;
  check(staffView.status === "leased" && staffView.sale_status === "available", "staff see it as rented; its sale state is kept for later");
  await call(`/properties/${u101.body.id}`, { token: sales, method: "PUT", body: { rent_status: "available" } });
  check((await call("/public/properties?service=buy")).body.some((p) => p.id === u101.body.id), "when the rent ends the unit is back on the Buy side");

  // Building photos: a unit without photos of its own shows the building's.
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), "tower.png");
  const uploaded = await fetch(`${server.base}/properties/${saleOnly.body.id}/images`, { method: "POST", headers: { Authorization: `Bearer ${sales}` }, body: form });
  check(uploaded.status === 201, "a photo is uploaded on one unit");
  const withPhotos = (await call(`/public/projects/${pid}`)).body.properties;
  const own = withPhotos.find((u) => u.id === saleOnly.body.id);
  const borrowed = withPhotos.find((u) => u.id === rentOnly.body.id);
  check(own?.photos.length === 1 && !own.photos[0].shared, "that unit shows its own photo");
  check(borrowed?.photos.length === 1 && borrowed.photos[0].shared === true && borrowed.photos[0].url === own.photos[0].url, "a unit without photos shows the building's photo, marked as shared");
  const single = (await call(`/public/properties/${rentOnly.body.id}`)).body;
  check(single.photos?.[0]?.shared === true, "the unit page shows the building photo too");

  // A visitor picks a unit and sends a request: Sales sees which unit.
  const phone = `+2557${String(Date.now()).slice(-8)}`;
  const request = await call("/public/requests", { method: "POST", body: { property: String(u101.body.id), service: "rent", name: "Unit Tester", phone, email: "", preferred_contact: "phone", budget: 1500000, message: "I like this one" } });
  check(request.status === 201, `a visitor can request a unit without an account (${request.status})`);
  const lead = await queryOne("SELECT notes FROM leads WHERE phone = $1 ORDER BY id DESC LIMIT 1", [phone]);
  check(Boolean(lead) && /Unit 101/.test(lead.notes || "") && /Floor 1/.test(lead.notes || "") && (lead.notes || "").includes(name), "the request reaches Sales naming the unit, floor and building");
} finally {
  await server.stop();
  await closeDatabase();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall building checks passed");
process.exit(failures ? 1 : 0);
