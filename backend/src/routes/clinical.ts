import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Ctx } from '../middleware/context.js';
import { audit, requirePermission } from '../middleware/context.js';
import { HttpError, intParam, parse } from '../utils/http.js';
import { canAccessPatient } from '../services/patients.js';
import { ageInYears, flagRow, hasCritical, rangesFor } from '../services/vitals.js';
import { notifyRoles, notifyStaff } from '../services/notifications.js';
import { hasConflict } from '../services/appointments.js';
import { buildPdf } from '../services/pdf.js';
import { emitLive } from '../services/live.js';

const isUniqueViolation = (e: any) => e?.code === '23505' || /unique|duplicate/i.test(String(e?.message));
const pad = (n: number) => String(n).padStart(2, '0');
const localNow = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Use YYYY-MM-DDTHH:MM');

export function clinicalRoutes({ db }: Ctx) {
  const r = Router();

  // ================= vitals trend =================
  r.get('/patients/:id/vitals/trend', requirePermission('clinical.read'), async (req, res) => {
    const id = intParam(req.params.id);
    if (!(await canAccessPatient(db, req.user!, id))) throw new HttpError(404, 'Patient not found');
    const limit = Math.min(60, Math.max(1, parseInt(String(req.query.limit ?? '30'), 10) || 30));
    const p = (await db.query<{ dob: string }>('SELECT dob FROM patients WHERE id=$1', [id])).rows[0];
    const age = ageInYears(p.dob);
    const rows = (await db.query(
      `SELECT * FROM (SELECT id, recorded_at, systolic, diastolic, heart_rate, temperature_c::float AS temperature_c, spo2, weight_kg::float AS weight_kg
          FROM patient_vitals WHERE patient_id=$1 ORDER BY recorded_at DESC, id DESC LIMIT ${limit}) x ORDER BY recorded_at, id`, [id])).rows;
    const data = rows.map((v: any) => ({ ...v, flags: flagRow(v, age) }));
    const r0 = rangesFor(age);
    res.json({
      data, age: Math.floor(age), ranges: Object.fromEntries(Object.entries(r0).map(([k, v]) => [k, { lo: v.lo, hi: v.hi }])),
      abnormalCount: data.filter((d) => Object.values(d.flags).some(Boolean)).length,
    });
  });

  r.post('/patients/:id/vitals', requirePermission('vitals.write'), async (req, res) => {
    const id = intParam(req.params.id);
    if (!(await canAccessPatient(db, req.user!, id))) throw new HttpError(404, 'Patient not found');
    const b = parse(z.object({
      systolic: z.number().int().min(40).max(300), diastolic: z.number().int().min(20).max(200), heart_rate: z.number().int().min(20).max(250),
      temperature_c: z.number().min(30).max(45), spo2: z.number().int().min(50).max(100), weight_kg: z.number().min(0.5).max(500),
      recorded_at: localDateTime.optional(),
    }).refine((v) => v.diastolic < v.systolic, { message: 'Diastolic must be lower than systolic', path: ['diastolic'] }), req.body);
    const at = b.recorded_at ?? localNow();
    if (at > localNow().slice(0, 16) + ':59') throw new HttpError(400, 'Readings cannot be recorded in the future');
    const p = (await db.query<{ dob: string; primary_doctor_id: number | null; first_name: string; last_name: string }>('SELECT dob, primary_doctor_id, first_name, last_name FROM patients WHERE id=$1', [id])).rows[0];
    const { rows } = await db.query('INSERT INTO patient_vitals(patient_id,recorded_at,systolic,diastolic,heart_rate,temperature_c,spo2,weight_kg) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [id, at, b.systolic, b.diastolic, b.heart_rate, b.temperature_c, b.spo2, b.weight_kg]);
    const flags = flagRow(b, ageInYears(p.dob));
    if (hasCritical(flags) && p.primary_doctor_id) {
      const bad = Object.entries(flags).filter(([, f]) => f?.startsWith('critical')).map(([k]) => k.replace('_', ' ')).join(', ');
      await notifyStaff(db, p.primary_doctor_id, { kind: 'vitals_critical', severity: 'critical', title: 'Critical vital signs', body: `${p.first_name} ${p.last_name}: ${bad}`, link: `/patients/${id}`, dedupeKey: `vitcrit:${rows[0].id}` });
    }
    await audit(db, req, 'vitals_record', 'patient', id);
    res.status(201).json({ id: rows[0].id, flags });
  });

  // ================= medication administration record (MAR) =================
  const marScope = (req: Request, alias = 'w', first = 1) => {
    const u = req.user!;
    if (u.role === 'doctor') return { sql: `ad.doctor_id = $${first}`, params: [u.staffId ?? 0] };
    if (u.role === 'nurse') return { sql: `${alias}.department_id = $${first}`, params: [u.departmentId ?? 0] };
    return { sql: 'true', params: [] as unknown[] };
  };
  const MAR_SELECT = `SELECT d.id, d.admission_id, d.prescription_item_id, d.scheduled_at, d.status, d.administered_at, d.note,
      p.id AS patient_id, p.first_name || ' ' || p.last_name AS patient, p.mrn, w.name AS ward, b.label AS bed,
      m.name AS medication, m.strength, pi.dosage, u.full_name AS administered_by,
      (SELECT count(*)::int FROM patient_allergies al WHERE al.patient_id=p.id AND al.severity='Severe') AS severe_allergies
    FROM mar_doses d JOIN admissions ad ON ad.id=d.admission_id JOIN patients p ON p.id=ad.patient_id JOIN beds b ON b.id=ad.bed_id JOIN wards w ON w.id=b.ward_id
    JOIN prescription_items pi ON pi.id=d.prescription_item_id JOIN medications m ON m.id=pi.medication_id LEFT JOIN users u ON u.id=d.administered_by`;

  r.get('/mar', requirePermission('mar.read'), async (req, res) => {
    const sc = marScope(req, 'w', 1);
    const params: unknown[] = [...sc.params];
    const where = [sc.sql];
    const date = req.query.date ? parse(dateStr, req.query.date) : localNow().slice(0, 10);
    params.push(date); where.push(`d.scheduled_at::date = $${params.length}::date`);
    if (req.query.admission_id) { params.push(intParam(req.query.admission_id)); where.push(`d.admission_id=$${params.length}`); }
    else where.push("ad.status='Admitted'");
    if (req.query.status) { params.push(parse(z.enum(['Scheduled', 'Given', 'Held', 'Refused', 'Missed']), req.query.status)); where.push(`d.status=$${params.length}`); }
    const rows = (await db.query(`${MAR_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.scheduled_at, p.last_name, d.id LIMIT 500`, params)).rows;
    const nowMs = Date.now();
    const data = rows.map((d: any) => ({ ...d, overdue: d.status === 'Scheduled' && new Date(d.scheduled_at).getTime() < nowMs - 60 * 60_000 }));
    const counts: Record<string, number> = { Scheduled: 0, Given: 0, Held: 0, Refused: 0, Missed: 0 };
    for (const d of data) counts[d.status]++;
    res.json({ date, data, counts, overdue: data.filter((d) => d.overdue).length });
  });

  r.post('/mar/schedule', requirePermission('mar.schedule'), async (req, res) => {
    const b = parse(z.object({
      admission_id: z.number().int().positive(), prescription_item_id: z.number().int().positive(),
      times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM')).min(1).max(6),
      days: z.number().int().min(1).max(14).default(1), start_date: dateStr.optional(),
    }), req.body);
    const adm = (await db.query('SELECT id, patient_id, doctor_id, status FROM admissions WHERE id=$1', [b.admission_id])).rows[0];
    if (!adm) throw new HttpError(404, 'Admission not found');
    if (adm.status !== 'Admitted') throw new HttpError(409, 'Doses can only be scheduled for current inpatients');
    if (req.user!.role === 'doctor' && adm.doctor_id !== req.user!.staffId) throw new HttpError(404, 'Admission not found');
    const item = (await db.query(`SELECT pi.id FROM prescription_items pi JOIN prescriptions rx ON rx.id=pi.prescription_id WHERE pi.id=$1 AND rx.patient_id=$2 AND rx.status='Active'`, [b.prescription_item_id, adm.patient_id])).rows[0];
    if (!item) throw new HttpError(400, 'The medication must belong to an active prescription for this patient');
    const times = [...new Set(b.times)].sort();
    const start = new Date(`${b.start_date ?? localNow().slice(0, 10)}T00:00:00Z`);
    let created = 0;
    await db.tx(async (t) => {
      for (let day = 0; day < b.days; day++) {
        const dt = new Date(start.getTime() + day * 86400000).toISOString().slice(0, 10);
        for (const tm of times) {
          const n = (await t.query(`INSERT INTO mar_doses(admission_id,prescription_item_id,scheduled_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`, [b.admission_id, b.prescription_item_id, `${dt}T${tm}:00`])).rows.length;
          created += n;
        }
      }
    });
    await audit(db, req, 'mar_schedule', 'admission', b.admission_id, `doses=${created}`);
    res.status(201).json({ created });
  });

  r.post('/mar/:id/administer', requirePermission('mar.administer'), async (req, res) => {
    const id = intParam(req.params.id);
    const b = parse(z.object({ status: z.enum(['Given', 'Held', 'Refused', 'Missed']), note: z.string().max(300).default('') }), req.body);
    if (b.status !== 'Given' && b.note.trim().length < 3) throw new HttpError(400, 'A note is required when a dose is not given');
    const sc = marScope(req, 'w', 2);
    const dose = (await db.query(`${MAR_SELECT} WHERE d.id=$1 AND ${sc.sql}`, [id, ...sc.params])).rows[0];
    if (!dose) throw new HttpError(404, 'Dose not found');
    if (dose.status !== 'Scheduled') throw new HttpError(409, `This dose is already recorded as ${dose.status}`);
    const upd = await db.query("UPDATE mar_doses SET status=$2, administered_at=$3, administered_by=$4, note=$5 WHERE id=$1 AND status='Scheduled' RETURNING id", [id, b.status, localNow(), req.user!.id, b.note.trim()]);
    if (!upd.rows.length) throw new HttpError(409, 'This dose was just recorded by someone else');
    await audit(db, req, 'mar_administer', 'mar_dose', id, b.status);
    res.json({ ok: true, status: b.status });
  });

  // ================= discharge summary =================
  async function loadAdmission(req: Request, id: number) {
    const u = req.user!;
    const adm = (await db.query(
      `SELECT a.id, a.patient_id, a.doctor_id, a.status, a.admitted_at, a.discharged_at, a.reason, p.first_name, p.last_name, p.mrn, p.dob, p.sex,
              w.name AS ward, w.department_id, b.label AS bed, s.full_name AS doctor
         FROM admissions a JOIN patients p ON p.id=a.patient_id JOIN beds b ON b.id=a.bed_id JOIN wards w ON w.id=b.ward_id JOIN staff s ON s.id=a.doctor_id WHERE a.id=$1`, [id])).rows[0];
    if (!adm) throw new HttpError(404, 'Admission not found');
    if (u.role === 'doctor' && adm.doctor_id !== u.staffId) throw new HttpError(404, 'Admission not found');
    if (u.role === 'nurse' && adm.department_id !== u.departmentId) throw new HttpError(404, 'Admission not found');
    return adm;
  }

  r.get('/admissions/:id/discharge-summary', requirePermission('discharge.read'), async (req, res) => {
    const id = intParam(req.params.id);
    const adm = await loadAdmission(req, id);
    const summary = (await db.query(
      `SELECT ds.id, ds.diagnosis, ds.hospital_course, ds.discharge_medications, ds.instructions, ds.follow_up_appointment_id, ds.updated_at,
              to_char(fa.scheduled_at,'YYYY-MM-DD"T"HH24:MI') AS follow_up_at, fs.full_name AS follow_up_doctor
         FROM discharge_summaries ds LEFT JOIN appointments fa ON fa.id=ds.follow_up_appointment_id LEFT JOIN staff fs ON fs.id=fa.doctor_id WHERE ds.admission_id=$1`, [id])).rows[0] ?? null;
    // suggestions to pre-fill a new summary
    const meds = (await db.query(`SELECT m.name || ' ' || m.strength || ' - ' || pi.dosage AS line FROM prescription_items pi JOIN prescriptions rx ON rx.id=pi.prescription_id JOIN medications m ON m.id=pi.medication_id
        WHERE rx.patient_id=$1 AND rx.status='Active' ORDER BY pi.id`, [adm.patient_id])).rows.map((x: any) => x.line);
    const dx = (await db.query(`SELECT i.description || ' (' || i.code || ')' AS line FROM consultation_diagnoses d JOIN consultations c ON c.id=d.consultation_id JOIN icd10_codes i ON i.code=d.icd_code
        WHERE c.patient_id=$1 AND c.status='Signed' AND d.is_primary ORDER BY c.signed_at DESC LIMIT 3`, [adm.patient_id])).rows.map((x: any) => x.line);
    res.json({ admission: adm, summary, suggestions: { medications: meds.join('\n'), diagnosis: dx.join('; ') } });
  });

  r.put('/admissions/:id/discharge-summary', requirePermission('discharge.write'), async (req, res) => {
    const id = intParam(req.params.id);
    const adm = await loadAdmission(req, id);
    const b = parse(z.object({
      diagnosis: z.string().trim().min(2).max(500), hospital_course: z.string().max(4000).default(''), discharge_medications: z.string().max(2000).default(''),
      instructions: z.string().max(2000).default(''), follow_up_appointment_id: z.number().int().positive().nullable().optional(),
    }), req.body);
    if (b.follow_up_appointment_id) {
      const fa = (await db.query('SELECT patient_id, status FROM appointments WHERE id=$1', [b.follow_up_appointment_id])).rows[0];
      if (!fa || fa.patient_id !== adm.patient_id) throw new HttpError(400, 'Follow-up appointment must belong to the same patient');
      if (['Cancelled', 'No-show'].includes(fa.status)) throw new HttpError(400, 'Follow-up appointment is not active');
    }
    await db.query(
      `INSERT INTO discharge_summaries(admission_id,diagnosis,hospital_course,discharge_medications,instructions,follow_up_appointment_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (admission_id) DO UPDATE SET diagnosis=EXCLUDED.diagnosis, hospital_course=EXCLUDED.hospital_course, discharge_medications=EXCLUDED.discharge_medications,
         instructions=EXCLUDED.instructions, follow_up_appointment_id=EXCLUDED.follow_up_appointment_id, updated_at=now()`,
      [id, b.diagnosis, b.hospital_course, b.discharge_medications, b.instructions, b.follow_up_appointment_id ?? null, req.user!.id]);
    await audit(db, req, 'discharge_summary_save', 'admission', id);
    res.json({ ok: true });
  });

  /** Books the follow-up with the attending doctor and links it to the discharge summary. */
  r.post('/admissions/:id/follow-up', requirePermission('discharge.write'), async (req, res) => {
    const id = intParam(req.params.id);
    const adm = await loadAdmission(req, id);
    const b = parse(z.object({ scheduled_at: localDateTime, duration_min: z.number().int().min(5).max(240).default(30), reason: z.string().max(200).default('Post-discharge follow-up') }), req.body);
    if (new Date(b.scheduled_at) < new Date(Date.now() - 5 * 60_000)) throw new HttpError(400, 'Appointments cannot be scheduled in the past');
    if (await hasConflict(db, adm.doctor_id, b.scheduled_at, b.duration_min)) throw new HttpError(409, 'The doctor already has an appointment in that time slot');
    const dept = (await db.query('SELECT department_id FROM staff WHERE id=$1', [adm.doctor_id])).rows[0].department_id;
    const apptId = await db.tx(async (t) => {
      const a = (await t.query('INSERT INTO appointments(patient_id,doctor_id,department_id,scheduled_at,duration_min,reason) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [adm.patient_id, adm.doctor_id, dept, b.scheduled_at, b.duration_min, b.reason])).rows[0].id;
      await t.query(`INSERT INTO discharge_summaries(admission_id,created_by,follow_up_appointment_id) VALUES ($1,$2,$3)
        ON CONFLICT (admission_id) DO UPDATE SET follow_up_appointment_id=EXCLUDED.follow_up_appointment_id, updated_at=now()`, [id, req.user!.id, a]);
      return a as number;
    });
    await audit(db, req, 'appointment_create', 'appointment', apptId);
    res.status(201).json({ appointment_id: apptId });
  });

  r.get('/admissions/:id/discharge-summary/pdf', requirePermission('discharge.read'), async (req, res) => {
    const id = intParam(req.params.id);
    const adm = await loadAdmission(req, id);
    const ds = (await db.query(
      `SELECT ds.diagnosis, ds.hospital_course, ds.discharge_medications, ds.instructions, to_char(fa.scheduled_at,'Dy DD Mon YYYY "at" HH24:MI') AS follow_up_at, fs.full_name AS follow_up_doctor, d.name AS follow_up_dept
         FROM discharge_summaries ds LEFT JOIN appointments fa ON fa.id=ds.follow_up_appointment_id LEFT JOIN staff fs ON fs.id=fa.doctor_id LEFT JOIN departments d ON d.id=fa.department_id WHERE ds.admission_id=$1`, [id])).rows[0];
    if (!ds || !ds.diagnosis) throw new HttpError(404, 'No discharge summary has been written for this admission');
    const allergies = (await db.query('SELECT allergen, severity FROM patient_allergies WHERE patient_id=$1 ORDER BY id', [adm.patient_id])).rows.map((a: any) => `${a.allergen} (${a.severity})`).join(', ');
    const fmt = (v: unknown) => (v ? new Date(v as string).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '-');
    const pdf = buildPdf({
      title: 'Discharge Summary', subtitle: `${adm.first_name} ${adm.last_name}  |  MRN ${adm.mrn}  |  SYNTHETIC RECORD`,
      blocks: [
        { type: 'heading', text: 'Patient and admission' },
        { type: 'kv', rows: [['Patient', `${adm.first_name} ${adm.last_name}`], ['MRN', adm.mrn], ['Date of birth', String(adm.dob).slice(0, 10)], ['Sex', adm.sex],
          ['Ward / bed', `${adm.ward} / ${adm.bed}`], ['Attending doctor', adm.doctor], ['Admitted', fmt(adm.admitted_at)], ['Discharged', adm.discharged_at ? fmt(adm.discharged_at) : 'Not yet discharged'],
          ['Reason for admission', adm.reason], ['Known allergies', allergies || 'None recorded']] },
        { type: 'heading', text: 'Diagnosis' }, { type: 'paragraph', text: ds.diagnosis },
        { type: 'heading', text: 'Hospital course' }, { type: 'paragraph', text: ds.hospital_course || 'Not recorded.' },
        { type: 'heading', text: 'Medications on discharge' }, { type: 'paragraph', text: ds.discharge_medications || 'None.' },
        { type: 'heading', text: 'Instructions for the patient' }, { type: 'paragraph', text: ds.instructions || 'None.' },
        { type: 'heading', text: 'Follow-up appointment' },
        { type: 'paragraph', text: ds.follow_up_at ? `${ds.follow_up_at} with ${ds.follow_up_doctor} (${ds.follow_up_dept})` : 'No follow-up appointment booked.' },
      ],
    });
    await audit(db, req, 'discharge_summary_pdf', 'admission', id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="discharge-${adm.mrn}.pdf"`);
    res.send(pdf);
  });

  // ================= triage / emergency queue =================
  const TRIAGE_SELECT = `SELECT t.id, t.patient_id, t.complaint, t.esi_level, t.status, t.arrived_at, t.started_at, t.completed_at, t.notes, t.heart_rate, t.systolic, t.spo2,
      p.first_name || ' ' || p.last_name AS patient, p.mrn, p.dob, p.sex, s.full_name AS doctor, t.assigned_doctor_id,
      round(extract(epoch FROM (COALESCE(t.started_at, now()) - t.arrived_at)) / 60)::int AS wait_minutes
    FROM triage_entries t JOIN patients p ON p.id=t.patient_id LEFT JOIN staff s ON s.id=t.assigned_doctor_id`;

  r.get('/triage', requirePermission('triage.read'), async (req, res) => {
    const all = req.query.status === 'all';
    const rows = (await db.query(`${TRIAGE_SELECT} ${all ? "WHERE t.arrived_at > now() - interval '3 days'" : "WHERE t.status IN ('Waiting','In treatment')"}
        ORDER BY CASE t.status WHEN 'Waiting' THEN 0 WHEN 'In treatment' THEN 1 ELSE 2 END, t.esi_level, t.arrived_at LIMIT 200`)).rows;
    const waiting = rows.filter((x: any) => x.status === 'Waiting');
    const byLevel: Record<number, number> = {};
    for (const w of waiting) byLevel[w.esi_level] = (byLevel[w.esi_level] ?? 0) + 1;
    res.json({
      data: rows,
      stats: { waiting: waiting.length, inTreatment: rows.filter((x: any) => x.status === 'In treatment').length, byLevel,
        longestWaitMinutes: waiting.reduce((m: number, w: any) => Math.max(m, w.wait_minutes), 0) },
    });
  });

  r.post('/triage', requirePermission('triage.write'), async (req, res) => {
    const b = parse(z.object({
      patient_id: z.number().int().positive(), complaint: z.string().trim().min(2).max(200), esi_level: z.number().int().min(1).max(5),
      heart_rate: z.number().int().min(20).max(250).nullish(), systolic: z.number().int().min(40).max(300).nullish(), spo2: z.number().int().min(50).max(100).nullish(),
      notes: z.string().max(300).default(''),
    }), req.body);
    const pat = (await db.query('SELECT status, first_name, last_name FROM patients WHERE id=$1', [b.patient_id])).rows[0];
    if (!pat) throw new HttpError(400, 'Patient not found');
    if (pat.status !== 'Active') throw new HttpError(409, 'Patient record is not active');
    try {
      const { rows } = await db.query('INSERT INTO triage_entries(patient_id,complaint,esi_level,heart_rate,systolic,spo2,notes,triaged_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [b.patient_id, b.complaint, b.esi_level, b.heart_rate ?? null, b.systolic ?? null, b.spo2 ?? null, b.notes, req.user!.id]);
      if (b.esi_level === 1) {
        await notifyRoles(db, ['doctor', 'nurse', 'administrator'], { kind: 'triage_resus', severity: 'critical', title: 'ESI 1 arrival: immediate resuscitation', body: b.complaint, link: '/triage', dedupeKey: `triage:${rows[0].id}` });
      }
      emitLive('triage', `New arrival in the emergency queue (ESI ${b.esi_level})`);
      await audit(db, req, 'triage_register', 'triage', rows[0].id, `esi=${b.esi_level}`);
      res.status(201).json({ id: rows[0].id });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'This patient is already in the emergency queue');
      throw e;
    }
  });

  r.patch('/triage/:id', requirePermission('triage.write'), async (req, res) => {
    const id = intParam(req.params.id);
    const b = parse(z.object({ esi_level: z.number().int().min(1).max(5).optional(), complaint: z.string().trim().min(2).max(200).optional(), notes: z.string().max(300).optional() }).strict(), req.body);
    const cur = (await db.query('SELECT status FROM triage_entries WHERE id=$1', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'Triage entry not found');
    if (cur.status !== 'Waiting') throw new HttpError(409, 'Only waiting patients can be re-triaged');
    const cols = Object.entries(b).filter(([, v]) => v !== undefined);
    if (!cols.length) throw new HttpError(400, 'No fields to update');
    await db.query(`UPDATE triage_entries SET ${cols.map(([k], i) => `${k}=$${i + 2}`).join(', ')} WHERE id=$1`, [id, ...cols.map(([, v]) => v)]);
    await audit(db, req, 'triage_update', 'triage', id);
    res.json({ ok: true });
  });

  r.post('/triage/:id/start', requirePermission('triage.treat'), async (req, res) => {
    const id = intParam(req.params.id);
    const b = parse(z.object({ doctor_id: z.number().int().positive().optional() }), req.body);
    const doctorId = req.user!.role === 'doctor' ? req.user!.staffId : b.doctor_id;
    if (!doctorId || !(await db.query("SELECT 1 FROM staff WHERE id=$1 AND staff_code LIKE 'DOC-%'", [doctorId])).rows.length) throw new HttpError(400, 'A treating doctor is required');
    const cur = (await db.query('SELECT status FROM triage_entries WHERE id=$1', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'Triage entry not found');
    if (cur.status !== 'Waiting') throw new HttpError(409, `Patient is ${cur.status.toLowerCase()}`);
    const upd = await db.query("UPDATE triage_entries SET status='In treatment', started_at=now(), assigned_doctor_id=$2 WHERE id=$1 AND status='Waiting' RETURNING id", [id, doctorId]);
    if (!upd.rows.length) throw new HttpError(409, 'Patient was just taken by someone else');
    await audit(db, req, 'triage_start', 'triage', id);
    res.json({ ok: true });
  });

  r.post('/triage/:id/complete', requirePermission('triage.treat'), async (req, res) => {
    const id = intParam(req.params.id);
    const upd = await db.query("UPDATE triage_entries SET status='Completed', completed_at=now() WHERE id=$1 AND status='In treatment' RETURNING id", [id]);
    if (!upd.rows.length) {
      if (!(await db.query('SELECT 1 FROM triage_entries WHERE id=$1', [id])).rows.length) throw new HttpError(404, 'Triage entry not found');
      throw new HttpError(409, 'Only patients in treatment can be completed');
    }
    await audit(db, req, 'triage_complete', 'triage', id);
    res.json({ ok: true });
  });

  r.post('/triage/:id/leave', requirePermission('triage.write'), async (req, res) => {
    const id = intParam(req.params.id);
    const upd = await db.query("UPDATE triage_entries SET status='Left without being seen', completed_at=now() WHERE id=$1 AND status='Waiting' RETURNING id", [id]);
    if (!upd.rows.length) {
      if (!(await db.query('SELECT 1 FROM triage_entries WHERE id=$1', [id])).rows.length) throw new HttpError(404, 'Triage entry not found');
      throw new HttpError(409, 'Only waiting patients can be marked as left');
    }
    await audit(db, req, 'triage_leave', 'triage', id);
    res.json({ ok: true });
  });

  return r;
}
