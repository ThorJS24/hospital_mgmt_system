import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Ctx } from '../middleware/context.js';
import { audit, requirePermission } from '../middleware/context.js';
import { HttpError, intParam, parse } from '../utils/http.js';
import { calcBalance } from '../services/billing.js';
import { hasConflict } from '../services/appointments.js';
import { isDate, isSlotAvailable, slotsFor } from '../services/staffing.js';
import { sendAppointmentNotice } from '../services/reminders.js';
import { buildPdf } from '../services/pdf.js';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(isDate, 'Invalid date');
const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (offsetDays = 0) => { const d = new Date(Date.now() + offsetDays * 86400000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const MAX_UPCOMING = 5;
const MAX_DAYS_AHEAD = 90;
const MIN_CANCEL_HOURS = 2;

/** Parses simple reference ranges ("4.0-11.0", "<5.2", ">3") to flag a value as outside the range. */
export function rangeFlag(value: string, range: string): 'normal' | 'low' | 'high' | null {
  const v = parseFloat(value);
  if (Number.isNaN(v)) return null;
  let m = /^\s*(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)\s*$/.exec(range);
  if (m) return v < Number(m[1]) ? 'low' : v > Number(m[2]) ? 'high' : 'normal';
  m = /^\s*<\s*(-?\d+(?:\.\d+)?)\s*$/.exec(range);
  if (m) return v >= Number(m[1]) ? 'high' : 'normal';
  m = /^\s*>\s*(-?\d+(?:\.\d+)?)\s*$/.exec(range);
  if (m) return v <= Number(m[1]) ? 'low' : 'normal';
  return null;
}

/**
 * Patient self-service portal. Every query is bound to the patient id stored on the signed-in user's account
 * (never taken from the request), so a patient can only ever see and change their own records.
 */
export function portalRoutes({ db }: Ctx) {
  const r = Router();
  const pid = (req: Request) => {
    const id = req.user!.patientId;
    if (!id) throw new HttpError(403, 'This account is not linked to a patient record');
    return id;
  };
  const guard = requirePermission('portal.access');

  r.get('/portal/me', guard, async (req, res) => {
    const id = pid(req);
    const p = (await db.query(
      `SELECT p.id, p.mrn, p.first_name, p.last_name, p.dob, p.sex, p.phone, p.email, p.address, p.contact_preference, p.blood_type, s.full_name AS primary_doctor
         FROM patients p LEFT JOIN staff s ON s.id=p.primary_doctor_id WHERE p.id=$1`, [id])).rows[0];
    const allergies = (await db.query('SELECT allergen, reaction, severity FROM patient_allergies WHERE patient_id=$1 ORDER BY id', [id])).rows;
    const next = (await db.query(
      `SELECT a.id, a.scheduled_at, a.status, s.full_name AS doctor, d.name AS department FROM appointments a JOIN staff s ON s.id=a.doctor_id JOIN departments d ON d.id=a.department_id
        WHERE a.patient_id=$1 AND a.status IN ('Scheduled','Confirmed') AND a.scheduled_at >= $2::timestamp ORDER BY a.scheduled_at LIMIT 1`, [id, `${localDate()}T00:00:00`])).rows[0] ?? null;
    const balance = (await db.query<{ v: number }>(
      `SELECT COALESCE(sum(t.total - t.paid),0)::float AS v FROM (SELECT COALESCE((SELECT sum(quantity*unit_price) FROM invoice_items WHERE invoice_id=i.id),0) AS total,
          COALESCE((SELECT sum(amount) FROM payments WHERE invoice_id=i.id),0) AS paid FROM invoices i WHERE i.patient_id=$1 AND i.status IN ('Issued','Partially paid')) t`, [id])).rows[0].v;
    res.json({ patient: p, allergies, nextAppointment: next, balanceDue: Math.max(0, balance) });
  });

  r.patch('/portal/me', guard, async (req, res) => {
    const id = pid(req);
    const b = parse(z.object({
      phone: z.string().max(30).optional(), email: z.union([z.email().max(200), z.literal('')]).optional(), address: z.string().max(300).optional(),
      contact_preference: z.enum(['email', 'sms', 'both']).optional(),
    }).strict(), req.body);
    const cols = Object.entries(b).filter(([, v]) => v !== undefined);
    if (!cols.length) throw new HttpError(400, 'No fields to update');
    await db.query(`UPDATE patients SET ${cols.map(([k], i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`, [id, ...cols.map(([, v]) => v)]);
    await audit(db, req, 'portal_profile_update', 'patient', id, cols.map(([k]) => k).join(','));
    res.json({ ok: true });
  });

  r.get('/portal/appointments', guard, async (req, res) => {
    const id = pid(req);
    const data = (await db.query(
      `SELECT a.id, a.scheduled_at, a.duration_min, a.status, a.reason, s.full_name AS doctor, d.name AS department
         FROM appointments a JOIN staff s ON s.id=a.doctor_id JOIN departments d ON d.id=a.department_id WHERE a.patient_id=$1 ORDER BY a.scheduled_at DESC LIMIT 100`, [id])).rows;
    res.json({ data });
  });

  r.get('/portal/doctors', guard, async (_req, res) => {
    res.json({ data: (await db.query("SELECT s.id, s.full_name, s.job_title, d.name AS department FROM staff s JOIN departments d ON d.id=s.department_id WHERE s.active AND s.staff_code LIKE 'DOC-%' ORDER BY d.name, s.full_name")).rows });
  });

  r.get('/portal/slots', guard, async (req, res) => {
    pid(req);
    const doctorId = intParam(req.query.doctor_id, 'doctor_id');
    const date = parse(dateStr, req.query.date);
    if (!(await db.query("SELECT 1 FROM staff WHERE id=$1 AND active AND staff_code LIKE 'DOC-%'", [doctorId])).rows.length) throw new HttpError(404, 'Doctor not found');
    res.json({ date, ...(await slotsFor(db, doctorId, date)) });
  });

  r.post('/portal/appointments', guard, async (req, res) => {
    const id = pid(req);
    const b = parse(z.object({ doctor_id: z.number().int().positive(), date: dateStr, time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'), reason: z.string().trim().max(200).default('') }), req.body);
    if (b.date < localDate() || b.date > localDate(MAX_DAYS_AHEAD)) throw new HttpError(400, `Choose a date within the next ${MAX_DAYS_AHEAD} days`);
    const doc = (await db.query("SELECT department_id FROM staff WHERE id=$1 AND active AND staff_code LIKE 'DOC-%'", [b.doctor_id])).rows[0];
    if (!doc) throw new HttpError(404, 'Doctor not found');
    const pat = (await db.query('SELECT status FROM patients WHERE id=$1', [id])).rows[0];
    if (pat.status !== 'Active') throw new HttpError(409, 'Your record is not active. Please contact the front desk.');
    const upcoming = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM appointments WHERE patient_id=$1 AND status IN ('Scheduled','Confirmed') AND scheduled_at >= $2::timestamp", [id, `${localDate()}T00:00:00`])).rows[0].n;
    if (upcoming >= MAX_UPCOMING) throw new HttpError(409, `You can hold at most ${MAX_UPCOMING} upcoming appointments. Cancel one first.`);
    const start = `${b.date}T${b.time}:00`;
    // the slot must be one the roster offers and that is still free
    if (!(await isSlotAvailable(db, b.doctor_id, b.date, b.time))) throw new HttpError(409, 'That time is no longer available');
    // a patient cannot be in two places at once
    const clash = (await db.query(
      `SELECT 1 FROM appointments WHERE patient_id=$1 AND status NOT IN ('Cancelled','No-show') AND scheduled_at < ($2::timestamp + interval '30 minutes') AND scheduled_at + (duration_min || ' minutes')::interval > $2::timestamp LIMIT 1`, [id, start])).rows.length;
    if (clash) throw new HttpError(409, 'You already have an appointment at that time');
    if (await hasConflict(db, b.doctor_id, start, 30)) throw new HttpError(409, 'That time is no longer available');
    const { rows } = await db.query('INSERT INTO appointments(patient_id,doctor_id,department_id,scheduled_at,duration_min,reason) VALUES ($1,$2,$3,$4,30,$5) RETURNING id', [id, b.doctor_id, doc.department_id, start, b.reason]);
    await audit(db, req, 'appointment_create', 'appointment', rows[0].id, 'portal');
    await sendAppointmentNotice(db, rows[0].id, 'confirmation');
    res.status(201).json({ id: rows[0].id });
  });

  r.post('/portal/appointments/:id/cancel', guard, async (req, res) => {
    const id = pid(req);
    const apptId = intParam(req.params.id);
    const a = (await db.query("SELECT status, to_char(scheduled_at,'YYYY-MM-DD\"T\"HH24:MI:SS') AS at FROM appointments WHERE id=$1 AND patient_id=$2", [apptId, id])).rows[0];
    if (!a) throw new HttpError(404, 'Appointment not found');
    if (!['Scheduled', 'Confirmed'].includes(a.status)) throw new HttpError(409, `This appointment is ${a.status.toLowerCase()} and cannot be cancelled online`);
    if (new Date(a.at).getTime() - Date.now() < MIN_CANCEL_HOURS * 3600_000) throw new HttpError(409, `Appointments can be cancelled online up to ${MIN_CANCEL_HOURS} hours before the start. Please call the front desk.`);
    await db.query("UPDATE appointments SET status='Cancelled' WHERE id=$1", [apptId]);
    await audit(db, req, 'appointment_status', 'appointment', apptId, 'Cancelled (portal)');
    await sendAppointmentNotice(db, apptId, 'cancellation');
    res.json({ ok: true });
  });

  /** Only approved results are released to the patient. */
  r.get('/portal/results', guard, async (req, res) => {
    const id = pid(req);
    const rows = (await db.query(
      `SELECT lr.id, lr.requested_at, t.name AS test, t.unit, t.reference_range, res.value, res.comment
         FROM laboratory_requests lr JOIN laboratory_tests t ON t.id=lr.test_id JOIN laboratory_results res ON res.request_id=lr.id
        WHERE lr.patient_id=$1 AND lr.status='Approved' AND res.approved ORDER BY lr.requested_at DESC LIMIT 100`, [id])).rows;
    res.json({ data: rows.map((x: any) => ({ ...x, flag: rangeFlag(x.value, x.reference_range) })), notice: 'Results are synthetic. Discuss any result with your doctor.' });
  });

  r.get('/portal/prescriptions', guard, async (req, res) => {
    const id = pid(req);
    const data = (await db.query(
      `SELECT rx.id, rx.status, rx.dispensing_status, rx.created_at, rx.refills_allowed, rx.refills_used, s.full_name AS doctor,
          (SELECT string_agg(m.name || ' ' || m.strength || ' - ' || pi.dosage, E'\n' ORDER BY pi.id) FROM prescription_items pi JOIN medications m ON m.id=pi.medication_id WHERE pi.prescription_id=rx.id) AS medicines
         FROM prescriptions rx JOIN staff s ON s.id=rx.doctor_id WHERE rx.patient_id=$1 ORDER BY rx.created_at DESC LIMIT 50`, [id])).rows;
    res.json({ data });
  });

  const INVOICE = `SELECT i.id, i.invoice_no, i.status, i.issued_on, i.due_on,
      COALESCE((SELECT sum(quantity*unit_price) FROM invoice_items WHERE invoice_id=i.id),0)::float AS total,
      COALESCE((SELECT sum(amount) FROM payments WHERE invoice_id=i.id),0)::float AS paid FROM invoices i`;

  r.get('/portal/invoices', guard, async (req, res) => {
    const id = pid(req);
    const rows = (await db.query(`${INVOICE} WHERE i.patient_id=$1 AND i.status <> 'Draft' ORDER BY i.issued_on DESC, i.id DESC LIMIT 100`, [id])).rows;
    res.json({ data: rows.map((x: any) => ({ ...x, balance: calcBalance(x.total, x.paid) })) });
  });

  r.get('/portal/invoices/:id/pdf', guard, async (req, res) => {
    const id = pid(req);
    const invId = intParam(req.params.id);
    const inv = (await db.query(`${INVOICE} WHERE i.id=$1 AND i.patient_id=$2 AND i.status <> 'Draft'`, [invId, id])).rows[0];
    if (!inv) throw new HttpError(404, 'Invoice not found');
    const [items, payments, pat] = await Promise.all([
      db.query('SELECT description, quantity, unit_price::float AS unit_price FROM invoice_items WHERE invoice_id=$1 ORDER BY id', [invId]),
      db.query("SELECT amount::float AS amount, method, kind, to_char(paid_at,'YYYY-MM-DD') AS day FROM payments WHERE invoice_id=$1 ORDER BY id", [invId]),
      db.query('SELECT first_name, last_name, mrn FROM patients WHERE id=$1', [id]),
    ]);
    const m = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    const p = pat.rows[0];
    const pdf = buildPdf({
      title: `Invoice ${inv.invoice_no}`, subtitle: `${p.first_name} ${p.last_name} (${p.mrn})  |  Status: ${inv.status}  |  SYNTHETIC`,
      blocks: [
        { type: 'table', columns: [{ label: 'Description', width: 5 }, { label: 'Qty', width: 1, align: 'right' }, { label: 'Unit price', width: 2, align: 'right' }, { label: 'Amount', width: 2, align: 'right' }],
          rows: items.rows.map((i: any) => [i.description, String(i.quantity), m(i.unit_price), m(i.quantity * i.unit_price)]) },
        { type: 'heading', text: 'Payments' },
        { type: 'table', columns: [{ label: 'Date', width: 2 }, { label: 'Method', width: 4 }, { label: 'Type', width: 2 }, { label: 'Amount', width: 2, align: 'right' }], rows: payments.rows.map((x: any) => [x.day, x.method, x.kind, m(x.amount)]) },
        { type: 'kv', rows: [['Total', m(inv.total)], ['Paid', m(inv.paid)], ['Balance due', m(calcBalance(inv.total, inv.paid))]] },
      ],
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${String(inv.invoice_no).replace(/[^\w.-]/g, '_')}.pdf"`);
    res.send(pdf);
  });

  return r;
}
