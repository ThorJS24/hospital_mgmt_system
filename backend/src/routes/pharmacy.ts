import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../middleware/context.js';
import { audit, requirePermission } from '../middleware/context.js';
import { HttpError, intParam, pageQuery, parse } from '../utils/http.js';
import { canAccessPatient, scopeClause } from '../services/patients.js';
import { checkPrescription } from '../services/prescribing.js';
import { issuePrescription } from '../services/rx.js';
import { scanInventory } from '../services/notifications.js';

const itemSchema = z.object({
  medication_id: z.number().int().positive(),
  quantity: z.number().int().min(1).max(500),
  dosage: z.string().trim().min(2).max(120),
  units_per_dose: z.number().int().min(1).max(20).nullish(),
  doses_per_day: z.number().int().min(1).max(12).nullish(),
});

export const prescriptionInput = z.object({
  patient_id: z.number().int().positive(),
  doctor_id: z.number().int().positive().optional(),
  notes: z.string().max(300).default(''),
  refills_allowed: z.number().int().min(0).max(5).default(0),
  override_reason: z.string().max(300).optional(),
  items: z.array(itemSchema).min(1).max(10),
});

export function pharmacyRoutes({ db }: Ctx) {
  const r = Router();

  r.get('/pharmacy/medications', requirePermission('pharmacy.read'), async (req, res) => {
    const pq = pageQuery(req.query);
    const params: unknown[] = [];
    let where = 'true';
    if (pq.q) { params.push(`%${pq.q}%`); where = `(name ILIKE $1 OR code ILIKE $1)`; }
    const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM medications WHERE ${where}`, params)).rows[0].n;
    const data = (await db.query(`SELECT id, code, name, form, strength, stock, drug_class, max_daily_units FROM medications WHERE ${where} ORDER BY name LIMIT ${pq.pageSize} OFFSET ${(pq.page - 1) * pq.pageSize}`, params)).rows;
    res.json({ data, total, page: pq.page, pageSize: pq.pageSize });
  });

  r.get('/pharmacy/medications/:id', requirePermission('pharmacy.read'), async (req, res) => {
    const m = (await db.query('SELECT id, code, name, form, strength, stock FROM medications WHERE id=$1', [intParam(req.params.id)])).rows[0];
    if (!m) throw new HttpError(404, 'Medication not found');
    res.json(m);
  });

  const ITEMS = `SELECT pi.id, pi.quantity, pi.dosage, pi.units_per_dose, pi.doses_per_day, m.name AS medication, m.strength, m.form, m.id AS medication_id FROM prescription_items pi JOIN medications m ON m.id=pi.medication_id`;
  const HEAD = `SELECT rx.id, rx.status, rx.dispensing_status, rx.notes, rx.created_at, rx.patient_id, rx.refills_allowed, rx.refills_used, rx.override_reason, rx.consultation_id, rx.last_dispensed_at,
      p.first_name || ' ' || p.last_name AS patient, p.mrn, s.full_name AS doctor,
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

  /** Dry-run of the safety checks: allergies, interactions, maximum daily dose, stock. */
  r.post('/pharmacy/prescriptions/check', requirePermission('prescriptions.write'), async (req, res) => {
    const b = parse(z.object({ patient_id: z.number().int().positive(), items: z.array(itemSchema).min(1).max(10) }), req.body);
    if (req.user!.role === 'doctor' && !(await canAccessPatient(db, req.user!, b.patient_id))) throw new HttpError(404, 'Patient not found');
    const warnings = await checkPrescription(db, b.patient_id, b.items);
    res.json({ warnings, blocked: warnings.some((w) => w.blocking) });
  });

  r.post('/pharmacy/prescriptions', requirePermission('prescriptions.write'), async (req, res) => {
    const b = parse(prescriptionInput, req.body);
    const doctorId = req.user!.role === 'doctor' ? req.user!.staffId : b.doctor_id;
    if (!doctorId) throw new HttpError(400, 'A prescribing doctor is required');
    if (req.user!.role === 'doctor' && !(await canAccessPatient(db, req.user!, b.patient_id))) throw new HttpError(404, 'Patient not found');
    const result = await issuePrescription(db, { patientId: b.patient_id, doctorId, notes: b.notes, items: b.items, refillsAllowed: b.refills_allowed, overrideReason: b.override_reason });
    await audit(db, req, 'prescription_create', 'prescription', result.id);
    if (result.overridden) await audit(db, req, 'prescription_override', 'prescription', result.id, (b.override_reason ?? '').slice(0, 200));
    res.status(201).json({ id: result.id, warnings: result.warnings });
  });

  /** Take items out of stock and keep the movement ledger; returns the medications that fell to the reorder level. */
  async function takeStock(t: Ctx['db'], rxId: number, reason: 'Dispense' | 'Refill', userId: number) {
    const items = (await t.query('SELECT medication_id, quantity FROM prescription_items WHERE prescription_id=$1', [rxId])).rows;
    for (const it of items) {
      const n = (await t.query('UPDATE medications SET stock = stock - $1 WHERE id=$2 AND stock >= $1 RETURNING id', [it.quantity, it.medication_id])).rows.length;
      if (!n) throw new HttpError(409, 'Insufficient stock to dispense this prescription');
      await t.query('INSERT INTO stock_movements(medication_id,delta,reason,note,user_id) VALUES ($1,$2,$3,$4,$5)', [it.medication_id, -it.quantity, reason, `Prescription #${rxId}`, userId]);
    }
  }

  r.post('/pharmacy/prescriptions/:id/dispense', requirePermission('prescriptions.dispense'), async (req, res) => {
    const id = intParam(req.params.id);
    await db.tx(async (t) => {
      const rx = (await t.query('SELECT status, dispensing_status, refills_allowed FROM prescriptions WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!rx) throw new HttpError(404, 'Prescription not found');
      if (rx.status !== 'Active' || rx.dispensing_status === 'Dispensed') throw new HttpError(409, 'Prescription cannot be dispensed');
      await takeStock(t, id, 'Dispense', req.user!.id);
      // a prescription with refills remaining stays active so that it can be refilled
      await t.query("UPDATE prescriptions SET dispensing_status='Dispensed', status=$2, last_dispensed_at=now() WHERE id=$1", [id, rx.refills_allowed > 0 ? 'Active' : 'Completed']);
    });
    await audit(db, req, 'prescription_dispense', 'prescription', id);
    await scanInventory(db);
    res.json({ ok: true });
  });

  r.post('/pharmacy/prescriptions/:id/refill', requirePermission('prescriptions.refill'), async (req, res) => {
    const id = intParam(req.params.id);
    const out = await db.tx(async (t) => {
      const rx = (await t.query('SELECT status, dispensing_status, refills_allowed, refills_used FROM prescriptions WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!rx) throw new HttpError(404, 'Prescription not found');
      if (rx.status !== 'Active' || rx.dispensing_status !== 'Dispensed') throw new HttpError(409, 'Only an active, already dispensed prescription can be refilled');
      if (rx.refills_used >= rx.refills_allowed) throw new HttpError(409, 'No refills remaining');
      await takeStock(t, id, 'Refill', req.user!.id);
      const used = rx.refills_used + 1;
      await t.query('UPDATE prescriptions SET refills_used=$2, status=$3, last_dispensed_at=now() WHERE id=$1', [id, used, used >= rx.refills_allowed ? 'Completed' : 'Active']);
      return { refills_used: used, refills_remaining: rx.refills_allowed - used };
    });
    await audit(db, req, 'prescription_refill', 'prescription', id);
    await scanInventory(db);
    res.json({ ok: true, ...out });
  });

  return r;
}
