// Read-only check: why a diaspora customer's documents do not show in
// Diaspora verification. Every statement is a SELECT; nothing is changed.
//
//   node tools/check_diaspora_verification.mjs [name or e-mail]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = (key, fallback) => {
  try {
    for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`));
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env */ }
  return fallback;
};
const who = (process.argv[2] || "sawe").toLowerCase();
const client = new pg.Client({ connectionString: env("DATABASE_URL", "postgresql://postgres@localhost:5432/mkuyu_org") });
await client.connect();
const q = async (text, values = []) => (await client.query(text, values)).rows;

console.log("\n=== Server restarted with today's changes? ===");
const col = await q("SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='clients' AND column_name='citizenship_confirmed_at'");
console.log(col.length ? "YES (new database column exists)" : "NO  -> close the server window and open start-mkuyu.bat again");

console.log(`\n=== Customers matching "${who}" ===`);
const rows = await q(`SELECT c.id, c.name, c.email, c.organization_id AS org, c.is_diaspora, c.verification_status AS status, c.department_id AS dept,
  (SELECT string_agg(d.category || ' (' || to_char(d.uploaded_at, 'HH24:MI') || ')', ', ' ORDER BY d.id) FROM documents d WHERE d.client_id=c.id AND d.category LIKE 'kyc_%') AS documents,
  (SELECT ca.status FROM customer_accounts ca WHERE ca.client_id=c.id) AS portal
  FROM clients c WHERE lower(c.name) LIKE $1 OR lower(c.email) LIKE $1 ORDER BY c.id`, [`%${who}%`]);
console.table(rows);

console.log("\n=== Organizations ===");
console.table(await q("SELECT id, name FROM organizations ORDER BY id"));

console.log("\n=== What the Diaspora verification screen lists (first 15) ===");
const org = (await q("SELECT id FROM organizations ORDER BY id LIMIT 1"))[0]?.id;
console.table(await q(`SELECT c.id, c.name, c.verification_status AS status FROM clients c
  WHERE c.organization_id=$1 AND c.is_diaspora=TRUE AND c.verification_status IS NOT NULL ORDER BY c.id DESC LIMIT 15`, [org]));

console.log("\n=== Diaspora Desk members ===");
console.table(await q(`SELECT u.id, u.display_name, u.email, d.name AS department, d.active FROM user_departments ud
  JOIN departments d ON d.id=ud.department_id JOIN users u ON u.id=ud.user_id WHERE upper(d.name) LIKE '%DIASPORA%' ORDER BY u.id`));
await client.end();
