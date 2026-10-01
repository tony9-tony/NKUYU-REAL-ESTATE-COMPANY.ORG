// ---------------------------------------------------------------------------
// The appointment for a website request.
//
// Customer Service contacts the customer and reports back; Sales (the manager
// or officer who handed it over) approves the report and ARRANGES the agreed
// appointment. The appointment lands in Appointments, tied to the customer
// (who becomes a client, or their existing client record is reused) and to the
// property they asked about. Arranging again moves the same appointment.
// ---------------------------------------------------------------------------
import { query, queryOne } from "../db.js";
import { findExistingClient } from "./clientMatch.js";

export const APPOINTMENT_TYPES = ["viewing", "meeting", "call"];

/**
 * Books (or re-arranges) the appointment for `request` (a leads row).
 * `own` is the ownership the new records get (the arranger's).
 * Returns { appointmentId, clientId, created }.
 */
export async function arrangeRequestAppointment(request, { when, type, note }, own) {
  const org = request.organization_id;
  let clientId = request.client_id || (await findExistingClient(org, { email: request.email, phone: request.phone }))?.id || null;
  if (!clientId) {
    const client = await queryOne(
      "INSERT INTO clients(organization_id,name,email,phone,client_type,status,notes,owner_id,created_by,department_id,visibility) VALUES($1,$2,$3,$4,$10,'lead',$5,$6,$7,$8,$9) RETURNING id",
      [org, request.name, request.email, request.phone, request.notes, own.owner_id, own.created_by, own.department_id, own.visibility,
       request.service === "sell" ? "seller" : request.service === "rent" ? "tenant" : "buyer"],
    );
    clientId = client.id;
  }
  const property = request.property_id ? await queryOne("SELECT id, name, project_id FROM properties WHERE id=$1", [request.property_id]) : null;
  const label = type === "call" ? "Call" : type === "meeting" ? "Meeting" : "Viewing";
  const title = `${label}: ${request.name}${property ? ` · ${property.name}` : ""}`;
  const notes = [note, request.outcome_note && request.outcome_note !== note ? `Customer Service: ${request.outcome_note}` : null, request.phone ? `Phone: ${request.phone}` : null, `Website request W-${request.id}`].filter(Boolean).join("\n");
  const existing = request.appointment_id ? await queryOne("SELECT id FROM appointments WHERE id=$1", [request.appointment_id]) : null;
  let appointmentId;
  if (existing) {
    await query("UPDATE appointments SET starts_at=$1, appointment_type=$2, title=$3, notes=$4, status='scheduled' WHERE id=$5", [when.toISOString(), type, title, notes, existing.id]);
    appointmentId = existing.id;
  } else {
    const appointment = await queryOne(
      `INSERT INTO appointments(organization_id,client_id,property_id,project_id,title,appointment_type,starts_at,status,notes,owner_id,created_by,department_id,visibility)
       VALUES($1,$2,$3,$4,$5,$6,$7,'scheduled',$8,$9,$10,$11,$12) RETURNING id`,
      [org, clientId, property?.id || null, property?.project_id || null, title, type, when.toISOString(), notes, own.owner_id, own.created_by, own.department_id, own.visibility],
    );
    appointmentId = appointment.id;
  }
  await query(
    "UPDATE leads SET client_id=$1, appointment_id=$2, appointment_at=$3, appointment_type=$4, status='appointment', converted_at=COALESCE(converted_at, NOW()), converted_by=COALESCE(converted_by, $6) WHERE id=$5",
    [clientId, appointmentId, when.toISOString(), type, request.id, own.created_by || null],
  );
  return { appointmentId, clientId, created: !existing };
}
