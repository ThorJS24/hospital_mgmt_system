import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../middleware/context.js';
import { audit, requirePermission } from '../middleware/context.js';
import { HttpError, intParam, parse } from '../utils/http.js';
import { isDate, slotsFor } from '../services/staffing.js';
import { notifyUsers } from '../services/notifications.js';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(isDate, 'Invalid date');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function staffingRoutes({ db }: Ctx) {
  const r = Router();

  // ---------- roster ----------
  r.get('/roster', requirePermission('staff.read'), async (req, res) => {
    const params: unknown[] = [];
    let where = 's.active';
    if (req.query.department_id) { params.push(intParam(req.query.department_id, 'department_id')); where += ` AND s.department_id=$${params.length}`; }
    const staff = (await db.query(`SELECT s.id, s.staff_code, s.full_name, s.job_title, d.name AS department FROM staff s LEFT JOIN departments d ON d.id=s.department_id WHERE ${where} ORDER BY d.name, s.full_name`, params)).rows;
    const shifts = (await db.query(`SELECT staff_id, weekday, to_char(start_time,'HH24:MI') AS start_time, to_char(end_time,'HH24:MI') AS end_time FROM staff_shifts ORDER BY weekday, start_time`)).rows;
    const leave = (await db.query(`SELECT staff_id, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date FROM staff_leave WHERE status='Approved' AND end_date >= current_date ORDER BY start_date`)).rows;
    res.json({ data: staff.map((s: any) => ({ ...s, shifts: shifts.filter((x: any) => x.staff_id === s.id), leave: leave.filter((x: any) => x.staff_id === s.id) })) });
  });

  r.put('/staff/:id/shifts', requirePermission('roster.manage'), async (req, res) => {
    const id = intParam(req.params.id);
    const b = parse(z.object({ shifts: z.array(z.object({ weekday: z.number().int().min(0).max(6), start_time: time, end_time: time })).max(14) }), req.body);
    if (!(await db.query('SELECT 1 FROM staff WHERE id=$1', [id])).rows.length) throw new HttpError(404, 'Staff member not found');
    for (const s of b.shifts) if (s.end_time <= s.start_time) throw new HttpError(400, 'A shift must end after it starts');
    for (let i = 0; i < b.shifts.length; i++) for (let j = i + 1; j < b.shifts.length; j++) {
      const a = b.shifts[i], c = b.shifts[j];
      if (a.weekday === c.weekday && a.start_time < c.end_time && c.start_time < a.end_time) throw new HttpError(400, 'Shifts on the same day must not overlap');
    }
    await db.tx(async (t) => {
      await t.query('DELETE FROM staff_shifts WHERE staff_id=$1', [id]);
      for (const s of b.shifts) await t.query('INSERT INTO staff_shifts(staff_id,weekday,start_time,end_time) VALUES ($1,$2,$3,$4)', [id, s.weekday, s.start_time, s.end_time]);
    });
    await audit(db, req, 'roster_update', 'staff', id);
    res.json({ ok: true });
  });

  /** Bookable appointment slots derived from the roster, approved leave and existing bookings. */
  r.get('/staff/:id/slots', requirePermission('appointments.read'), async (req, res) => {
    const id = intParam(req.params.id);
    const date = parse(dateStr, req.query.date);
    const minutes = req.query.minutes ? parseInt(String(req.query.minutes), 10) : 30;
    if (!(await db.query("SELECT 1 FROM staff WHERE id=$1 AND active AND staff_code LIKE 'DOC-%'", [id])).rows.length) throw new HttpError(404, 'Doctor not found');
    res.json({ date, ...(await slotsFor(db, id, date, minutes)) });
  });

  // ---------- leave ----------
  const LEAVE = `SELECT l.id, l.staff_id, s.full_name AS staff, l.status, l.reason, to_char(l.start_date,'YYYY-MM-DD') AS start_date, to_char(l.end_date,'YYYY-MM-DD') AS end_date, l.created_at, l.decided_at
    FROM staff_leave l JOIN staff s ON s.id=l.staff_id`;

  r.get('/leave', requirePermission('staff.read'), async (req, res) => {
    const u = req.user!;
    const manager = u.permissions.includes('leave.decide');
    const params: unknown[] = [];
    const where: string[] = [];
    if (req.query.status) { params.push(parse(z.enum(['Pending', 'Approved', 'Rejected']), req.query.status)); where.push(`l.status=$${params.length}`); }
    if (!manager) { params.push(u.staffId ?? 0); where.push(`(l.staff_id=$${params.length} OR l.status='Approved')`); }
    const rows = (await db.query(`${LEAVE} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.start_date DESC, l.id DESC LIMIT 200`, params)).rows;
    // reasons are private to the requester and to leave managers
    res.json({ data: rows.map((l: any) => (manager || l.staff_id === u.staffId ? l : { ...l, reason: '' })) });
  });

  r.post('/leave', requirePermission('leave.request'), async (req, res) => {
    const staffId = req.user!.staffId;
    if (!staffId) throw new HttpError(400, 'A staff profile is required to request leave');
    const b = parse(z.object({ start_date: dateStr, end_date: dateStr, reason: z.string().max(200).default('') }), req.body);
    if (b.start_date < todayStr()) throw new HttpError(400, 'Leave cannot start in the past');
    if (b.end_date < b.start_date) throw new HttpError(400, 'The end date must not be before the start date');
    if ((Date.parse(b.end_date) - Date.parse(b.start_date)) / 86400000 > 60) throw new HttpError(400, 'Leave requests are limited to 60 days');
    const overlap = (await db.query("SELECT 1 FROM staff_leave WHERE staff_id=$1 AND status <> 'Rejected' AND start_date <= $3::date AND end_date >= $2::date", [staffId, b.start_date, b.end_date])).rows.length;
    if (overlap) throw new HttpError(409, 'You already have leave requested or approved for these dates');
    const { rows } = await db.query('INSERT INTO staff_leave(staff_id,start_date,end_date,reason,requested_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [staffId, b.start_date, b.end_date, b.reason, req.user!.id]);
    const admins = (await db.query<{ id: number }>("SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id WHERE r.code='administrator' AND u.active")).rows.map((x) => x.id);
    await notifyUsers(db, admins, { kind: 'leave_request', title: 'Leave request awaiting decision', body: `${req.user!.fullName}: ${b.start_date} to ${b.end_date}`, link: '/roster', dedupeKey: `leave:${rows[0].id}` });
    await audit(db, req, 'leave_request', 'leave', rows[0].id);
    res.status(201).json({ id: rows[0].id });
  });

  r.post('/leave/:id/decision', requirePermission('leave.decide'), async (req, res) => {
    const id = intParam(req.params.id);
    const b = parse(z.object({ status: z.enum(['Approved', 'Rejected']) }), req.body);
    const l = (await db.query('SELECT staff_id, status, requested_by, start_date::text AS start_date, end_date::text AS end_date FROM staff_leave WHERE id=$1', [id])).rows[0];
    if (!l) throw new HttpError(404, 'Leave request not found');
    if (l.status !== 'Pending') throw new HttpError(409, `This request is already ${l.status.toLowerCase()}`);
    if (l.requested_by === req.user!.id) throw new HttpError(403, 'You cannot decide your own leave request');
    await db.query('UPDATE staff_leave SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1', [id, b.status, req.user!.id]);
    const conflicts = b.status === 'Approved'
      ? (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM appointments WHERE doctor_id=$1 AND status IN ('Scheduled','Confirmed') AND scheduled_at::date BETWEEN $2::date AND $3::date", [l.staff_id, l.start_date, l.end_date])).rows[0].n
      : 0;
    if (l.requested_by) await notifyUsers(db, [l.requested_by], { kind: 'leave_decision', severity: b.status === 'Approved' ? 'info' : 'warn', title: `Leave ${b.status.toLowerCase()}`, body: `${l.start_date} to ${l.end_date}`, link: '/roster' });
    await audit(db, req, 'leave_decision', 'leave', id, b.status);
    res.json({ ok: true, status: b.status, appointmentConflicts: conflicts });
  });

  r.delete('/leave/:id', requirePermission('leave.request', 'leave.decide'), async (req, res) => {
    const id = intParam(req.params.id);
    const l = (await db.query('SELECT status, requested_by FROM staff_leave WHERE id=$1', [id])).rows[0];
    if (!l) throw new HttpError(404, 'Leave request not found');
    const manager = req.user!.permissions.includes('leave.decide');
    if (!manager && l.requested_by !== req.user!.id) throw new HttpError(404, 'Leave request not found');
    if (l.status !== 'Pending') throw new HttpError(409, 'Only pending requests can be withdrawn');
    await db.query('DELETE FROM staff_leave WHERE id=$1', [id]);
    await audit(db, req, 'leave_withdraw', 'leave', id);
    res.json({ ok: true });
  });

  return r;
}
