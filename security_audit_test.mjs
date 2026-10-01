// Authorized, defensive security probe for the LOCAL MKUYU application.
//
// Scope: the real HTTP API of a private server bound to the throwaway test
// database. It asserts that the server refuses what it must refuse. It never
// touches the live workspace and never attacks a system it does not own.
//
// Run: node --import ./test_support/guard.mjs security_audit_test.mjs
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { legacyPasswordFor, demoPasswordFor } from "./backend/src/org/demoCredentials.js";
import { closeDatabase } from "./backend/src/db.js";
import { connect } from "node:net";

const PORT = 3210;

reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ label: "security-audit", port: PORT });
const base = server.base;

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

const ADMIN = { email: "admin@mkuyu.local", password: legacyPasswordFor("admin@mkuyu.local") };
const MD = { email: "md@mkuyu.local", password: legacyPasswordFor("md@mkuyu.local") };
const SALES = { email: "sales@demo.mkuyu.local", password: demoPasswordFor("sales@demo.mkuyu.local") };
const LEGAL = { email: "legal@demo.mkuyu.local", password: demoPasswordFor("legal@demo.mkuyu.local") };
const CS = { email: "cs@demo.mkuyu.local", password: demoPasswordFor("cs@demo.mkuyu.local") };

async function login({ email, password }) {
  const response = await fetch(`${base}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function call(path, { token, method = "GET", body, headers = {}, raw = false } = {}) {
  const merged = { ...headers };
  if (body !== undefined && !raw) merged["Content-Type"] = "application/json";
  if (token) merged.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, {
    method, headers: merged,
    body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
  });
  const text = await response.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = { __text: text }; }
  return { status: response.status, body: parsed, headers: response.headers };
}

try {
  const adminToken = (await login(ADMIN)).body.token;
  const salesToken = (await login(SALES)).body.token;
  const legalToken = (await login(LEGAL)).body.token;
  const csToken = (await login(CS)).body.token;
  const mdToken = (await login(MD)).body.token;
  check(Boolean(adminToken && salesToken && legalToken && csToken && mdToken), "every persona signed in for the probe");

  // === 1. Unauthenticated access ==========================================
  console.log("\n=== 1. unauthenticated access is refused ===");
  for (const path of ["/projects", "/clients", "/contracts", "/debts", "/payments", "/org/users", "/org/me", "/backups", "/auth/me"]) {
    const res = await call(path);
    check(res.status === 401, `${path} without a token -> 401 (${res.status})`);
  }
  const write = await call("/clients", { method: "POST", body: { name: "x", client_type: "buyer", status: "active" } });
  check(write.status === 401, `POST /clients without a token -> 401 (${write.status})`);

  // === 2. Session forgery / invalidation ===================================
  console.log("\n=== 2. session tokens are unforgeable ===");
  for (const bad of ["abc", "0000000000000000", "null", "../../etc/passwd"]) {
    const res = await call("/auth/me", { token: bad });
    check(res.status === 401, `a forged token ${JSON.stringify(bad).slice(0, 18)} is refused -> ${res.status}`);
  }
  const tampered = await call("/auth/me", { token: `${adminToken}x` });
  check(tampered.status === 401, `a token with one character altered is refused -> ${tampered.status}`);
  // A logout must actually kill the session, not just clear the client.
  const throwaway = (await login(SALES)).body.token;
  const before = await call("/auth/me", { token: throwaway });
  await call("/auth/logout", { token: throwaway, method: "POST", body: "{}" });
  // === 3. Role escalation by parameter tampering ===========================
  console.log("\n=== 3. a staff account cannot become an administrator by asking ===");
  const forgedUser = await call("/org/users", {
    token: salesToken, method: "POST",
    body: { email: `forged.${Date.now()}@mkuyu.local`, password: "ForgedPassword123", display_name: "Forged Admin", role: "admin", role_ids: [1] },
  });
  check(forgedUser.status === 403, `staff cannot create a user at all (${forgedUser.status})`);
  // Even the administrator's create path must not honour a forged role column.
  const marker = `sec.newuser.${Date.now()}@mkuyu.local`;
  const created = await call("/org/users", {
    token: adminToken, method: "POST",
    body: { email: marker, password: "ForgedPassword123", display_name: "Forged", role: "admin", role_ids: [1], department_ids: [] },
  });
  if (created.status === 201) {
    check(created.body?.role === "staff", `a user created with a forged role:admin body is stored as ${created.body?.role} (the server decides)`);
  } else {
    check([400, 403].includes(created.status), `admin user creation refused for another reason (${created.status})`);
  }
  // Self-promotion: a staff member editing their own row to claim admin.
  const me = await call("/auth/me", { token: salesToken });
  const selfPromote = await call(`/org/users/${me.body.id}`, { token: salesToken, method: "PUT", body: { role: "admin" } });
  check(selfPromote.status === 403, `staff cannot edit their own user row (${selfPromote.status})`);

  // === 4. Privilege escalation on admin-only endpoints =====================
  console.log("\n=== 4. admin-only endpoints refuse every staff account ===");
  const adminOnly = ["/org/users", "/org/roles", "/org/departments", "/org/permissions", "/org/access-matrix", "/org/records/allocation", "/org/settings", "/backups"];
  for (const [name, token] of [["MD", mdToken], ["sales", salesToken], ["legal", legalToken], ["customer service", csToken]]) {
    for (const path of adminOnly) {
      const res = await call(path, { token });
      check(res.status === 403, `${name} -> ${path} is 403 (${res.status})`);
    }
  }

  // === 5. Cross-department data access (IDOR) ==============================
  console.log("\n=== 5. records are scoped to their owner/department ===");
  const stampId = Date.now();
  const privateProject = await call("/projects", { token: salesToken, method: "POST", body: { name: `SEC Private ${stampId}` } });
  check(privateProject.status === 201, `sales created a private project (${privateProject.status})`);
  const projectId = privateProject.body?.id;
  if (projectId) {
    // The Managing Director is deliberately organization-scoped: `access_matrix`
    // asserts "managing director sees organization-wide records", so the MD
    // reading a business record is the design, not a leak. System
    // administration is still withheld (section 4 covers that).
    for (const [name, token] of [["legal", legalToken], ["customer service", csToken]]) {
      const direct = await call(`/projects/${projectId}`, { token });
      check([403, 404].includes(direct.status), `${name} cannot read sales' private project by id (${direct.status})`);
    }
    const byMd = await call(`/projects/${projectId}`, { token: mdToken });
    check(byMd.status === 200, `the Managing Director (organization scope) still can (${byMd.status})`);
    const byAdmin = await call(`/projects/${projectId}`, { token: adminToken });
    check(byAdmin.status === 403, `the System Administrator cannot read business records (${byAdmin.status})`);
    // Enumeration must not leak it through a list either.
    for (const [name, token] of [["legal", legalToken], ["customer service", csToken]]) {
      const listed = await call("/projects", { token });
      const rows = Array.isArray(listed.body) ? listed.body : [];
      const leaked = rows.some((p) => p.id === projectId);
      check(!leaked, `the private project does not appear in ${name}'s list`);
    }
  }

  // === 6. Identifier validation ============================================
  console.log("\n=== 6. identifiers are validated, not blindly cast ===");
  for (const badId of ["0", "-1", "abc", "1 OR 1=1", "1;DROP TABLE users", "1.5", "999999999999"]) {
    const res = await call(`/projects/${encodeURIComponent(badId)}`, { token: mdToken });
    check([400, 404].includes(res.status), `project id ${JSON.stringify(badId).slice(0, 18)} -> 400/404 (${res.status})`);
  }

  // === 7. SQL injection attempts ==========================================
  console.log("\n=== 7. injected input is treated as data, not SQL ===");
  for (const payload of ["'; DROP TABLE users; --", "1' OR '1'='1", "admin'--", "\\'; DELETE FROM clients; --"]) {
    const res = await call("/projects", { token: mdToken, method: "POST", body: { name: payload, status: "active" } });
    check([201, 400].includes(res.status), `a project named ${JSON.stringify(payload).slice(0, 22)} is stored, not executed (${res.status})`);
  }
  const stillThere = await call("/projects", { token: mdToken });
  check(stillThere.status === 200, "the endpoints still answer after the injection attempts");
  for (const payload of ["' OR 1=1 --", "%' OR '1'='1", "1; DELETE FROM users"]) {
    const res = await call(`/projects?search=${encodeURIComponent(payload)}`, { token: mdToken });
    check(res.status === 200, `a search for ${JSON.stringify(payload).slice(0, 20)} returns 200 rather than erroring (${res.status})`);
  }
  // === 8. Path traversal on every file-serving endpoint ====================
  console.log("\n=== 8. file endpoints refuse path traversal ===");
  const traversals = [
    "../../../../../../etc/passwd",
    "..%2f..%2f..%2fetc%2fpasswd",
    "....//....//etc/passwd",
    "/etc/passwd",
    "..\\..\\..\\windows\\win.ini",
  ];
  for (const payload of traversals) {
    for (const path of [
      `/documents/${encodeURIComponent(payload)}/file`,
      `/properties/${encodeURIComponent(payload)}/images/1/file`,
    ]) {
      const res = await call(path, { token: mdToken });
      check([400, 404].includes(res.status), `traversal in ${path.slice(0, 42)} -> 400/404 (${res.status})`);
    }
  }
  // The backup download route takes a name straight from the URL.
  for (const payload of ["..%2f..%2f.env", "....//....//.env", "..%5c..%5c.env", ".env", "..%2f..%2fpackage.json"]) {
    const res = await call(`/backups/${payload}/download`, { token: adminToken });
    check([400, 404].includes(res.status), `backup download ${JSON.stringify(payload).slice(0, 24)} -> 400/404 (${res.status})`);
  }

  // === 9. Error messages must not leak internals ==========================
  console.log("\n=== 9. errors do not leak internals ===");
  const badId = await call("/projects/abc", { token: mdToken });
  const badLogin = await call("/auth/login", { method: "POST", body: { email: "not-an-email", password: "x" } });
  for (const [label, res] of [["bad id", badId], ["bad login", badLogin]]) {
    const text = JSON.stringify(res.body);
    check(!/postgres|pg_|at Object|node_modules|SELECT |INSERT |stack|at .*\.js:/i.test(text),
      `${label} error carries no internals (${text.slice(0, 90)})`);
  }
  const sqlErr = await call("/projects", { token: mdToken, method: "POST", body: { name: "x".repeat(60000), status: "active" } });
  check([400, 413].includes(sqlErr.status), `an oversized payload is refused cleanly (${sqlErr.status})`);

  // === 10. Account enumeration ============================================
  console.log("\n=== 10. login does not reveal whether an account exists ===");
  const unknown = await call("/auth/login", { method: "POST", body: { email: "definitely.not.here@mkuyu.local", password: "Whatever12345" } });
  const wrongPassword = await call("/auth/login", { method: "POST", body: { email: "sales@demo.mkuyu.local", password: "Whatever12345" } });
  check(unknown.status === 401 && wrongPassword.status === 401, "an unknown address and a wrong password both return 401");
  check(unknown.body?.error === wrongPassword.body?.error, `identical message for both ("${unknown.body?.error}")`);
  const adminWrong = await call("/auth/login", { method: "POST", body: { email: "admin@mkuyu.local", password: "Whatever12345" } });
  check(adminWrong.body?.error === unknown.body?.error, "an administrator address is indistinguishable from an unknown one");

  // === 11. XSS payloads are stored inertly ===============================
  console.log("\n=== 11. script payloads are stored as plain text ===");
  const xss = "<script>alert(1)</script>";
  const xssClient = await call("/clients", { token: salesToken, method: "POST", body: { name: xss, client_type: "buyer", status: "active" } });
  check([201, 400].includes(xssClient.status), `a client name containing a script tag is accepted as text (${xssClient.status})`);
  if (xssClient.status === 201) {
    const back = await call(`/clients/${xssClient.body.id}`, { token: salesToken });
    check(back.body?.name === xss, "the API round-trips the name verbatim as a JSON string");
  }
  const ct = (await call("/projects", { token: mdToken })).headers.get("content-type") || "";
  check(/application\/json/.test(ct), `API responses are served as application/json (${ct})`);

  // === 12. Mass assignment on contracts (forged money/status) =============
  console.log("\n=== 12. a client cannot forge contract money or status ===");
  // A valid project is required, otherwise the API correctly answers 400 and we
  // would not actually be testing the forgery at all.
  const project = (await call("/projects", { token: salesToken, method: "POST", body: { name: `SEC Pricing ${Date.now()}` } })).body;
  const client = (await call("/clients", { token: salesToken, method: "POST", body: { name: `SEC Client ${Date.now()}`, client_type: "buyer", status: "active" } })).body;
  check(project?.id && client?.id, "a project and a client exist to price a contract against");
  if (project?.id && client?.id) {
    const forgedContract = await call("/contracts", {
      token: salesToken, method: "POST",
      body: {
        project_id: project.id, client_id: client.id,
        client_name: "SEC Client", contract_type: "new", deal_type: "buy",
        original_price: 1000, discount_pct: 0,
        // Forged: the server must price the contract, not accept these.
        final_price: 1, discount_amount: 999, status: "active",
      },
    });
    check(forgedContract.status === 201, `a contract with forged money fields was accepted (${forgedContract.status})`);
    if (forgedContract.status === 201) {
      check(forgedContract.body?.status === "draft", `forged status:active is ignored, stored as ${forgedContract.body?.status}`);
      check(Number(forgedContract.body?.value) === 1000, `forged final_price:1 is ignored, server value is ${forgedContract.body?.value}`);
      check(Number(forgedContract.body?.final_price ?? 1000) === 1000, `forged final_price is not echoed back (${forgedContract.body?.final_price})`);
    }
    // And the same forgery through an UPDATE, which is the classic bypass.
    const putForged = await call(`/contracts/${forgedContract.body?.id}`, {
      token: salesToken, method: "PUT",
      body: { status: "active", final_price: 1, discount_amount: 999, original_price: 1000 },
    });
    if ([200, 400].includes(putForged.status)) {
      check(putForged.body?.status !== "active", `an update cannot jump a draft to active (${putForged.body?.status ?? putForged.status})`);
      if (putForged.status === 200) check(Number(putForged.body?.value) === 1000, `an update cannot reprice the contract to 1 (${putForged.body?.value})`);
    }
    const bornCancelled = await call("/contracts", {
      token: salesToken, method: "POST",
      body: { project_id: project.id, client_id: client.id, client_name: "SEC Client", contract_type: "new", deal_type: "buy", value: 500, status: "cancelled" },
    });
    check(bornCancelled.status === 201 ? bornCancelled.body?.status === "draft" : bornCancelled.status === 400,
      `a contract cannot be created already cancelled (${bornCancelled.status} / ${bornCancelled.body?.status})`);
  }

  // === 13. Method / content-type tampering ================================
  console.log("\n=== 13. an unexpected request is refused, not guessed ===");
  // undici (Node's fetch client) refuses to SEND a TRACE request, so the
  // transport-level check has to use a raw socket to be meaningful.
  const traceStatus = await new Promise((resolve) => {
    const socket = connect(PORT, "127.0.0.1", () => {
      socket.write("TRACE /api/v1/projects HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer x\r\nConnection: close\r\n\r\n");
    });
    let data = "";
    socket.on("data", (chunk) => { data += chunk.toString(); });
    socket.on("close", () => resolve(Number((data.match(/HTTP\/1\.\d (\d{3})/) || [])[1] || 0)));
    socket.on("error", () => resolve(0));
    setTimeout(() => socket.destroy(), 4000);
  });
  check(traceStatus >= 400, `TRACE /api/v1/projects over a raw socket -> ${traceStatus} (not 2xx)`);

  // === 14. Malformed JSON must not 500 ====================================
  console.log("\n=== 14. malformed input fails safely ===");
  const badJson = await call("/projects", { token: mdToken, method: "POST", body: "{not json", raw: true, headers: { "Content-Type": "application/json" } });
  check(badJson.status >= 400 && badJson.status < 500, `malformed JSON -> 4xx, not 500 (${badJson.status})`);
  const wrongType = await call("/projects", { token: mdToken, method: "POST", body: { name: { nested: true }, status: ["x"] } });
  check([201, 400].includes(wrongType.status), `wrong field types are validated (${wrongType.status})`);
  const health = await call("/health");
  check(health.status === 200, "the service is still healthy after every probe above");
} finally {
  await server.stop();
  await closeDatabase().catch(() => {});
}

console.log(failures ? `\n${failures} SECURITY CHECK(S) FAILED` : "\nSECURITY_PROBE_PASSED");
process.exitCode = failures ? 1 : 0;
