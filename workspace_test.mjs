// Workspace regression test.
//
// The workspace bootstrap changed from "every record in the office" to "one
// bounded page per list, plus scoped counts and page descriptors". That is only
// safe if the following still hold, and this file is what proves them:
//
//   * every sector still receives a workspace, and still sees ONLY the modules it
//     is entitled to (a trimmed payload must not become a trimmed permission set);
//   * the scoped counts agree with what the caller may actually read, and never
//     with the organization's true row count;
//   * the first page is a real slice, not a truncation, and the remaining pages
//     are reachable and non-overlapping;
//   * server-side search finds records that are NOT on the first page, which is
//     the whole reason search moved to the API;
//   * a record that is off-page can still be fetched by id for an edit modal.
//
// Runs against the throwaway test database only.
// Run: node --import ./test_support/guard.mjs workspace_test.mjs
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { legacyPasswordFor, demoPasswordFor } from "./backend/src/org/demoCredentials.js";
import { query, queryOne, closeDatabase } from "./backend/src/db.js";
import { organizationId } from "./backend/src/org/rbac.js";

reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ label: "workspace", port: 3215 });
const base = server.base;

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

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
const LABEL = `wstest${stamp}`;

/** Seeds enough rows to force more than one page. */
async function seed() {
  const org = await organizationId();
  const project = (await queryOne(
    "INSERT INTO projects (organization_id,name,status) VALUES ($1,$2,'active') RETURNING id",
    [org, `${LABEL} Project`],
  )).id;
  // 120 clients is deliberately more than one 50-row page, so page 2 exists and
  // a record that is definitely NOT on page 1 can be looked up by id.
  await query(
    `INSERT INTO clients (organization_id,project_id,name,client_type,status)
     SELECT $1,$2,$3 || ' Client ' || g,'buyer','active' FROM generate_series(1,120) g`,
    [org, project, LABEL],
  );
  await query(
    `INSERT INTO properties (organization_id,project_id,name,property_type,status,price,location,area,bedrooms,bathrooms)
     SELECT $1,$2,$3 || ' Plot ' || g,'villa','available',100000,'Test',150,2,1 FROM generate_series(1,120) g`,
    [org, project, LABEL],
  );
  return { project };
}

try {
  const adminToken = await signIn({ email: "admin@mkuyu.local", password: legacyPasswordFor("admin@mkuyu.local") });
  const mdToken = await signIn({ email: "md@mkuyu.local", password: legacyPasswordFor("md@mkuyu.local") });
  const salesToken = await signIn({ email: "sales@demo.mkuyu.local", password: demoPasswordFor("sales@demo.mkuyu.local") });
  const financeToken = await signIn({ email: "finance@demo.mkuyu.local", password: demoPasswordFor("finance@demo.mkuyu.local") });
  const legalToken = await signIn({ email: "legal@demo.mkuyu.local", password: demoPasswordFor("legal@demo.mkuyu.local") });
  const csToken = await signIn({ email: "cs@demo.mkuyu.local", password: demoPasswordFor("cs@demo.mkuyu.local") });
  const ictoToken = await signIn({ email: "icto@demo.mkuyu.local", password: demoPasswordFor("icto@demo.mkuyu.local") });
  check(Boolean(adminToken && mdToken && salesToken && financeToken && legalToken && csToken && ictoToken), "every persona signed in");

  const seeded = await seed();
  console.log(`seeded 120 clients and 120 properties into project ${seeded.project}`);
  const Q = `project_id=${seeded.project}&`;

  // === 1. Every sector still gets a workspace ==============================
  console.log("\n=== 1. every sector still loads a workspace ===");
  const sectors = { admin: adminToken, md: mdToken, sales: salesToken, finance: financeToken, legal: legalToken, cs: csToken, icto: ictoToken };
  const workspaces = {};
  for (const [name, token] of Object.entries(sectors)) {
    const res = await call("/org/workspace", { token });
    workspaces[name] = res.body;
    check(res.status === 200 && res.body && typeof res.body === "object", `${name} workspace loads (${res.status})`);
    // A non-200 here is the failure worth diagnosing: the isolated server's
    // stderr explains which of the workspace's many queries fell over, and this
    // surfaces that diagnosis in the log rather than a bare status code.
    if (res.status !== 200) console.log(`  SERVER SAID: ${JSON.stringify(server.logs?.join("\n").slice(-3000) ?? "")}`);
  }

  // === 2. The payload is bounded, and says so ==============================
  console.log("\n=== 2. the workspace ships a page, and says so ===");
  const admin = workspaces.admin;
  check(Array.isArray(admin.clients) && admin.clients.length <= 50, `clients arrive as one bounded page (${admin.clients?.length} rows)`);
  check(Array.isArray(admin.properties) && admin.properties.length <= 50, `properties arrive as one bounded page (${admin.properties?.length} rows)`);
  check(admin.pages?.clients?.total >= 120, `pages.clients.total covers the whole seeded set plus whatever the shared test DB already held (${admin.pages?.clients?.total})`);
  // The shared test database already holds rows from other suites, so the exact
  // total is not 120 - what matters is that the boundary maths is consistent.
  const claimedTotal = Number(admin.pages?.clients?.total || 0);
  const claimedPages = Number(admin.pages?.clients?.total_pages || 0);
  check(claimedPages === Math.max(1, Math.ceil(claimedTotal / 50)), `total_pages is ceil(total/50) (${claimedPages} for ${claimedTotal})`);
  check(admin.pages?.clients?.page === 1, "pages.clients.page is 1");
  check(admin.pages?.clients?.has_next === true, "pages.clients.has_next is true");
  check(admin.pages?.clients?.has_previous === false, "pages.clients.has_previous is false on page 1");
  // Projects stay complete: every filter and selector hangs off them.
  check(Array.isArray(admin.projects) && admin.projects.length > 0, "projects are still delivered complete");

  // === 3. Scoped counts, not array lengths ================================
  console.log("\n=== 3. dashboard counts are server-computed and scoped ===");
  check(typeof admin.counts === "object" && admin.counts !== null, "the workspace carries a counts block");
  check(admin.counts.clients >= 120, `the administrator's client count covers the whole set (${admin.counts.clients})`);
  check(typeof admin.counts.contracts === "number", "contracts are counted");
  // A caller without view_financial must be told null, not 0, for the money
  // registers: "0" would read as "the office has no debts".
  check(workspaces.sales.counts.debts === null, `a non-financial caller gets null for debts (${workspaces.sales.counts.debts})`);
  check(workspaces.sales.counts.payments === null, `a non-financial caller gets null for payments (${workspaces.sales.counts.payments})`);
  check(typeof workspaces.finance.counts.debts === "number", "a financial caller gets a real debt count");
  check(workspaces.sales.summary && workspaces.sales.summary.financial === false, "the sales summary is still marked non-financial");
  check(workspaces.finance.summary && workspaces.finance.summary.financial === true, "the finance summary is still marked financial");

  // === 4. Module gating is unchanged by the trimming ======================
  console.log("\n=== 4. unauthorized modules stay hidden ===");
  check((workspaces.cs.contracts || []).length === 0, "customer service receives no contracts");
  // Module gating sits BEHIND authorization: a caller without the contracts
  // module must be told NULL ("you may not know about this"), never the
  // office's true total.
  check(workspaces.cs.counts.contracts === null, `customer service is told null for contracts (${workspaces.cs.counts.contracts})`);
  check((workspaces.cs.clients || []).length > 0, "customer service still receives clients");
  check((workspaces.icto.projects || []).length === 0 && (workspaces.icto.clients || []).length === 0, "ICTO receives no business lists at all");
  check((workspaces.sales.debts || []).length === 0 && (workspaces.sales.payments || []).length === 0, "sales receives no money registers");
  check((workspaces.sales.contracts || []).length > 0, "sales still receives contracts");
  check((workspaces.legal.reminders || []).length === 0, "legal receives no reminders without view_financial");

  // === 5. Paging through a register =======================================
  console.log("\n=== 5. the remaining pages are reachable and disjoint ===");
  // The shared test database holds rows from other suites, so assert the shape
  // (full pages, then a short tail that covers the rest) rather than exact 120.
  const seededCount = 120;
  const pageA = await call(`/clients?${Q}page=1&page_size=50`, { token: adminToken });
  const pageB = await call(`/clients?${Q}page=2&page_size=50`, { token: adminToken });
  const pageC = await call(`/clients?${Q}page=3&page_size=50`, { token: adminToken });
  check(pageA.body.data.length === 50 && pageB.body.data.length === 50,
    `the first two project-scoped pages are full (${pageA.body.data.length}/${pageB.body.data.length})`);
  check(pageC.body.data.length === seededCount - 100,
    `the third page holds the remaining ${seededCount - 100} seeded clients (${pageC.body.data.length})`);
  check(pageC.body.pagination.total === seededCount, `the scoped total is exactly the seeded set (${pageC.body.pagination.total})`);
  const idsA = new Set(pageA.body.data.map((r) => r.id));
  const idsB = new Set(pageB.body.data.map((r) => r.id));
  const idsC = new Set(pageC.body.data.map((r) => r.id));
  check([...idsB].every((id) => !idsA.has(id)) && [...idsC].every((id) => !idsA.has(id) && !idsB.has(id)),
    "no client appears on two pages");
  check(pageA.body.pagination.has_previous === false && pageB.body.pagination.has_previous === true, "has_previous tracks the page");
  check(pageB.body.pagination.has_next === true && pageC.body.pagination.has_next === false, "has_next tracks the page");

  // === 6. Off-page record lookup (the edit-modal path) ====================
  console.log("\n=== 6. an off-page record can still be opened by id ===");
  const offPage = pageC.body.data[0];
  check(Boolean(offPage), "page 3 carries a record that is not on page 1");
  const byId = await call(`/clients/${offPage.id}`, { token: adminToken });
  check(byId.status === 200 && byId.body.id === offPage.id, `GET /clients/${offPage.id} returns the off-page record (${byId.status})`);
  check(!idsA.has(offPage.id), "and it genuinely is not in page 1");
  // The same fetch must still be refused when it is out of scope.
  const foreign = await call(`/clients/${offPage.id}`, { token: ictoToken });
  check([403, 404].includes(foreign.status), `a caller with no business module is still refused it (${foreign.status})`);

  // === 7. Search is server-side and complete ==============================
  console.log("\n=== 7. search reaches records that are off the first page ===");
  // A name that only exists on the LAST page: a client-side filter of page 1
  // would have reported it as missing.
  const term = `Client ${String(offPage.name).match(/Client (\d+)/)?.[1] ?? ""}`;
  const searched = await call(`/clients?${Q}search=${encodeURIComponent(term)}&page=1&page_size=50`, { token: adminToken });
  check(searched.status === 200, `GET /clients?search=... -> 200 (${searched.status})`);
  check(searched.body.pagination.total >= 1, `the search finds records on a later page (total ${searched.body.pagination.total})`);
  check(searched.body.data.some((r) => r.id === offPage.id), "the off-page record is returned by its name");
  const none = await call(`/clients?${Q}search=zzzznomatchzzzz`, { token: adminToken });
  check((none.body.data || []).length === 0 && none.body.pagination?.total === 0,
    `a non-matching search returns nothing (${(none.body.data || []).length} rows, total ${none.body.pagination?.total})`);
  const tooLong = await call(`/clients?${Q}search=${"x".repeat(200)}`, { token: adminToken });
  check(tooLong.status === 400, `an absurd search term is rejected (${tooLong.status})`);

  // === 8. Search cannot widen the caller's scope ==========================
  console.log("\n=== 8. search does not bypass the record scope ===");
  // The seeded rows carry no owner, which by design puts them in the office-wide
  // pool that every sector may see. To test that search cannot widen a scope,
  // the target must actually be outside Sales' scope: give it a private owner.
  await query(
    "UPDATE clients SET owner_id = u.id, created_by = u.id, visibility = 'own' FROM users u WHERE u.email = 'admin@mkuyu.local' AND clients.id = $1",
    [offPage.id],
  );
  const salesSearch = await call(`/clients?search=${encodeURIComponent(term)}`, { token: salesToken });
  check(salesSearch.status === 200, "a search for the same term succeeds for sales");
  check((salesSearch.body.data || []).every((r) => r.id !== offPage.id),
    "sales' search never returns a record outside their scope");
  const ictoSearch = await call(`/clients?search=x`, { token: ictoToken });
  check(ictoSearch.status === 403, `a caller with no clients module is refused the search (${ictoSearch.status})`);

  // === 9. Contract enrichment survives ====================================
  console.log("\n=== 9. per-caller contract actions still arrive with the page ===");
  check(Array.isArray(workspaces.sales.contracts), "sales receives a contracts page");
  check((workspaces.sales.contracts || []).every((c) => Array.isArray(c.available_actions)),
    "every contract on the page carries its own available_actions");
  check((workspaces.legal.contracts || []).every((c) => Array.isArray(c.available_actions)),
    "legal's contracts carry available_actions too");

  // === 10. Cleanup ========================================================
  await query("DELETE FROM clients WHERE name LIKE $1", [`${LABEL}%`]);
  await query("DELETE FROM properties WHERE name LIKE $1", [`${LABEL}%`]);
  await query("DELETE FROM projects WHERE name LIKE $1", [`${LABEL}%`]);
  const leftovers = Number((await queryOne("SELECT COUNT(*)::int AS n FROM clients WHERE name LIKE $1", [`${LABEL}%`])).n);
  check(leftovers === 0, "the seeded fixtures were removed again");
} catch (error) {
  console.log(`\nERROR  ${error?.stack || error}`);
  failures += 1;
} finally {
  await server.stop();
  await closeDatabase().catch(() => {});
}

console.log(failures ? `\n${failures} WORKSPACE CHECK(S) FAILED` : "\nWORKSPACE_ALL_PASSED");
process.exitCode = failures ? 1 : 0;
