// ---------------------------------------------------------------------------
// Regression test: a completed CLIENT cannot be created without a CONTRACT.
//
// The rule is about the CLIENT record only. MKUYU already has a prospect concept
// (`clients.status = 'lead'`) plus a separate `leads` table, so a person who has
// not signed may exist as a prospect with no contract. What is refused is
// completing a client record with no associated contract.
//
// Enforcement lives in the API (POST /clients, and the move to `active` in
// PUT /clients/:id), because a rule the server does not know about is not a rule.
//
// Deliberately NOT enforced:
//   * a property on the contract - 0 of 35 existing contracts link one, so
//     requiring it would reject every legitimate contract;
//   * anything retroactively - pre-existing active clients have no contract and
//     must stay editable, so the check only fires when a client is CREATED as
//     active, or MOVED to active.
// ---------------------------------------------------------------------------
import { legacyPasswordFor } from "./backend/src/org/demoCredentials.js";
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { query, closeDatabase } from "./backend/src/db.js";

// PRIVATE server on the throwaway test database, not the live app on :3003.
reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ label: "client-workflow", port: 3203 });
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

const reachable = await call("/health").then((r) => r.status === 200).catch(() => false);
if (!reachable) {
  console.log(`FAIL  no server at ${base} - start it with "npm start" first`);
  await closeDatabase();
  console.log(failures ? `\n${failures} CLIENT WORKFLOW CHECK(S) FAILED` : "\nCLIENT_WORKFLOW_ALL_PASSED");
  process.exit(1);
}

let salesToken = "";
let projectId = null;
const createdClients = [];
const createdContracts = [];
const suffix = Date.now();

console.log("=== client -> contract workflow ===");
try {
  const sales = await call("/auth/login", { method: "POST", body: { email: "sales@demo.mkuyu.local", password: legacyPasswordFor("sales@demo.mkuyu.local") } });
  salesToken = sales.body.token || "";
  check(Boolean(salesToken), "a sales officer signed in");

  const project = await call("/projects", { token: salesToken, method: "POST", body: { name: `Workflow Project ${suffix}` } });
  projectId = project.body.id;

  // 1. A NEW client cannot be COMPLETED without a contract. The server refuses
  //    it outright when the caller insists, and otherwise files the person as a
  //    prospect rather than silently creating a completed client with no
  //    contract behind it.
  const noContract = await call("/clients", {
    token: salesToken, method: "POST",
    body: { name: `Workflow NoContract ${suffix}`, client_type: "buyer", status: "active", project_id: projectId, require_contract: true },
  });
  check(noContract.status === 400, `a new client completed without a contract is refused with 400 (${noContract.status})`);
  check(/contract/i.test(noContract.body.error || ""), `the refusal explains a contract is required ("${noContract.body.error || ""}")`);

  // Without the insistence flag the same call is accepted as a PROSPECT, which is
  // the documented New Client -> Contract -> Complete flow.
  const downgraded = await call("/clients", {
    token: salesToken, method: "POST",
    body: { name: `Workflow Downgrade ${suffix}`, client_type: "buyer", status: "active", project_id: projectId },
  });
  check(downgraded.status === 201 && downgraded.body.status === "lead", `a client completed without a contract is filed as a prospect, never a completed client (${downgraded.status}/${downgraded.body.status})`);
  if (downgraded.body.id) createdClients.push(downgraded.body.id);

  // The transition itself is refused: a prospect cannot be completed until it has
  // a contract.
  const premature = await call(`/clients/${downgraded.body.id}`, {
    token: salesToken, method: "PUT",
    body: { name: `Workflow Downgrade ${suffix}`, client_type: "buyer", status: "active", project_id: projectId },
  });
  check(premature.status === 400, `completing a client with no contract is refused (${premature.status})`);

  // 2. A prospect may exist with no contract: that is the pre-signature state.
  const prospect = await call("/clients", {
    token: salesToken, method: "POST",
    body: { name: `Workflow Prospect ${suffix}`, client_type: "buyer", status: "lead", project_id: projectId },
  });
  check(prospect.status === 201, `a prospect (status=lead) is created without a contract (${prospect.status})`);
  if (prospect.body.id) createdClients.push(prospect.body.id);

  // 3. A new client completed WITH a valid contract succeeds.
  const buyer = await call("/clients", {
    token: salesToken, method: "POST",
    body: { name: `Workflow Buyer ${suffix}`, client_type: "buyer", status: "lead", project_id: projectId },
  });
  check(buyer.status === 201, "the buyer record is created as a prospect first");
  if (buyer.body.id) createdClients.push(buyer.body.id);

  const contract = await call("/contracts", {
    token: salesToken, method: "POST",
    body: { project_id: projectId, client_id: buyer.body.id, client_name: `Workflow Buyer ${suffix}`, contract_type: "new", original_price: 100000000, discount_pct: 10 },
  });
  check(contract.status === 201, `a contract is created for that client (${contract.status})`);
  check(Number(contract.body.final_price) === 90000000, `the contract carries the discounted final price (${contract.body.final_price})`);
  if (contract.body.id) createdContracts.push(contract.body.id);

  const completed = await call(`/clients/${buyer.body.id}`, {
    token: salesToken, method: "PUT",
    body: { name: `Workflow Buyer ${suffix}`, client_type: "buyer", status: "active", project_id: projectId },
  });
  check(completed.status === 200, `a client with a contract can be completed (${completed.status})`);
  check(completed.body.status === "active", "the completed client is active");

  // 4. A LEAD can be created with no contract: leads are not clients.
  const lead = await call("/org/leads", { token: salesToken, method: "POST", body: { name: `Workflow Lead ${suffix}` } });
  check(lead.status === 201, `a lead is created without a contract (${lead.status})`);
  const converted = await call(`/org/leads/${lead.body.id}/convert`, { token: salesToken, method: "POST", body: {} });
  check(converted.status === 201, `a lead can still be converted to a client record (${converted.status} ${JSON.stringify(converted.body).slice(0, 160)})`);
  if (converted.body.id) createdClients.push(converted.body.id);
  // Conversion is not signature, so it must not silently produce a completed
  // client with no contract.
  check(converted.body.status !== "active", `a converted lead is a prospect, not a completed client (${converted.body.status})`);

  // 5. An invalid contract association is refused. A contract id that does not
  //    exist must never be silently ignored.
  const badRef = await call("/clients", {
    token: salesToken, method: "POST",
    body: { name: `Workflow BadRef ${suffix}`, client_type: "buyer", status: "lead", project_id: projectId, contract_id: 99999999 },
  });
  check(badRef.status >= 400, `a contract_id that does not exist is refused (${badRef.status})`);

  // 6. RBAC is unchanged. Customer Service cannot open the contracts module, so
  //    it must never reach the client-creation path at all; whichever gate fires
  //    first, the record must not be created as a completed client.
  const cs = await call("/auth/login", { method: "POST", body: { email: "cs@demo.mkuyu.local", password: legacyPasswordFor("cs@demo.mkuyu.local") } });
  const csMe = await call("/org/me", { token: cs.body.token });
  const csHasClients = (csMe.body.modules || []).includes("clients");
  const forbidden = await call("/clients", {
    token: cs.body.token, method: "POST",
    body: { name: `Workflow RBAC ${suffix}`, client_type: "buyer", status: "active", project_id: projectId, require_contract: true },
  });
  const created = forbidden.status === 201;
  check(!created, `a caller without the contracts module cannot create a completed client (${forbidden.status}, clients=${csHasClients})`);

  // 7. Historical clients are untouched and remain editable.
  const historical = (await query(
    "SELECT c.id FROM clients c WHERE c.organization_id=1 AND c.status='active' AND NOT EXISTS (SELECT 1 FROM contracts k WHERE k.client_id=c.id) ORDER BY c.id LIMIT 1",
  )).rows[0];
  if (historical) {
    const row = (await query("SELECT name, client_type, project_id, status, phone FROM clients WHERE id=$1", [historical.id])).rows[0];
    const edit = await call(`/clients/${historical.id}`, {
      token: salesToken, method: "PUT",
      body: { name: row.name, client_type: row.client_type, status: "active", project_id: row.project_id, phone: row.phone || "" },
    });
    check(edit.status === 200, `an existing client with no contract is still editable (${edit.status})`);
    const after = (await query("SELECT name, status FROM clients WHERE id=$1", [historical.id])).rows[0];
    check(after.name === row.name && after.status === row.status, "editing a historical client did not change its data");
  } else {
    check(true, "no historical contract-less client to check");
  }

  // 8. A contract is still creatable on its own, which is how a client is
  //    completed later.
  const standalone = await call("/contracts", {
    token: salesToken, method: "POST",
    body: { project_id: projectId, client_name: `Workflow Standalone ${suffix}`, contract_type: "new", original_price: 1000, discount_pct: 0 },
  });
  check(standalone.status === 201, `a contract can still be created without a linked client (${standalone.status})`);
  if (standalone.body.id) createdContracts.push(standalone.body.id);
} catch (error) {
  check(false, `unexpected error: ${error.message}`);
} finally {
  for (const id of createdContracts) await query("DELETE FROM contracts WHERE id=$1", [id]).catch(() => {});
  for (const id of createdClients) await query("DELETE FROM clients WHERE id=$1", [id]).catch(() => {});
  if (projectId) await query("DELETE FROM projects WHERE id=$1", [projectId]).catch(() => {});
  await closeDatabase();
  await server.stop();
}

console.log(failures ? `\n${failures} CLIENT WORKFLOW CHECK(S) FAILED` : "\nCLIENT_WORKFLOW_ALL_PASSED");
if (failures) process.exitCode = 1;
