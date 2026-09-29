// Regression test for the administration endpoints that were returning 500.
//
// Two independent defects, both server-side:
//
//   1. `scopedList` appends `ORDER BY` itself, but its callers passed a combined
//      "AND ... ORDER BY ..." string, producing two ORDER BY clauses and a SQL
//      syntax error. That broke GET /org/collections.
//   2. `reminders` was added to the shared record table catalogue so Finance
//      would see the module, but a reminder has no owner_id/created_by/
//      department_id/visibility columns: it inherits the scope of the installment
//      it belongs to. The record-allocation route assumed every catalogue entry
//      had them and queried `r.owner_id`, which does not exist.
//
// The payload-shape assertions matter as much as the status codes: a dropped
// `await` returns HTTP 200 with a Promise serialised as `{}`, so a status-only
// check would pass while the panel silently rendered nothing.
import assert from "node:assert/strict";
import { legacyPasswordFor } from "./backend/src/org/demoCredentials.js";
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { closeDatabase } from "./backend/src/db.js";

// Talks to a PRIVATE server bound to the throwaway test database, never the
// developer's live application on :3003.
reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ label: "export", port: 3201 });
const base = server.base;

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

async function call(path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

// Read-only, so this targets the running workspace like the other endpoint
// suites (rotation, demo, export) rather than spawning an isolated server.
const reachable = await call("/health").then((r) => r.status === 200).catch(() => false);
if (!reachable) {
  console.log(`FAIL  no server at ${base} - start it with "npm start" first`);
  process.exit(1);
}

try {
  // The administrator is the seeded legacy account, not a @demo alias: it is the
  // only account whose `users.role` is 'admin', which is what every route here
  // requires.
  const adminEmail = "admin@mkuyu.local";
  const login = await call("/auth/login", {
    method: "POST",
    body: { email: adminEmail, password: legacyPasswordFor(adminEmail) },
  });
  check(login.status === 200 && Boolean(login.body.token), `signed in as the administrator (${login.status})`);
  const token = login.body.token;

  // --- the endpoints that were failing -------------------------------------
  for (const path of ["/org/collections", "/org/records/allocation", "/org/dashboard", "/org/workspace"]) {
    const attempt = await call(path, { token });
    check(attempt.status === 200, `GET ${path} -> ${attempt.status}`);
  }

  // --- collections: four real arrays, not Promises or empty objects ---------
  const collections = await call("/org/collections", { token });
  for (const key of ["outstanding", "overdue", "due_soon", "follow_ups"]) {
    check(Array.isArray(collections.body[key]), `collections.${key} is an array (${Array.isArray(collections.body[key]) ? collections.body[key].length : typeof collections.body[key]})`);
  }

  // --- allocation: every catalogue entity is represented and well formed ----
  const allocation = await call("/org/records/allocation", { token });
  check(Array.isArray(allocation.body.entities), "allocation returns an entities array");
  check(allocation.body.entities.length === 12, `allocation covers all 12 record types (got ${allocation.body.entities?.length})`);
  check((allocation.body.entities || []).every((entity) => Array.isArray(entity.records)), "every allocation entity carries a records array");

  // The non-ownable entity is reported, not silently dropped, and is not queried.
  const reminder = (allocation.body.entities || []).find((entity) => entity.entity === "reminder");
  check(Boolean(reminder), "reminders still appear in the allocation overview");
  check(reminder?.ownable === false, "reminders are marked ownable=false rather than queried for ownership columns");

  // --- a non-ownable entity is refused clearly, not with a 500 -------------
  const shares = await call("/org/records/reminder/1/shares", { token });
  check(shares.status === 400, `sharing a reminder is refused with 400, not 500 (got ${shares.status})`);
  const unknown = await call("/org/records/not_a_thing/1/shares", { token });
  check(unknown.status === 404, `an unknown entity is refused with 404 (got ${unknown.status})`);
} catch (error) {
  console.log(`FAIL  ${error.message}`);
  failures += 1;
} finally {
  await closeDatabase();
  await server.stop();
}

console.log(failures ? `\n${failures} ADMIN ENDPOINT CHECK(S) FAILED` : "\nADMIN_ENDPOINTS_ALL_PASSED");
if (failures) process.exitCode = 1;





