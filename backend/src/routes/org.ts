import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../middleware/context.js';
import { audit, requirePermission } from '../middleware/context.js';
import { HttpError, intParam, orderBy, pageQuery, parse } from '../utils/http.js';

const AVAIL = ['Available', 'In Surgery', 'On Leave', 'Off Duty'] as const;

export function orgRoutes({ db }: Ctx) {
  const r = Router();

  // ---- departments ----
  r.get('/departments', requirePermission('departments.read'), async (_req, res) => {
    const rows = (await db.query(`SELECT d.id, d.name, d.description, d.services,
        (SELECT count(*)::int FROM staff s WHERE s.department_id=d.id AND s.active) AS staff_count,
        (SELECT count(*)::int FROM appointments a WHERE a.department_id=d.id AND a.scheduled_at::date = current_date) AS appointments_today
      FROM departments d ORDER BY d.name`)).rows;
    res.json({ data: rows });
  });

  r.get('/departments/:id', requirePermission('departments.read'), async (req, res) => {
    const id = intParam(req.params.id);
    const d = (await db.query('SELECT * FROM departments WHERE id=$1', [id])).rows[0];
    if (!d) throw new HttpError(404, 'Department not found');
    const [staff, summary] = await Promise.all([
      db.query('SELECT id, staff_code, full_name, job_title, availability FROM staff WHERE department_id=$1 AND active ORDER BY full_name', [id]),
      db.query('SELECT status, count(*)::int AS n FROM appointments WHERE department_id=$1 GROUP BY status ORDER BY status', [id]),
    ]);
    res.json({ ...d, staff: staff.rows, appointment_summary: summary.rows });
  });

  const deptBody = z.object({ name: z.string().trim().min(2).max(80), description: z.string().max(300).default(''), services: z.string().max(500).default('') });
  r.post('/departments', requirePermission('departments.manage'), async (req, res) => {
    const b = parse(deptBody, req.body);
    if ((await db.query('SELECT 1 FROM departments WHERE lower(name)=lower($1)', [b.name])).rows.length) throw new HttpError(409, 'A department with that name already exists');
    const { rows } = await db.query('INSERT INTO departments(name,description,services) VALUES ($1,$2,$3) RETURNING id', [b.name, b.description, b.services]);
    await audit(db, req, 'department_create', 'department', rows[0].id);
    res.status(201).json({ id: rows[0].id });
  });
  r.put('/departments/:id', requirePermission('departments.manage'), async (req, res) => {
    const id = intParam(req.params.id);
    const b = parse(deptBody, req.body);
    const n = (await db.query('UPDATE departments SET name=$1, description=$2, services=$3 WHERE id=$4 RETURNING id', [b.name, b.description, b.services, id])).rows.length;
    if (!n) throw new HttpError(404, 'Department not found');
    await audit(db, req, 'department_update', 'department', id);
    res.json({ ok: true });
  });

  // ---- staff ----
  const SORTS = { name: 's.full_name', code: 's.staff_code', title: 's.job_title', department: 'd.name', availability: 's.availability' };
  r.get('/staff', requirePermission('staff.read'), async (req, res) => {
    const pq = pageQuery(req.query, 'name');
    const params: unknown[] = [];
    const where = ['s.active'];
    if (pq.q) { params.push(`%${pq.q}%`); where.push(`(s.full_name ILIKE $${params.length} OR s.staff_code ILIKE $${params.length} OR s.job_title ILIKE $${params.length})`); }
    if (req.query.department_id) { params.push(intParam(req.query.department_id)); where.push(`s.department_id=$${params.length}`); }
    if (req.query.availability) { params.push(parse(z.enum(AVAIL), req.query.availability)); where.push(`s.availability=$${params.length}`); }
    if (req.query.kind === 'doctor') where.push("s.staff_code LIKE 'DOC-%'");
    const w = where.join(' AND ');
    const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM staff s WHERE ${w}`, params)).rows[0].n;
    const data = (await db.query(`SELECT s.id, s.staff_code, s.full_name, s.job_title, s.email, s.availability, s.schedule, s.department_id, d.name AS department
      FROM staff s LEFT JOIN departments d ON d.id=s.department_id WHERE ${w} ORDER BY ${orderBy(pq, SORTS, 'name')}, s.id LIMIT ${pq.pageSize} OFFSET ${(pq.page - 1) * pq.pageSize}`, params)).rows;
    res.json({ data, total, page: pq.page, pageSize: pq.pageSize });
  });

  r.get('/staff/:id', requirePermission('staff.read'), async (req, res) => {
    const id = intParam(req.params.id);
    const s = (await db.query('SELECT s.*, d.name AS department FROM staff s LEFT JOIN departments d ON d.id=s.department_id WHERE s.id=$1', [id])).rows[0];
    if (!s) throw new HttpError(404, 'Staff member not found');
    const appts = req.user!.permissions.includes('appointments.read')
      ? (await db.query(`SELECT a.id, a.scheduled_at, a.status, p.first_name || ' ' || p.last_name AS patient FROM appointments a JOIN patients p ON p.id=a.patient_id WHERE a.doctor_id=$1 AND a.scheduled_at >= now() - interval '1 day' ORDER BY a.scheduled_at LIMIT 20`, [id])).rows
      : null;
    res.json({ ...s, appointments: appts });
  });

  const staffBody = z.object({ full_name: z.string().trim().min(2).max(100), job_title: z.string().min(2).max(80), department_id: z.number().int().positive(), email: z.email().max(200), availability: z.enum(AVAIL).default('Available'), schedule: z.string().max(80).default('Mon-Fri 08:00-16:00') });
  r.post('/staff', requirePermission('staff.manage'), async (req, res) => {
    const b = parse(staffBody.extend({ staff_code: z.string().regex(/^[A-Z]{3}-\d{3}$/, 'Format ABC-123') }), req.body);
    if ((await db.query('SELECT 1 FROM staff WHERE staff_code=$1', [b.staff_code])).rows.length) throw new HttpError(409, 'Staff code already exists');
    const { rows } = await db.query('INSERT INTO staff(staff_code,full_name,job_title,department_id,email,availability,schedule) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [b.staff_code, b.full_name, b.job_title, b.department_id, b.email, b.availability, b.schedule]);
    await audit(db, req, 'staff_create', 'staff', rows[0].id);
    res.status(201).json({ id: rows[0].id });
  });
  r.put('/staff/:id', requirePermission('staff.manage'), async (req, res) => {
    const id = intParam(req.params.id);
    const b = parse(staffBody, req.body);
    const n = (await db.query('UPDATE staff SET full_name=$1, job_title=$2, department_id=$3, email=$4, availability=$5, schedule=$6 WHERE id=$7 RETURNING id', [b.full_name, b.job_title, b.department_id, b.email, b.availability, b.schedule, id])).rows.length;
    if (!n) throw new HttpError(404, 'Staff member not found');
    await audit(db, req, 'staff_update', 'staff', id);
    res.json({ ok: true });
  });

  return r;
}
