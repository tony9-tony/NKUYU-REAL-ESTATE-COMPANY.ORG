// ---------------------------------------------------------------------------
// Phase 2.1 regression test: pricing and discount.
//
// `contracts.value` is the authoritative contract amount and is redefined as the
// FINAL PRICE. `original_price` and `discount_pct` are the only inputs; the
// server derives `discount_amount` and the final price, and a client-supplied
// final price is never trusted.
//
// The calculation runs in integer minor units (cents) with BigInt scaling, so no
// binary floating-point error can reach a monetary total.
//
// Written BEFORE the calculation exists: the pure-function block fails until
// backend/src/contracts/pricing.js is implemented.
// ---------------------------------------------------------------------------
import { legacyPasswordFor } from "./backend/src/org/demoCredentials.js";
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { query, closeDatabase } from "./backend/src/db.js";

// PRIVATE server on the throwaway test database, not the live app on :3003.
reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ label: "pricing", port: 3202 });
const base = server.base;
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

console.log("=== isolated generation migration ===");
const contractColumnRows = (await query(
  "SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='contracts'",
)).rows;
const contractColumns = new Set(contractColumnRows.map((row) => row.column_name));
const contractColumnInfo = new Map(contractColumnRows.map((row) => [row.column_name, row]));
for (const column of [
  "client_phone", "client_email", "original_price", "discount_pct", "discount_amount", "value",
  "start_date", "end_date", "agreement_duration", "agreement_duration_unit", "deposit_amount",
  "installment_count", "payment_frequency", "first_due_date", "contract_number", "contract_date",
  "template_document_id", "generated_document_id",
]) {
  check(contractColumns.has(column), `contracts.${column} exists after isolated migration`);
}
for (const column of ["client_phone", "client_email"]) {
  const info = contractColumnInfo.get(column);
  check(info?.is_nullable === "YES" && info.column_default === null, `contracts.${column} is nullable and has no default/backfill`);
}
for (const duplicate of ["final_price", "agreement_start_date", "agreement_end_date", "deposit"]) {
  check(!contractColumns.has(duplicate), `contracts.${duplicate} was not added as a duplicate field`);
}

async function call(path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

// === 1. the calculation itself (pure, no database) =========================
console.log("=== pricing calculation ===");
let computePricing = null;
try {
  ({ computePricing } = await import("./backend/src/contracts/pricing.js"));
} catch {
  console.log("FAIL  backend/src/contracts/pricing.js does not exist yet");
}

if (computePricing) {
  const money = (result) => ({
    original_price: Number(result.original_price),
    discount_pct: Number(result.discount_pct),
    discount_amount: Number(result.discount_amount),
    final_price: Number(result.final_price),
  });

  let r = money(computePricing({ originalPrice: 100000, discountPct: 0 }));
  check(r.discount_amount === 0 && r.final_price === 100000, `0% -> amount 0, final 100000 (got ${r.discount_amount}/${r.final_price})`);

  r = money(computePricing({ originalPrice: 100000, discountPct: 10 }));
  check(r.discount_amount === 10000, `10% of 100000 -> discount 10000 (got ${r.discount_amount})`);
  check(r.final_price === 90000, `10% of 100000 -> final 90000 (got ${r.final_price})`);

  r = money(computePricing({ originalPrice: 100000, discountPct: 100 }));
  check(r.discount_amount === 100000, `100% -> discount equals original (got ${r.discount_amount})`);
  check(r.final_price === 0, `100% -> final is 0, never negative (got ${r.final_price})`);

  let threw = null;
  try { computePricing({ originalPrice: -1, discountPct: 0 }); } catch (e) { threw = e; }
  check(Boolean(threw), `a negative original price is rejected (${threw?.message || "no error"})`);

  threw = null;
  try { computePricing({ originalPrice: 1000, discountPct: -5 }); } catch (e) { threw = e; }
  check(Boolean(threw), `a discount below 0 is rejected (${threw?.message || "no error"})`);

  threw = null;
  try { computePricing({ originalPrice: 1000, discountPct: 101 }); } catch (e) { threw = e; }
  check(Boolean(threw), `a discount above 100 is rejected (${threw?.message || "no error"})`);

  for (const pct of [0, 1, 7.5, 33.33, 50, 99.99, 100]) {
    const out = money(computePricing({ originalPrice: 99999.99, discountPct: pct }));
    check(out.discount_amount <= out.original_price && out.final_price >= 0, `pct ${pct}: discount <= original and final >= 0`);
  }

  r = money(computePricing({ originalPrice: 0.1, discountPct: 50 }));
  check(r.discount_amount === 0.05 && r.final_price === 0.05, `0.10 at 50% -> 0.05/0.05 exactly (got ${r.discount_amount}/${r.final_price})`);
  r = money(computePricing({ originalPrice: 120000000, discountPct: 10 }));
  check(r.discount_amount === 12000000 && r.final_price === 108000000, `120,000,000 at 10% -> 12,000,000 / 108,000,000 (got ${r.discount_amount}/${r.final_price})`);

  // The specified rule is `original * (pct / 100)`. Asserted directly so a future
  // edit that drops the division by 100 fails here rather than in production.
  for (const [original, pct, expectedDiscount, expectedFinal] of [
    [100000000, 10, 10000000, 90000000],
    [100000, 10, 10000, 90000],
    [100000, 0, 0, 100000],
    [100000, 100, 100000, 0],
    [250000, 1, 2500, 247500],
    [80000000, 25, 20000000, 60000000],
  ]) {
    const out = money(computePricing({ originalPrice: original, discountPct: pct }));
    // Independently recompute the specification: original * (pct / 100).
    const specDiscount = Math.round(original * (pct / 100) * 100) / 100;
    const specFinal = original - specDiscount;
    check(
      out.discount_amount === expectedDiscount && out.final_price === expectedFinal
        && out.discount_amount === specDiscount && out.final_price === specFinal,
      `original ${original} at ${pct}% -> discount ${out.discount_amount}, final ${out.final_price} (spec: ${specDiscount}/${specFinal})`,
    );
  }

  // A percentage is a plain number, not a fraction: 10 means 10%, so a 10% discount
  // must be a tenth of the original, NOT ten times it.
  const tenth = money(computePricing({ originalPrice: 1000000, discountPct: 10 }));
  check(tenth.discount_amount === 100000, `10% of 1,000,000 is 100,000, not 10,000,000 (got ${tenth.discount_amount})`);

  r = money(computePricing({ originalPrice: 100000, discountPct: 10, finalPrice: 999999 }));
  check(r.final_price === 90000, `a forged final price in the input is ignored (got ${r.final_price})`);

  r = money(computePricing({ originalPrice: 0, discountPct: 25 }));
  check(r.original_price === 0 && r.final_price === 0, "a zero original price is allowed and yields a zero final price");
}


// === 2. the API persists the calculation and refuses a forged final price ===
const reachable = await call("/health").then((r) => r.status === 200).catch(() => false);
if (!reachable) {
  console.log(`FAIL  no server at ${base} - start it with "npm start" first`);
  await closeDatabase();
  console.log(failures ? `\n${failures} PRICING CHECK(S) FAILED` : "\nPRICING_ALL_PASSED");
  process.exit(1);
}

console.log("\n=== pricing through the API ===");
let salesToken = "";
let projectId = null;
let contractId = null;
let adminContractId = null;

try {
  const sales = await call("/auth/login", { method: "POST", body: { email: "sales@demo.mkuyu.local", password: legacyPasswordFor("sales@demo.mkuyu.local") } });
  salesToken = sales.body.token || "";
  check(Boolean(salesToken), "a sales officer signed in");

  // Snapshot an existing contract so we can prove it was not disturbed.
  const before = (await query("SELECT id FROM contracts WHERE organization_id=1 ORDER BY id LIMIT 1")).rows[0];
  const beforeRow = (await query("SELECT value, contract_number, client_name FROM contracts WHERE id=$1", [before.id])).rows[0];

  const suffix = Date.now();
  const project = await call("/projects", { token: salesToken, method: "POST", body: { name: `Pricing Project ${suffix}` } });
  projectId = project.body.id;
  const client = await call("/clients", { token: salesToken, method: "POST", body: { name: `Pricing Client ${suffix}`, client_type: "buyer", status: "active" } });
  const baseBody = { project_id: projectId, client_id: client.body.id, client_name: `Pricing Client ${suffix}`, contract_type: "new", deal_type: "buy" };

  const created = await call("/contracts", { token: salesToken, method: "POST", body: { ...baseBody, original_price: 100000, discount_pct: 10 } });
  contractId = created.body.id;
  check(created.status === 201, `a contract is created from original_price + discount_pct (${created.status})`);
  check(Number(created.body.original_price) === 100000, `original_price persisted (${created.body.original_price})`);
  check(Number(created.body.discount_pct) === 10, `discount_pct persisted (${created.body.discount_pct})`);
  check(Number(created.body.discount_amount) === 10000, `discount_amount calculated by the server (${created.body.discount_amount})`);
  check(Number(created.body.final_price) === 90000, `final_price calculated by the server (${created.body.final_price})`);
  check(Number(created.body.value) === 90000, `contracts.value carries the final price (${created.body.value})`);

  const forged = await call(`/contracts/${contractId}`, {
    token: salesToken, method: "PUT",
    body: { ...baseBody, original_price: 100000, discount_pct: 10, discount_amount: 0, final_price: 1, value: 1 },
  });
  check(Number(forged.body.final_price) === 90000, `a forged final_price is ignored on update (${forged.body.final_price})`);
  check(Number(forged.body.discount_amount) === 10000, `a forged discount_amount is ignored on update (${forged.body.discount_amount})`);
  check(Number(forged.body.value) === 90000, `a forged value is ignored on update (${forged.body.value})`);

  const full = await call(`/contracts/${contractId}`, { token: salesToken, method: "PUT", body: { ...baseBody, original_price: 100000, discount_pct: 100 } });
  check(Number(full.body.final_price) === 0, `100% discount yields a final price of 0 (${full.body.final_price})`);

  // Legacy callers that send only `value` (no pricing fields) keep working: the
  // amount becomes the list price with no discount. Prevents a silent regression
  // for any existing client of POST /contracts.
  const legacy = await call("/contracts", { token: salesToken, method: "POST", body: { ...baseBody, value: 750000 } });
  const legacyId = legacy.body.id;
  check(legacy.status === 201, `a legacy contract created with only 'value' still works (${legacy.status})`);
  check(Number(legacy.body.final_price) === 750000, `legacy 'value' becomes the list price with no discount (${legacy.body.final_price})`);
  check(Number(legacy.body.discount_pct) === 0, "the legacy path records a 0% discount");
  await query("DELETE FROM contracts WHERE id=$1", [legacyId]).catch(() => {});

  const badPct = await call(`/contracts/${contractId}`, { token: salesToken, method: "PUT", body: { ...baseBody, original_price: 1000, discount_pct: 150 } });
  check(badPct.status === 400, `a discount above 100 is refused with 400 (${badPct.status}: ${badPct.body.error || ""})`);

  const badPrice = await call(`/contracts/${contractId}`, { token: salesToken, method: "PUT", body: { ...baseBody, original_price: -500, discount_pct: 0 } });
  check(badPrice.status === 400, `a negative original price is refused with 400 (${badPrice.status}: ${badPrice.body.error || ""})`);

  // Payment schedule must consume the authoritative final price. This runs
  // against an ADMINISTRATOR-created contract, which is organization-visible:
  // a Sales-owned contract is department-scoped, so Finance and Legal correctly
  // cannot see it. The 404 that taught us this is the record-scope rule working.
  const admin = await call("/auth/login", { method: "POST", body: { email: "md@demo.mkuyu.local", password: legacyPasswordFor("md@demo.mkuyu.local") } });
  const adminContract = await call("/contracts", { token: admin.body.token, method: "POST", body: { ...baseBody, original_price: 120000000, discount_pct: 10 } });
  const adminContractId = adminContract.body.id;
  check(Number(adminContract.body.discount_amount) === 12000000, "the server calculates a 12,000,000 discount");
  check(Number(adminContract.body.value) === 108000000, "contracts.value stores the 108,000,000 final price");

  const finance = await call("/auth/login", { method: "POST", body: { email: "finance.manager@demo.mkuyu.local", password: legacyPasswordFor("finance.manager@demo.mkuyu.local") } });
  const schedule = await call(`/contracts/${adminContractId}/schedule`, { token: finance.body.token, method: "POST", body: { deposit: 8000000, installments: 10, first_due_date: "2027-01-05" } });
  check(schedule.status === 201, `a payment schedule is generated (${schedule.status})`);
  const planTotal = Number((schedule.body.debts || []).reduce((sum, debt) => sum + Number(debt.amount), 0));
  check((schedule.body.debts || []).length === 11, `the schedule contains one deposit and ten installments (got ${(schedule.body.debts || []).length})`);
  check(planTotal === 108000000, `deposit plus installments reconcile to the FINAL value 108000000, not 120000000 (got ${planTotal})`);

  const afterRow = (await query("SELECT value, contract_number, client_name FROM contracts WHERE id=$1", [before.id])).rows[0];
  check(Number(afterRow.value) === Number(beforeRow.value), `an existing contract keeps its value (${beforeRow.value} -> ${afterRow.value})`);
  check(afterRow.contract_number === beforeRow.contract_number && afterRow.client_name === beforeRow.client_name, "an existing contract keeps its number and client");

  const legal = await call("/auth/login", { method: "POST", body: { email: "legal@demo.mkuyu.local", password: legacyPasswordFor("legal@demo.mkuyu.local") } });
  const legalPeek = await call(`/contracts/${adminContractId}`, { token: legal.body.token });
  check(legalPeek.status === 200, "legal can still read an organization-visible contract (the lifecycle is untouched)");
  const legalPeekOwed = await call(`/contracts/${contractId}`, { token: legal.body.token });
  check(legalPeekOwed.status === 404, "record scope is unchanged: legal still cannot reach a department-scoped contract");
} catch (error) {
  check(false, `unexpected error: ${error.message}`);
} finally {
  if (contractId) await query("DELETE FROM contracts WHERE id=$1", [contractId]).catch(() => {});
  if (adminContractId) await query("DELETE FROM contracts WHERE id=$1", [adminContractId]).catch(() => {});
  if (projectId) await query("DELETE FROM projects WHERE id=$1", [projectId]).catch(() => {});
  await query("DELETE FROM clients WHERE name LIKE 'Pricing Client %'").catch(() => {});
  await closeDatabase();
  await server.stop();
}

console.log(failures ? `\n${failures} PRICING CHECK(S) FAILED` : "\nPRICING_ALL_PASSED");
if (failures) process.exitCode = 1;
