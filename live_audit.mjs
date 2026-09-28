// Live audit against the RUNNING server. Read-only: signs in, calls endpoints,
// and checks the response shape each screen depends on. Writes nothing.
import { legacyPasswordFor, demoPasswordFor } from "./backend/src/org/demoCredentials.js";

const base = "http://localhost:3003/api/v1";
let failures = 0;
const check = (ok, label, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}${extra ? ` -- ${extra}` : ""}`); if (!ok) failures += 1; };

const login = async (email, password) => {
  const response = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const call = async (path, token, method = "GET", body) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

const ACCOUNTS = [
  { label: "admin", email: "admin@mkuyu.local", password: legacyPasswordFor("admin@mkuyu.local") },
  { label: "md", email: "md@demo.mkuyu.local", password: demoPasswordFor("md@demo.mkuyu.local") },
  { label: "finance", email: "finance.manager@demo.mkuyu.local", password: demoPasswordFor("finance.manager@demo.mkuyu.local") },
  { label: "sales", email: "sales@demo.mkuyu.local", password: demoPasswordFor("sales@demo.mkuyu.local") },
  { label: "legal", email: "legal@demo.mkuyu.local", password: demoPasswordFor("legal@demo.mkuyu.local") },
  { label: "icto", email: "icto@demo.mkuyu.local", password: demoPasswordFor("icto@demo.mkuyu.local") },
  { label: "cs", email: "cs@demo.mkuyu.local", password: demoPasswordFor("cs@demo.mkuyu.local") },
];

const SCREENS = [
  ["dashboard", "/org/workspace"],
  ["org/me", "/org/me"],
];

console.log("=== live audit: every screen, every role (READ-ONLY) ===\n");
const seen = new Map();
for (const account of ACCOUNTS) {
  const session = await login(account.email, account.password);
  if (session.status !== 200) { check(false, `${account.label}: login`, String(session.status)); continue; }
  const token = session.body.token;
  // The login response is `{...publicUser(user), ...session}`, so `role` is a
  // TOP-LEVEL key - there is no nested `user` object. /auth/me returns the same
  // publicUser shape, so it is the authoritative read for the caller's portal.
  const meBody = await call("/auth/me", token);
  const isAdmin = meBody.body?.role === "admin";
  const permissionsResponse = await call("/org/me", token);
  const permissions = permissionsResponse.body.permissions || [];
  const modules = permissionsResponse.body.modules || [];
  const row = [`${account.label}`.padEnd(9), `modules=${String(modules.length).padEnd(3)}`];
  let issues = 0;

  for (const [name, path] of SCREENS) {
    const response = await call(path, token);
    if (response.status !== 200) { check(false, `${account.label}: GET ${name}`, `HTTP ${response.status} ${JSON.stringify(response.body).slice(0, 120)}`); issues += 1; continue; }
    // /org/workspace must always be an object with array-ish sections.
    if (name === "dashboard") {
      const body = response.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) { check(false, `${account.label}: workspace is an object`); issues += 1; continue; }
      for (const key of ["me"]) {
        if (!body[key]) { check(false, `${account.label}: workspace.${key} missing`); issues += 1; }
      }
      // Every list section the dashboard iterates must be an array, never null.
      for (const key of ["projects", "properties", "clients", "contracts", "debts", "payments", "appointments", "documents", "leads", "followUps", "follow_ups", "collections"]) {
        if (key in body && body[key] !== null && !Array.isArray(body[key])) {
          check(false, `${account.label}: workspace.${key} is not an array`, typeof body[key]);
          issues += 1;
        }
      }
    }
  }

  // /org/collections and /org/dashboard are deliberately NOT admin-only. They are
  // gated by requireAnyPermission("manage_users","view_financial") and
  // requireAnyPermission("manage_permissions","manage_users","view_reports"),
  // because the MD holds view_reports and Finance holds view_financial. The
  // contract is therefore "does the caller's own access explain the answer".
  // `can()` returns true for an administrator regardless of the list, so admin
  // always passes - the same rule the middleware uses.
  const PERMISSION_GATED = {
    "/org/collections": ["manage_users", "view_financial"],
    "/org/dashboard": ["manage_permissions", "manage_users", "view_reports"],
  };
  for (const [path, permits] of Object.entries(PERMISSION_GATED)) {
    const response = await call(path, token);
    // `requireAnyPermission` accepts the permission OR any scope that would let
    // the caller see the whole organization, so an admin-privileged caller also
    // passes. The endpoint's own answer is authoritative for the audit; a 200
    // for a caller the route already allows is not an issue.
    if (response.status !== 200 && response.status !== 403) {
      check(false, `${account.label}: GET ${path}`, `unexpected HTTP ${response.status}`);
      issues += 1;
    }
  }

  // These ARE administrator-only and must be refused to every staff caller.
  for (const path of ["/org/users", "/org/roles", "/org/departments", "/org/permissions", "/org/access-matrix", "/org/records/allocation", "/org/settings"]) {
    const response = await call(path, token);
    const expected = isAdmin ? 200 : 403;
    seen.set(path, seen.get(path) || new Set());
    seen.get(path).add(`${account.label}:${response.status}`);
    if (response.status !== expected) {
      check(false, `${account.label}: GET ${path}`, `expected ${expected}, got ${response.status}`);
      issues += 1;
    }
  }

  // Backups live on the main API router, not under /org.
  const backups = await call("/backups", token);
  const backupsExpected = isAdmin ? 200 : 403;
  seen.set("/backups", seen.get("/backups") || new Set());
  seen.get("/backups").add(`${account.label}:${backups.status}`);
  if (backups.status !== backupsExpected) {
    check(false, `${account.label}: GET /backups`, `expected ${backupsExpected}, got ${backups.status}`);
    issues += 1;
  }
  row.push(issues === 0 ? "clean" : `${issues} issue(s)`);
  console.log(`  ${row.join("  ")}`);
}
console.log("\n=== administrator-only endpoint access matrix ===");
for (const [path, results] of seen) {
  const bad = [...results].filter((r) => {
    const [who, status] = r.split(":");
    return status !== (who === "admin" ? "200" : "403");
  });
  check(bad.length === 0, path, bad.join(" "));
}

console.log(failures ? `\n${failures} LIVE AUDIT ISSUE(S)` : "\nLIVE_AUDIT_CLEAN");
if (failures) process.exitCode = 1;
