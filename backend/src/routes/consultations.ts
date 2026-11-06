import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../middleware/context.js';
import { audit, requirePermission } from '../middleware/context.js';
import { HttpError, intParam, pageQuery, parse } from '../utils/http.js';
import { canAccessPatient, scopeClause } from '../services/patients.js';
import { issuePrescription } from '../services/rx.js';
import { prescriptionInput } from './pharmacy.js';

const isUniqueViolation = (e: any) => e?.code === '23505' || /unique|duplicate/i.test(String(e?.message));
const soap = z.object({
  subjective: z.string().max(4000).optional(),
  objective: z.string().max(4000).optional(),
  assessment: z.string().max(4000).optional(),
  plan: z.string().max(4000).optional(),
}).strict();

export function consultationRoutes({ db }: Ctx) {
  const r = Router();

  const HEAD = `SELECT c.id, c.patient_id, c.doctor_id, c.appointment_id, c.subjective, c.objective, c.assessment, c.plan, c.status, c.signed_at, c.created_at, c.updated_at,
      p.first_name || ' ' || p.last_name AS patient, p.mrn, s.full_name AS doctor,
      (SELECT d.icd_code FROM consultation_diagnoses d WHERE d.consultation_id=c.id AND d.is_primary) AS primary_diagnosis
    FROM consultations c JOIN patients p ON p.id=c.patient_id JOIN staff s ON s.id=c.doctor_id`;

  /** Loads a consultation the caller may see (care-team scope on the patient) or throws 404. */
  async function load(req: any, id: number) {
    const sc = scopeClause(req.user, 'p', 2);
    const row = (await db.query(`${HEAD} WHERE c.id=$1 AND ${sc.sql}`, [id, ...sc.params])).rows[0];
    if (!row) throw new HttpError(404, 'Consultation not found');
    return row;
  }
  /** Only the authoring doctor can change a draft. */
  function assertEditable(req: any, c: { doctor_id: number; status: string }) {
    if (c.doctor_id !== req.user.staffId) throw new HttpError(403, 'Only the authoring doctor can change this consultation');
    if (c.status !== 'Draft') throw new HttpError(409, 'A signed consultation can no longer be changed');
  }

  r.get('/icd10', requirePermission('consultations.read'), async (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 60);
    if (q.length < 2) return void res.json({ data: [] });
    const data = (await db.query(
      `SELECT code, description FROM icd10_codes WHERE code ILIKE $1 OR description ILIKE $2
        ORDER BY (code ILIKE $1) DESC, code LIMIT 20`, [`${q}%`, `%${q}%`])).rows;
    res.json({ data });
  });

  r.get('/consultations', requirePermission('consultations.read'), async (req, res) => {
    const pq = pageQuery(req.query);
    const sc = scopeClause(req.user!, 'p', 1);
    const params: unknown[] = [...sc.params];
    const where = [sc.sql];
    if (req.query.patient_id) { params.push(intParam(req.query.patient_id)); where.push(`c.patient_id=$${params.length}`); }
    if (req.query.status) { params.push(parse(z.enum(['Draft', 'Signed']), req.query.status)); where.push(`c.status=$${params.length}`); }
    if (req.query.mine === '1' && req.user!.staffId) { params.push(req.user!.staffId); where.push(`c.doctor_id=$${params.length}`); }
    if (pq.q) { params.push(`%${pq.q}%`); where.push(`(p.first_name || ' ' || p.last_name ILIKE $${params.length} OR p.mrn ILIKE $${params.length})`); }
    const w = where.join(' AND ');
    const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM consultations c JOIN patients p ON p.id=c.patient_id WHERE ${w}`, params)).rows[0].n;
    const data = (await db.query(`${HEAD} WHERE ${w} ORDER BY c.created_at DESC, c.id DESC LIMIT ${pq.pageSize} OFFSET ${(pq.page - 1) * pq.pageSize}`, params)).rows;
    res.json({ data, total, page: pq.page, pageSize: pq.pageSize });
  });

  r.get('/consultations/:id', requirePermission('consultations.read'), async (req, res) => {
    const id = intParam(req.params.id);
    const c = await load(req, id);
    const [diagnoses, labs, rx, allergies] = await Promise.all([
      db.query('SELECT d.icd_code AS code, i.description, d.is_primary FROM consultation_diagnoses d JOIN icd10_codes i ON i.code=d.icd_code WHERE d.consultation_id=$1 ORDER BY d.is_primary DESC, d.icd_code', [id]),
      db.query(`SELECT lr.id, lr.status, t.name AS test, t.code FROM laboratory_requests lr JOIN laboratory_tests t ON t.id=lr.test_id WHERE lr.consultation_id=$1 ORDER BY lr.id`, [id]),
      db.query(`SELECT rx.id, rx.status, rx.refills_allowed, rx.override_reason,
          (SELECT string_agg(m.name || ' ' || m.strength || ' x' || pi.quantity, '; ' ORDER BY pi.id) FROM prescription_items pi JOIN medications m ON m.id=pi.medication_id WHERE pi.prescription_id=rx.id) AS summary
        FROM prescriptions rx WHERE rx.consultation_id=$1 ORDER BY rx.id`, [id]),
      db.query('SELECT allergen, reaction, severity FROM patient_allergies WHERE patient_id=$1 ORDER BY id', [c.patient_id]),
    ]);
    res.json({ ...c, diagnoses: diagnoses.rows, lab_orders: labs.rows, prescriptions: rx.rows, allergies: allergies.rows });
  });

  r.post('/consultations', requirePermission('consultations.write'), async (req, res) => {
    const b = parse(z.object({ patient_id: z.number().int().positive(), appointment_id: z.number().int().positive().optional() }), req.body);
    const doctorId = req.user!.staffId;
    if (!doctorId) throw new HttpError(400, 'A doctor profile is required');
    if (!(await canAccessPatient(db, req.user!, b.patient_id))) throw new HttpError(404, 'Patient not found');
    if (b.appointment_id) {
      const a = (await db.query('SELECT patient_id, doctor_id, status FROM appointments WHERE id=$1', [b.appointment_id])).rows[0];
      if (!a || a.patient_id !== b.patient_id || a.doctor_id !== doctorId) throw new HttpError(404, 'Appointment not found');
      const existing = (await db.query('SELECT id FROM consultations WHERE appointment_id=$1', [b.appointment_id])).rows[0];
      if (existing) return void res.json({ id: existing.id, existing: true });
      if (['Cancelled', 'No-show'].includes(a.status)) throw new HttpError(409, `The appointment is ${a.status.toLowerCase()}`);
      if (['Scheduled', 'Confirmed', 'Checked in'].includes(a.status)) {
        // starting the visit moves the appointment through the clinic flow
        if (a.status !== 'Checked in') await db.query("UPDATE appointments SET status='Checked in' WHERE id=$1", [b.appointment_id]);
        await db.query("UPDATE appointments SET status='In consultation' WHERE id=$1", [b.appointment_id]);
      }
    }
    try {
      const { rows } = await db.query('INSERT INTO consultations(patient_id,doctor_id,appointment_id) VALUES ($1,$2,$3) RETURNING id', [b.patient_id, doctorId, b.appointment_id ?? null]);
      await audit(db, req, 'consultation_start', 'consultation', rows[0].id);
      res.status(201).json({ id: rows[0].id, existing: false });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'A consultation already exists for this appointment');
      throw e;
    }
  });

  r.patch('/consultations/:id', requirePermission('consultations.write'), async (req, res) => {
    const id = intParam(req.params.id);
    const c = await load(req, id);
    assertEditable(req, c);
    const b = parse(soap, req.body);
    const cols = Object.entries(b).filter(([, v]) => v !== undefined);
    if (!cols.length) throw new HttpError(400, 'No fields to update');
    await db.query(`UPDATE consultations SET ${cols.map(([k], i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`, [id, ...cols.map(([, v]) => v)]);
    await audit(db, req, 'consultation_update', 'consultation', id);
    res.json({ ok: true });
  });

  r.put('/consultations/:id/diagnoses', requirePermission('consultations.write'), async (req, res) => {
    const id = intParam(req.params.id);
    const c = await load(req, id);
    assertEditable(req, c);
    const b = parse(z.object({ diagnoses: z.array(z.object({ icd_code: z.string().min(2).max(10), is_primary: z.boolean().default(false) })).max(10) }), req.body);
    const codes = b.diagnoses.map((d) => d.icd_code);
    if (new Set(codes).size !== codes.length) throw new HttpError(400, 'Duplicate diagnosis codes');
    if (b.diagnoses.filter((d) => d.is_primary).length > 1) throw new HttpError(400, 'Only one primary diagnosis is allowed');
    if (codes.length) {
      const found = (await db.query<{ code: string }>('SELECT code FROM icd10_codes WHERE code = ANY($1::text[])', [codes])).rows.map((x) => x.code);
      const missing = codes.filter((x) => !found.includes(x));
      if (missing.length) throw new HttpError(400, `Unknown ICD-10 code: ${missing.join(', ')}`);
    }
    await db.tx(async (t) => {
      await t.query('DELETE FROM consultation_diagnoses WHERE consultation_id=$1', [id]);
      for (const d of b.diagnoses) await t.query('INSERT INTO consultation_diagnoses(consultation_id,icd_code,is_primary) VALUES ($1,$2,$3)', [id, d.icd_code, d.is_primary]);
      await t.query('UPDATE consultations SET updated_at=now() WHERE id=$1', [id]);
    });
    await audit(db, req, 'consultation_diagnoses', 'consultation', id);
    res.json({ ok: true });
  });

  r.post('/consultations/:id/lab-orders', requirePermission('consultations.write'), async (req, res) => {
    const id = intParam(req.params.id);
    const c = await load(req, id);
    assertEditable(req, c);
    const b = parse(z.object({ test_ids: z.array(z.number().int().positive()).min(1).max(10) }), req.body);
    const ids: number[] = [];
    await db.tx(async (t) => {
      for (const testId of [...new Set(b.test_ids)]) {
        if (!(await t.query('SELECT 1 FROM laboratory_tests WHERE id=$1', [testId])).rows.length) throw new HttpError(400, `Test ${testId} not found`);
        ids.push((await t.query('INSERT INTO laboratory_requests(patient_id,test_id,ordering_doctor_id,consultation_id) VALUES ($1,$2,$3,$4) RETURNING id', [c.patient_id, testId, c.doctor_id, id])).rows[0].id);
      }
    });
    for (const rid of ids) await audit(db, req, 'lab_request', 'laboratory_request', rid);
    res.status(201).json({ ids });
  });

  r.post('/consultations/:id/prescriptions', requirePermission('consultations.write', 'prescriptions.write'), async (req, res) => {
    const id = intParam(req.params.id);
    const c = await load(req, id);
    assertEditable(req, c);
    const b = parse(prescriptionInput.omit({ patient_id: true, doctor_id: true }), req.body);
    const result = await issuePrescription(db, { patientId: c.patient_id, doctorId: c.doctor_id, notes: b.notes, items: b.items, refillsAllowed: b.refills_allowed, overrideReason: b.override_reason, consultationId: id });
    await audit(db, req, 'prescription_create', 'prescription', result.id);
    if (result.overridden) await audit(db, req, 'prescription_override', 'prescription', result.id, (b.override_reason ?? '').slice(0, 200));
    res.status(201).json({ id: result.id, warnings: result.warnings });
  });

  r.post('/consultations/:id/sign', requirePermission('consultations.write'), async (req, res) => {
    const id = intParam(req.params.id);
    const c = await load(req, id);
    assertEditable(req, c);
    if (!c.assessment.trim()) throw new HttpError(409, 'Record an assessment before signing');
    if (!c.primary_diagnosis) throw new HttpError(409, 'Select a primary diagnosis before signing');
    await db.tx(async (t) => {
      await t.query("UPDATE consultations SET status='Signed', signed_at=now(), signed_by=$2, updated_at=now() WHERE id=$1", [id, req.user!.id]);
      if (c.appointment_id) await t.query("UPDATE appointments SET status='Completed' WHERE id=$1 AND status='In consultation'", [c.appointment_id]);
      // the primary diagnosis becomes part of the patient's problem list
      const d = (await t.query('SELECT i.description, i.code FROM consultation_diagnoses d JOIN icd10_codes i ON i.code=d.icd_code WHERE d.consultation_id=$1 AND d.is_primary', [id])).rows[0];
      const label = `${d.description} (${d.code})`;
      if (!(await t.query('SELECT 1 FROM medical_histories WHERE patient_id=$1 AND condition=$2', [c.patient_id, label])).rows.length) {
        await t.query('INSERT INTO medical_histories(patient_id,condition,diagnosed_on,notes) VALUES ($1,$2,current_date,$3)', [c.patient_id, label, 'Recorded from signed consultation']);
      }
    });
    await audit(db, req, 'consultation_sign', 'consultation', id);
    res.json({ ok: true, status: 'Signed' });
  });

  return r;
}
