// ---------------------------------------------------------------------------
// Local demo credentials.
//
// One place that decides what every seeded account's password is, so the seed,
// the rotation and the test scripts can never drift apart. Pure functions with
// no imports, so any script can pull them in cheaply.
//
// THESE ARE NON-PRODUCTION CREDENTIALS. The `MkuDemo#` prefix makes them
// obvious in a log or a config file, and every demo account lives on a
// `demo.mkuyu.local` address. Replace all of them before any real deployment.
// ---------------------------------------------------------------------------

const PASSWORD_PREFIX = "MkuDemo#";

/** Local part of the address with punctuation removed: `sales.officer` -> `salesofficer`. */
function passwordKey(email) {
  return String(email).split("@")[0].replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

/** The password for a seeded account, derived deterministically from its address. */
export function demoPasswordFor(email) {
  return `${PASSWORD_PREFIX}${passwordKey(email)}2026`;
}

/**
 * Legacy accounts that predate the `demo.mkuyu.local` set.
 *
 * Only the password is rotated for these: `id`, email, display name, role,
 * department, owned records and audit history all stay exactly as they are.
 * `role`/`department` here are the EXPECTED values used by the verification
 * test to prove the rotation changed nothing but the credential.
 */
export const LEGACY_ACCOUNTS = [
  { email: "admin@mkuyu.local", role: "System Administrator", department: "ICT & ADMINISTRATION", administrator: true },
  { email: "md@mkuyu.local", role: "Managing Director", department: "MANAGEMENT", administrator: false },
  { email: "sales.officer@mkuyu.local", role: "Sales, Marketing & Operations Officer", department: "SALES, MARKETING & OPERATIONS", administrator: false },
  { email: "amina.sales@mkuyu.local", role: "Sales, Marketing & Operations Officer", department: "SALES, MARKETING & OPERATIONS", administrator: false },
];

/** The rotated password for a legacy account. */
export function legacyPasswordFor(email) {
  return demoPasswordFor(email);
}

/** Every account this project seeds, for documentation and verification. */
export function allSeededCredentials(demoEmails) {
  return [
    ...LEGACY_ACCOUNTS.map((account) => ({ email: account.email, password: legacyPasswordFor(account.email), role: account.role })),
    ...demoEmails.map((email) => ({ email, password: demoPasswordFor(email), role: "(demo)" })),
  ];
}
