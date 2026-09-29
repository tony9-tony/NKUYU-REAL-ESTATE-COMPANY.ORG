import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { assertTestDatabase } from "./test_support/harness.mjs";
import { query, closeDatabase } from "./backend/src/db.js";
import { propertyUploadsDir } from "./backend/src/uploads.js";
import { runMigrations } from "./backend/src/migrate.js";
import { Project } from "./backend/src/models/project.js";
import { Client, Property, PropertyImage } from "./backend/src/models/catalog.js";
import { Contract } from "./backend/src/models/contract.js";
import { Debt } from "./backend/src/models/debt.js";
import { Payment } from "./backend/src/models/payment.js";
import { Reminder } from "./backend/src/models/reminder.js";
import { Report } from "./backend/src/models/report.js";

// Refuse to touch mkuyu_org before any write happens.
await assertTestDatabase("unit_test");

try {
  await runMigrations();
  const suffix = Date.now();
  const project = await Project.create(`Unit Project ${suffix}`);
  const projectId = project.id;
  const client = await Client.create({ project_id: projectId, name: `Unit Client ${suffix}`, client_type: "buyer", status: "active" });
  const clientId = client.id;
  const contract = await Contract.create({ project_id: projectId, client_id: clientId, client_name: `Unit Client ${suffix}`, contract_type: "new", value: 1000 });
  const firstDebt = await Debt.create({ contract_id: contract.id, client_name: `Unit Client ${suffix}`, amount: 600, due_date: "2099-01-01" });
  const secondDebt = await Debt.create({ contract_id: contract.id, client_name: `Unit Client ${suffix}`, amount: 400, due_date: "2099-02-01" });
  await Reminder.sync(firstDebt.id, new Date(Date.now() + 86400000).toISOString());
  assert.equal((await Reminder.upcoming(2)).some((row) => row.debt_id === firstDebt.id), true);
  const payment = await Payment.create({ contract_id: contract.id, debt_id: firstDebt.id, client_name: `Unit Client ${suffix}`, amount: 600, paid_at: "2026-09-25 10:00:00", method: "bank" });
  await Payment.syncInstallment(firstDebt.id);
  assert.equal((await Debt.get(firstDebt.id)).status, "paid");
  assert.equal(await Payment.forDebt(firstDebt.id), 600);
  const property = await Property.create({ project_id: projectId, name: `Unit Villa ${suffix}`, property_type: "villa", status: "available", price: 5000, location: "Test", area: 100 });
  assert.equal((await Property.get(property.id)).image_count, 0);
  // The picture needs a real file behind it: the gallery now reports what is
  // actually servable, so a row with no file on disk counts as unavailable.
  const storedName = `unit-${suffix}.png`;
  const picturePath = path.join(propertyUploadsDir, storedName);
  fs.mkdirSync(propertyUploadsDir, { recursive: true });
  fs.writeFileSync(picturePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await PropertyImage.create(property.id, { original_filename: "unit.png", stored_name: storedName, file_size: 4, mime_type: "image/png" });
  const withPicture = await Property.get(property.id);
  assert.equal(withPicture.image_count, 1);
  assert.equal(withPicture.cover_image_id !== null, true);
  // The record exists but its file does not, so it is reported as unavailable
  // rather than served - and the row is still returned so it can be removed.
  await PropertyImage.create(property.id, { original_filename: "gone.png", stored_name: `gone-${suffix}.png`, file_size: 4, mime_type: "image/png" });
  const withOrphan = await Property.get(property.id);
  assert.equal(withOrphan.image_count, 1, "only the picture with a file is counted");
  assert.equal(withOrphan.missing_image_count, 1, "the record with no file is reported, not hidden");
  assert.equal((await PropertyImage.listFor(property.id)).length, 2, "both records still exist");
  fs.rmSync(picturePath, { force: true });
  const summary = await Report.summary();
  assert.equal(typeof summary.income_all.total, "number");
  const report = await Report.create({ title: `Unit Report ${suffix}`, report_type: "income", source: "generated", filters_json: JSON.stringify({}) });
  assert.equal((await Report.get(report.id)).title, `Unit Report ${suffix}`);
  assert.equal((await Report.history({ search: `Unit Report ${suffix}` })).some((row) => row.id === report.id), true);
  await query("DELETE FROM reports WHERE id=$1", [report.id]);
  await query("DELETE FROM projects WHERE id=$1", [projectId]);
  console.log("UNIT_TESTS_PASSED");
} catch (error) {
  console.error("UNIT_TESTS_FAILED", error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
