import { query, withTransaction } from "../db.js";

// ---------------------------------------------------------------------------
// MKUYU contract lifecycle.
//
//   Sales/Operations -> Legal -> Finance -> MD (when required) -> Customer
//   -> final record owned by Legal.
//
// This module is the single source of truth for the status list, the legal
// transitions between them, and the database shape that backs them. The route
// and the model both import from here so a status can never drift between the
// API, the schema and the UI.
// ---------------------------------------------------------------------------

export const CONTRACT_STATUSES = [
  "draft",
  "submitted",
  "under_review",
  "changes_requested",
  "legal_approved",
  "pending_management_approval",
  "approved",
  "customer_pending",
  "active",
  "completed",
  "rejected",
  "cancelled",
];

export const CONTRACT_STATUS_SET = new Set(CONTRACT_STATUSES);

// Statuses that mean "the deal is still being worked on inside MKUYU".
export const OPEN_CONTRACT_STATUSES = new Set([
  "draft", "submitted", "under_review", "changes_requested",
  "legal_approved", "pending_management_approval", "approved", "customer_pending",
]);
// Statuses that mean the contract is finished one way or another.
export const CLOSED_CONTRACT_STATUSES = new Set(["active", "completed", "rejected", "cancelled"]);

// Statuses a contract may be created in. Everything else must be reached through
// the workflow, so nobody can drop a contract straight to `active`.
export const CREATABLE_CONTRACT_STATUSES = new Set(["draft"]);

// Legacy status -> lifecycle status. The three original values keep their
// meaning; only `closed` is renamed to `completed`.
export const LEGACY_STATUS_MAP = { active: "active", closed: "completed", cancelled: "cancelled" };

/**
 * The status each action moves a contract to.
 *
 * `permission` is the permission key the caller must hold. `from` lists the
 * statuses the action is legal from, which is what stops someone approving a
 * contract that Legal has not reviewed yet.
 */
export const CONTRACT_ACTIONS = {
  submit: { from: ["draft", "changes_requested"], to: "submitted", permission: "submit_contract", label: "Submit to Legal" },
  start_review: { from: ["submitted"], to: "under_review", permission: "review_legal", label: "Start legal review" },
  request_changes: { from: ["submitted", "under_review", "legal_approved", "pending_management_approval", "approved", "customer_pending"], to: "changes_requested", permission: "request_changes", label: "Request changes" },
  legal_approve: { from: ["under_review", "submitted"], to: "legal_approved", permission: "approve_legal", label: "Legal approval" },
  finance_validate: { from: ["legal_approved", "under_review"], to: "legal_approved", permission: "validate_finance", label: "Validate financial terms" },
  submit_management: { from: ["legal_approved"], to: "pending_management_approval", permission: "approve_legal", label: "Send for management approval" },
  management_approve: { from: ["pending_management_approval"], to: "approved", permission: "approve_management", label: "Management approval" },
  management_reject: { from: ["pending_management_approval"], to: "rejected", permission: "approve_management", label: "Management rejection" },
  // Legal releases the approved contract to the customer, so this step is gated
  // on `approve_legal` rather than the Sales-side `submit_contract`.
  send_to_customer: { from: ["approved"], to: "customer_pending", permission: "approve_legal", label: "Send to customer" },
  record_signature: { from: ["customer_pending"], to: "active", permission: "approve_legal", label: "Record customer signature" },
  complete: { from: ["active", "customer_pending"], to: "completed", permission: "approve_legal", label: "Mark completed" },
  reject: { from: ["draft", "submitted", "under_review", "changes_requested", "legal_approved", "pending_management_approval"], to: "rejected", permission: "approve_legal", label: "Reject" },
  cancel: { from: [...OPEN_CONTRACT_STATUSES], to: "cancelled", permission: "edit", label: "Cancel contract" },
};

/** Transitions a contract may make right now, filtered by the caller's permissions. */
export function availableActions(status, permissions) {
  const granted = new Set(permissions || []);
  return Object.entries(CONTRACT_ACTIONS)
    .filter(([, action]) => granted.has(action.permission) && action.from.includes(status))
    .map(([name, action]) => ({ action: name, to: action.to, label: action.label }));
}

/** True when the action is legal from the contract's current status. */
export function canTransition(status, actionName) {
  const action = CONTRACT_ACTIONS[actionName];
  return Boolean(action && action.from.includes(status));
}

const LIFECYCLE_COLUMNS = [
  ["contract_number", "TEXT"],
  ["property_id", "INTEGER REFERENCES properties(id) ON DELETE SET NULL"],
  ["terms", "TEXT"],
  ["requires_management_approval", "BOOLEAN NOT NULL DEFAULT FALSE"],
  ["submitted_at", "TIMESTAMPTZ"],
  ["legal_reviewed_by", "INTEGER REFERENCES users(id) ON DELETE SET NULL"],
  ["legal_reviewed_at", "TIMESTAMPTZ"],
  ["legal_notes", "TEXT"],
  ["finance_validated_by", "INTEGER REFERENCES users(id) ON DELETE SET NULL"],
  ["finance_validated_at", "TIMESTAMPTZ"],
  ["finance_notes", "TEXT"],
  ["management_approved_by", "INTEGER REFERENCES users(id) ON DELETE SET NULL"],
  ["management_approved_at", "TIMESTAMPTZ"],
  ["management_notes", "TEXT"],
  ["customer_signed_at", "TIMESTAMPTZ"],
  ["customer_signed_by", "TEXT"],
  ["status_note", "TEXT"],
  ["legal_owner_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL"],
  ["updated_by", "INTEGER REFERENCES users(id) ON DELETE SET NULL"],
  ["updated_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],
];

/**
 * Brings an existing contracts table up to the lifecycle shape:
 *   * widens the status CHECK to the twelve lifecycle values
 *   * maps any legacy status onto its equivalent
 *   * adds the lifecycle tracking columns
 *   * adds the revision-history table
 *
 * Existing rows are migrated in place; nothing is dropped or recreated.
 */
export async function migrateContractWorkflow() {
  // Two processes (a test server and a migration run, say) can reach this at the
  // same time. The drop-then-add pair below is not atomic, so without a lock both
  // drop, then the loser fails with "constraint already exists". The advisory
  // lock serialises the whole migration across processes; it is released when the
  // transaction ends, including on failure.
  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(88101)");
    // The original CHECK is auto-named, so drop it by definition before the
    // widened one is attached. No-op on a fresh database.
    await client.query("ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_status_check");
    // Map legacy values first so the new constraint never sees an unknown status.
    await client.query("UPDATE contracts SET status='completed' WHERE status='closed'");
    for (const [column, definition] of LIFECYCLE_COLUMNS) {
      await client.query(`ALTER TABLE contracts ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
    }
    await client.query(`ALTER TABLE contracts ADD CONSTRAINT contracts_status_check CHECK (status IN (${CONTRACT_STATUSES.map((status) => `'${status}'`).join(",")}))`);
    // Every contract needs a stable reference number; backfill by id so existing
    // rows are never left without one.
    await client.query("UPDATE contracts SET contract_number = 'MK-C-' || LPAD(id::text, 6, '0') WHERE contract_number IS NULL OR contract_number = ''");
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_number ON contracts(contract_number)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_contracts_property ON contracts(property_id)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS contract_revisions (
        id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
        contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
      action TEXT,
      notes TEXT,
      changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      changed_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_contract_revisions_contract ON contract_revisions(contract_id, revision DESC)");
  });
}

