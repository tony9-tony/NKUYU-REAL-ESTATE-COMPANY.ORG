// Pagination contract test.
//
// Two things are being asserted, and the second matters more than the first:
//
//   1. The opt-in contract behaves (page/page_size/total/has_next/has_previous).
//   2. The DEFAULT is untouched, and pagination cannot become a way around the
//      record scope. A paged `total` is the specific risk: it is computed
//      separately from the rows, so if it were built without the same
//      authorization predicate it would disclose how many records the caller is
//      NOT allowed to see.
//
// Runs against the throwaway test database only.
// Run: node --import ./test_support/guard.mjs pagination_test.mjs
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { legacyPasswordFor, demoPasswordFor } from "./backend/src/org/demoCredentials.js";
import { query, queryOne, closeDatabase } from "./backend/src/db.js";
import { organizationId } from "./backend/src/org/rbac.js";

reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ label: "pagination", port: 3212 });
const base = server.base;

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

// Business lists are read as the Managing Director (organization scope): the
// System Administrator no longer has any business module.
const ADMIN = { email: "md@demo.mkuyu.local", password: legacyPasswordFor("md@demo.mkuyu.local") };
const SALES = { email: "sales@demo.mkuyu.local", password: demoPasswordFor("sales@demo.mkuyu.local") };
const LEGAL = { email: "legal@demo.mkuyu.local", password: demoPasswordFor("legal@demo.mkuyu.local") };
const FINANCE = { email: "finance@demo.mkuyu.local", password: demoPasswordFor("finance@demo.mkuyu.local") };
const MD = { email: "md@mkuyu.local", password: legacyPasswordFor("md@mkuyu.local") };

async function signIn({ email, password }) {
  const response = await fetch(`${base}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return (await response.json()).token;
}

async function call(path, { token, method = "GET" } = {}) {
  const response = await fetch(`${base}${path}`, {
    method, headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

const stamp = Date.now();
const LABEL = `pagetest${stamp}`;

/** Seeds a known, deliberately uneven dataset so page maths is verifiable. */
async function seed(count) {
  const org = await organizationId();
  const project = (await queryOne(
    "INSERT INTO projects (organization_id,name,status) VALUES ($1,$2,'active') RETURNING id",
    [org, `${LABEL} Project`],
  )).id;
  await query(
    `INSERT INTO clients (organization_id,project_id,name,client_type,status)
     SELECT $1,$2,$3 || ' Client ' || g,'buyer','active' FROM generate_series(1,$4) g`,
    [org, project, LABEL, count],
  );
  await query(
    `INSERT INTO properties (organization_id,project_id,name,property_type,status,price,location,area,bedrooms,bathrooms)
     SELECT $1,$2,$3 || ' Plot ' || g,'villa','available',100000,'Test',150,2,1 FROM generate_series(1,$4) g`,
    [org, project, LABEL, count],
  );
  await query(
    `INSERT INTO contracts (organization_id,project_id,client_name,contract_type,status,value)
     SELECT $1,$2,$3 || ' Client ' || g,'new','active',200000 FROM generate_series(1,$4) g`,
    [org, project, LABEL, count],
  );
  return { project, clients: count, properties: count, contracts: count };
}

try {
  const adminToken = await signIn(ADMIN);
  const salesToken = await signIn(SALES);
  const legalToken = await signIn(LEGAL);
  const financeToken = await signIn(FINANCE);
  const mdToken = await signIn(MD);
  check(Boolean(adminToken && salesToken && legalToken && financeToken && mdToken), "every persona signed in");

  const seeded = await seed(25);
  console.log(`seeded ${seeded.clients} clients / ${seeded.properties} properties / ${seeded.contracts} contracts`);

  // === 1. Backward compatibility ===========================================
  // The single most important section: with no pagination parameters the
  // response must still be the bare array it has always been.
  console.log("\n=== 1. the default response is unchanged ===");
  // These are scoped to the seeded project on purpose. The shared test database
  // carries ~11k rows from the earlier 10k benchmark, so an unscoped bare-array
  // fetch returns megabytes per call; the SHAPE is what is under test here, and
  // `project_id` does not change the response shape.
  for (const path of ["clients", "properties", "contracts", "projects", "documents", "appointments"]) {
    const sep = path === "projects" ? "" : `project_id=${seeded.project}&`;
    const res = await call(`/${path}?${sep}`.replace("?&", "?"), { token: adminToken });
    check(res.status === 200 && Array.isArray(res.body), `/${path} without pagination params still returns a bare array (${res.status})`);
  }
  const defaultDebts = await call("/debts", { token: adminToken });
  check(defaultDebts.status === 200 && Array.isArray(defaultDebts.body), `/debts without params is a bare array (${defaultDebts.status})`);
  const defaultPayments = await call("/payments", { token: adminToken });
  check(defaultPayments.status === 200 && Array.isArray(defaultPayments.body), `/payments without params is a bare array (${defaultPayments.status})`);
  const defaultLeads = await call("/org/leads", { token: adminToken });
  check(defaultLeads.status === 200 && Array.isArray(defaultLeads.body), `/org/leads without params is a bare array (${defaultLeads.status})`);
  const defaultFollowUps = await call("/org/follow-ups", { token: adminToken });
  check(defaultFollowUps.status === 200 && Array.isArray(defaultFollowUps.body), `/org/follow-ups without params is a bare array (${defaultFollowUps.status})`);
  // A filter alone must NOT switch the shape on - only page/page_size does.
  const filteredOnly = await call(`/clients?project_id=${seeded.project}&status=active`, { token: adminToken });
  check(filteredOnly.status === 200 && Array.isArray(filteredOnly.body), `a status filter alone keeps the array shape (${filteredOnly.status})`);

  // === 2. The opt-in contract ==============================================
  // Scoped to the seeded project so the expected numbers are EXACT and the
  // calls stay small: the shared test database carries ~11k benchmark rows,
  // which would otherwise turn these assertions into approximations.
  console.log("\n=== 2. the pagination contract ===");
  const Q = `project_id=${seeded.project}&`;
  const page1 = await call(`/clients?${Q}page=1&page_size=10`, { token: adminToken });
  check(page1.status === 200, `GET /clients?page=1&page_size=10 -> 200 (${page1.status})`);
  check(Array.isArray(page1.body.data), "the response carries a `data` array");
  check(page1.body.data.length === 10, `page 1 returned 10 rows (${page1.body.data?.length})`);
  const p = page1.body.pagination || {};
  check(p.page === 1 && p.page_size === 10, `page/page_size echoed (${p.page}/${p.page_size})`);
  check(p.total === 25, `total equals the seeded row count exactly (${p.total})`);
  check(p.total_pages === 3, `total_pages is ceil(total/page_size) (${p.total_pages})`);
  check(p.has_next === true, "has_next is true on the first page");
  check(p.has_previous === false, "has_previous is false on the first page");

  const page2 = await call(`/clients?${Q}page=2&page_size=10`, { token: adminToken });
  check(page2.body.data.length === 10, "page 2 is full");
  check(page2.body.pagination.has_previous === true, "has_previous is true on page 2");
  check(page2.body.pagination.has_next === true, "has_next is true on page 2");
  // 25 rows over 10 per page makes page 3 the last, holding the final 5.
  const page3 = await call(`/clients?${Q}page=3&page_size=10`, { token: adminToken });
  check(page3.body.data.length === 5, `the last page holds the 5 remaining rows (${page3.body.data?.length})`);
  check(page3.body.pagination.has_next === false, `has_next is false on the last page (${page3.body.pagination.has_next})`);
  check(page3.body.pagination.has_previous === true, "has_previous is true on the last page");

  // page_size alone, and page alone, both opt in.
  const sizeOnly = await call(`/clients?${Q}page_size=5`, { token: adminToken });
  check(sizeOnly.status === 200 && sizeOnly.body.data.length === 5, `page_size alone opts in (${sizeOnly.body.data?.length} rows)`);
  const pageOnly = await call(`/clients?${Q}page=2`, { token: adminToken });
  check(pageOnly.status === 200 && pageOnly.body.pagination.page === 2, "page alone opts in");
  check(pageOnly.body.pagination.page_size === 50, "the default page_size is 50 when omitted");

  // === 3. Validation =======================================================
  console.log("\n=== 3. invalid pagination input is refused ===");
  const rejects = [
    ["page=0", "page=0"],
    ["page=-1", "page=-1"],
    ["page=abc", "page=abc"],
    ["page=1.5", "page=1.5"],
    ["page=", "page= (empty)"],
    ["page_size=0", "page_size=0"],
    ["page_size=-5", "page_size=-5"],
    ["page_size=abc", "page_size=abc"],
    ["page_size=201", "page_size=201 (over the cap)"],
    ["page_size=999999", "page_size=999999"],
    ["page=1e400", "page=1e400 (Infinity)"],
    ["page=99999999999999999999", "page=99999999999999999999 (beyond 2^53)"],
    ["page=999999999", "page=999999999 (absurd offset)"],
  ];
  for (const [query, label] of rejects) {
    const res = await call(`/clients?${Q}${query}`, { token: adminToken });
    check(res.status === 400, `${label} -> 400 (${res.status})`);
  }
  // The cap itself must be accepted.
  const atCap = await call(`/clients?${Q}page_size=200`, { token: adminToken });
  check(atCap.status === 200 && atCap.body.pagination.page_size === 200, `page_size=200 is accepted (${atCap.status})`);

  // === 4. Page boundary behaviour ==========================================
  console.log("\n=== 4. boundaries and page integrity ===");
  // Past the end is computed from the real total, so the check stays meaningful
  // whatever the shared test database already contains.
  const wellPast = Math.ceil(p.total / p.page_size) + 50;
  const beyond = await call(`/clients?${Q}page=${wellPast}&page_size=10`, { token: adminToken });
  check(beyond.status === 200 && beyond.body.data.length === 0, `a page past the end returns an empty data array (page ${wellPast}, ${beyond.body.data?.length} rows)`);
  check(beyond.body.pagination.has_next === false, "has_next is false past the end");
  check(beyond.body.pagination.has_previous === true, "has_previous is still true past the end");
  check(beyond.body.pagination.total === 25, "total is still reported past the end");

  // The three seeded pages must tile the 25 rows exactly: no overlap, no gaps.
  const collected = [];
  for (let page = 1; page <= 3; page += 1) {
    const res = await call(`/clients?${Q}page=${page}&page_size=10`, { token: adminToken });
    collected.push(...res.body.data.map((row) => row.id));
  }
  const unique = new Set(collected);
  check(collected.length === unique.size, `consecutive pages do not overlap (${collected.length} rows, ${unique.size} unique)`);
  check(collected.length === 25, `the three pages cover every seeded row (${collected.length})`);
  // Stable ordering: the same page must return the same rows in the same order.
  const repeat = await call(`/clients?${Q}page=2&page_size=10`, { token: adminToken });
  const again = await call(`/clients?${Q}page=2&page_size=10`, { token: adminToken });
  check(JSON.stringify(repeat.body.data.map((r) => r.id)) === JSON.stringify(again.body.data.map((r) => r.id)),
    "the same page returns the same rows in the same order");
  // Ordering must follow created_at DESC (newest first).
  const ordered = await call(`/clients?${Q}page=1&page_size=200`, { token: adminToken });
  const times = ordered.body.data.map((r) => new Date(r.created_at).getTime());
  check(times.every((t, i) => i === 0 || times[i - 1] >= t), "rows come back newest-first, matching the existing sort");

  // === 5. Filters still apply, and are reflected in `total` ==================
  console.log("\n=== 5. filters work and scope the total ===");
  const filtered = await call(`/clients?${Q}status=active&page=1&page_size=200`, { token: adminToken });
  check(filtered.status === 200 && (filtered.body.data || []).every((row) => row.status === "active"),
    "a status filter still filters the paged rows");
  check(filtered.body.pagination.total === 25, `a matching filter keeps the full scoped total (${filtered.body.pagination.total})`);
  // A filter that matches nothing must report zero, not the unfiltered total.
  // `inactive` is a valid client status that the seeded rows never use.
  const none = await call(`/clients?${Q}status=inactive&page=1&page_size=10`, { token: adminToken });
  check(none.status === 200 && none.body.data.length === 0,
    `a filter matching nothing yields an empty page (${none.status}, ${none.body.data?.length} rows)`);
  check(none.body.pagination.total === 0, `...and reports total=0, not the unfiltered total (${none.body.pagination.total})`);
  check(none.body.pagination.total_pages === 0, "total_pages is 0 when nothing matches");

  // === 6. Authorization is NOT bypassable through pagination ===============
  // This is the section that matters. Sales cannot see Legal's records, so a
  // paged `total` that ignored the scope predicate would tell Sales how many
  // records exist that it may never read.
  console.log("\n=== 6. pagination cannot bypass the record scope ===");
  const org = await organizationId();
  // A contract that is genuinely private to Legal: owned by a Legal officer,
  // in Legal's own department, with `visibility='own'`. A contract inserted
  // without ownership columns defaults to organization-visible, which Sales is
  // entitled to read - so an unowned fixture would prove nothing.
  const legalUser = await queryOne("SELECT id, display_name FROM users WHERE email = 'legal@demo.mkuyu.local'");
  const legalDept = await queryOne("SELECT id FROM departments WHERE name = 'LEGAL'");
  const legalProject = (await queryOne(
    "INSERT INTO projects (organization_id,name,status,owner_id,created_by,department_id,visibility) VALUES ($1,$2,'active',$3,$3,$4,'own') RETURNING id",
    [org, `${LABEL} Legal Only`, legalUser.id, legalDept.id],
  )).id;
  const legalContract = (await queryOne(
    `INSERT INTO contracts (organization_id,project_id,client_name,contract_type,status,value,owner_id,created_by,department_id,visibility)
     VALUES ($1,$2,$3,'new','active',999000,$4,$4,$5,'own') RETURNING id`,
    [org, legalProject, `${LABEL} Secret Client`, legalUser.id, legalDept.id],
  )).id;
  await query("UPDATE projects SET owner_id=$1, created_by=$1, department_id=$2, visibility='own' WHERE id=$3", [legalUser.id, legalDept.id, legalProject]);

  // A small page is enough: what matters is that the private row is absent and
  // that the total is the caller's, not the organization's.
  const salesSees = await call("/contracts?page=1&page_size=200", { token: salesToken });
  const salesIds = (salesSees.body.data || []).map((row) => row.id);
  check(!salesIds.includes(legalContract), "a paged Sales caller never receives another department's contract");
  const salesById = await call(`/contracts/${legalContract}`, { token: salesToken });
  check([403, 404].includes(salesById.status), `the same record is refused by direct id (${salesById.status})`);

  // The total must not count it either: compare the organization's true row
  // count with what each caller is told. Unscoped on purpose - the point is
  // that a globally scoped total still differs per caller.
  const trueTotal = Number((await queryOne("SELECT COUNT(*)::int AS n FROM contracts WHERE organization_id=$1", [org])).n);
  const adminTotal = (await call("/contracts?page=1&page_size=1", { token: adminToken })).body.pagination.total;
  const salesTotal = (await call("/contracts?page=1&page_size=1", { token: salesToken })).body.pagination.total;
  check(adminTotal === trueTotal, `an administrator's total is the true count (${adminTotal} vs ${trueTotal})`);
  check(salesTotal < trueTotal, `a Sales total is SMALLER than the true count, so it hides records (${salesTotal} < ${trueTotal})`);
  // Walk Sales pages and confirm the private contract is on none of them.
  // Paging is exactly the technique an attacker would use to reach a hidden row,
  // so the check sweeps a wide window rather than trusting page 1. The sweep is
  // capped because the shared test database still holds ~11k rows from the
  // earlier 10k benchmark; a full walk is thorough but not a contract test.
  let seen = 0;
  let leaked = false;
  const pages = Math.min(Math.ceil(salesTotal / 200) + 1, 15);
  for (let page = 1; page <= pages; page += 1) {
    const res = await call(`/contracts?page=${page}&page_size=200`, { token: salesToken });
    for (const row of res.body.data || []) { seen += 1; if (row.id === legalContract) leaked = true; }
  }
  check(!leaked, `the private contract appears on none of the ${pages} swept Sales pages`);
  // The last swept page is naturally partial, so the expectation is every row
  // the caller is entitled to within the swept window - not `pages * 200`.
  const expected = Math.min(salesTotal, pages * 200);
  check(seen === expected, `the sweep retrieved every requested row (${seen} of ${expected})`);

  // === 7. Financial gating is unchanged =====================================
  console.log("\n=== 7. financial and department gates survive pagination ===");
  for (const [name, token] of [["sales", salesToken], ["legal", legalToken]]) {
    for (const path of ["/debts?page=1&page_size=10", "/payments?page=1&page_size=10"]) {
      const res = await call(path, { token });
      check(res.status === 403, `${name} is still refused ${path} (${res.status})`);
    }
  }
  const financeDebts = await call("/debts?page=1&page_size=5", { token: financeToken });
  check(financeDebts.status === 200 && Array.isArray(financeDebts.body.data), `Finance can still page /debts (${financeDebts.status})`);
  const csToken = await signIn({ email: "cs@demo.mkuyu.local", password: demoPasswordFor("cs@demo.mkuyu.local") });
  // Customer Service legitimately holds `access_properties` (they show viewings),
  // so properties is NOT a gate to assert. Contracts are: CS owns no contract
  // content, and pagination must not become a way around that.
  const csContracts = await call("/contracts?page=1&page_size=10", { token: csToken });
  check(csContracts.status === 403, `customer service is still refused paged /contracts (${csContracts.status})`);
  const csContractsBare = await call("/contracts", { token: csToken });
  check(csContractsBare.status === 403, `...and the unpaged call agrees (${csContractsBare.status})`);
  const csDebts = await call("/debts?page=1&page_size=10", { token: csToken });
  check(csDebts.status === 403, `customer service is still refused paged /debts (${csDebts.status})`);
  const anon = await call("/clients?page=1&page_size=10");
  check(anon.status === 401, `an anonymous paged call is refused (${anon.status})`);

  // === 8. A full page returns the same rows as the bare array ===============
  console.log("\n=== 8. a full page returns the same rows as the bare array ===");
  // Scoped to the seeded project: comparing a full page against the bare array
  // is the strongest statement available, and it is exact at 25 rows.
  for (const [name, path] of [["/properties", "/properties"], ["/contracts", "/contracts"], ["/clients", "/clients"]]) {
    const bare = await call(`${path}?${Q}`, { token: adminToken });
    const paged = await call(`${path}?${Q}page=1&page_size=200`, { token: adminToken });
    const a = bare.body.map((r) => r.id).sort((x, y) => x - y);
    const b = (paged.body.data || []).map((r) => r.id).sort((x, y) => x - y);
    check(JSON.stringify(a) === JSON.stringify(b), `${name}: a full page matches the bare array exactly`);
    // Field parity, not just id parity: an opt-in page must not quietly drop or
    // rename anything the unpaged caller has always received.
    check(JSON.stringify(Object.keys(bare.body[0] || {}).sort()) === JSON.stringify(Object.keys(paged.body.data[0] || {}).sort()),
      `${name}: a paged row carries the same fields as an unpaged row`);
  }
  const pagedProps = await call(`/properties?${Q}page=1&page_size=5`, { token: adminToken });
  check("image_count" in (pagedProps.body.data[0] || {}), "paged properties still carry their picture counts");
  const pagedContracts = await call(`/contracts?${Q}page=1&page_size=5`, { token: adminToken });
  // The list route has never applied `contractResponse` (only `/:id` does), so a
  // page must not invent `available_actions` the unpaged caller never received.
  check(!("available_actions" in (pagedContracts.body.data[0] || {})),
    "paged contracts carry no field the unpaged list does not");
  const pagedPayments = await call("/payments?page=1&page_size=200", { token: adminToken });
  const barePayments = await call("/payments", { token: adminToken });
  const pa = barePayments.body.map((r) => r.id).sort((x, y) => x - y);
  const pb = (pagedPayments.body.data || []).map((r) => r.id).sort((x, y) => x - y);
  check(JSON.stringify(pa) === JSON.stringify(pb), "/payments: a full page matches the bare array exactly");

  // === 9. Every paginated endpoint honours the contract =====================
  console.log("\n=== 9. every paginated endpoint returns { data, pagination } ===");
  for (const [name, path, token] of [
    ["clients", "/clients?page=1&page_size=5", adminToken],
    ["properties", "/properties?page=1&page_size=5", adminToken],
    ["contracts", "/contracts?page=1&page_size=5", adminToken],
    ["debts", "/debts?page=1&page_size=5", financeToken],
    ["payments", "/payments?page=1&page_size=5", financeToken],
    ["documents", "/documents?page=1&page_size=5", adminToken],
    ["appointments", "/appointments?page=1&page_size=5", adminToken],
    ["projects", "/projects?page=1&page_size=5", adminToken],
    ["leads", "/org/leads?page=1&page_size=5", adminToken],
    ["follow-ups", "/org/follow-ups?page=1&page_size=5", adminToken],
  ]) {
    const res = await call(path, { token });
    const ok = res.status === 200 && Array.isArray(res.body.data)
      && res.body.pagination?.page === 1 && res.body.pagination?.page_size === 5
      && typeof res.body.pagination?.total === "number";
    check(ok, `${name} returns the contract shape (${res.status})`);
  }

  // === 10. Cleanup ==========================================================
  // Seeded fixtures are removed so a later suite is not left with extra rows.
  await query("DELETE FROM contracts WHERE client_name LIKE $1", [`${LABEL}%`]);
  await query("DELETE FROM clients WHERE name LIKE $1", [`${LABEL}%`]);
  await query("DELETE FROM properties WHERE name LIKE $1", [`${LABEL}%`]);
  await query("DELETE FROM projects WHERE name LIKE $1", [`${LABEL}%`]);
  const leftovers = Number((await queryOne("SELECT COUNT(*)::int AS n FROM projects WHERE name LIKE $1", [`${LABEL}%`])).n);
  check(leftovers === 0, "the seeded fixtures were removed again");
  void mdToken;
} catch (error) {
  // Without this the process exits silently: `finally` still runs, so the
  // server is stopped cleanly, but the reason for the failure never reaches the
  // log and the run looks like an unexplained hang.
  console.log(`\nERROR  ${error?.stack || error}`);
  failures += 1;
} finally {
  await server.stop();
  await closeDatabase().catch(() => {});
}

console.log(failures ? `\n${failures} PAGINATION CHECK(S) FAILED` : "\nPAGINATION_ALL_PASSED");
process.exitCode = failures ? 1 : 0;
