import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { as, makeLab, type Lab } from './helpers.js';

let lab: Lab;
beforeAll(async () => { lab = await makeLab('secure'); });
afterAll(async () => { await lab.db.close(); });

const q = async <T = any>(sql: string, params: unknown[] = []) => (await lab.db.query<T>(sql, params)).rows;
const staff = async (code: string) => (await q('SELECT id FROM staff WHERE staff_code=$1', [code]))[0].id as number;
const med = async (code: string) => (await q('SELECT id FROM medications WHERE code=$1', [code]))[0].id as number;

/** A brand-new patient whose primary doctor is the given staff member and who is linked to nobody else. */
async function newPatient(doctorStaffId: number | null, extra: Record<string, unknown> = {}) {
  const c = await as(lab, 'receptionist.lindqvist');
  const r = await c.post('/api/patients', { first_name: 'Test', last_name: `Case${Math.floor(Math.random() * 1e6)}`, dob: '1980-05-05', sex: 'Female', primary_doctor_id: doctorStaffId, ...extra });
  expect(r.status).toBe(201);
  return r.body.id as number;
}

describe('consultations', () => {
  it('walks a draft through SOAP, diagnoses, orders and signing, then locks it', async () => {
    const mehta = await staff('DOC-001');
    const pid = await newPatient(mehta);
    const doc = await as(lab, 'doctor.mehta');

    const icd = await doc.get('/api/icd10?q=hypertens');
    expect(icd.status).toBe(200);
    expect(icd.body.data.map((x: any) => x.code)).toContain('I10');
    expect((await doc.get('/api/icd10?q=h')).body.data).toEqual([]); // too short

    const created = await doc.post('/api/consultations', { patient_id: pid });
    expect(created.status).toBe(201);
    const id = created.body.id;

    expect((await doc.patch(`/api/consultations/${id}`, { subjective: 'Headache for 3 days', objective: 'BP 150/95', plan: 'Recheck in 2 weeks' })).status).toBe(200);
    expect((await doc.patch(`/api/consultations/${id}`, { status: 'Signed' })).status).toBe(400); // strict schema: status cannot be forced
    expect((await doc.post(`/api/consultations/${id}/sign`)).status).toBe(409); // no assessment / diagnosis yet

    await doc.patch(`/api/consultations/${id}`, { assessment: 'Likely hypertension' });
    expect((await doc.post(`/api/consultations/${id}/sign`)).status).toBe(409); // still no primary diagnosis
    expect((await doc.put(`/api/consultations/${id}/diagnoses`, { diagnoses: [{ icd_code: 'NOPE', is_primary: true }] })).status).toBe(400);
    expect((await doc.put(`/api/consultations/${id}/diagnoses`, { diagnoses: [{ icd_code: 'I10', is_primary: true }, { icd_code: 'E11.9', is_primary: true }] })).status).toBe(400);
    expect((await doc.put(`/api/consultations/${id}/diagnoses`, { diagnoses: [{ icd_code: 'I10', is_primary: true }, { icd_code: 'E78.5' }] })).status).toBe(200);

    const labTest = (await q('SELECT id FROM laboratory_tests ORDER BY id LIMIT 1'))[0].id;
    const orders = await doc.post(`/api/consultations/${id}/lab-orders`, { test_ids: [labTest] });
    expect(orders.status).toBe(201);
    expect(orders.body.ids).toHaveLength(1);
    const rx = await doc.post(`/api/consultations/${id}/prescriptions`, { items: [{ medication_id: await med('AMD5'), quantity: 30, dosage: '1 tablet once daily' }], refills_allowed: 1 });
    expect(rx.status).toBe(201);

    const signed = await doc.post(`/api/consultations/${id}/sign`);
    expect(signed.status).toBe(200);

    const detail = (await doc.get(`/api/consultations/${id}`)).body;
    expect(detail.status).toBe('Signed');
    expect(detail.diagnoses.map((d: any) => d.code).sort()).toEqual(['E78.5', 'I10']);
    expect(detail.lab_orders).toHaveLength(1);
    expect(detail.prescriptions).toHaveLength(1);
    // the primary diagnosis lands on the problem list
    expect((await q("SELECT 1 FROM medical_histories WHERE patient_id=$1 AND condition LIKE '%(I10)'", [pid])).length).toBe(1);

    // locked after signing
    expect((await doc.patch(`/api/consultations/${id}`, { plan: 'changed' })).status).toBe(409);
    expect((await doc.put(`/api/consultations/${id}/diagnoses`, { diagnoses: [] })).status).toBe(409);
    expect((await doc.post(`/api/consultations/${id}/lab-orders`, { test_ids: [labTest] })).status).toBe(409);
    expect((await doc.post(`/api/consultations/${id}/sign`)).status).toBe(409);
  });

  it('enforces authorship and care-team scope', async () => {
    const mehta = await staff('DOC-001');
    const pid = await newPatient(mehta);
    const mehtaC = await as(lab, 'doctor.mehta');
    const id = (await mehtaC.post('/api/consultations', { patient_id: pid })).body.id;

    const sven = await as(lab, 'doctor.svensson');
    expect((await sven.get(`/api/consultations/${id}`)).status).toBe(404); // not on the care team
    expect((await sven.post('/api/consultations', { patient_id: pid })).status).toBe(404);
    expect((await sven.patch(`/api/consultations/${id}`, { plan: 'x' })).status).toBe(404);

    const rec = await as(lab, 'receptionist.lindqvist');
    expect((await rec.get('/api/consultations')).status).toBe(403);
    expect((await rec.get('/api/icd10?q=asthma')).status).toBe(403);
    const nurse = await as(lab, 'nurse.okafor');
    expect((await nurse.post('/api/consultations', { patient_id: pid })).status).toBe(403); // read-only role
    expect((await request(lab.app).get('/api/consultations')).status).toBe(401);

    // admin can read but never author
    const admin = await as(lab, 'admin.hartley');
    expect((await admin.get(`/api/consultations/${id}`)).status).toBe(200);
    expect((await admin.patch(`/api/consultations/${id}`, { plan: 'x' })).status).toBe(403);
  });

  it('links to an appointment, moves it through the clinic flow and is idempotent per appointment', async () => {
    const mehta = await staff('DOC-001');
    const pid = await newPatient(mehta);
    const dept = (await q('SELECT department_id FROM staff WHERE id=$1', [mehta]))[0].department_id;
    const appt = (await q("INSERT INTO appointments(patient_id,doctor_id,department_id,scheduled_at,status) VALUES ($1,$2,$3, now() + interval '3 days', 'Scheduled') RETURNING id", [pid, mehta, dept]))[0].id;
    const doc = await as(lab, 'doctor.mehta');
    const first = await doc.post('/api/consultations', { patient_id: pid, appointment_id: appt });
    expect(first.status).toBe(201);
    expect((await q('SELECT status FROM appointments WHERE id=$1', [appt]))[0].status).toBe('In consultation');
    const again = await doc.post('/api/consultations', { patient_id: pid, appointment_id: appt });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: first.body.id, existing: true });
    await doc.patch(`/api/consultations/${first.body.id}`, { assessment: 'Stable' });
    await doc.put(`/api/consultations/${first.body.id}/diagnoses`, { diagnoses: [{ icd_code: 'Z00.00', is_primary: true }] });
    expect((await doc.post(`/api/consultations/${first.body.id}/sign`)).status).toBe(200);
    expect((await q('SELECT status FROM appointments WHERE id=$1', [appt]))[0].status).toBe('Completed');
    // someone else's appointment or the wrong patient is not accepted
    const other = (await q("SELECT id, patient_id FROM appointments WHERE doctor_id <> $1 LIMIT 1", [mehta]))[0];
    expect((await doc.post('/api/consultations', { patient_id: pid, appointment_id: other.id })).status).toBe(404);
  });
});

describe('prescribing safety checks', () => {
  async function setup(extraAllergy?: [string, string, string]) {
    const mehta = await staff('DOC-001');
    const pid = await newPatient(mehta);
    if (extraAllergy) await q('INSERT INTO patient_allergies(patient_id,allergen,reaction,severity) VALUES ($1,$2,$3,$4)', [pid, ...extraAllergy]);
    return { pid, doc: await as(lab, 'doctor.mehta') };
  }
  const item = async (code: string, extra: Record<string, unknown> = {}) => ({ medication_id: await med(code), quantity: 10, dosage: '1 tablet twice daily', ...extra });

  it('blocks a severe allergy (including class cross-reactivity) unless a documented override is given', async () => {
    const { pid, doc } = await setup(['Penicillin', 'Anaphylaxis', 'Severe']);
    const body = { patient_id: pid, items: [await item('AMX500')] };
    const chk = await doc.post('/api/pharmacy/prescriptions/check', body);
    expect(chk.status).toBe(200);
    expect(chk.body.blocked).toBe(true);
    expect(chk.body.warnings[0]).toMatchObject({ type: 'allergy', severity: 'Major', blocking: true });
    expect((await q('SELECT count(*)::int AS n FROM prescriptions WHERE patient_id=$1', [pid]))[0].n).toBe(0); // dry run creates nothing

    const blocked = await doc.post('/api/pharmacy/prescriptions', body);
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.warnings[0].type).toBe('allergy');
    expect((await doc.post('/api/pharmacy/prescriptions', { ...body, override_reason: 'too short' })).status).toBe(409);
    const ok = await doc.post('/api/pharmacy/prescriptions', { ...body, override_reason: 'Allergy history unreliable; test dose supervised' });
    expect(ok.status).toBe(201);
    const row = (await q('SELECT override_reason FROM prescriptions WHERE id=$1', [ok.body.id]))[0];
    expect(row.override_reason).toMatch(/supervised/);
    expect((await q("SELECT 1 FROM audit_events WHERE action='prescription_override' AND entity_id=$1", [String(ok.body.id)])).length).toBe(1);
  });

  it('treats an aspirin allergy as an NSAID cross-reaction and a mild allergy as a non-blocking warning', async () => {
    const a = await setup(['Aspirin', 'Bronchospasm', 'Severe']);
    const r1 = await a.doc.post('/api/pharmacy/prescriptions/check', { patient_id: a.pid, items: [await item('IBU400')] });
    expect(r1.body.blocked).toBe(true);
    const b = await setup(['Ibuprofen', 'GI upset', 'Mild']);
    const r2 = await b.doc.post('/api/pharmacy/prescriptions', { patient_id: b.pid, items: [await item('IBU400')] });
    expect(r2.status).toBe(201);
    expect(r2.body.warnings[0]).toMatchObject({ type: 'allergy', severity: 'Minor', blocking: false });
  });

  it('blocks major interactions with a current prescription, but only warns on minor ones', async () => {
    const { pid, doc } = await setup();
    expect((await doc.post('/api/pharmacy/prescriptions', { patient_id: pid, items: [await item('WAR5')] })).status).toBe(201);
    const major = await doc.post('/api/pharmacy/prescriptions', { patient_id: pid, items: [await item('IBU400')] });
    expect(major.status).toBe(409);
    expect(major.body.details.warnings.some((w: any) => w.type === 'interaction' && w.severity === 'Major' && /already prescribed/.test(w.message))).toBe(true);
    const minor = await doc.post('/api/pharmacy/prescriptions', { patient_id: pid, items: [await item('PAR500')] });
    expect(minor.status).toBe(201);
    expect(minor.body.warnings.some((w: any) => w.type === 'interaction' && w.severity === 'Minor' && !w.blocking)).toBe(true);
    // two interacting drugs inside the same prescription are caught too
    const p2 = await setup();
    const both = await p2.doc.post('/api/pharmacy/prescriptions', { patient_id: p2.pid, items: [await item('WAR5'), await item('CLO75')] });
    expect(both.status).toBe(409);
  });

  it('enforces the maximum daily dose and flags duplicates and low stock', async () => {
    const { pid, doc } = await setup();
    const over = await doc.post('/api/pharmacy/prescriptions', { patient_id: pid, items: [await item('PAR500', { units_per_dose: 3, doses_per_day: 4 })] });
    expect(over.status).toBe(409);
    expect(over.body.details.warnings[0]).toMatchObject({ type: 'dose', blocking: true });
    const fine = await doc.post('/api/pharmacy/prescriptions', { patient_id: pid, items: [await item('PAR500', { units_per_dose: 2, doses_per_day: 4 })] });
    expect(fine.status).toBe(201);
    const dup = await doc.post('/api/pharmacy/prescriptions/check', { patient_id: pid, items: [await item('PAR500')] });
    expect(dup.body.warnings.some((w: any) => w.type === 'duplicate')).toBe(true);
    const stock = await doc.post('/api/pharmacy/prescriptions/check', { patient_id: pid, items: [await item('SER50', { quantity: 500 })] });
    expect(stock.body.warnings.some((w: any) => w.type === 'stock' && !w.blocking)).toBe(true);
    expect((await doc.post('/api/pharmacy/prescriptions', { patient_id: pid, items: [{ ...(await item('SER50')), units_per_dose: 99 }] })).status).toBe(400);
  });

  it('dispenses and refills with a stock ledger, and refuses refills that are not allowed', async () => {
    const { pid, doc } = await setup();
    const rx = (await doc.post('/api/pharmacy/prescriptions', { patient_id: pid, refills_allowed: 2, items: [await item('CET10', { quantity: 20 })] })).body.id;
    const ph = await as(lab, 'pharmacist.rossi');
    const stock0 = (await q('SELECT stock FROM medications WHERE code=$1', ['CET10']))[0].stock;
    expect((await ph.post(`/api/pharmacy/prescriptions/${rx}/refill`)).status).toBe(409); // nothing dispensed yet
    expect((await ph.post(`/api/pharmacy/prescriptions/${rx}/dispense`)).status).toBe(200);
    expect((await q('SELECT status, dispensing_status FROM prescriptions WHERE id=$1', [rx]))[0]).toEqual({ status: 'Active', dispensing_status: 'Dispensed' });
    expect((await ph.post(`/api/pharmacy/prescriptions/${rx}/dispense`)).status).toBe(409);
    const r1 = await ph.post(`/api/pharmacy/prescriptions/${rx}/refill`);
    expect(r1.body).toMatchObject({ refills_used: 1, refills_remaining: 1 });
    const r2 = await ph.post(`/api/pharmacy/prescriptions/${rx}/refill`);
    expect(r2.body).toMatchObject({ refills_used: 2, refills_remaining: 0 });
    expect((await q('SELECT status FROM prescriptions WHERE id=$1', [rx]))[0].status).toBe('Completed');
    expect((await ph.post(`/api/pharmacy/prescriptions/${rx}/refill`)).status).toBe(409);
    expect((await q('SELECT stock FROM medications WHERE code=$1', ['CET10']))[0].stock).toBe(stock0 - 60);
    const ledger = await q("SELECT reason, delta FROM stock_movements WHERE note=$1 ORDER BY id", [`Prescription #${rx}`]);
    expect(ledger.map((x: any) => x.reason)).toEqual(['Dispense', 'Refill', 'Refill']);
    expect(ledger.every((x: any) => x.delta === -20)).toBe(true);
    // a prescription without refills completes on first dispense and cannot be refilled
    const one = (await doc.post('/api/pharmacy/prescriptions', { patient_id: pid, items: [await item('LEV50')] })).body.id;
    await ph.post(`/api/pharmacy/prescriptions/${one}/dispense`);
    expect((await q('SELECT status FROM prescriptions WHERE id=$1', [one]))[0].status).toBe('Completed');
    expect((await ph.post(`/api/pharmacy/prescriptions/${one}/refill`)).status).toBe(409);
    // roles
    expect((await doc.post(`/api/pharmacy/prescriptions/${rx}/refill`)).status).toBe(403);
    expect((await ph.post('/api/pharmacy/prescriptions/check', { patient_id: pid, items: [await item('LEV50')] })).status).toBe(403);
    expect((await doc.post('/api/pharmacy/prescriptions', { patient_id: pid, refills_allowed: 9, items: [await item('LEV50')] })).status).toBe(400);
  });
});

describe('vitals trend', () => {
  it('records readings, flags abnormal and critical values and alerts the doctor', async () => {
    const mehta = await staff('DOC-001');
    const pid = await newPatient(mehta, { dob: '1975-01-01' });
    const nurse = await as(lab, 'nurse.okafor');
    const admin = await as(lab, 'admin.hartley');
    const good = { systolic: 118, diastolic: 76, heart_rate: 72, temperature_c: 36.8, spo2: 98, weight_kg: 70 };
    expect((await admin.post(`/api/patients/${pid}/vitals`, good)).status).toBe(201);
    const bad = await admin.post(`/api/patients/${pid}/vitals`, { ...good, systolic: 190, diastolic: 100, spo2: 88 });
    expect(bad.status).toBe(201);
    expect(bad.body.flags).toMatchObject({ systolic: 'critical-high', spo2: 'critical-low', diastolic: 'high', heart_rate: null });
    expect((await admin.post(`/api/patients/${pid}/vitals`, { ...good, systolic: 80, diastolic: 90 })).status).toBe(400);
    expect((await admin.post(`/api/patients/${pid}/vitals`, { ...good, spo2: 140 })).status).toBe(400);
    expect((await admin.post(`/api/patients/${pid}/vitals`, { ...good, recorded_at: '2999-01-01T10:00' })).status).toBe(400);
    expect((await nurse.post(`/api/patients/${pid}/vitals`, good)).status).toBe(404); // outside the nurse's department scope

    const trend = await (await as(lab, 'doctor.mehta')).get(`/api/patients/${pid}/vitals/trend`);
    expect(trend.status).toBe(200);
    expect(trend.body.data).toHaveLength(2);
    expect(trend.body.abnormalCount).toBe(1);
    expect(trend.body.data[0].recorded_at <= trend.body.data[1].recorded_at).toBe(true); // oldest first for charting
    expect(trend.body.ranges.systolic).toEqual({ lo: 90, hi: 139 });
    const doctorUser = (await q("SELECT id FROM users WHERE username='doctor.mehta'"))[0].id;
    const notes = await q("SELECT title, severity FROM notifications WHERE user_id=$1 AND kind='vitals_critical' AND body LIKE '%systolic%'", [doctorUser]);
    expect(notes[0]).toMatchObject({ title: 'Critical vital signs', severity: 'critical' });
    expect((await (await as(lab, 'receptionist.lindqvist')).get(`/api/patients/${pid}/vitals/trend`)).status).toBe(403);
  });
});

describe('medication administration record', () => {
  async function wardAdmission(ward: string) {
    return (await q(`SELECT a.id, a.patient_id FROM admissions a JOIN beds b ON b.id=a.bed_id JOIN wards w ON w.id=b.ward_id
        WHERE a.status='Admitted' AND w.name=$1 AND EXISTS (SELECT 1 FROM prescription_items pi JOIN prescriptions rx ON rx.id=pi.prescription_id WHERE rx.patient_id=a.patient_id AND rx.status='Active') ORDER BY a.id LIMIT 1`, [ward]))[0];
  }
  const itemFor = async (patientId: number) => (await q("SELECT pi.id FROM prescription_items pi JOIN prescriptions rx ON rx.id=pi.prescription_id WHERE rx.patient_id=$1 AND rx.status='Active' ORDER BY pi.id LIMIT 1", [patientId]))[0].id as number;

  it('shows each nurse only the doses of their own department and supports the seeded schedule', async () => {
    const nurse = await as(lab, 'nurse.okafor');
    const mar = await nurse.get('/api/mar');
    expect(mar.status).toBe(200);
    expect(mar.body.data.length).toBeGreaterThan(0);
    expect(new Set(mar.body.data.map((d: any) => d.ward))).toEqual(new Set(['General Ward B']));
    const yesterday = new Date(Date.now() - 86400000);
    const ymd = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    expect((await nurse.get(`/api/mar?date=${ymd}`)).body.counts.Given).toBeGreaterThan(0);
    expect((await (await as(lab, 'receptionist.lindqvist')).get('/api/mar')).status).toBe(403);
  });

  it('schedules doses, records them once, and refuses out-of-scope or incomplete updates', async () => {
    const adm = await wardAdmission('General Ward B');
    const item = await itemFor(adm.patient_id);
    const admin = await as(lab, 'admin.hartley');
    const date = '2031-03-15';
    expect((await admin.post('/api/mar/schedule', { admission_id: adm.id, prescription_item_id: item, times: ['08:00', '08:00', '20:00'], days: 2, start_date: date })).body.created).toBe(4);
    expect((await admin.post('/api/mar/schedule', { admission_id: adm.id, prescription_item_id: item, times: ['08:00'], days: 1, start_date: date })).body.created).toBe(0); // idempotent
    expect((await admin.post('/api/mar/schedule', { admission_id: adm.id, prescription_item_id: 999999, times: ['08:00'] })).status).toBe(400);
    expect((await admin.post('/api/mar/schedule', { admission_id: adm.id, prescription_item_id: item, times: ['25:00'] })).status).toBe(400);
    const other = (await q("SELECT pi.id FROM prescription_items pi JOIN prescriptions rx ON rx.id=pi.prescription_id WHERE rx.patient_id <> $1 LIMIT 1", [adm.patient_id]))[0].id;
    expect((await admin.post('/api/mar/schedule', { admission_id: adm.id, prescription_item_id: other, times: ['08:00'] })).status).toBe(400); // someone else's prescription

    const nurse = await as(lab, 'nurse.okafor');
    const day = await nurse.get(`/api/mar?date=${date}&admission_id=${adm.id}`);
    expect(day.body.data).toHaveLength(2);
    const dose = day.body.data[0];
    expect((await nurse.post(`/api/mar/${dose.id}/administer`, { status: 'Held' })).status).toBe(400); // a reason is required
    expect((await nurse.post(`/api/mar/${dose.id}/administer`, { status: 'Late' })).status).toBe(400);
    const given = await nurse.post(`/api/mar/${dose.id}/administer`, { status: 'Given' });
    expect(given.status).toBe(200);
    const row = (await q('SELECT status, administered_by, administered_at FROM mar_doses WHERE id=$1', [dose.id]))[0];
    expect(row.status).toBe('Given');
    expect(row.administered_by).toBe((await q("SELECT id FROM users WHERE username='nurse.okafor'"))[0].id);
    expect(row.administered_at).toBeTruthy();
    expect((await nurse.post(`/api/mar/${dose.id}/administer`, { status: 'Given' })).status).toBe(409); // cannot be changed afterwards
    const held = await nurse.post(`/api/mar/${day.body.data[1].id}/administer`, { status: 'Held', note: 'Patient nil by mouth' });
    expect(held.status).toBe(200);

    // a dose on a ward belonging to another department is invisible to this nurse
    const cardio = await wardAdmission('Cardiology Ward A');
    const cItem = await itemFor(cardio.patient_id);
    await admin.post('/api/mar/schedule', { admission_id: cardio.id, prescription_item_id: cItem, times: ['10:00'], days: 1, start_date: date });
    const cDose = (await q('SELECT id FROM mar_doses WHERE admission_id=$1 AND scheduled_at::date=$2::date', [cardio.id, date]))[0].id;
    expect((await nurse.post(`/api/mar/${cDose}/administer`, { status: 'Given' })).status).toBe(404);
    expect((await nurse.post('/api/mar/schedule', { admission_id: adm.id, prescription_item_id: item, times: ['09:00'] })).status).toBe(403); // nurses administer, doctors schedule
  });
});

describe('discharge summaries', () => {
  it('serves the seeded summary and a valid PDF with the follow-up appointment', async () => {
    const admin = await as(lab, 'admin.hartley');
    const adm = (await q("SELECT ad.id FROM admissions ad JOIN discharge_summaries ds ON ds.admission_id=ad.id WHERE ds.follow_up_appointment_id IS NOT NULL ORDER BY ad.id LIMIT 1"))[0].id;
    const body = (await admin.get(`/api/admissions/${adm}/discharge-summary`)).body;
    expect(body.summary.diagnosis).toBeTruthy();
    expect(body.summary.follow_up_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    const pdf = await admin.get(`/api/admissions/${adm}/discharge-summary/pdf`).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toMatch(/attachment; filename="discharge-SYN-\d+\.pdf"/);
    const text = (pdf.body as Buffer).toString('latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text).toContain('Discharge Summary');
    expect(text).toContain('Follow-up appointment');
  });

  it('creates a summary, books a follow-up, and respects doctor ownership', async () => {
    const admin = await as(lab, 'admin.hartley');
    const adm = (await q("SELECT ad.id, ad.patient_id, ad.doctor_id FROM admissions ad WHERE ad.status='Discharged' AND NOT EXISTS (SELECT 1 FROM discharge_summaries ds WHERE ds.admission_id=ad.id) ORDER BY ad.id LIMIT 1"))[0];
    expect((await admin.get(`/api/admissions/${adm.id}/discharge-summary/pdf`)).status).toBe(404); // nothing written yet
    const empty = await admin.get(`/api/admissions/${adm.id}/discharge-summary`);
    expect(empty.body.summary).toBeNull();
    const put = await admin.put(`/api/admissions/${adm.id}/discharge-summary`, { diagnosis: 'Community-acquired pneumonia', hospital_course: 'Improved on antibiotics.', discharge_medications: 'Amoxicillin 500 mg three times daily', instructions: 'Rest and fluids.' });
    expect(put.status).toBe(200);
    const when = new Date(Date.now() + 20 * 86400000);
    const at = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}T17:00`;
    const fu = await admin.post(`/api/admissions/${adm.id}/follow-up`, { scheduled_at: at });
    expect(fu.status).toBe(201);
    expect((await admin.post(`/api/admissions/${adm.id}/follow-up`, { scheduled_at: at })).status).toBe(409); // doctor already booked
    expect((await admin.post(`/api/admissions/${adm.id}/follow-up`, { scheduled_at: '2001-01-01T10:00' })).status).toBe(400);
    const after = (await admin.get(`/api/admissions/${adm.id}/discharge-summary`)).body;
    expect(after.summary.follow_up_appointment_id).toBe(fu.body.appointment_id);
    expect(after.summary.diagnosis).toBe('Community-acquired pneumonia'); // booking did not wipe the text
    expect((await admin.put(`/api/admissions/${adm.id}/discharge-summary`, { diagnosis: 'x' })).status).toBe(400);
    const foreign = (await q("SELECT id FROM appointments WHERE patient_id <> $1 LIMIT 1", [adm.patient_id]))[0].id;
    expect((await admin.put(`/api/admissions/${adm.id}/discharge-summary`, { diagnosis: 'Pneumonia', follow_up_appointment_id: foreign })).status).toBe(400);

    // a doctor can only see summaries of their own patients
    const mehtaId = await staff('DOC-001');
    const notMine = (await q('SELECT id FROM admissions WHERE doctor_id <> $1 ORDER BY id LIMIT 1', [mehtaId]))[0].id;
    expect((await (await as(lab, 'doctor.mehta')).get(`/api/admissions/${notMine}/discharge-summary`)).status).toBe(404);
    expect((await (await as(lab, 'receptionist.lindqvist')).get(`/api/admissions/${adm.id}/discharge-summary`)).status).toBe(403);
    expect((await (await as(lab, 'nurse.okafor')).put(`/api/admissions/${adm.id}/discharge-summary`, { diagnosis: 'Pneumonia' })).status).toBe(403);
  });
});

describe('emergency triage queue', () => {
  async function freshPatients(n: number) {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) ids.push(await newPatient(null));
    return ids;
  }
  it('orders by acuity then arrival, rejects duplicates and manages the treatment lifecycle', async () => {
    await q("UPDATE triage_entries SET status='Completed', completed_at=now() WHERE status IN ('Waiting','In treatment')");
    const [a, b, c, d] = await freshPatients(4);
    const rec = await as(lab, 'receptionist.lindqvist');
    const t5 = (await rec.post('/api/triage', { patient_id: a, complaint: 'Sore throat', esi_level: 5 })).body.id;
    const t3 = (await rec.post('/api/triage', { patient_id: b, complaint: 'Abdominal pain', esi_level: 3 })).body.id;
    const t3b = (await rec.post('/api/triage', { patient_id: c, complaint: 'Fever and cough', esi_level: 3 })).body.id;
    expect((await rec.post('/api/triage', { patient_id: a, complaint: 'Again', esi_level: 4 })).status).toBe(409);
    expect((await rec.post('/api/triage', { patient_id: d, complaint: 'x', esi_level: 3 })).status).toBe(400);
    expect((await rec.post('/api/triage', { patient_id: d, complaint: 'Cough', esi_level: 6 })).status).toBe(400);
    expect((await rec.post('/api/triage', { patient_id: 999999, complaint: 'Cough', esi_level: 3 })).status).toBe(400);

    const queue = await rec.get('/api/triage');
    expect(queue.body.data.map((x: any) => x.id)).toEqual([t3, t3b, t5]);
    expect(queue.body.stats).toMatchObject({ waiting: 3, inTreatment: 0, byLevel: { 3: 2, 5: 1 } });

    expect((await rec.patch(`/api/triage/${t5}`, { esi_level: 2 })).status).toBe(200); // re-triage upwards
    expect((await rec.get('/api/triage')).body.data[0].id).toBe(t5);
    expect((await rec.post(`/api/triage/${t5}/start`)).status).toBe(403); // receptionists cannot start treatment

    const doc = await as(lab, 'doctor.mehta');
    expect((await doc.post(`/api/triage/${t5}/complete`)).status).toBe(409); // not in treatment yet
    expect((await doc.post(`/api/triage/${t5}/start`)).status).toBe(200);
    expect((await doc.post(`/api/triage/${t5}/start`)).status).toBe(409);
    expect((await rec.patch(`/api/triage/${t5}`, { esi_level: 1 })).status).toBe(409); // already in treatment
    const row = (await q('SELECT status, assigned_doctor_id, started_at FROM triage_entries WHERE id=$1', [t5]))[0];
    expect(row).toMatchObject({ status: 'In treatment', assigned_doctor_id: await staff('DOC-001') });
    expect(row.started_at).toBeTruthy();
    expect((await doc.post(`/api/triage/${t5}/complete`)).status).toBe(200);
    expect((await rec.post(`/api/triage/${t3}/leave`)).status).toBe(200);
    expect((await rec.post(`/api/triage/${t3}/leave`)).status).toBe(409);
    expect((await rec.post('/api/triage/999999/leave')).status).toBe(404);
    const done = await rec.post('/api/triage', { patient_id: a, complaint: 'Returned later', esi_level: 4 });
    expect(done.status).toBe(201); // a finished visit does not block a new one
    expect((await (await as(lab, 'billing.nakamura')).get('/api/triage')).status).toBe(403);
  });

  it('alerts clinicians immediately for an ESI 1 arrival', async () => {
    const [p] = await freshPatients(1);
    const nurse = await as(lab, 'nurse.okafor');
    expect((await nurse.post('/api/triage', { patient_id: p, complaint: 'Cardiac arrest', esi_level: 1, heart_rate: 40, systolic: 60 })).status).toBe(201);
    const doctorUser = (await q("SELECT id FROM users WHERE username='doctor.svensson'"))[0].id;
    const n = await q("SELECT severity, title FROM notifications WHERE user_id=$1 AND kind='triage_resus'", [doctorUser]);
    expect(n.length).toBeGreaterThanOrEqual(1);
    expect(n[0].severity).toBe('critical');
  });
});
