// Chases diaspora requests that were handed to Customer Service but have no report yet.
//   after HANDOFF_OVERDUE_HOURS (default 24): the task becomes URGENT and gets a reminder note;
//   after twice that: a second note says the Desk and the MD are waiting.
// The task is what the Customer Service officer and the Desk already watch (attention badge),
// so no new screen is needed. A failure here only logs; it never touches the request itself.
import { query } from "../db.js";

const HOUR = 60 * 60 * 1000;
const hours = () => Math.max(1, Number(process.env.HANDOFF_OVERDUE_HOURS) || 24);

export async function chaseOverdueHandoffs() {
  const first = hours();
  const rows = (await query(
    `SELECT l.id AS lead_id, l.name, l.overdue_level, t.id AS task_id, t.priority,
            FLOOR(EXTRACT(EPOCH FROM (NOW() - l.handed_off_at)) / 3600)::int AS waited
       FROM leads l JOIN tasks t ON t.id = l.task_id
      WHERE l.source = 'diaspora-portal' AND l.status = 'handed_off' AND l.handed_off_at IS NOT NULL
        AND l.outcome IS NULL
        AND t.status IN ('assigned','in_progress','changes_requested')
        AND ((l.overdue_level < 1 AND l.handed_off_at <= NOW() - ($1 || ' hours')::interval)
          OR (l.overdue_level < 2 AND l.handed_off_at <= NOW() - (($1::int * 2) || ' hours')::interval))
      LIMIT 100`, [String(first)])).rows;
  for (const row of rows) {
    const level = row.waited >= first * 2 ? 2 : 1;
    const note = level === 1
      ? `Reminder: ${row.name} has been waiting ${row.waited} hours for a call. Please call the customer (check their preferred contact and time zone) and send your report.`
      : `Second reminder: ${row.name} has now waited ${row.waited} hours with no report. The Diaspora Desk is waiting for your report - please call today.`;
    await query("UPDATE tasks SET priority='urgent', updated_at=NOW() WHERE id=$1 AND priority <> 'urgent'", [row.task_id]);
    await query("INSERT INTO task_comments (task_id, author_id, body) VALUES ($1, NULL, $2)", [row.task_id, note]);
    await query("UPDATE leads SET overdue_level=$1 WHERE id=$2", [level, row.lead_id]);
  }
  return rows.length;
}

export function startHandoffWatch() {
  if (process.env.HANDOFF_WATCH === "0") return;
  const run = () => chaseOverdueHandoffs().catch((error) => console.error("handoff watch:", error.message));
  setTimeout(run, 90 * 1000).unref?.();
  setInterval(run, 30 * 60 * 1000).unref?.();
}
