// ---------------------------------------------------------------------------
// Contract hand-over visibility.
//
// The workflow decides who may ACT on a contract; the data scope decides who
// may SEE it. The two used to be disconnected: a contract created by Sales
// stayed a Sales-department record, so after "Submit to Legal" the Legal desk
// was told it was their turn on a record it could not open, and the deal stuck.
//
// This module closes that gap without widening anyone's permissions. When a
// contract reaches a status, it is SHARED (through the existing record_shares
// mechanism) with the departments that own the next steps from that status, as
// declared by CONTRACT_ACTIONS (which permission moves it) and
// CONTRACT_OWNERSHIP (which department owns that permission). Sharing only
// grants visibility; every action is still checked against the caller's own
// permissions by the transition route.
//
// Shares are cumulative on purpose: a desk that handled a contract keeps sight
// of it for follow-up and audit. The generated contract document travels with
// the contract so the desk can open the agreement it is reviewing.
// ---------------------------------------------------------------------------
import { query, queryOne } from "../db.js";
import { CONTRACT_ACTIONS } from "./workflow.js";
import { CONTRACT_OWNERSHIP } from "../org/duties.js";

// Withdrawing, bouncing back or declining are not hand-overs: they must not
// pull a department into a contract it would otherwise never see.
const NOT_A_HANDOVER = new Set(["cancel", "request_changes", "reject"]);
// A draft (or a draft sent back for changes) belongs to its author's desk.
const PRIVATE_STATUSES = new Set(["draft", "changes_requested"]);

/** Departments that own a forward step out of `status`. */
export function handoverDepartments(status) {
  if (PRIVATE_STATUSES.has(status)) return [];
  const names = new Set();
  for (const [name, action] of Object.entries(CONTRACT_ACTIONS)) {
    if (NOT_A_HANDOVER.has(name) || !action.from.includes(status)) continue;
    for (const department of CONTRACT_OWNERSHIP[action.permission] || []) names.add(department);
  }
  return [...names].sort();
}

/**
 * Shares one contract (and its generated document) with the departments that
 * hold its current step. Idempotent: the unique share index absorbs repeats.
 */
export async function shareContractWithHandoverDesks(contractId, actorId = null) {
  const contract = await queryOne("SELECT id, organization_id, status, generated_document_id FROM contracts WHERE id = $1", [contractId]);
  if (!contract) return [];
  const names = handoverDepartments(contract.status);
  if (!names.length) return [];
  const departments = (await query(
    "SELECT id, name FROM departments WHERE organization_id = $1 AND name = ANY($2::text[])",
    [contract.organization_id, names],
  )).rows;
  const targets = [["contract", contract.id]];
  if (contract.generated_document_id) targets.push(["document", contract.generated_document_id]);
  for (const department of departments) {
    for (const [entity, recordId] of targets) {
      await query(
        `INSERT INTO record_shares (organization_id, entity, record_id, department_id, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (entity, record_id, COALESCE(user_id, 0), COALESCE(department_id, 0)) DO NOTHING`,
        [contract.organization_id, entity, recordId, department.id, actorId],
      );
    }
  }
  return departments.map((department) => department.name);
}

/**
 * Startup repair: contracts that moved along the workflow before hand-over
 * sharing existed get the shares they should have had. Safe to run every boot.
 */
export async function backfillHandoverShares() {
  // Set-based: one statement per (status, department) rather than several
  // queries per contract, so startup stays fast as the register grows (the
  // per-contract loop took ~50 s on 11,000 contracts).
  const statuses = (await query("SELECT DISTINCT status FROM contracts WHERE status <> ALL($1::text[])", [[...PRIVATE_STATUSES]])).rows.map((row) => row.status);
  let shared = 0;
  for (const status of statuses) {
    const names = handoverDepartments(status);
    if (!names.length) continue;
    const contracts = await query(
      `INSERT INTO record_shares (organization_id, entity, record_id, department_id, created_by)
       SELECT c.organization_id, 'contract', c.id, d.id, NULL FROM contracts c
         JOIN departments d ON d.organization_id = c.organization_id AND d.name = ANY($2::text[])
        WHERE c.status = $1
       ON CONFLICT (entity, record_id, COALESCE(user_id, 0), COALESCE(department_id, 0)) DO NOTHING`, [status, names]);
    await query(
      `INSERT INTO record_shares (organization_id, entity, record_id, department_id, created_by)
       SELECT c.organization_id, 'document', c.generated_document_id, d.id, NULL FROM contracts c
         JOIN departments d ON d.organization_id = c.organization_id AND d.name = ANY($2::text[])
        WHERE c.status = $1 AND c.generated_document_id IS NOT NULL
       ON CONFLICT (entity, record_id, COALESCE(user_id, 0), COALESCE(department_id, 0)) DO NOTHING`, [status, names]);
    shared += contracts.rowCount;
  }
  return shared;
}
