// Confirms the records owned by leftover matrix accounts are test fixtures,
// not real business data, before anything is removed.
import { query, closeDatabase } from "./backend/src/db.js";

const matrixIds = (await query("SELECT id,email FROM users WHERE email LIKE 'matrix.%' ORDER BY id")).rows;
const ids = matrixIds.map((u) => u.id);
console.log(`matrix accounts: ${ids.length}`);

const contracts = (await query(
  "SELECT id,notes,client_name,value,status FROM contracts WHERE owner_id = ANY($1::int[]) OR created_by = ANY($1::int[]) ORDER BY id", [ids],
)).rows;
console.log(`\ncontracts owned by matrix accounts (${contracts.length}):`);
for (const c of contracts) console.log(`  id=${c.id} notes="${c.notes}" client="${c.client_name}" value=${c.value} status=${c.status}`);

const clients = (await query(
  "SELECT id,name,created_at FROM clients WHERE owner_id = ANY($1::int[]) OR created_by = ANY($1::int[]) ORDER BY id", [ids],
)).rows;
console.log(`\nclients owned by matrix accounts (${clients.length}):`);
for (const c of clients) console.log(`  id=${c.id} name="${c.name}"`);

const projects = (await query(
  "SELECT id,name FROM projects WHERE owner_id = ANY($1::int[]) OR created_by = ANY($1::int[]) ORDER BY id", [ids],
)).rows;
console.log(`\nprojects owned by matrix accounts (${projects.length}):`);
for (const p of projects) console.log(`  id=${p.id} name="${p.name}"`);

const leads = (await query("SELECT id,name FROM leads WHERE assigned_to = ANY($1::int[]) ORDER BY id", [ids])).rows;
console.log(`\nleads assigned to matrix accounts (${leads.length}):`);
for (const l of leads) console.log(`  id=${l.id} name="${l.name}"`);

const debts = (await query("SELECT id,client_name,amount,notes FROM debts WHERE owner_id = ANY($1::int[]) OR created_by = ANY($1::int[]) ORDER BY id", [ids])).rows;
console.log(`\ndebts owned by matrix accounts (${debts.length}):`);
for (const d of debts) console.log(`  id=${d.id} client="${d.client_name}" amount=${d.amount} notes="${d.notes}"`);

// Safety: list anything that is NOT obviously a test fixture.
const suspicious = contracts.filter((c) => !String(c.notes || "").startsWith("matrix-"))
  .concat(clients.filter((c) => !String(c.name).startsWith("Matrix ")))
  .concat(projects.filter((p) => !String(p.name).startsWith("Matrix ")));
console.log(`\nnon-test-looking records among them: ${suspicious.length}`);
await closeDatabase();
