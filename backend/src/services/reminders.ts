import type { Db } from '../db/index.js';
import { notifyPatient } from './notifications.js';

/** Messages are written to the local outbox table only; nothing is ever sent over a network. */
export interface OutboxInput { channel: 'email' | 'sms'; recipient: string; subject?: string; body: string; kind: string; relatedId?: number; patientId?: number }

export async function queueMessage(db: Db, m: OutboxInput): Promise<void> {
  await db.query('INSERT INTO outbox_messages(channel,recipient,subject,body,kind,related_id,patient_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [m.channel, m.recipient, m.subject ?? '', m.body, m.kind, m.relatedId ?? null, m.patientId ?? null]);
}

const pad = (n: number) => String(n).padStart(2, '0');
const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

interface ApptRow { id: number; patient_id: number; when_text: string; doctor: string; department: string; email: string; phone: string; contact_preference: 'email' | 'sms' | 'both'; first_name: string }

const APPT_INFO = `SELECT a.id, a.patient_id, to_char(a.scheduled_at,'Dy DD Mon YYYY "at" HH24:MI') AS when_text, s.full_name AS doctor, d.name AS department,
    p.email, p.phone, p.contact_preference, p.first_name
  FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN staff s ON s.id=a.doctor_id JOIN departments d ON d.id=a.department_id`;

async function deliver(db: Db, a: ApptRow, kind: 'reminder' | 'confirmation' | 'cancellation'): Promise<void> {
  const subject = kind === 'reminder' ? 'Appointment reminder' : kind === 'confirmation' ? 'Appointment confirmed' : 'Appointment cancelled';
  const verb = kind === 'reminder' ? 'is coming up' : kind === 'confirmation' ? 'is booked' : 'was cancelled';
  const body = `Hello ${a.first_name}, your appointment with ${a.doctor} (${a.department}) on ${a.when_text} ${verb}. SYNTHETIC MESSAGE - MediCore HMS lab.`;
  const wantsEmail = a.contact_preference !== 'sms' && !!a.email;
  const wantsSms = (a.contact_preference !== 'email' && !!a.phone) || (!wantsEmail && !!a.phone);
  if (wantsEmail) await queueMessage(db, { channel: 'email', recipient: a.email, subject, body, kind: `appointment_${kind}`, relatedId: a.id, patientId: a.patient_id });
  if (wantsSms) await queueMessage(db, { channel: 'sms', recipient: a.phone, body: body.slice(0, 300), kind: `appointment_${kind}`, relatedId: a.id, patientId: a.patient_id });
}

export async function sendAppointmentNotice(db: Db, appointmentId: number, kind: 'confirmation' | 'cancellation'): Promise<void> {
  const a = (await db.query<ApptRow>(`${APPT_INFO} WHERE a.id=$1`, [appointmentId])).rows[0];
  if (a) await deliver(db, a, kind);
}

export async function reminderWindowHours(db: Db): Promise<number> {
  const v = (await db.query<{ value: string }>("SELECT value FROM system_config WHERE key='reminder_hours'")).rows[0]?.value;
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 168 ? n : 24;
}

/** Queue one reminder per upcoming, not-yet-reminded appointment inside the reminder window. Returns the number processed. */
export async function sendDueReminders(db: Db, now = new Date()): Promise<number> {
  const hours = await reminderWindowHours(db);
  const rows = (await db.query<ApptRow>(
    `${APPT_INFO} WHERE a.status IN ('Scheduled','Confirmed') AND a.reminder_sent_at IS NULL
        AND a.scheduled_at > $1::timestamp AND a.scheduled_at <= $2::timestamp ORDER BY a.scheduled_at LIMIT 200`,
    [local(now), local(new Date(now.getTime() + hours * 3600_000))])).rows;
  for (const a of rows) {
    await deliver(db, a, 'reminder');
    await db.query('UPDATE appointments SET reminder_sent_at=now() WHERE id=$1', [a.id]);
    await notifyPatient(db, a.patient_id, { kind: 'appointment_reminder', title: 'Upcoming appointment', body: `${a.doctor}, ${a.when_text}`, link: '/portal', dedupeKey: `appt-remind:${a.id}` });
  }
  return rows.length;
}
