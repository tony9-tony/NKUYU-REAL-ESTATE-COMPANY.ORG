// ---------------------------------------------------------------------------
// Security audit fixes MK-01 .. MK-13, proved against running servers.
//
// Server A runs as development (the default); server B runs with
// NODE_ENV=production and an explicit PUBLIC_SITE_ORIGINS, to prove the
// production-only rules (demo passwords refused, Secure cookies, strict CORS).
// Both use the throwaway test database.
// ---------------------------------------------------------------------------
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { closeDatabase, query } from "./backend/src/db.js";
import { demoPasswordFor, legacyPasswordFor } from "./backend/src/org/demoCredentials.js";

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

reapOrphanServers();
await prepareTestDatabase();
const devServer = await startIsolatedServer({ label: "security-dev", port: 3230 });
const tag = Date.now().toString(36);

function client(base) {
  const call = async (path, { method = "GET", body, token, headers = {}, raw } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, body: await response.json().catch(() => ({})) };
  };
  const signIn = async (email, password) => (await call("/auth/login", { method: "POST", body: { email, password } })).body.token;
  return { call, signIn };
}
const dev = client(devServer.base);
const root = devServer.base.replace(/\/api\/v1$/, "");
const cookieOf = (response) => (response.headers.get("set-cookie") || "").split(";")[0];
let prodServer = null;

try {
  const adminToken = await dev.signIn("admin@mkuyu.local", legacyPasswordFor("admin@mkuyu.local"));
  const mdToken = await dev.signIn("md@mkuyu.local", legacyPasswordFor("md@mkuyu.local"));
  check(Boolean(adminToken && mdToken), "signed in as the administrator and the MD (API clients use Bearer tokens)");

  console.log("\n=== MK-04 security headers ===");
  const page = await fetch(`${root}/`);
  const csp = page.headers.get("content-security-policy") || "";
  check(csp.includes("default-src 'self'") && csp.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'"), "the app is served with a Content-Security-Policy");
  check(page.headers.get("x-frame-options") === "DENY", "X-Frame-Options: DENY");
  check(page.headers.get("x-content-type-options") === "nosniff", "X-Content-Type-Options: nosniff");
  check(Boolean(page.headers.get("referrer-policy")) && Boolean(page.headers.get("permissions-policy")), "Referrer-Policy and Permissions-Policy are set");
  check(!page.headers.get("x-powered-by"), "the framework is not advertised (no X-Powered-By)");
  check(!page.headers.get("strict-transport-security"), "no HSTS over plain HTTP (it would break a local install)");
  const overHttps = await fetch(`${root}/api/v1/health`, { headers: { "X-Forwarded-Proto": "https" } });
  check((overHttps.headers.get("strict-transport-security") || "").includes("max-age="), "HSTS is sent when the request arrived over HTTPS");

  console.log("\n=== MK-02 sign-in attempts are limited ===");
  const victim = `nobody.${tag}@test.mkuyu.local`;
  const statuses = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await dev.call("/auth/login", { method: "POST", body: { email: victim, password: `wrong-${i}-password` } })).status);
  check(statuses.slice(0, 5).every((s) => s === 401) && statuses[5] === 429, `after 5 failures the account is locked for a while (${statuses.join(",")})`);
  const locked = await dev.call("/auth/login", { method: "POST", body: { email: victim, password: "anything-else" } });
  check(locked.status === 429 && Number(locked.headers.get("retry-after")) > 0, "the lock says when to try again (Retry-After)");
  check(Boolean(await dev.signIn("md@mkuyu.local", legacyPasswordFor("md@mkuyu.local"))), "other accounts from the same address still sign in normally");

  console.log("\n=== MK-05 browser session is an HttpOnly cookie with CSRF protection ===");
  const browserLogin = await dev.call("/auth/login", { method: "POST", body: { email: "md@mkuyu.local", password: legacyPasswordFor("md@mkuyu.local"), remember: false }, headers: { "X-MKUYU-CSRF": "1" } });
  const setCookie = browserLogin.headers.get("set-cookie") || "";
  check(browserLogin.status === 200 && !browserLogin.body.token, "the browser app gets no token in the response body");
  check(/mkuyu_session=/.test(setCookie) && /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie) && /Path=\/api/.test(setCookie), "the session arrives as an HttpOnly, SameSite=Strict cookie scoped to the API");
  const cookie = cookieOf(browserLogin);
  check((await dev.call("/auth/me", { headers: { Cookie: cookie } })).status === 200, "the cookie alone authenticates reads");
  const noCsrf = await dev.call("/projects", { method: "POST", body: { name: `CSRF ${tag}` }, headers: { Cookie: cookie } });
  check(noCsrf.status === 403, `a cookie-authenticated change WITHOUT the CSRF header is refused (${noCsrf.status})`);
  const foreign = await dev.call("/projects", { method: "POST", body: { name: `CSRF ${tag}` }, headers: { Cookie: cookie, "X-MKUYU-CSRF": "1", Origin: "http://evil.example" } });
  check(foreign.status === 403, `a change from a foreign Origin is refused (${foreign.status})`);
  const withCsrf = await dev.call("/projects", { method: "POST", body: { name: `CSRF ok ${tag}` }, headers: { Cookie: cookie, "X-MKUYU-CSRF": "1" } });
  check(withCsrf.status === 201, `the page itself (cookie + CSRF header) can change data (${withCsrf.status})`);

  console.log("\n=== MK-06 session lifetime, idle timeout, rotation, logout ===");
  const sessionRow = (await query("SELECT id, remember, EXTRACT(EPOCH FROM (expires_at - created_at))/3600 AS hours FROM sessions ORDER BY id DESC LIMIT 1")).rows[0];
  check(sessionRow && sessionRow.remember === false && Math.round(Number(sessionRow.hours)) === 12, `a session without "remember me" lasts 12 hours (${Math.round(Number(sessionRow?.hours))}h)`);
  const idleToken = await dev.signIn("md@mkuyu.local", legacyPasswordFor("md@mkuyu.local"));
  await query("UPDATE sessions SET last_seen_at = NOW() - INTERVAL '9 hours' WHERE id = (SELECT MAX(id) FROM sessions)");
  check((await dev.call("/auth/me", { token: idleToken })).status === 401, "a session unused for more than 8 hours is refused");
  await query("UPDATE sessions SET created_at = NOW() - INTERVAL '13 hours' WHERE id = $1", [sessionRow.id]);
  const rotated = await dev.call("/auth/me", { headers: { Cookie: cookie } });
  const newCookie = cookieOf(rotated);
  check(rotated.status === 200 && newCookie.startsWith("mkuyu_session=") && newCookie !== cookie, "a browser session older than 12 hours is given a fresh token");
  check((await dev.call("/auth/me", { headers: { Cookie: cookie } })).status === 401, "the replaced token no longer works");
  const logout = await dev.call("/auth/logout", { method: "POST", body: {}, headers: { Cookie: newCookie, "X-MKUYU-CSRF": "1" } });
  check(logout.status === 200 && /Max-Age=0/.test(logout.headers.get("set-cookie") || ""), "logout clears the cookie");
  check((await dev.call("/auth/me", { headers: { Cookie: newCookie } })).status === 401, "and the session is gone on the server");

  console.log("\n=== MK-07 first-run setup cannot be repeated ===");
  const setup = await dev.call("/auth/setup", { method: "POST", body: { display_name: "Intruder", email: `setup.${tag}@test.mkuyu.local`, password: "IntruderPass#1" } });
  check(setup.status === 409, `setup on a configured workspace is refused (${setup.status})`);
  const racers = await Promise.all(Array.from({ length: 5 }, (_, i) => dev.call("/auth/setup", { method: "POST", body: { display_name: "Racer", email: `race${i}.${tag}@test.mkuyu.local`, password: "RacerPass#123" } })));
  check(racers.every((r) => r.status === 409), "five simultaneous setup attempts all fail on a configured workspace");
  check(Number((await query("SELECT COUNT(*) FROM users WHERE email LIKE $1", [`%.${tag}@test.mkuyu.local`])).rows[0].count) === 0, "no account was created by any setup attempt");

  console.log("\n=== MK-08 public API: known origins only ===");
  const evil = await fetch(`${devServer.base}/public/properties`, { headers: { Origin: "http://evil.example" } });
  check(evil.status === 403, `a browser on an unknown origin is refused the public API (${evil.status})`);
  const site = await fetch(`${devServer.base}/public/properties`, { headers: { Origin: "http://localhost:5500" } });
  check(site.status === 200 && site.headers.get("access-control-allow-origin") === "http://localhost:5500" && site.headers.get("access-control-allow-credentials") !== "true", "the public website's origin reads it, without credentials");

  console.log("\n=== MK-03 payments stay inside the Finance user's scope ===");
  const salesToken = await dev.signIn("sales@demo.mkuyu.local", demoPasswordFor("sales@demo.mkuyu.local"));
  const financeToken = await dev.signIn("finance@demo.mkuyu.local", demoPasswordFor("finance@demo.mkuyu.local"));
  const project = (await dev.call("/projects", { method: "POST", token: mdToken, body: { name: `Sec ${tag}` } })).body;
  const privateContract = (await dev.call("/contracts", { method: "POST", token: salesToken, body: { project_id: project.id, client_name: `Private ${tag}`, contract_type: "new", deal_type: "buy", value: 1000000 } })).body;
  await query("UPDATE contracts SET visibility='own', department_id=NULL WHERE id=$1", [privateContract.id]);
  const outside = await dev.call("/payments", { method: "POST", token: financeToken, body: { contract_id: privateContract.id, amount: 1000, paid_at: "2026-09-01", client_name: "x" } });
  check(outside.status === 404, `Finance cannot record a payment on a contract outside its scope (${outside.status})`);
  check(!JSON.stringify(outside.body).includes(`Private ${tag}`), "and learns nothing about that contract's client");
  const openContract = (await dev.call("/contracts", { method: "POST", token: mdToken, body: { project_id: project.id, client_name: `Open ${tag}`, contract_type: "new", deal_type: "rent", value: 500000 } })).body;
  const inside = await dev.call("/payments", { method: "POST", token: financeToken, body: { contract_id: openContract.id, amount: 1000, paid_at: "2026-09-01" } });
  check(inside.status === 201, `Finance records a payment on a contract in its scope (${inside.status})`);

  console.log("\n=== MK-09 contract history hides financial notes without view_financial ===");
  await query("INSERT INTO contract_revisions (organization_id, contract_id, revision, status, action, notes) SELECT organization_id, id, 99, status, 'finance_validate', 'Deposit 20,000,000 confirmed' FROM contracts WHERE id=$1", [openContract.id]);
  const legalToken = await dev.signIn("legal@demo.mkuyu.local", demoPasswordFor("legal@demo.mkuyu.local"));
  const legalView = (await dev.call(`/contracts/${openContract.id}/history`, { token: legalToken })).body;
  const financeView = (await dev.call(`/contracts/${openContract.id}/history`, { token: financeToken })).body;
  const legalEntry = Array.isArray(legalView) && legalView.find((e) => e.action === "finance_validate");
  const financeEntry = Array.isArray(financeView) && financeView.find((e) => e.action === "finance_validate");
  check(Boolean(legalEntry) && legalEntry.notes === null && legalEntry.notes_redacted === true, "Legal (no view_financial) sees the finance step but not its notes");
  check(financeEntry?.notes === "Deposit 20,000,000 confirmed", "Finance sees the full note");

  console.log("\n=== MK-10 / MK-11 bounded lists, safe errors ===");
  const bare = await dev.call("/projects", { token: mdToken });
  check(Array.isArray(bare.body) && bare.body.length <= 1000, `a list requested without paging is bounded (${bare.body.length} rows)`);
  const badJson = await dev.call("/auth/login", { method: "POST", body: "{not json", raw: true });
  check(badJson.status === 400 && badJson.body.error === "the request body is not valid JSON", "malformed JSON gets a plain message, not parser internals");

  console.log("\n=== MK-12 public listing needs publish AND approval ===");
  const listed = (await dev.call("/properties", { method: "POST", token: mdToken, body: { name: `Pub ${tag}`, property_type: "house", status: "available", price: 90000000, location: "Arusha", area: 100, offer_buy: 1, public_listing: 1 } })).body;
  const visible = async () => (await fetch(`${devServer.base}/public/properties`)).json().then((rows) => rows.some((p) => p.id === listed.id));
  check(await visible(), "a property the Sales Officer published is public");
  await query("UPDATE properties SET public_listing_status='pending' WHERE id=$1", [listed.id]);
  check(!(await visible()) && (await fetch(`${devServer.base}/public/properties/${listed.id}`)).status === 404, "the same property with its approval withdrawn is not public (list or detail)");

  console.log("\n=== MK-13 access changes reach existing sessions ===");
  const victimUser = (await dev.call("/org/users", { method: "POST", token: adminToken, body: { display_name: "Short Lived", email: `short.${tag}@test.mkuyu.local`, password: "ShortLived#2026", role_ids: [(await dev.call("/org/roles", { token: adminToken })).body.find((r) => r.name === "Accountant").id] } })).body;
  const victimToken = await dev.signIn(`short.${tag}@test.mkuyu.local`, "ShortLived#2026");
  check((await dev.call("/auth/me", { token: victimToken })).status === 200, "a new staff member is signed in");
  await dev.call(`/org/users/${victimUser.id}`, { method: "PUT", token: adminToken, body: { active: false } });
  check((await dev.call("/auth/me", { token: victimToken })).status === 401, "deactivation ends their session at once");
  await query("UPDATE roles SET active = FALSE WHERE name = 'Accountant' AND organization_id = (SELECT organization_id FROM users WHERE id=$1)", [victimUser.id]);
  await query("UPDATE users SET active = TRUE WHERE id=$1", [victimUser.id]);
  const again = await dev.signIn(`short.${tag}@test.mkuyu.local`, "ShortLived#2026");
  const perms = (await dev.call("/org/me", { token: again })).body.permissions || [];
  check(!perms.includes("access_payments"), "a deactivated role grants no permission any more");
  await query("UPDATE roles SET active = TRUE WHERE name = 'Accountant'");

  console.log("\n=== production mode (NODE_ENV=production) ===");
  const strong = `prod.${tag}@test.mkuyu.local`;
  await dev.call("/org/users", { method: "POST", token: adminToken, body: { display_name: "Prod Check", email: strong, password: "Str0ng-Prod-Pass#26", role_ids: [(await dev.call("/org/roles", { token: adminToken })).body.find((r) => r.name === "ICT Officer").id] } });
  process.env.NODE_ENV = "production";
  process.env.PUBLIC_SITE_ORIGINS = "https://www.mkuyu.example";
  prodServer = await startIsolatedServer({ label: "security-prod", port: 3231 });
  const prod = client(prodServer.base);
  const demoLogin = await prod.call("/auth/login", { method: "POST", body: { email: "sales@demo.mkuyu.local", password: demoPasswordFor("sales@demo.mkuyu.local") } });
  check(demoLogin.status === 403 && /demo password/i.test(demoLogin.body.error || ""), `MK-01: a published demo password is refused in production (${demoLogin.status})`);
  const realLogin = await prod.call("/auth/login", { method: "POST", body: { email: strong, password: "Str0ng-Prod-Pass#26" }, headers: { "X-MKUYU-CSRF": "1" } });
  check(realLogin.status === 200 && /;\s*Secure/i.test(realLogin.headers.get("set-cookie") || ""), "a real password works, and the production cookie is Secure");
  const prodToken = await prod.signIn(strong, "Str0ng-Prod-Pass#26");
  const clerk = (await prod.call("/org/users", { token: prodToken })).body.find((u) => u.email === "sales@demo.mkuyu.local");
  const demoReset = await prod.call(`/org/users/${clerk?.id}`, { method: "PUT", token: prodToken, body: { password: demoPasswordFor("sales@demo.mkuyu.local") } });
  check(demoReset.status === 400, `MK-01: nobody can be given a demo-scheme password in production (${demoReset.status})`);
  const prodSite = await fetch(`${prodServer.base}/public/properties`, { headers: { Origin: "https://www.mkuyu.example" } });
  const prodLocal = await fetch(`${prodServer.base}/public/properties`, { headers: { Origin: "http://localhost:5500" } });
  check(prodSite.status === 200 && prodLocal.status === 403, "MK-08: production allows only the configured public site origin");
} catch (error) {
  failures += 1;
  console.error(error);
} finally {
  delete process.env.NODE_ENV;
  delete process.env.PUBLIC_SITE_ORIGINS;
}

console.log(`\n${failures ? `${failures} SECURITY FIX CHECK(S) FAILED` : "SECURITY_FIXES_ALL_PASSED"}`);
if (failures) process.exitCode = 1;
await query("UPDATE roles SET active = TRUE WHERE name = 'Accountant'").catch(() => {});
await closeDatabase();
await devServer.stop();
if (prodServer) await prodServer.stop();
