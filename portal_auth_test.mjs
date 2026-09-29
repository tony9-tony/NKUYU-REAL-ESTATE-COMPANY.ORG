// Portal boundary regression test.
//
// The sign-in screen offers a Staff Portal and an Admin Portal. This proves
// those are real authentication boundaries enforced by the SERVER, not UI
// tabs: the portal travels in the login request, and an account is refused at
// the one portal it does not belong to.
//
// Everything here goes through the real HTTP API against a private server
// bound to the throwaway test database (see ./test_support/guard.mjs and
// harness.mjs). The live workspace is never read from or written to.
//
// Run: node --import ./test_support/guard.mjs portal_auth_test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startIsolatedServer, prepareTestDatabase, reapOrphanServers } from "./test_support/harness.mjs";
import { legacyPasswordFor, demoPasswordFor } from "./backend/src/org/demoCredentials.js";
import { closeDatabase } from "./backend/src/db.js";

const root = path.dirname(fileURLToPath(import.meta.url));

reapOrphanServers();
await prepareTestDatabase();
const server = await startIsolatedServer({ label: "portal-auth", port: 3208 });
const base = server.base;

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

const ADMIN = { email: "admin@mkuyu.local", password: legacyPasswordFor("admin@mkuyu.local") };
const STAFF = { email: "md@mkuyu.local", password: legacyPasswordFor("md@mkuyu.local") };

/** Raw login call. `portal` is omitted from the body when undefined. */
async function login({ email, password }, portal) {
  const body = { email, password };
  if (portal !== undefined) body.portal = portal;
  const response = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

try {
  // --- 1. The matching pair signs in ---------------------------------------
  console.log("\n=== matching account and portal is accepted ===");
  const staffIn = await login(STAFF, "staff");
  check(staffIn.status === 200 && Boolean(staffIn.body.token), `staff credentials + Staff Portal -> SUCCESS (${staffIn.status})`);
  check(staffIn.body.portal === "staff", `the response reports the staff portal (${staffIn.body.portal})`);

  const adminIn = await login(ADMIN, "admin");
  check(adminIn.status === 200 && Boolean(adminIn.body.token), `admin credentials + Admin Portal -> SUCCESS (${adminIn.status})`);
  check(adminIn.body.portal === "admin", `the response reports the admin portal (${adminIn.body.portal})`);

  // --- 2. The crossed pair is refused --------------------------------------
  console.log("\n=== an account is refused at the portal it does not belong to ===");
  const staffOnAdmin = await login(STAFF, "admin");
  check(staffOnAdmin.status === 403, `staff credentials + Admin Portal -> REJECTED (${staffOnAdmin.status})`);
  check(!staffOnAdmin.body.token, "a refused staff login returns no session token");
  check(/Staff account/i.test(staffOnAdmin.body.error || ""), `it says which portal to use: "${staffOnAdmin.body.error}"`);

  const adminOnStaff = await login(ADMIN, "staff");
  check(adminOnStaff.status === 403, `admin credentials + Staff Portal -> REJECTED (${adminOnStaff.status})`);
  check(!adminOnStaff.body.token, "a refused admin login returns no session token");
  check(/Admin account/i.test(adminOnStaff.body.error || ""), `it says which portal to use: "${adminOnStaff.body.error}"`);

  // --- 3. Bad credentials, either portal ------------------------------------
  console.log("\n=== invalid credentials are rejected on both portals ===");
  const wrongStaff = await login({ email: STAFF.email, password: "DefinitelyNotThePassword1" }, "staff");
  check(wrongStaff.status === 401, `a wrong staff password + Staff Portal -> REJECTED (${wrongStaff.status})`);
  const wrongAdmin = await login({ email: ADMIN.email, password: "DefinitelyNotThePassword1" }, "admin");
  check(wrongAdmin.status === 401, `a wrong admin password + Admin Portal -> REJECTED (${wrongAdmin.status})`);

  // The refusal must not leak which portal an address belongs to: an attacker
  // with a wrong password learns nothing, so accounts cannot be enumerated.
  check(!/Staff account|Admin account/i.test(wrongStaff.body.error || ""), "a wrong password never reveals the account's portal");
  check(!/Staff account|Admin account/i.test(wrongAdmin.body.error || ""), "a wrong password never reveals the account's portal (admin)");
  check(!wrongAdmin.body.token, "a refused login returns no session token");

  // This is the important half: no amount of hand-crafting the request reaches
  // the other portal. These are byte-for-byte direct calls to /auth/login.
  console.log("\n=== a direct API attempt cannot cross the portal boundary ===");
  const bypassStaff = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: STAFF.email, password: STAFF.password, portal: "admin" }),
  });
  const bypassStaffBody = await bypassStaff.json().catch(() => ({}));
  check(bypassStaff.status === 403, `direct API: staff credentials claiming portal=admin -> REJECTED (${bypassStaff.status})`);
  check(!bypassStaffBody.token, "direct API: no token is issued for the crossed staff/admin attempt");

  const bypassAdmin = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // A caller cannot smuggle a claimed role in alongside the portal either.
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password, portal: "staff", role: "staff" }),
  });
  const bypassAdminBody = await bypassAdmin.json().catch(() => ({}));
  check(bypassAdmin.status === 403, `direct API: admin credentials claiming portal=staff -> REJECTED (${bypassAdmin.status})`);
  check(!bypassAdminBody.token, "direct API: no token is issued for the crossed admin/staff attempt");

  // The legitimate request must still work, or the two checks above prove
  // nothing beyond "admin can never log in".
  const control = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password, portal: "admin" }),
  });
  check(control.status === 200, `control: the same admin request with portal=admin still succeeds (${control.status})`);

  // --- 5. A nonsense portal is a bad request, never a silent default --------
  console.log("\n=== an unrecognised portal is refused rather than ignored ===");
  for (const bogus of ["administrator", "root", "STAFF-ADMIN", 42]) {
    const result = await login(STAFF, bogus);
    check(result.status === 400, `portal=${JSON.stringify(bogus)} -> 400 (${result.status})`);
  }
  // Case and surrounding whitespace are normalised rather than rejected.
  const messy = await login(ADMIN, "  ADMIN  ");
  check(messy.status === 200, `portal="  ADMIN  " is normalised and accepted (${messy.status})`);

  // --- 6. The boundary holds for every seeded staff account ----------------
  // The Managing Director is the case that matters most: wide business
  // authority, yet still not an administrator.
  console.log("\n=== every seeded staff account is refused at the Admin Portal ===");
  const staffEmails = [
    "md@demo.mkuyu.local",
    "finance.manager@demo.mkuyu.local",
    "sales@demo.mkuyu.local",
    "legal@demo.mkuyu.local",
    "icto@demo.mkuyu.local",
    "cs@demo.mkuyu.local",
  ];
  for (const email of staffEmails) {
    const password = demoPasswordFor(email);
    const onStaff = await login({ email, password }, "staff");
    const onAdmin = await login({ email, password }, "admin");
    check(onStaff.status === 200 && onAdmin.status === 403,
      `${email}: Staff Portal ${onStaff.status}, Admin Portal ${onAdmin.status}`);
  }

  // --- 7. Portal routing and session context -------------------------------
  // The portal a session belongs to must survive being read back, which is what
  // a page refresh does. This is the same /auth/me the app calls on boot.
  console.log("\n=== the session remembers its portal across a refresh ===");
  const staffSession = await login(STAFF, "staff");
  const staffMe = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${staffSession.body.token}` } }).then((r) => r.json());
  check(staffMe.portal === "staff", `a staff session reads back portal=staff (${staffMe.portal})`);
  check(staffMe.role === "staff", `and still reports role=staff (${staffMe.role})`);
  // The staff portal is /staff and the admin portal is /admin; the two must not
  // be interchangeable for a single account.
  check(staffMe.portal !== "admin", "a staff session can never read back as the admin portal");

  const adminSession = await login(ADMIN, "admin");
  const adminMe = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${adminSession.body.token}` } }).then((r) => r.json());
  check(adminMe.portal === "admin", `an admin session reads back portal=admin (${adminMe.portal})`);
  check(adminMe.role === "admin", `and still reports role=admin (${adminMe.role})`);

  // --- 8. Existing RBAC is untouched and still authoritative ----------------
  // Authentication is unchanged: the same session that logs in now reaches
  // exactly the same endpoints with exactly the same permissions as before.
  console.log("\n=== existing role-based access control is unchanged ===");
  const staffToken = staffSession.body.token;
  const adminToken = adminSession.body.token;
  const staffOrgs = await fetch(`${base}/org/users`, { headers: { Authorization: `Bearer ${staffToken}` } });
  check(staffOrgs.status === 403, `staff is still refused the administration list (${staffOrgs.status})`);
  const adminOrgs = await fetch(`${base}/org/users`, { headers: { Authorization: `Bearer ${adminToken}` } });
  check(adminOrgs.status === 200, `admin still reaches the administration list (${adminOrgs.status})`);

  // The MD keeps its business authority - the portal split must not have
  // demoted a staff member who already had real permissions.
  const mdMe = await fetch(`${base}/org/me`, { headers: { Authorization: `Bearer ${staffToken}` } }).then((r) => r.json());
  check((mdMe.permissions || []).includes("approve_management"), "the Managing Director keeps its business permissions");
  check(!(mdMe.permissions || []).some((key) => key.startsWith("manage_")), "and still holds no system administration");

  // --- 9. Logout still clears the session ----------------------------------
  console.log("\n=== logout is unaffected ===");
  const logout = await fetch(`${base}/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" }, body: "{}" });
  check(logout.status === 200, `logout succeeds (${logout.status})`);
  const afterLogout = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${adminToken}` } });
  check(afterLogout.status === 401, `the token is dead afterwards (${afterLogout.status})`);

  // --- 10. Backward compatibility ------------------------------------------
  // Every pre-existing script and test logs in WITHOUT a portal. They must
  // still work, and must land in the portal the account actually owns.
  console.log("\n=== a login with no portal still works (existing scripts) ===");
  const noPortalStaff = await login(STAFF);
  check(noPortalStaff.status === 200, `staff login with no portal field -> SUCCESS (${noPortalStaff.status})`);
  check(noPortalStaff.body.portal === "staff", `and it resolves to the staff portal (${noPortalStaff.body.portal})`);
  const noPortalAdmin = await login(ADMIN);
  check(noPortalAdmin.status === 200, `admin login with no portal field -> SUCCESS (${noPortalAdmin.status})`);
  check(noPortalAdmin.body.portal === "admin", `and it resolves to the admin portal (${noPortalAdmin.body.portal})`);
  // An empty string means "no preference" and must not be read as a claim.
  const emptyPortal = await login(STAFF, "");
  check(emptyPortal.status === 200, `an empty portal is treated as no preference (${emptyPortal.status})`);

  // --- 11. The login form actually sends the portal ------------------------
  // The existing frontend suite covers navigation after sign-in, but never
  // submits the form, so nothing else proves the chosen portal reaches the
  // server. Without this, a regression that dropped `portal` from the request
  // would leave every check above still green.
  console.log("\n=== the login form sends the selected portal ===");
  const appSource = fs.readFileSync(path.join(root, "frontend", "js", "app.js"), "utf8");
  check(/body\.portal\s*=\s*authMode\s*===\s*"setup"\s*\?\s*"admin"\s*:\s*authPortal/.test(appSource),
    "the login submit attaches the selected portal to the request");
  check(/authPortal\s*=\s*portal\s*===\s*"admin"\s*\?\s*"admin"\s*:\s*"staff"/.test(appSource),
    "the portal tab selection sets the value that is sent");
  // The markup keeps both portals on one sign-in screen; nothing is hidden.
  const indexHtml = fs.readFileSync(path.join(root, "frontend", "index.html"), "utf8");
  check(indexHtml.includes('data-portal="staff"') && indexHtml.includes('data-portal="admin"'),
    "both portal tabs are still present on the sign-in screen");
} finally {
  await server.stop();
  await closeDatabase().catch(() => {});
}

console.log(failures ? `\n${failures} PORTAL CHECK(S) FAILED` : "\nPORTAL_BOUNDARY_VERIFIED");
// exitCode, not exit(): process.exit() would truncate the buffered summary line
// when stdout is redirected to a file, hiding the result of a passing run.
process.exitCode = failures ? 1 : 0;

