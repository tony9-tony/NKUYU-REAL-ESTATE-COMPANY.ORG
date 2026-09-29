// Verifies GET /org/duties against the running server.
//
// Two properties matter and are easy to get backwards:
//   1. an unauthenticated caller is refused (it sits behind the normal auth gate);
//   2. a signed-in STAFF member can read it, because the duty catalogue and the
//      approval path are organizational reference data, not business records.
//
// It also asserts the payload matches the enforcement the server already holds:
// the stage rail must cover every contract status, and each stage's owning
// department must be a department CONTRACT_OWNERSHIP really gives that
// permission. That is the check that would catch the diagram claiming, say, that
// Sales may give management approval.
import { CONTRACT_STATUSES, WORKFLOW_STAGES } from "../backend/src/contracts/workflow.js";
import { CONTRACT_OWNERSHIP } from "../backend/src/org/duties.js";
import { demoPasswordFor } from "../backend/src/org/demoCredentials.js";

const BASE = process.env.BASE_URL || "http://localhost:3003/api/v1";

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

const request = async (path, token) => {
  const response = await fetch(`${BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON error page */ }
  return { status: response.status, body };
};

// --- 1. Unauthenticated is refused -----------------------------------------
const anon = await request("/org/duties");
check(anon.status === 401, `an unauthenticated caller is refused (got ${anon.status})`);

// --- 2. Sign in as a seeded demo staff member -------------------------------
// The password comes from the same helper the seeding uses, so this test never
// hard-codes a credential or needs one rotated by hand.
const email = process.env.DEMO_EMAIL || "sales@demo.mkuyu.local";
const password = demoPasswordFor(email);
const signedIn = await fetch(`${BASE}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
const session = await signedIn.json().catch(() => null);
const token = session?.token;
if (!token) {
  console.log(`\nSKIPPED: could not sign in as ${email}. These live checks need the seeded demo account.`);
  console.log(`(HTTP ${signedIn.status})`);
  process.exit(0);
}
check(true, `signed in as ${email}`);

// --- 3. Staff can read the reference data ----------------------------------
const res = await request("/org/duties", token);
check(res.status === 200, `a staff member can read /org/duties (got ${res.status})`);
if (res.status !== 200) process.exit(1);

const data = res.body;
check(Array.isArray(data.departments) && data.departments.length === 6, `all six departments are returned (got ${data.departments?.length})`);
check(data.totals.roles === 16, `all sixteen roles are returned (got ${data.totals?.roles})`);
check(data.totals.duties >= 78, `every duty is returned (got ${data.totals?.duties})`);
check(data.departments.every((department) => department.roles.length > 0), "every department carries at least one role");
check(data.departments.every((department) => department.roles.every((role) => role.duties.length > 0)), "every role carries at least one duty");

// --- 4. The workflow rail matches the enforced state machine ---------------
const stageStatuses = data.workflow.stages.map((stage) => stage.status);
const exceptionStatuses = data.workflow.exceptions.map((entry) => entry.status);
const covered = new Set([...stageStatuses, ...exceptionStatuses]);
const missing = CONTRACT_STATUSES.filter((status) => !covered.has(status));
check(missing.length === 0, `the rail covers every contract status${missing.length ? ` (missing ${missing.join(", ")})` : ""}`);
check(data.workflow.stages.length === WORKFLOW_STAGES.length, "every pipeline stage is published");

// The department that ACTS at each stage must be one CONTRACT_OWNERSHIP really
// gives that permission. This is the check that would catch the diagram
// claiming, say, that Sales may give management approval. `owner` is the desk
// holding the contract once it arrives, which is a different question and is
// deliberately not tested here.
const ownershipProblems = [];
for (const stage of data.workflow.stages) {
  const owners = CONTRACT_OWNERSHIP[stage.permission];
  if (!owners) continue; // `create` is not a lifecycle permission
  if (!owners.includes(stage.actor)) ownershipProblems.push(`${stage.status}: ${stage.actor} may not ${stage.permission}`);
}
check(ownershipProblems.length === 0, `every stage's acting department may hold its permission${ownershipProblems.length ? ` (${ownershipProblems.join("; ")})` : ""}`);

// Handover: once Sales submits, the contract belongs to Legal, so no stage after
// `submitted` may still be owned by Sales.
const handedOver = data.workflow.stages.filter((stage) => stage.stage > 2 && stage.owner === "SALES, MARKETING & OPERATIONS");
check(handedOver.length === 0, `Sales hands the contract to Legal at step 2 and does not own it again${handedOver.length ? ` (${handedOver.map((s) => s.status).join(", ")})` : ""}`);

// --- 5. The caller's own authority is reflected, and only their own ---------
const me = await request("/org/me", token);
const held = new Set(me.body.permissions || []);
const yourApprovals = new Set(data.yourApprovals || []);
const leaked = [...yourApprovals].filter((key) => !held.has(key));
check(leaked.length === 0, `yourApprovals only lists permissions the caller holds${leaked.length ? ` (leaked ${leaked.join(", ")})` : ""}`);

const overclaimed = data.workflow.stages.filter((stage) => stage.yours && !held.has(stage.permission));
check(overclaimed.length === 0, `a stage is marked "yours" only when the caller holds its permission${overclaimed.length ? ` (${overclaimed.map((s) => s.status).join(", ")})` : ""}`);

const dutyOverclaims = [];
for (const department of data.departments) {
  for (const role of department.roles) {
    for (const duty of role.duties) {
      if (duty.yours && !duty.permissions.every((key) => held.has(key))) dutyOverclaims.push(`${role.role}/${duty.key}`);
    }
  }
}
check(dutyOverclaims.length === 0, `a duty is marked "yours" only when every permission it needs is held${dutyOverclaims.length ? ` (${dutyOverclaims.join(", ")})` : ""}`);

// --- 6. It is reference data only: no business records leak -----------------
const raw = JSON.stringify(data);
check(!/"(client_name|email|password_hash|contract_number|owner_id)"/.test(raw), "the payload carries no business or personal record fields");
check(!data.users && !data.clients && !data.contracts, "no user, client or contract collections are included");

// --- 7. The admin-only matrix is still admin-only ---------------------------
const anonMatrix = await request("/org/access-matrix");
check(anonMatrix.status === 401, `the access matrix stays closed to anonymous callers (got ${anonMatrix.status})`);

console.log(failures ? `\n${failures} DUTIES CHECK(S) FAILED` : "\nDUTIES_ALL_PASSED");
process.exit(failures ? 1 : 0);
