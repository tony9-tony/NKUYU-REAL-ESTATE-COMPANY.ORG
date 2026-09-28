// End-to-end smoke test: starts its own API server against the dedicated PostgreSQL database.
// runs against it, then always stops the server and deletes the temp database.
// Run: node e2e_test.mjs  (optional: E2E_PORT=3177 node e2e_test.mjs)
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { closeDatabase } from "./backend/src/db.js";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.E2E_PORT || 3177);
const BASE = `http://localhost:${PORT}/api/v1`;
let token = "";
let serverProcess = null;
let serverLogs = "";

// The server this test drives needs the seeded accounts to exist in the
// throwaway database. Refuses to run if that database is the live workspace.
reapOrphanServers();
await prepareTestDatabase();

// ---- isolated server lifecycle -------------------------------------------

function startServer() {
  const child = spawn(process.execPath, [path.join(projectRoot, "backend", "src", "server.js")], {
    cwd: projectRoot,
    // DATABASE_URL comes from the isolation guard (the throwaway test database);
    // DATA_DIR keeps uploads and backups out of the live data/ directory.
    env: { ...process.env, PORT: String(PORT), DATABASE_URL: process.env.DATABASE_URL, DATA_DIR: process.env.DATA_DIR || path.join(projectRoot, "data", "test-runtime") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess = child;
  const forward = (chunk) => { serverLogs += chunk.toString(); };
  child.stdout.on("data", forward);
  child.stderr.on("data", forward);
  child.on("exit", (code, signal) => {
    child.exited = { code, signal };
  });
  return child;
}

async function stopServer() {
  if (!serverProcess) return;
  const child = serverProcess;
  if (child.exited) {
    serverProcess = null;
    return;
  }
  child.kill();
  const deadline = Date.now() + 5000;
  while (!child.exited && Date.now() < deadline) await sleep(100);
  if (!child.exited && child.pid) {
    // Force-kill the whole tree on Windows if graceful termination hangs.
    try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  serverProcess = null;
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (serverProcess?.exited) {
      throw new Error(`server exited early (code ${serverProcess.exited.code})\n${serverLogs}`);
    }
    try {
      const response = await fetch(`${BASE}/auth/state`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`server on port ${PORT} did not become ready: ${lastError?.message || "timeout"}\n${serverLogs}`);
}

// ---- HTTP helpers ----------------------------------------------------------

function assert(condition, label) {
  if (!condition) throw new Error(`Assertion failed: ${label}`);
  console.log(`ok: ${label}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function call(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!options.form) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${BASE}${path}`, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

async function main() {
  let res = await call("/auth/login", { method: "POST", body: JSON.stringify({ email: process.env.E2E_EMAIL || "admin@mkuyu.local", password: process.env.E2E_PASSWORD || (await import("./backend/src/org/demoCredentials.js")).legacyPasswordFor("admin@mkuyu.local") }) });
  assert(res.status === 200, "PostgreSQL admin login");
  token = res.payload.token;
  assert(Boolean(token), "has session token");

  // 1. Client selection on contracts.
  res = await call("/clients", { method: "POST", body: JSON.stringify({ name: "E2E Client", client_type: "buyer", status: "active" }) });
  assert(res.status === 201, "create client");
  const clientId = res.payload.id;
  res = await call("/projects", { method: "POST", body: JSON.stringify({ name: "E2E Project" }) });
  assert(res.status === 201, "create project");
  const projectId = res.payload.id;
  res = await call("/contracts", { method: "POST", body: JSON.stringify({ project_id: projectId, client_id: clientId, client_name: "E2E Client", contract_type: "new", value: 120000, start_date: "2026-10-01" }) });
  assert(res.status === 201 && res.payload.client_id === clientId, "create contract with linked client");
  const contractId = res.payload.id;
  res = await call(`/contracts/${contractId}`);
  assert(res.payload.linked_client_name === "E2E Client", "contract join returns linked client name");

  // 2. Payment schedule generator.
  res = await call(`/contracts/${contractId}/schedule`, { method: "POST", body: JSON.stringify({ deposit: 20000, installments: 7, first_due_date: "2026-11-05" }) });
  assert(res.status === 201, "generate schedule");
  let debts = res.payload.debts || [];
  const total = Math.round(debts.reduce((s, d) => s + d.amount, 0) * 100) / 100;
  assert(debts.length === 8, `deposit + 7 installments (got ${debts.length})`);
  assert(total === 120000, `schedule totals contract value (got ${total})`);
  assert(debts[1].due_date === "2026-11-05" && debts[2].due_date === "2026-12-05", `monthly due dates (${debts[1]?.due_date}, ${debts[2]?.due_date})`);
  res = await call(`/contracts/${contractId}/schedule`, { method: "POST", body: JSON.stringify({ deposit: 0, installments: 4, first_due_date: "2026-11-05" }) });
  assert(res.status === 409, "schedule refuses overwrite without replace");
  res = await call(`/contracts/${contractId}/schedule`, { method: "POST", body: JSON.stringify({ deposit: 0, installments: 4, first_due_date: "2026-11-05", replace: true }) });
  assert(res.status === 201 && res.payload.created === 4, "schedule replaces with replace=true");
  debts = res.payload.debts;

  // 3. Reminders: past-due installment surfaces in /reminders and acknowledges.
  res = await call("/debts", { method: "POST", body: JSON.stringify({ contract_id: contractId, client_name: "E2E Client", amount: 1000, due_date: "2026-08-01" }) });
  assert(res.status === 201, "create overdue installment directly");
  const reminderDebtId = res.payload.id;
  res = await call("/reminders");
  assert(Array.isArray(res.payload) && res.payload.some((r) => r.debt_id === reminderDebtId), "reminder auto-created for due installment");
  res = await call(`/reminders/${res.payload.find((r) => r.debt_id === reminderDebtId).id}/acknowledge`, { method: "POST", body: "{}" });
  assert(res.status === 200, "acknowledge reminder");

  // 4. Payment with receipt settles its installment.
  const firstDebt = debts[0];
  const paymentForm = new FormData();
  paymentForm.append("file", new Blob([PNG], { type: "image/png" }), "receipt.png");
  paymentForm.append("contract_id", String(contractId));
  paymentForm.append("debt_id", String(firstDebt.id));
  paymentForm.append("amount", String(firstDebt.amount));
  paymentForm.append("paid_at", "2026-10-02");
  paymentForm.append("method", "mobile");
  paymentForm.append("reference", "MP261001");
  res = await call("/payments/upload", { method: "POST", form: true, body: paymentForm });
  assert(res.status === 201, `payment with receipt uploaded (${JSON.stringify(res.payload).slice(0, 240)})`);
  const receiptPaymentId = res.payload?.id;
  assert(res.payload?.has_receipt === true, "payment reports has_receipt");
  const receiptResp = await fetch(`${BASE}/payments/${receiptPaymentId}/receipt`, { headers: { Authorization: `Bearer ${token}` } });
  assert(receiptResp.status === 200, "receipt endpoint returns 200");
  const receiptBytes = Buffer.from(await receiptResp.arrayBuffer());
  assert(receiptBytes.equals(PNG), "receipt bytes match uploaded PNG");
  res = await call(`/debts/${firstDebt.id}`);
  assert(res.payload.status === "paid", "installment auto-marked paid");

  // 5. Integrity: a schedule with recorded payments can never be replaced.
  res = await call(`/contracts/${contractId}/schedule`, { method: "POST", body: JSON.stringify({ deposit: 0, installments: 3, first_due_date: "2026-11-05", replace: true }) });
  assert(res.status === 409, "schedule replacement refused (409) when installments have payments");

  // 6. JSON payment without receipt; list exposes receipt flags.
  const secondDebt = debts[1];
  const thirdDebt = debts[2];
  res = await call("/payments", { method: "POST", body: JSON.stringify({ contract_id: contractId, debt_id: secondDebt.id, amount: secondDebt.amount, paid_at: "2026-10-03", method: "cash" }) });
  assert(res.status === 201 && res.payload.has_receipt === false, "JSON payment without receipt");
  const cashPaymentId = res.payload.id;
  res = await call("/payments");
  assert(Array.isArray(res.payload) && res.payload.some((p) => p.has_receipt), "payment list has receipt flags");

  // 7. Updating a payment retimes BOTH installments (old link reopens, new one settles).
  res = await call(`/payments/${cashPaymentId}`, { method: "PUT", body: JSON.stringify({ debt_id: thirdDebt.id }) });
  assert(res.status === 200, "update payment moves it to another installment");
  res = await call(`/debts/${secondDebt.id}`);
  assert(res.payload.status === "pending", "old installment reopens after its payment moved away");
  res = await call(`/debts/${thirdDebt.id}`);
  assert(res.payload.status === "paid", "new installment settles after payment moved onto it");

  // 8. Deleting the moved payment reopens that installment too (even from paid).
  res = await call(`/payments/${cashPaymentId}`, { method: "DELETE" });
  assert(res.status === 200, "delete payment");
  res = await call(`/debts/${thirdDebt.id}`);
  assert(res.payload.status === "pending", "installment reopens after its only payment is deleted");
  res = await call(`/debts/${firstDebt.id}`);
  assert(res.payload.status === "paid", "untouched installment keeps its paid status");
  res = await call(`/debts/${secondDebt.id}`);
  assert(res.payload.status === "pending", "old installment stays open after payment deletion");
  res = await call("/payments");
  assert(Array.isArray(res.payload) && res.payload.some((p) => p.id === receiptPaymentId && p.has_receipt), "receipt payment survives the unrelated delete");
  res = await call("/reports/summary");
  assert(Number(res.payload.income_all?.total) >= 30000, `income total includes surviving payments (got ${res.payload.income_all?.total})`);

  await runPropertyAndBackupTests(projectId);
}

async function runPropertyAndBackupTests(projectId) {
  let res = await call("/properties", { method: "POST", body: JSON.stringify({ project_id: projectId, name: "E2E Villa", property_type: "villa", status: "available", price: 500000, location: "Dar", area: 400, bedrooms: 4, bathrooms: 3, featured: false }) });
  assert(res.status === 201, "create property without pictures (must succeed)");
  const propertyId = res.payload.id;
  assert(res.payload.image_count === 0, "new property has zero pictures");

  res = await call(`/properties/${propertyId}/images`);
  assert(res.status === 200 && Array.isArray(res.payload) && res.payload.length === 0, "empty gallery lists fine");

  const imageForm = new FormData();
  imageForm.append("file", new Blob([PNG], { type: "image/png" }), "villa.png");
  res = await call(`/properties/${propertyId}/images`, { method: "POST", form: true, body: imageForm });
  assert(res.status === 201, "upload property picture");
  const imageId = res.payload?.id;
  assert(Boolean(res.payload?.file_url), "picture response has file_url");

  const coverResp = await fetch(`${BASE}/properties/${propertyId}/images/${imageId}/file`, { headers: { Authorization: `Bearer ${token}` } });
  assert(coverResp.status === 200, "picture file endpoint returns 200");

  res = await call(`/properties/${propertyId}`);
  assert(res.payload.image_count === 1 && res.payload.cover_image_id === imageId, "property reports cover + count");

  const badForm = new FormData();
  badForm.append("file", new Blob([Buffer.from("MZ.not-an-image")], { type: "application/x-msdownload" }), "evil.exe");
  res = await call(`/properties/${propertyId}/images`, { method: "POST", form: true, body: badForm });
  assert(res.status === 400, "non-image upload rejected with 400");
  res = await call(`/properties/${propertyId}/images`);
  assert(res.payload.length === 1, "rejected upload did not create a row");

  res = await call(`/properties/${propertyId}/images/${imageId}`, { method: "DELETE" });
  assert(res.status === 200, "delete picture");
  res = await call(`/properties/${propertyId}`);
  assert(res.payload.image_count === 0, "gallery empty after delete");

  res = await call("/backups", { method: "POST", body: "{}" });
  assert(res.status === 201 && res.payload?.name, `backup created (${res.payload?.name})`);
  const backupName = res.payload.name;
  // The backup must land in the ISOLATED runtime directory, not the live data/
  // directory. This assertion is what proves a test run cannot pollute the real
  // workspace with generated snapshots, so it checks the redirected path.
  const backupPath = path.join(process.env.DATA_DIR || path.join(projectRoot, "data", "test-runtime"), "backups", backupName);
  assert(fs.existsSync(backupPath), `backup is written to the isolated runtime directory (${backupPath})`);
  assert(!backupPath.startsWith(path.join(projectRoot, "data", "backups")), "the backup did NOT land in the live data/backups directory");
  res = await call("/backups");
  assert(Array.isArray(res.payload) && res.payload.some((b) => b.name === backupName), "backup listed");
  const dl = await fetch(`${BASE}/backups/${encodeURIComponent(backupName)}/download`, { headers: { Authorization: `Bearer ${token}` } });
  assert(dl.status === 200, "backup downloads");
  res = await call("/backups/system-not-a-real-backup.dump/download");
  assert(res.status === 404, "unknown but valid backup name 404s");
  res = await call("/backups/not-a-real-backup.db/download");
  assert(res.status === 400, "invalid backup name 400s");

  res = await call("/reports/summary");
  assert(res.payload.income_all && res.payload.income_30d, "summary exposes income totals");
}

try {
  startServer();
  await waitForServer();
  console.log(`E2E server ready on :${PORT} (database: mkuyu_org)`);
  await main();
  if (process.exitCode) {
    if (serverLogs.trim()) console.error("---- server logs ----\n" + serverLogs);
    console.log("\nE2E FAILED");
  } else {
    console.log("\nE2E ALL PASSED");
  }
} catch (error) {
  console.error("FAIL: unhandled", error);
  if (serverLogs.trim()) console.error("---- server logs ----\n" + serverLogs);
  process.exitCode = 1;
} finally {
  await stopServer();
  await closeDatabase().catch(() => {});
}

