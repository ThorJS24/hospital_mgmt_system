import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../middleware/context.js';
import { audit, requirePermission } from '../middleware/context.js';
import { HttpError, intParam, orderBy, pageQuery, parse } from '../utils/http.js';
import { APPOINTMENT_STATUSES, appointmentScope, hasConflict, setStatus } from '../services/appointments.js';
import { canAccessPatient } from '../services/patients.js';

const SORTS = { time: 'a.scheduled_at', patient: 'p.last_name', doctor: 's.full_name', status: 'a.status', department: 'd.name' };
const isoLocal = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Use YYYY-MM-DDTHH:MM');

export function appointmentRoutes({ db }: Ctx) {
  const r = Router();
  const SELECT = `SELECT a.id, a.scheduled_at, a.duration_min, a.status, a.reason, a.patient_id, a.doctor_id, a.department_id,
      p.first_name || ' ' || p.last_name AS patient, p.mrn, s.full_name AS doctor, d.name AS department
    FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN staff s ON s.id=a.doctor_id JOIN departments d ON d.id=a.department_id`;

  r.get('/appointments', requirePermission('appointments.read'), async (req, res) => {
    const pq = pageQuery(req.query, 'time');
    const sc = appointmentScope(req.user!);
    const params: unknown[] = [...sc.params];
    const where = [sc.sql];
    const add = (cond: string, v: unknown) => { params.push(v); where.push(cond.replace('?', `$${params.length}`)); };
    if (req.query.date) add('a.scheduled_at::date = ?::date', String(req.query.date));
    if (req.query.from) add('a.scheduled_at::date >= ?::date', String(req.query.from));
    if (req.query.to) add('a.scheduled_at::date <= ?::date', String(req.query.to));
    if (req.query.department_id) add('a.department_id = ?', intParam(req.query.department_id));
    if (req.query.doctor_id) add('a.doctor_id = ?', intParam(req.query.doctor_id));
    if (req.query.patient_id) add('a.patient_id = ?', intParam(req.query.patient_id));
    if (req.query.status) add('a.status = ?', parse(z.enum(APPOINTMENT_STATUSES), req.query.status));
    if (pq.q) {
      params.push(`%${pq.q}%`);
      where.push(`(p.first_name || ' ' || p.last_name ILIKE $${params.length} OR s.full_name ILIKE $${params.length})`);
    }
    const sql = where.join(' AND ');
    const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN staff s ON s.id=a.doctor_id JOIN departments d ON d.id=a.department_id WHERE ${sql}`, params)).rows[0].n;
    const data = (await db.query(`${SELECT} WHERE ${sql} ORDER BY ${orderBy(pq, SORTS, 'time')}, a.id LIMIT ${pq.pageSize} OFFSET ${(pq.page - 1) * pq.pageSize}`, params)).rows;
    res.json({ data, total, page: pq.page, pageSize: pq.pageSize });
  });

  r.get('/appointments/:id', requirePermission('appointments.read'), async (req, res) => {
    const sc = appointmentScope(req.user!, 'a', 2);
    const row = (await db.query(`${SELECT} WHERE a.id=$1 AND ${sc.sql}`, [intParam(req.params.id), ...sc.params])).rows[0];
    if (!row) throw new HttpError(404, 'Appointment not found');
    res.json(row);
  });

  r.post('/appointments', requirePermission('appointments.write'), async (req, res) => {
    const b = parse(z.object({
      patient_id: z.number().int().positive(), doctor_id: z.number().int().positive(), scheduled_at: isoLocal,
      duration_min: z.number().int().min(5).max(240).default(30), reason: z.string().max(200).default(''),
    }), req.body);
    if (new Date(b.scheduled_at) < new Date(Date.now() - 5 * 60_000)) throw new HttpError(400, 'Appointments cannot be scheduled in the past');
    if (!(await canAccessPatient(db, req.user!, b.patient_id)) && !req.user!.permissions.includes('patients.read_all')) throw new HttpError(404, 'Patient not found');
    const doc = (await db.query('SELECT department_id, availability FROM staff WHERE id=$1 AND active AND staff_code LIKE \'DOC-%\'', [b.doctor_id])).rows[0];
    if (!doc) throw new HttpError(400, 'Doctor not found');
    const pat = (await db.query('SELECT status FROM patients WHERE id=$1', [b.patient_id])).rows[0];
    if (!pat) throw new HttpError(400, 'Patient not found');
    if (pat.status !== 'Active') throw new HttpError(409, 'Patient record is not active');
    if (await hasConflict(db, b.doctor_id, b.scheduled_at, b.duration_min)) throw new HttpError(409, 'The doctor already has an appointment in that time slot');
    const { rows } = await db.query('INSERT INTO appointments(patient_id,doctor_id,department_id,scheduled_at,duration_min,reason) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [b.patient_id, b.doctor_id, doc.department_id, b.scheduled_at, b.duration_min, b.reason]);
    await audit(db, req, 'appointment_create', 'appointment', rows[0].id);
    res.status(201).json({ id: rows[0].id });
  });

  r.patch('/appointments/:id', requirePermission('appointments.write'), async (req, res) => {
    const id = intParam(req.params.id);
    const sc = appointmentScope(req.user!, 'a', 2);
    const cur = (await db.query(`SELECT a.* FROM appointments a WHERE a.id=$1 AND ${sc.sql}`, [id, ...sc.params])).rows[0];
    if (!cur) throw new HttpError(404, 'Appointment not found');
    if (!['Scheduled', 'Confirmed'].includes(cur.status)) throw new HttpError(409, 'Only scheduled or confirmed appointments can be rescheduled');
    const b = parse(z.object({ scheduled_at: isoLocal.optional(), duration_min: z.number().int().min(5).max(240).optional(), reason: z.string().max(200).optional() }).strict(), req.body);
    const start = b.scheduled_at ?? new Date(cur.scheduled_at).toISOString().slice(0, 19);
    if (b.scheduled_at && new Date(b.scheduled_at) < new Date(Date.now() - 5 * 60_000)) throw new HttpError(400, 'Appointments cannot be scheduled in the past');
    const mins = b.duration_min ?? cur.duration_min;
    if (await hasConflict(db, cur.doctor_id, start, mins, id)) throw new HttpError(409, 'The doctor already has an appointment in that time slot');
    await db.query('UPDATE appointments SET scheduled_at=$1, duration_min=$2, reason=$3 WHERE id=$4', [start, mins, b.reason ?? cur.reason, id]);
    await audit(db, req, 'appointment_reschedule', 'appointment', id);
    res.json({ ok: true });
  });

  r.post('/appointments/:id/status', requirePermission('appointments.write'), async (req, res) => {
    const id = intParam(req.params.id);
    const { status } = parse(z.object({ status: z.enum(APPOINTMENT_STATUSES) }), req.body);
    const sc = appointmentScope(req.user!, 'a', 2);
    if (!(await db.query(`SELECT 1 FROM appointments a WHERE a.id=$1 AND ${sc.sql}`, [id, ...sc.params])).rows.length) throw new HttpError(404, 'Appointment not found');
    await setStatus(db, id, status);
    await audit(db, req, 'appointment_status', 'appointment', id, status);
    res.json({ ok: true, status });
  });

  return r;
}
