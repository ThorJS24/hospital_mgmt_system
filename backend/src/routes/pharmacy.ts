import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../middleware/context.js';
import { audit, requirePermission } from '../middleware/context.js';
import { HttpError, intParam, pageQuery, parse } from '../utils/http.js';
import { canAccessPatient, scopeClause } from '../services/patients.js';

export function pharmacyRoutes({ db }: Ctx) {
  const r = Router();

  r.get('/pharmacy/medications', requirePermission('pharmacy.read'), async (req, res) => {
    const pq = pageQuery(req.query);
    const params: unknown[] = [];
    let where = 'true';
    if (pq.q) { params.push(`%${pq.q}%`); where = `(name ILIKE $1 OR code ILIKE $1)`; }
    const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM medications WHERE ${where}`, params)).rows[0].n;
    const data = (await db.query(`SELECT id, code, name, form, strength, stock FROM medications WHERE ${where} ORDER BY name LIMIT ${pq.pageSize} OFFSET ${(pq.page - 1) * pq.pageSize}`, params)).rows;
    res.json({ data, total, page: pq.page, pageSize: pq.pageSize });
  });

  r.get('/pharmacy/medications/:id', requirePermission('pharmacy.read'), async (req, res) => {
    const m = (await db.query('SELECT id, code, name, form, strength, stock FROM medications WHERE id=$1', [intParam(req.params.id)])).rows[0];
    if (!m) throw new HttpError(404, 'Medication not found');
    res.json(m);
  });

  const ITEMS = `SELECT pi.id, pi.quantity, pi.dosage, m.name AS medication, m.strength, m.form, m.id AS medication_id FROM prescription_items pi JOIN medications m ON m.id=pi.medication_id`;
  const HEAD = `SELECT rx.id, rx.status, rx.dispensing_status, rx.notes, rx.created_at, rx.patient_id, p.first_name || ' ' || p.last_name AS patient, p.mrn, s.full_name AS doctor,
      (SELECT count(*)::int FROM prescription_items WHERE prescription_id=rx.id) AS item_count
    FROM prescriptions rx JOIN patients p ON p.id=rx.patient_id JOIN staff s ON s.id=rx.doctor_id`;

  r.get('/pharmacy/prescriptions', requirePermission('pharmacy.read'), async (req, res) => {
    const pq = pageQuery(req.query);
    const sc = scopeClause(req.user!, 'p', 1);
    const params: unknown[] = [...sc.params];
    const where = [sc.sql];
    if (req.query.dispensing_status) { params.push(String(req.query.dispensing_status)); where.push(`rx.dispensing_status=$${params.length}`); }
    if (req.query.patient_id) { params.push(intParam(req.query.patient_id)); where.push(`rx.patient_id=$${params.length}`); }
    if (pq.q) { params.push(`%${pq.q}%`); where.push(`(p.first_name || ' ' || p.last_name ILIKE $${params.length} OR p.mrn ILIKE $${params.length})`); }
    const w = where.join(' AND ');
    const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM prescriptions rx JOIN patients p ON p.id=rx.patient_id WHERE ${w}`, params)).rows[0].n;
    const data = (await db.query(`${HEAD} WHERE ${w} ORDER BY rx.created_at DESC, rx.id DESC LIMIT ${pq.pageSize} OFFSET ${(pq.page - 1) * pq.pageSize}`, params)).rows;
    res.json({ data, total, page: pq.page, pageSize: pq.pageSize });
  });

  r.get('/pharmacy/prescriptions/:id', requirePermission('pharmacy.read'), async (req, res) => {
    const id = intParam(req.params.id);
    const sc = scopeClause(req.user!, 'p', 2);
    const head = (await db.query(`${HEAD} WHERE rx.id=$1 AND ${sc.sql}`, [id, ...sc.params])).rows[0];
    if (!head) throw new HttpError(404, 'Prescription not found');
    res.json({ ...head, items: (await db.query(`${ITEMS} WHERE pi.prescription_id=$1 ORDER BY pi.id`, [id])).rows, notice: 'SYNTHETIC record - not a medical instruction.' });
  });

  r.post('/pharmacy/prescriptions', requirePermission('prescriptions.write'), async (req, res) => {
    const b = parse(z.object({
      patient_id: z.number().int().positive(), doctor_id: z.number().int().positive().optional(), notes: z.string().max(300).default(''),
      items: z.array(z.object({ medication_id: z.number().int().positive(), quantity: z.number().int().min(1).max(500), dosage: z.string().trim().min(2).max(120) })).min(1).max(10),
    }), req.body);
    const doctorId = req.user!.role === 'doctor' ? req.user!.staffId : b.doctor_id;
    if (!doctorId) throw new HttpError(400, 'A prescribing doctor is required');
    if (req.user!.role === 'doctor' && !(await canAccessPatient(db, req.user!, b.patient_id))) throw new HttpError(404, 'Patient not found');
    const id = await db.tx(async (t) => {
      if (!(await t.query('SELECT 1 FROM patients WHERE id=$1', [b.patient_id])).rows.length) throw new HttpError(400, 'Patient not found');
      const { rows } = await t.query('INSERT INTO prescriptions(patient_id,doctor_id,notes) VALUES ($1,$2,$3) RETURNING id', [b.patient_id, doctorId, b.notes]);
      for (const it of b.items) {
        if (!(await t.query('SELECT 1 FROM medications WHERE id=$1', [it.medication_id])).rows.length) throw new HttpError(400, `Medication ${it.medication_id} not found`);
        await t.query('INSERT INTO prescription_items(prescription_id,medication_id,quantity,dosage) VALUES ($1,$2,$3,$4)', [rows[0].id, it.medication_id, it.quantity, it.dosage]);
      }
      return rows[0].id;
    });
    await audit(db, req, 'prescription_create', 'prescription', id);
    res.status(201).json({ id });
  });

  r.post('/pharmacy/prescriptions/:id/dispense', requirePermission('prescriptions.dispense'), async (req, res) => {
    const id = intParam(req.params.id);
    await db.tx(async (t) => {
      const rx = (await t.query('SELECT status, dispensing_status FROM prescriptions WHERE id=$1', [id])).rows[0];
      if (!rx) throw new HttpError(404, 'Prescription not found');
      if (rx.status !== 'Active' || rx.dispensing_status === 'Dispensed') throw new HttpError(409, 'Prescription cannot be dispensed');
      const items = (await t.query('SELECT medication_id, quantity FROM prescription_items WHERE prescription_id=$1', [id])).rows;
      for (const it of items) {
        const n = (await t.query('UPDATE medications SET stock = stock - $1 WHERE id=$2 AND stock >= $1 RETURNING id', [it.quantity, it.medication_id])).rows.length;
        if (!n) throw new HttpError(409, 'Insufficient stock to dispense this prescription');
      }
      await t.query("UPDATE prescriptions SET dispensing_status='Dispensed', status='Completed' WHERE id=$1", [id]);
    });
    await audit(db, req, 'prescription_dispense', 'prescription', id);
    res.json({ ok: true });
  });

  return r;
}
