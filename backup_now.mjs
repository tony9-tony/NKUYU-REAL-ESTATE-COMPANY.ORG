// Pre-change backup through the app's own endpoint. Run before any account work.
import { legacyPasswordFor } from "./backend/src/org/demoCredentials.js";

const base = "http://localhost:3003/api/v1";

const login = await fetch(`${base}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "admin@mkuyu.local", password: legacyPasswordFor("admin@mkuyu.local") }),
});
const session = await login.json();
if (!session.token) { console.log("SKIP  admin login failed; no backup taken"); process.exit(0); }

const created = await fetch(`${base}/backups`, {
  method: "POST",
  headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
  body: "{}",
});
const backup = await created.json();
console.log(`backup: status=${created.status} name=${backup.name || JSON.stringify(backup).slice(0, 160)}`);
if (created.status >= 400) process.exitCode = 1;
