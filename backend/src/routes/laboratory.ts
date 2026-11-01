import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Ctx } from '../middleware/context.js';
import { audit, requirePermission } from '../middleware/context.js';
import { HttpError, intParam, pageQuery, parse } from '../utils/http.js';
import { scopeClause, canAccessPatient } from '../services/patients.js';

const STATUSES = ['Requested', 'In progress', 'Resulted', 'Approved', 'Cancelled'] as const;

export function laboratoryRoutes({ db, cfg }: Ctx) {
  const r = Router();
  const SELECT = `SELECT lr.id, lr.status, lr.requested_at, lr.patient_id, p.first_name || ' ' || p.last_name AS patient, p.mrn,
      t.code AS test_code, t.name AS test, t.unit, t.reference_range, od.full_name AS ordering_doctor, tech.full_name AS technician, lr.assigned_tech_id,
      res.value AS result_value, res.comment AS result_comment, res.approved AS result_approved
    FROM laboratory_requests lr JOIN patients p ON p.id=lr.patient_id JOIN laboratory_tests t ON t.id=lr.test_id
    JOIN staff od ON od.id=lr.ordering_doctor_id LEFT JOIN staff tech ON tech.id=lr.assigned_tech_id LEFT JOIN laboratory_results res ON res.request_id=lr.id`;

  r.get('/laboratory/tests', requirePermission('lab.read'), async (_req, res) => {
    res.json({ data: (await db.query('SELECT id, code, name, unit, reference_range, price::float AS price FROM laboratory_tests ORDER BY name')).rows });
  });

  r.get('/laboratory/requests', requirePermission('lab.read'), async (req, res) => {
    const pq = pageQuery(req.query);
    const sc = scopeClause(req.user!, 'p', 1);
    const params: unknown[] = [...sc.params];
    const where = [sc.sql];
    if (req.query.status) { params.push(parse(z.enum(STATUSES), req.query.status)); where.push(`lr.status=$${params.length}`); }
    if (req.query.patient_id) { params.push(intParam(req.query.patient_id)); where.push(`lr.patient_id=$${params.length}`); }
    if (pq.q) { params.push(`%${pq.q}%`); where.push(`(p.first_name || ' ' || p.last_name ILIKE $${params.length} OR t.name ILIKE $${params.length} OR p.mrn ILIKE $${params.length})`); }
    const w = where.join(' AND ');
    const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM laboratory_requests lr JOIN patients p ON p.id=lr.patient_id JOIN laboratory_tests t ON t.id=lr.test_id WHERE ${w}`, params)).rows[0].n;
    const data = (await db.query(`${SELECT} WHERE ${w} ORDER BY lr.requested_at DESC, lr.id DESC LIMIT ${pq.pageSize} OFFSET ${(pq.page - 1) * pq.pageSize}`, params)).rows;
    res.json({ data, total, page: pq.page, pageSize: pq.pageSize, notice: 'All laboratory results are SYNTHETIC and unsuitable for clinical decisions.' });
  });

  r.get('/laboratory/requests/:id', requirePermission('lab.read'), async (req, res) => {
    const sc = scopeClause(req.user!, 'p', 2);
    const row = (await db.query(`${SELECT} WHERE lr.id=$1 AND ${sc.sql}`, [intParam(req.params.id), ...sc.params])).rows[0];
    if (!row) throw new HttpError(404, 'Request not found');
    res.json(row);
  });

  r.post('/laboratory/requests', requirePermission('lab.request'), async (req, res) => {
    const b = parse(z.object({ patient_id: z.number().int().positive(), test_id: z.number().int().positive(), ordering_doctor_id: z.number().int().positive().optional() }), req.body);
    const doctorId = req.user!.role === 'doctor' ? req.user!.staffId : b.ordering_doctor_id;
    if (!doctorId) throw new HttpError(400, 'An ordering doctor is required');
    if (req.user!.role === 'doctor' && !(await canAccessPatient(db, req.user!, b.patient_id))) throw new HttpError(404, 'Patient not found');
    if (!(await db.query('SELECT 1 FROM patients WHERE id=$1', [b.patient_id])).rows.length) throw new HttpError(400, 'Patient not found');
    if (!(await db.query('SELECT 1 FROM laboratory_tests WHERE id=$1', [b.test_id])).rows.length) throw new HttpError(400, 'Test not found');
    const { rows } = await db.query('INSERT INTO laboratory_requests(patient_id,test_id,ordering_doctor_id) VALUES ($1,$2,$3) RETURNING id', [b.patient_id, b.test_id, doctorId]);
    await audit(db, req, 'lab_request', 'laboratory_request', rows[0].id);
    res.status(201).json({ id: rows[0].id });
  });

  r.post('/laboratory/requests/:id/assign', requirePermission('lab.result'), async (req, res) => {
    const id = intParam(req.params.id);
    const { tech_id } = parse(z.object({ tech_id: z.number().int().positive().optional() }), req.body);
    const tech = tech_id ?? req.user!.staffId;
    if (!tech || !(await db.query("SELECT 1 FROM staff WHERE id=$1 AND staff_code LIKE 'LAB-%'", [tech])).rows.length) throw new HttpError(400, 'A laboratory technician is required');
    const cur = (await db.query('SELECT status FROM laboratory_requests WHERE id=$1', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'Request not found');
    if (!['Requested', 'In progress'].includes(cur.status)) throw new HttpError(409, `Request is ${cur.status}`);
    await db.query("UPDATE laboratory_requests SET assigned_tech_id=$1, status='In progress' WHERE id=$2", [tech, id]);
    await audit(db, req, 'lab_assign', 'laboratory_request', id);
    res.json({ ok: true });
  });

  r.post('/laboratory/requests/:id/result', requirePermission('lab.result'), async (req, res) => {
    const id = intParam(req.params.id);
    const b = parse(z.object({ value: z.string().trim().min(1).max(60), comment: z.string().max(300).default('') }), req.body);
    const cur = (await db.query('SELECT status FROM laboratory_requests WHERE id=$1', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'Request not found');
    if (cur.status !== 'In progress') throw new HttpError(409, 'Results can only be entered for requests that are in progress');
    await db.tx(async (t) => {
      await t.query('INSERT INTO laboratory_results(request_id,value,comment,entered_by) VALUES ($1,$2,$3,$4)', [id, b.value, b.comment, req.user!.id]);
      await t.query("UPDATE laboratory_requests SET status='Resulted' WHERE id=$1", [id]);
    });
    await audit(db, req, 'lab_result', 'laboratory_request', id);
    res.status(201).json({ ok: true });
  });

  r.post('/laboratory/requests/:id/approve', requirePermission('lab.approve'), async (req, res) => {
    const id = intParam(req.params.id);
    const cur = (await db.query('SELECT status FROM laboratory_requests WHERE id=$1', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'Request not found');
    if (cur.status !== 'Resulted') throw new HttpError(409, 'Only resulted requests can be approved');
    await db.tx(async (t) => {
      await t.query('UPDATE laboratory_results SET approved=true WHERE request_id=$1', [id]);
      await t.query("UPDATE laboratory_requests SET status='Approved' WHERE id=$1", [id]);
    });
    await audit(db, req, 'lab_approve', 'laboratory_request', id);
    res.json({ ok: true });
  });

  // Secure counterpart of HMS-V12: only file names from a fixed allow-list in lab-data/public-docs.
  r.get('/laboratory/reference-docs/:name', requirePermission('lab.read'), (req, res) => {
    const dir = path.join(cfg.labDataDir, 'public-docs');
    const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const name = String(req.params.name);
    if (!names.includes(name)) throw new HttpError(404, 'File not found');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(fs.readFileSync(path.join(dir, name)));
  });
  r.get('/laboratory/reference-docs', requirePermission('lab.read'), (_req, res) => {
    const dir = path.join(cfg.labDataDir, 'public-docs');
    res.json({ data: fs.existsSync(dir) ? fs.readdirSync(dir) : [] });
  });

  return r;
}
