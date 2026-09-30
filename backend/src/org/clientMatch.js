// Recognises a returning customer: a client with the same email (any case) or
// the same phone number (compared on its last 9 digits, so "+255 712 000 111"
// and "0712000111" match). Used so a repeat website request is shown as an
// existing client and never creates a second client record.
import { queryOne } from "../db.js";

const digits = (value) => String(value || "").replace(/\D/g, "");

/** SQL for the id of the matching client of a lead aliased `l` (or NULL). */
export const EXISTING_CLIENT_SQL = `(SELECT c.id FROM clients c WHERE c.organization_id = l.organization_id AND (
    (COALESCE(l.email, '') <> '' AND LOWER(c.email) = LOWER(l.email))
    OR (length(regexp_replace(COALESCE(l.phone, ''), '\\D', '', 'g')) >= 9
        AND right(regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g'), 9) = right(regexp_replace(COALESCE(l.phone, ''), '\\D', '', 'g'), 9))
  ) ORDER BY c.id LIMIT 1)`;

/** The matching client for an email/phone, or null. */
export async function findExistingClient(organizationId, { email, phone } = {}) {
  const mail = String(email || "").trim().toLowerCase();
  const tail = digits(phone).slice(-9);
  if (!mail && tail.length < 9) return null;
  return queryOne(
    `SELECT id, name FROM clients WHERE organization_id = $1 AND (
       ($2 <> '' AND LOWER(email) = $2)
       OR ($3 <> '' AND right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 9) = $3)
     ) ORDER BY id LIMIT 1`,
    [organizationId, mail, tail.length >= 9 ? tail : ""],
  );
}
