import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../middleware/context.js';
import { audit, requirePermission } from '../middleware/context.js';
import { HttpError, intParam, parse } from '../utils/http.js';
import { notifyBedChange } from '../services/notifications.js';

const isUniqueViolation = (e: any) => e?.code === '23505' || /unique|duplicate/i.test(String(e?.message));

export function inpatientRoutes({ db }: Ctx) {
  const r = Router();

  r.get('/wards', requirePermission('admissions.read'), async (_req, res) => {
    const wards = (await db.query(`SELECT w.id, w.name, d.name AS department,
        (SELECT count(*)::int FROM beds b WHERE b.ward_id=w.id) AS beds,
        (SELECT count(*)::int FROM beds b JOIN admissions a ON a.bed_id=b.id AND a.status='Admitted' WHERE b.ward_id=w.id) AS occupied
      FROM wards w LEFT JOIN departments d ON d.id=w.department_id ORDER BY w.id`)).rows;
    const beds = (await db.query(`SELECT b.id, b.ward_id, b.label, a.id AS admission_id, p.first_name || ' ' || p.last_name AS patient, p.mrn
      FROM beds b LEFT JOIN admissions a ON a.bed_id=b.id AND a.status='Admitted' LEFT JOIN patients p ON p.id=a.patient_id ORDER BY b.ward_id, b.label`)).rows;
    res.json(wards.map((w: any) => ({ ...w, available: w.beds - w.occupied, bedList: beds.filter((b: any) => b.ward_id === w.id) })));
  });

  r.get('/admissions', requirePermission('admissions.read'), async (req, res) => {
    const status = req.query.status ? parse(z.enum(['Admitted', 'Discharged']), req.query.status) : null;
    const params: unknown[] = [];
    let where = 'true';
    if (status) { params.push(status); where = 'a.status=$1'; }
    if (req.user!.role === 'doctor') { params.push(req.user!.staffId ?? 0); where += ` AND a.doctor_id=$${params.length}`; }
    if (req.user!.role === 'nurse') { params.push(req.user!.departmentId ?? 0); where += ` AND w.department_id=$${params.length}`; }
    const rows = (await db.query(`SELECT a.id, a.status, a.admitted_at, a.discharged_at, a.reason, p.id AS patient_id, p.first_name || ' ' || p.last_name AS patient, p.mrn,
        w.name AS ward, b.label AS bed, s.full_name AS doctor
      FROM admissions a JOIN patients p ON p.id=a.patient_id JOIN beds b ON b.id=a.bed_id JOIN wards w ON w.id=b.ward_id JOIN staff s ON s.id=a.doctor_id
      WHERE ${where} ORDER BY a.status, a.admitted_at DESC LIMIT 200`, params)).rows;
    res.json({ data: rows, total: rows.length });
  });

  r.post('/admissions', requirePermission('admissions.manage'), async (req, res) => {
    const b = parse(z.object({ patient_id: z.number().int().positive(), bed_id: z.number().int().positive(), doctor_id: z.number().int().positive(), reason: z.string().max(200).default('') }), req.body);
    try {
      const id = await db.tx(async (t) => {
        const occupied = (await t.query("SELECT 1 FROM admissions WHERE bed_id=$1 AND status='Admitted'", [b.bed_id])).rows.length;
        if (occupied) throw new HttpError(409, 'Bed is already occupied');
        if ((await t.query("SELECT 1 FROM admissions WHERE patient_id=$1 AND status='Admitted'", [b.patient_id])).rows.length) throw new HttpError(409, 'Patient already has an active admission');
        if (!(await t.query('SELECT 1 FROM beds WHERE id=$1', [b.bed_id])).rows.length) throw new HttpError(400, 'Bed not found');
        if (!(await t.query('SELECT 1 FROM patients WHERE id=$1', [b.patient_id])).rows.length) throw new HttpError(400, 'Patient not found');
        if (!(await t.query("SELECT 1 FROM staff WHERE id=$1 AND staff_code LIKE 'DOC-%'", [b.doctor_id])).rows.length) throw new HttpError(400, 'Doctor not found');
        return (await t.query('INSERT INTO admissions(patient_id,bed_id,doctor_id,admitted_at,reason) VALUES ($1,$2,$3,now(),$4) RETURNING id', [b.patient_id, b.bed_id, b.doctor_id, b.reason])).rows[0].id;
      });
      await audit(db, req, 'admission_create', 'admission', id);
      await notifyBedChange(db, id, 'admitted');
      res.status(201).json({ id });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'Bed or patient is already part of an active admission');
      throw e;
    }
  });

  r.post('/admissions/:id/discharge', requirePermission('admissions.manage'), async (req, res) => {
    const id = intParam(req.params.id);
    const cur = (await db.query('SELECT status FROM admissions WHERE id=$1', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'Admission not found');
    if (cur.status !== 'Admitted') throw new HttpError(409, 'Patient is already discharged');
    await db.query("UPDATE admissions SET status='Discharged', discharged_at=now() WHERE id=$1", [id]);
    await audit(db, req, 'admission_discharge', 'admission', id);
    await notifyBedChange(db, id, 'discharged');
    res.json({ ok: true });
  });

  r.post('/admissions/:id/transfer', requirePermission('admissions.manage'), async (req, res) => {
    const id = intParam(req.params.id);
    const { bed_id } = parse(z.object({ bed_id: z.number().int().positive() }), req.body);
    try {
      await db.tx(async (t) => {
        const cur = (await t.query('SELECT status FROM admissions WHERE id=$1', [id])).rows[0];
        if (!cur) throw new HttpError(404, 'Admission not found');
        if (cur.status !== 'Admitted') throw new HttpError(409, 'Admission is not active');
        if ((await t.query("SELECT 1 FROM admissions WHERE bed_id=$1 AND status='Admitted'", [bed_id])).rows.length) throw new HttpError(409, 'Bed is already occupied');
        await t.query('UPDATE admissions SET bed_id=$1 WHERE id=$2', [bed_id, id]);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'Bed is already occupied');
      throw e;
    }
    await audit(db, req, 'admission_transfer', 'admission', id);
    await notifyBedChange(db, id, 'transferred');
    res.json({ ok: true });
  });

  return r;
}
