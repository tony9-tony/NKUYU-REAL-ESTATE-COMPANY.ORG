// ---------------------------------------------------------------------------
// Regression test: a property picture whose FILE is missing must not produce a
// request that can only 404.
//
// A `property_images` row and its file on disk are stored separately, so the row
// can outlive the file. Before this change the cover was the lowest-id row and
// the photo strip rendered every row, so a property whose picture had been lost
// fired a burst of failing /file requests on every page load.
//
// The rule under test: the server reports what is actually servable, and the
// client only asks for that. The records themselves are never deleted, so this
// also proves the data is left intact.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { closeDatabase, query } from "./backend/src/db.js";
import { legacyPasswordFor } from "./backend/src/org/demoCredentials.js";
import { propertyUploadsDir } from "./backend/src/uploads.js";

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ label: "images", port: 3207 });
const base = server.base;
let token = "";

async function call(path, { method = "GET", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

// A 1x1 PNG, used as a real file so the "available" case is genuinely served.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

console.log("=== property picture availability ===");
try {
  const login = await call("/auth/login", { method: "POST", body: { email: "admin@mkuyu.local", password: legacyPasswordFor("admin@mkuyu.local") } });
  check(login.status === 200 && Boolean(login.body.token), `signed in as the administrator (${login.status})`);
  token = login.body.token;

  const project = await call("/projects", { method: "POST", body: { name: `Image Project ${Date.now()}` } });
  const property = await call("/properties", {
    method: "POST",
    body: { project_id: project.body.id, name: `Image Property ${Date.now()}`, property_type: "villa", status: "available", price: 100, location: "Test", area: 10 },
  });
  const propertyId = property.body.id;
  check(property.status === 201, `created a property (${property.status})`);

  // --- a picture whose file really exists ----------------------------------
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), "real.png");
  const upload = await fetch(`${base}/properties/${propertyId}/images`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  const uploaded = await upload.json();
  check(upload.status === 201, `uploaded a real picture (${upload.status})`);
  check(fs.existsSync(path.join(propertyUploadsDir, uploaded.stored_name)), "the uploaded file is on disk");

  let listed = await call(`/properties/${propertyId}/images`);
  check(Array.isArray(listed.body) && listed.body.length === 1, "the gallery lists the picture");
  check(listed.body[0].available === true, "an on-disk picture is reported available");
  check(Boolean(listed.body[0].file_url), "an available picture still carries its file_url");

  let detail = await call(`/properties/${propertyId}`);
  check(detail.body.cover_image_id === uploaded.id, "the cover is the available picture");
  check(detail.body.image_count === 1, "image_count counts the available picture");
  check((await fetch(`${base}/properties/${propertyId}/images/${uploaded.id}/file`, { headers: { Authorization: `Bearer ${token}` } })).status === 200, "the real picture is served with 200");

  // --- a record whose file has vanished ------------------------------------
  // Inserted directly, standing in for a restore or a moved data directory that
  // left the record behind. Nothing is deleted to produce this state.
  const orphanStored = `orphan-${Date.now()}.png`;
  const org = (await query("SELECT id FROM organizations ORDER BY id LIMIT 1")).rows[0].id;
  const inserted = (await query(
    "INSERT INTO property_images (organization_id, property_id, original_filename, stored_name, file_size, mime_type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    [org, propertyId, "gone.png", orphanStored, PNG.length, "image/png"],
  )).rows[0];
  check(!fs.existsSync(path.join(propertyUploadsDir, orphanStored)), "the orphan picture's file genuinely does not exist");

  listed = await call(`/properties/${propertyId}/images`);
  const orphan = listed.body.find((image) => image.id === inserted.id);
  check(Boolean(orphan), "the orphaned record is still returned (it was not deleted)");
  check(orphan.available === false, "the orphaned record is reported as NOT available");
  check(Boolean(orphan.file_url), "the orphaned record still carries its file_url for removal");

  detail = await call(`/properties/${propertyId}`);
  check(detail.body.cover_image_id === uploaded.id, "the cover skips the orphaned record and stays on the real picture");
  check(detail.body.image_count === 1, "image_count counts only the servable picture");
  check(detail.body.missing_image_count === 1, "the missing picture is still reported, not hidden");
  check(Boolean(detail.body.id), "the property record itself is intact");

  // The endpoint still answers honestly: 404 for a file that is really gone.
  const missingFile = await fetch(`${base}/properties/${propertyId}/images/${inserted.id}/file`, { headers: { Authorization: `Bearer ${token}` } });
  check(missingFile.status === 404, `a missing file still returns a real 404, not a fake image (${missingFile.status})`);

  // An administrator can still remove the orphan, so the record is actionable.
  const removed = await call(`/properties/${propertyId}/images/${inserted.id}`, { method: "DELETE" });
  check(removed.status === 200, "the orphaned record can still be deleted by an administrator");
  listed = await call(`/properties/${propertyId}/images`);
  check(listed.body.length === 1 && listed.body[0].available === true, "only the real picture remains");

  // --- a property with no servable picture at all ---------------------------
  const bare = await call("/properties", {
    method: "POST",
    body: { project_id: project.body.id, name: `Bare Property ${Date.now()}`, property_type: "land", status: "available", price: 50, location: "Test", area: 5 },
  });
  const bareDetail = await call(`/properties/${bare.body.id}`);
  check(bareDetail.body.cover_image_id === null, "a property with no pictures has no cover (renders no image request)");
  check(bareDetail.body.image_count === 0, "a property with no pictures reports zero");

  // --- cleanup --------------------------------------------------------------
  await call(`/properties/${propertyId}`, { method: "DELETE" });
  await call(`/properties/${bare.body.id}`, { method: "DELETE" });
  await call(`/projects/${project.body.id}`, { method: "DELETE" });
  check(true, "fixtures removed");
} catch (error) {
  check(false, `unexpected error: ${error.message}`);
} finally {
  await closeDatabase();
  await server.stop();
}

console.log(failures ? `\n${failures} IMAGE CHECK(S) FAILED` : "\nPROPERTY_IMAGES_ALL_PASSED");
if (failures) process.exitCode = 1;

  // left the record behind. Nothing is deleted to produce this state.
  const orphanStored = `orphan-${Date.now()}.png`;
  const org = (await query("SELECT id FROM organizations ORDER BY id LIMIT 1")).rows[0].id;
  const inserted = (await query(
    "INSERT INTO property_images (organization_id, property_id, original_filename, stored_name, file_size, mime_type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    [org, propertyId, "gone.png", orphanStored, PNG.length, "image/png"],
  )).rows[0];
  check(!fs.existsSync(path.join(propertyUploadsDir, orphanStored)), "the orphan picture's file genuinely does not exist");
