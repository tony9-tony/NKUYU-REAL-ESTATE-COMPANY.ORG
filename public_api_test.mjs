// ---------------------------------------------------------------------------
// Public website API.
//
//   Sales Officer → Internal MKUYU System → /api/v1/public/* → public website
//
// Proves the Sales Officer can offer a property or project for Rent, Buy or
// both and publish it directly, that the public API returns only published
// records with only public fields, that sold/rented homes leave the listings,
// that pictures are served only while published, and that the staff API is
// still closed to anyone without a login.
// ---------------------------------------------------------------------------
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { closeDatabase } from "./backend/src/db.js";
import { legacyPasswordFor } from "./backend/src/org/demoCredentials.js";

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ label: "public-api", port: 3217 });
const base = server.base;
let token = "";

async function call(path, { method = "GET", body, auth = true, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(auth && token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, body: await response.json().catch(() => ({})) };
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
async function upload(path) {
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), "photo.png");
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const publicList = async (query = "") => (await call(`/public/properties${query}`, { auth: false })).body;
const tag = Date.now().toString(36);

try {
  console.log("=== the Sales Officer publishes ===");
  const login = await call("/auth/login", { method: "POST", body: { email: "sales@demo.mkuyu.local", password: legacyPasswordFor("sales@demo.mkuyu.local") } });
  check(login.status === 200, `signed in as the Sales officer (${login.status})`);
  token = login.body.token;

  const project = await call("/projects", { method: "POST", body: { name: `Hillside ${tag}`, location: "Arusha", summary: "Homes to rent", offer_rent: 1, public_listing: 1 } });
  check(project.status === 201 && project.body.offer_rent === true && project.body.public_listing === true, `created and published a Rent project (${project.status})`);

  const draft = await call("/properties", { method: "POST", body: { project_id: project.body.id, name: `Villa ${tag}`, property_type: "villa", status: "available", price: 185000000, location: "Dar es Salaam", area: 240, bedrooms: 3, bathrooms: 2 } });
  check(draft.status === 201 && draft.body.public_listing === false, "a new property is NOT published by default");
  const id = draft.body.id;
  check(!(await publicList()).some((p) => p.id === id), "an unpublished property is not in the public listings");

  check((await call(`/properties/${id}`, { method: "PUT", body: { public_listing: 1 } })).status === 400, "publishing with no Rent/Buy choice is refused");
  check((await call(`/properties/${id}`, { method: "PUT", body: { public_listing: 1, offer_rent: 1 } })).status === 400, "offering to rent without a rent price is refused");
  const noSale = await call("/properties", { method: "POST", body: { name: `Plot ${tag}`, property_type: "land", status: "available", price: 0, location: "Pwani", offer_buy: 1, public_listing: 1 } });
  check(noSale.status === 400, "offering to buy without a sale price is refused");

  const published = await call(`/properties/${id}`, { method: "PUT", body: {
    offer_buy: 1, offer_rent: 1, rent_price: 2800000, rent_period: "month",
    summary: "Three-bedroom villa with a garden.", features: "Private garden\nBackup power\n", public_listing: 1,
  } });
  check(published.status === 200 && published.body.public_listing === true && published.body.public_listing_status === "approved", "published directly, no approval step");
  const photo = await upload(`/properties/${id}/images`);
  check(photo.status === 201, `uploaded a property photo (${photo.status})`);

  console.log("\n=== what the public website receives ===");
  const listed = (await publicList()).find((p) => p.id === id);
  check(Boolean(listed), "the published property is in /public/properties");
  check(listed && JSON.stringify(listed.services) === JSON.stringify(["rent", "buy"]), `services are rent + buy (${listed?.services})`);
  check(listed?.price.sale === 185000000 && listed?.price.rent?.amount === 2800000 && listed?.price.rent?.period === "month", "sale and rent prices come through");
  check(listed?.type === "Villa" && listed?.status === "available" && listed?.bedrooms === 3, "type, status and rooms come through");
  check(listed?.project?.name === `Hillside ${tag}`, "its published project is named");
  check(JSON.stringify(listed?.features) === JSON.stringify(["Private garden", "Backup power"]), "features arrive as a list");
  const forbidden = ["owner_id", "created_by", "department_id", "visibility", "sector", "organization_id", "public_listing_status"];
  check(listed && forbidden.every((key) => !(key in listed)), "no internal or ownership fields are exposed");
  check((await publicList("?service=rent")).some((p) => p.id === id) && (await publicList("?service=buy")).some((p) => p.id === id), "listed under both Rent and Buy");
  check((await call("/public/properties?service=lease", { auth: false })).status === 400, "an unknown service is rejected");

  const photoUrl = listed?.photos?.[0]?.url;
  check(Boolean(photoUrl) && photoUrl.startsWith("http"), "the photo has an absolute public URL");
  const picture = await fetch(photoUrl);
  check(picture.status === 200 && picture.headers.get("content-type") === "image/png", `the photo is served without a login (${picture.status})`);

  console.log("\n=== the website follows the property's real status ===");
  await call(`/properties/${id}`, { method: "PUT", body: { status: "sold" } });
  check(!(await publicList()).some((p) => p.id === id), "a SOLD property leaves the listings");
  const soldDetail = await call(`/public/properties/${id}`, { auth: false });
  check(soldDetail.status === 200 && soldDetail.body.status === "sold", "an old link still explains that it is sold");
  await call(`/properties/${id}`, { method: "PUT", body: { status: "leased" } });
  check((await call(`/public/properties/${id}`, { auth: false })).body.status === "rented", "leased is shown to the public as 'rented'");
  await call(`/properties/${id}`, { method: "PUT", body: { status: "available", offer_rent: 0 } });
  check(!(await publicList("?service=rent")).some((p) => p.id === id) && (await publicList("?service=buy")).some((p) => p.id === id), "unticking Rent removes it from Rent only");

  await call(`/properties/${id}`, { method: "PUT", body: { public_listing: 0 } });
  check((await call(`/public/properties/${id}`, { auth: false })).status === 404, "an unpublished property is not found publicly");
  check((await fetch(photoUrl)).status === 404, "its photo is no longer served");

  console.log("\n=== projects ===");
  const projectPhoto = await upload(`/projects/${project.body.id}/images`);
  check(projectPhoto.status === 201, `uploaded a project photo (${projectPhoto.status})`);
  const projects = (await call("/public/projects", { auth: false })).body;
  const publicProject = projects.find((p) => p.slug === String(project.body.id));
  check(Boolean(publicProject) && JSON.stringify(publicProject.services) === JSON.stringify(["rent"]), "the project is published for Rent");
  check(publicProject?.location === "Arusha" && publicProject?.photos?.length === 1, "its location and photo come through");
  check((await fetch(publicProject.photos[0].url)).status === 200, "the project photo is served");
  check(!(await call("/public/projects?service=buy", { auth: false })).body.some((p) => p.slug === String(project.body.id)), "a Rent-only project is not under Buy");
  await call(`/projects/${project.body.id}`, { method: "PUT", body: { status: "archived" } });
  check(!(await call("/public/projects", { auth: false })).body.some((p) => p.slug === String(project.body.id)), "an archived project leaves the website");

  console.log("\n=== boundaries ===");
  const cors = await call("/public/properties", { auth: false, headers: { Origin: "http://localhost:5500" } });
  check(cors.status === 200 && cors.headers.get("access-control-allow-origin") === "http://localhost:5500", "the public website's origin may read the public API");
  const crossWrite = await call("/properties", { method: "POST", body: { name: "x" }, headers: { Origin: "http://evil.example" } });
  check(crossWrite.status === 403, `a cross-origin write to the staff API is refused (${crossWrite.status})`);
  check((await call("/properties", { auth: false })).status === 401, "the staff API still requires a login");
  check((await call("/public/enquiries", { method: "POST", auth: false, body: {} })).status === 501, "enquiries answer 'not available yet'");
} catch (error) {
  failures += 1;
  console.error(error);
}

console.log(`\n${failures ? `${failures} PUBLIC API CHECK(S) FAILED` : "PUBLIC_API_ALL_PASSED"}`);
if (failures) process.exitCode = 1;
await closeDatabase();
await server.stop();
