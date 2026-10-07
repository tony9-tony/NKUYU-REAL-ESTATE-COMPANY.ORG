// Owner listings: database reads shared by the routes, the lead conversion and
// the weekly-update reminder. The rules themselves live in ./ownerListing.js.
import { query, queryOne } from "../db.js";
import { organizationId } from "../org/rbac.js";
import {
  ACTIVE_OWNER_LISTING_STAGES, DEFAULT_STANDARD_COMMISSION, OWNER_UPDATE_DAYS, STANDARD_COMMISSION_SETTING,
} from "./ownerListing.js";

/** SQL: this listing is active and the owner has not heard from MKUYU for 7 days. */
export const OVERDUE_SQL = `(o.stage = ANY('{${ACTIVE_OWNER_LISTING_STAGES.join(",")}}'::text[]) AND COALESCE(o.last_update_at, o.created_at) <= NOW() - INTERVAL '${OWNER_UPDATE_DAYS} days')`;

export const LISTING_SELECT = `SELECT o.*,
    ou.display_name AS officer_name,
    au.display_name AS mandate_agreed_by_name,
    su.display_name AS mandate_signed_by_name,
    du.display_name AS documents_checked_by_name,
    vu.display_name AS valued_by_name,
    FLOOR(EXTRACT(EPOCH FROM (NOW() - COALESCE(o.last_update_at, o.created_at))) / 86400)::int AS days_since_update,
    ${OVERDUE_SQL} AS update_overdue,
    EXISTS (SELECT 1 FROM owner_listing_offers f WHERE f.listing_id = o.id AND f.decision = 'accepted' AND f.fell_through_at IS NULL) AS has_accepted_offer
  FROM owner_listings o
  LEFT JOIN users ou ON ou.id = o.officer_id
  LEFT JOIN users au ON au.id = o.mandate_agreed_by
  LEFT JOIN users su ON su.id = o.mandate_signed_by
  LEFT JOIN users du ON du.id = o.documents_checked_by
  LEFT JOIN users vu ON vu.id = o.valued_by`;

/** The standard commission rate (percent). An unset or broken setting falls back to 3%. */
export async function standardCommission() {
  const row = await queryOne("SELECT setting_value FROM settings WHERE organization_id=$1 AND setting_key=$2", [await organizationId(), STANDARD_COMMISSION_SETTING]);
  const value = Number(row?.setting_value);
  return Number.isFinite(value) && value > 0 && value <= 50 ? value : DEFAULT_STANDARD_COMMISSION;
}

export async function getListing(listingId) {
  return queryOne(`${LISTING_SELECT} WHERE o.id=$1 AND o.organization_id=$2`, [listingId, await organizationId()]);
}

/**
 * A Sell request MKUYU accepted (Sales turned it into a client) opens its
 * owner listing at "Received". Once per request; never breaks the conversion.
 */
export async function openListingForSellLead(lead, clientId, userId = null) {
  if (!lead || lead.service !== "sell") return null;
  const sell = lead.sell_details || {};
  return queryOne(
    `INSERT INTO owner_listings (organization_id, lead_id, client_id, owner_name, owner_phone, owner_email, property_type, location, asking_price, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (lead_id) WHERE lead_id IS NOT NULL DO UPDATE SET client_id = COALESCE(owner_listings.client_id, EXCLUDED.client_id)
     RETURNING id`,
    [lead.organization_id, lead.id, clientId, lead.name, lead.phone || null, lead.email || null,
      sell.property_type || null, sell.location || null, Number(sell.asking_price) > 0 ? Number(sell.asking_price) : null, userId],
  );
}

/** Counts for "Your work today" and the MD. */
export async function listingSummary(userId) {
  const row = await queryOne(
    `SELECT
       COUNT(*) FILTER (WHERE o.stage = ANY($2::text[]))::int AS active,
       COUNT(*) FILTER (WHERE ${OVERDUE_SQL})::int AS overdue,
       COUNT(*) FILTER (WHERE ${OVERDUE_SQL} AND o.officer_id = $3)::int AS mine_overdue,
       COUNT(*) FILTER (WHERE o.stage = ANY($2::text[]) AND o.officer_id = $3)::int AS mine_active,
       COUNT(*) FILTER (WHERE o.stage = ANY($2::text[]) AND o.officer_id IS NULL)::int AS unassigned,
       COUNT(*) FILTER (WHERE o.stage = 'received')::int AS received,
       COUNT(*) FILTER (WHERE o.stage = 'valued')::int AS awaiting_legal,
       COUNT(*) FILTER (WHERE o.stage = 'documents_checked' AND o.mandate_status = 'awaiting_md')::int AS awaiting_md,
       COUNT(*) FILTER (WHERE o.stage = 'documents_checked' AND o.mandate_status IN ('none','returned'))::int AS mandate_to_agree,
       (SELECT COUNT(*)::int FROM owner_listing_offers f JOIN owner_listings x ON x.id = f.listing_id
         WHERE x.organization_id = $1 AND x.stage IN ('listed','under_offer') AND f.decision IS NULL) AS offers_open
     FROM owner_listings o WHERE o.organization_id = $1`,
    [await organizationId(), ACTIVE_OWNER_LISTING_STAGES, userId],
  );
  return { ...row, update_days: OWNER_UPDATE_DAYS, standard_commission: await standardCommission() };
}

/**
 * Weekly owner update reminder. Same pattern as notify/handoffWatch.js: the
 * reminder is an URGENT task for the listing's Property Officer (what they
 * already watch on Assignments), with a note; a second note after twice the
 * time says the MD can see it. Logging an update closes the task.
 */
export async function chaseOverdueOwnerUpdates() {
  const rows = (await query(
    `SELECT o.id, o.organization_id, o.owner_name, o.location, o.officer_id, o.overdue_level, o.reminder_task_id,
            t.status AS task_status,
            FLOOR(EXTRACT(EPOCH FROM (NOW() - COALESCE(o.last_update_at, o.created_at))) / 86400)::int AS waited,
            (SELECT ud.department_id FROM user_departments ud WHERE ud.user_id = o.officer_id ORDER BY ud.department_id LIMIT 1) AS department_id
       FROM owner_listings o LEFT JOIN tasks t ON t.id = o.reminder_task_id
      WHERE ${OVERDUE_SQL} AND o.officer_id IS NOT NULL
      LIMIT 100`)).rows;
  let chased = 0;
  for (const row of rows) {
    const open = row.reminder_task_id && row.task_status && !["completed", "cancelled"].includes(row.task_status);
    if (!open) {
      const task = await queryOne(
        `INSERT INTO tasks (organization_id, title, description, assigned_by, assigned_to, department_id, visibility, priority, status)
         VALUES ($1,$2,$3,NULL,$4,$5,'own','urgent','assigned') RETURNING id`,
        [row.organization_id, `Weekly update due: ${row.owner_name}`.slice(0, 160),
          `Owner listing #${row.id}${row.location ? ` (${row.location})` : ""}: the owner has not had an update for ${row.waited} days. Call or message the owner, then log the update on Owner listings. Logging it closes this task.`,
          row.officer_id, row.department_id],
      );
      await query("INSERT INTO task_comments (task_id, author_id, body) VALUES ($1, NULL, $2)", [task.id, `Reminder: ${row.owner_name} has waited ${row.waited} days for news about their property. Every owner gets an update at least once a week.`]);
      await query("UPDATE owner_listings SET reminder_task_id=$1, overdue_level=1 WHERE id=$2", [task.id, row.id]);
      chased += 1;
    } else if (row.overdue_level < 2 && row.waited >= OWNER_UPDATE_DAYS * 2) {
      await query("INSERT INTO task_comments (task_id, author_id, body) VALUES ($1, NULL, $2)", [row.reminder_task_id, `Second reminder: ${row.owner_name} has now waited ${row.waited} days. The Managing Director sees this listing as overdue - please update the owner today.`]);
      await query("UPDATE owner_listings SET overdue_level=2 WHERE id=$1", [row.id]);
      chased += 1;
    }
  }
  return chased;
}

/** Logging an update ends the overdue episode and closes its reminder task. */
export async function closeOverdueReminder(listing, userId) {
  if (listing.reminder_task_id) {
    const closed = await queryOne(
      `UPDATE tasks SET status='completed', completed_by=$2, completed_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND status NOT IN ('completed','cancelled') RETURNING id`, [listing.reminder_task_id, userId]);
    if (closed) await query("INSERT INTO task_comments (task_id, author_id, body) VALUES ($1, $2, $3)", [closed.id, userId, "Weekly update logged on the owner listing. Closed automatically."]);
  }
  await query("UPDATE owner_listings SET overdue_level=0, reminder_task_id=NULL WHERE id=$1", [listing.id]);
}
