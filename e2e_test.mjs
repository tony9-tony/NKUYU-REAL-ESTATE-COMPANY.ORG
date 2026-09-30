// End-to-end smoke test: starts its own API server against the dedicated PostgreSQL database.
// runs against it, then always stops the server and deletes the temp database.
// Run: node e2e_test.mjs  (optional: E2E_PORT=3177 node e2e_test.mjs)
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareTestDatabase, reapOrphanServers, connectedDatabase } from "./test_support/harness.mjs";
import { closeDatabase, query } from "./backend/src/db.js";

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
  const body = !options.form && options.body && typeof options.body === "object"
    ? JSON.stringify(options.body)
    : options.body;
  const response = await fetch(`${BASE}${path}`, { ...options, body, headers });
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

  await runPropertyAndBackupTests(projectId, clientId);
}

async function runPropertyAndBackupTests(projectId, clientId) {
  let res;
  const profilePhotoForm = new FormData();
  profilePhotoForm.append("file", new Blob([PNG], { type: "image/png" }), "profile.png");
  res = await call("/profile/photo", { method: "POST", form: true, body: profilePhotoForm });
  assert(res.status === 200 && Boolean(res.payload?.profile_photo_url), `upload profile photo (${res.status}: ${res.payload?.error || "ok"})`);
  const profile = await call("/org/me");
  assert(profile.payload?.user?.profile_photo_url, "profile photo is returned after refresh");
  const profilePhotoResponse = await fetch(`${BASE}/profile/photo`, { headers: { Authorization: `Bearer ${token}` } });
  assert(profilePhotoResponse.status === 200, "authenticated profile photo file endpoint returns 200");

  res = await call("/properties", { method: "POST", body: JSON.stringify({ project_id: projectId, name: "E2E Villa", property_type: "villa", status: "available", price: 500000, location: "Dar", area: 400, bedrooms: 4, bathrooms: 3, featured: false }) });
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

  await runContractGenerationTests(projectId, propertyId, clientId);

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

async function runContractGenerationTests(projectId, propertyId, clientId) {
  console.log("\n=== contract generation, templates and protected documents ===");
  const templateBody = `# FULL SALE AGREEMENT

Agreement {{CONTRACT_NUMBER}} between {{COMPANY_NAME}} and {{CLIENT_NAME}}.
Contact: {{CLIENT_PHONE}} / {{CLIENT_EMAIL}}.
Project: {{PROJECT_NAME}}. Property: {{PROPERTY_NAME}} ({{PROPERTY_NUMBER}}), {{PROPERTY_LOCATION}}.
Contract date: {{CONTRACT_DATE}}. Term: {{AGREEMENT_DURATION}} from {{AGREEMENT_START_DATE}} to {{AGREEMENT_END_DATE}}.
Original: {{ORIGINAL_PRICE}}. Discount: {{DISCOUNT_PERCENT}} / {{DISCOUNT_AMOUNT}}. Final: {{FINAL_PRICE}}.
Deposit: {{DEPOSIT}}. Installments: {{INSTALLMENT_COUNT}} at {{PAYMENT_FREQUENCY}}, first due {{FIRST_DUE_DATE}}.

FULL TERMS: The seller shall convey the property described above to the buyer on the terms stated in this agreement. Both parties acknowledge the purchase price and payment obligations stated above.

Signed for the Seller: ____________________
Signed by the Buyer: ____________________`;
  const template = await call("/contract-templates", { method: "POST", body: { title: "E2E Full Agreement", body_text: templateBody } });
  assert(template.status === 201, `authorized administrator creates a shared Documents template (${template.status})`);
  const templateId = template.payload.id;

  const badTemplate = await call("/contract-templates", { method: "POST", body: { title: "E2E Invalid Template", body_text: "Unknown {{NOT_A_CONTRACT_FIELD}}" } });
  assert(badTemplate.status === 400 && /unknown placeholder/i.test(badTemplate.payload.error || ""), "unknown template placeholder is rejected clearly");
  const orgId = (await query("SELECT id FROM organizations WHERE slug='mkuyu'")).rows[0].id;
  const malformed = await query(
    "INSERT INTO documents (organization_id,title,category,status,body_text) VALUES ($1,$2,'template','approved',$3) RETURNING id",
    [orgId, `E2E malformed template ${Date.now()}`, "Invalid {{NOT_A_CONTRACT_FIELD}}"],
  );

  const common = {
    project_id: projectId,
    property_id: propertyId,
    client_id: clientId,
    client_name: "E2E Client",
    client_phone: "+255 700 123 456",
    client_email: "e2e.client@example.com",
    contract_type: "new",
    contract_date: "2027-01-01",
    start_date: "2027-01-31",
    agreement_duration: 1,
    agreement_duration_unit: "months",
    end_date: "2027-02-28",
    original_price: 120000000,
    discount_pct: 10,
    template_document_id: templateId,
  };

  const savedToken = token;
  const financeLogin = await call("/auth/login", { method: "POST", body: { email: "finance@demo.mkuyu.local", password: (await import("./backend/src/org/demoCredentials.js")).legacyPasswordFor("finance@demo.mkuyu.local") } });
  token = financeLogin.payload.token || "";
  assert(Boolean(token), "Finance Officer signs in for template RBAC checks");
  const templateListDenied = await call("/contract-templates");
  assert(templateListDenied.status === 403, "Finance Officer without Documents access cannot list templates");
  const templateUseDenied = await call("/contracts/generate", { method: "POST", body: common });
  assert(templateUseDenied.status === 403, "Finance Officer with contract access cannot use a shared template without Documents access");
  token = savedToken;

  const unknownGeneration = await call("/contracts/generate", { method: "POST", body: { ...common, template_document_id: malformed.rows[0].id } });
  assert(unknownGeneration.status === 400 && /unknown placeholder/i.test(unknownGeneration.payload.error || ""), `generation refuses an unknown placeholder before creating the contract (${unknownGeneration.status}: ${unknownGeneration.payload.error || "no error text"})`);

  const generated = await call("/contracts/generate", {
    method: "POST",
    body: { ...common, deposit: 8000000, installments: 10, frequency: "monthly", first_due_date: "2027-02-28", final_price: 1, discount_amount: 0, value: 1 },
  });
  assert(generated.status === 201, `complete contract generation succeeds (${generated.status})`);
  const contract = generated.payload.contract || {};
  const document = generated.payload.document || {};
  assert(Number(contract.original_price) === 120000000 && Number(contract.discount_pct) === 10, "generation persists the submitted original price and discount percentage");
  assert(Number(contract.discount_amount) === 12000000 && Number(contract.value) === 108000000, "generation ignores forged amounts and stores authoritative pricing");
  assert(contract.client_phone === common.client_phone && contract.client_email === common.client_email, "contract stores entered phone and email snapshots");
  assert(contract.agreement_duration === 1 && contract.agreement_duration_unit === "months" && contract.end_date === "2027-02-28", "generation persists duration and derived end date");
  assert(contract.generated_document_id === document.id && contract.template_document_id === templateId, "generated document and selected template are linked to the contract");
  assert(document.contract_id === contract.id && document.has_file, "generated full document is stored and linked back to the contract");
  assert(generated.payload.schedule.created === 11, "generation creates the deposit and ten installments");
  const generationTotal = generated.payload.schedule.debts.reduce((sum, debt) => sum + Number(debt.amount), 0);
  assert(generationTotal === 108000000, `generated payment plan reconciles to contracts.value (${generationTotal})`);

  const templateDocument = await call(`/documents/${templateId}`);
  const { buildContractValues, renderContractDocument, DEFAULT_CONTRACT_TEMPLATE } = await import("./backend/src/contracts/generation.js");
  const rendered = renderContractDocument(templateDocument.payload.body_text, buildContractValues({
    contract,
    project: { name: "E2E Project" },
    property: { id: propertyId, name: "E2E Villa", location: "Dar" },
    client: {},
    companyName: "MKUYU",
  }));
  assert(rendered.includes("E2E Client") && rendered.includes(common.client_phone) && rendered.includes(common.client_email), "rendered full contract contains actual client and contact details");
  assert(rendered.includes("E2E Project") && rendered.includes("E2E Villa") && rendered.includes("Dar"), "rendered full contract contains project and property details");
  assert(rendered.includes("108,000,000.00") && rendered.includes("12,000,000.00"), "rendered contract contains actual discount and final price");
  assert(rendered.includes("FULL TERMS") && rendered.includes("Signed by the Buyer") && rendered.length > 500, "rendered document contains the complete terms and signature sections");
  assert(!/\{\{[A-Z_]+\}\}/.test(rendered), "no known or unknown raw placeholder remains in the rendered contract");

  const filePath = `/documents/${document.id}/file`;
  const opened = await fetch(`${BASE}${filePath}`, { headers: { Authorization: `Bearer ${token}` } });
  const docxBytes = Buffer.from(await opened.arrayBuffer());
  assert(opened.status === 200 && opened.headers.get("content-type")?.includes("wordprocessingml.document"), "Open serves the generated DOCX through the protected document route");
  assert(docxBytes.subarray(0, 2).toString() === "PK", "stored contract is a real DOCX package");

  const editor = await call(`/contracts/${contract.id}/document-content`);
  assert(editor.status === 200 && editor.payload.document_id === document.id, "View retrieves the exact document linked to the contract");
  assert(editor.payload.body_text.includes("FULL TERMS") && editor.payload.body_text.includes("E2E Client"), "View returns the complete readable agreement text");
  const revisedText = `${editor.payload.body_text}\n\nCUSTOMER REVISION: The buyer has reviewed this agreement.`;
  const saved = await call(`/contracts/${contract.id}/document-content`, { method: "PUT", body: { body_text: revisedText } });
  assert(saved.status === 200 && saved.payload.id === document.id, "Save replaces the generated file on the same document record");
  assert(saved.payload.original_filename.endsWith(".docx") && saved.payload.has_file, "the saved revision remains a stored DOCX");
  const reopened = await call(`/contracts/${contract.id}/document-content`);
  assert(reopened.payload.body_text.includes("CUSTOMER REVISION"), "reopening the modal shows the saved revision");
  const downloaded = await fetch(`${BASE}${filePath}?download=1`, { headers: { Authorization: `Bearer ${token}` } });
  const downloadBytes = Buffer.from(await downloaded.arrayBuffer());
  assert(downloaded.status === 200 && /attachment/i.test(downloaded.headers.get("content-disposition") || ""), "Download serves the revised DOCX as an attachment");
  assert(downloadBytes.subarray(0, 2).toString() === "PK", "downloaded revised contract is a DOCX package");

  token = financeLogin.payload.token;
  const documentDenied = await call(filePath);
  assert(documentDenied.status === 403, "Finance Officer without Documents access cannot open the generated document");
  token = savedToken;

  for (const [unit, duration, expected] of [
    ["days", 1, "2027-02-01"],
    ["weeks", 2, "2027-02-14"],
    ["years", 1, "2028-01-31"],
  ]) {
    const result = await call("/contracts/generate", { method: "POST", body: { ...common, template_document_id: null, agreement_duration_unit: unit, agreement_duration: duration, end_date: expected } });
    assert(result.status === 201 && result.payload.contract.end_date === expected, `${unit} duration persists the correct end date (${expected})`);
    const noPlanValues = buildContractValues({
      contract: result.payload.contract,
      project: { name: "E2E Project" },
      property: { id: propertyId, name: "E2E Villa", location: "Dar" },
      client: {},
      companyName: "MKUYU",
    });
    const builtIn = renderContractDocument(DEFAULT_CONTRACT_TEMPLATE, noPlanValues);
    assert(!/\{\{[A-Z_]+\}\}/.test(builtIn) && builtIn.includes("Not specified"), `${unit} generated contract fills optional payment placeholders explicitly`);
  }

  const ictLogin = await call("/auth/login", { method: "POST", body: { email: "icto@demo.mkuyu.local", password: (await import("./backend/src/org/demoCredentials.js")).legacyPasswordFor("icto@demo.mkuyu.local") } });
  token = ictLogin.payload.token || "";
  const ictGeneration = await call("/contracts/generate", { method: "POST", body: {} });
  assert(ictGeneration.status === 403, "ICTO receives no contract-generation business authority");
  token = savedToken;
}

try {
  startServer();
  await waitForServer();
  // Report the database the server is ACTUALLY connected to, read from the
  // connection rather than assumed. A hardcoded name here once claimed the live
  // database for a run that was in fact isolated, which is exactly the kind of
  // message that hides a real isolation bug.
  const connected = await connectedDatabase();
  if (connected === process.env.MKUYU_LIVE_DATABASE) {
    console.error(`\nREFUSING TO RUN: the E2E server is connected to the LIVE database "${connected}".\n`);
    process.exit(1);
  }
  console.log(`E2E server ready on :${PORT} (database: ${connected}, live is ${process.env.MKUYU_LIVE_DATABASE})`);
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

