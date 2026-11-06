import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { as, Client, makeLab, type Lab } from './helpers.js';

let lab: Lab;
beforeAll(async () => { lab = await makeLab('secure'); });
afterAll(async () => { await lab.db.close(); });

const q = async <T = any>(sql: string, params: unknown[] = []) => (await lab.db.query<T>(sql, params)).rows;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const PATIENT = 5; // the seeded portal account is linked to this patient

/** First (date, time) with a free slot for the doctor, searching from `fromDay` days ahead. */
async function freeSlot(c: Client, doctorId: number, fromDay = 3) {
  for (let n = fromDay; n < fromDay + 40; n++) {
    const date = ymd(new Date(Date.now() + n * 86400000));
    const slots = (await c.get(`/api/portal/slots?doctor_id=${doctorId}&date=${date}`)).body.slots as { time: string; available: boolean }[];
    const s = slots?.find((x) => x.available);
    if (s) return { date, time: s.time };
  }
  throw new Error('no free slot found');
}

describe('patient portal: isolation', () => {
  it('lets a patient see their own record and nothing else', async () => {
    const p = await as(lab, 'patient.portal');
    const me = (await p.get('/api/portal/me')).body;
    expect(me.patient.id).toBe(PATIENT);
    expect(me.patient).not.toHaveProperty('ssn');
    expect(me.patient).not.toHaveProperty('insurance_policy_no');
    expect(me.nextAppointment).toBeTruthy();
    expect(me.balanceDue).toBeGreaterThan(0);

    // every staff-facing area refuses a patient account
    for (const url of ['/api/patients', `/api/patients/${PATIENT}`, '/api/appointments', '/api/invoices', '/api/laboratory/requests', '/api/pharmacy/prescriptions', '/api/dashboard',
      '/api/consultations', '/api/mar', '/api/triage', '/api/inventory', '/api/claims', '/api/payments', '/api/reports/summary', '/api/admin/users', '/api/staff', '/api/roster', '/api/leave', '/api/openapi.json', '/api/live/recent']) {
      const r = await p.get(url);
      expect([401, 403], `${url} -> ${r.status}`).toContain(r.status);
      expect(r.status, url).toBe(403);
    }
    expect((await p.get('/api/search?q=Ash')).body.groups).toEqual([]);
    expect((await p.get('/api/notifications')).status).toBe(200);
    // and staff cannot use the portal
    for (const u of ['admin.hartley', 'doctor.mehta', 'receptionist.lindqvist']) expect((await (await as(lab, u)).get('/api/portal/me')).status, u).toBe(403);
    expect((await request(lab.app).get('/api/portal/me')).status).toBe(401);
  });

  it('refuses a portal account that is not linked to a patient record', async () => {
    await q("INSERT INTO users(username,email,full_name,password_hash,role_id) SELECT 'orphan.portal','o@example.test','Orphan',password_hash,r.id FROM users u, roles r WHERE u.username='patient.portal' AND r.code='patient'");
    const pw = (await q("SELECT password_hash FROM users WHERE username='patient.portal'"))[0].password_hash;
    await q("UPDATE users SET password_hash=$1 WHERE username='orphan.portal'", [pw]);
    const c = new Client(lab);
    expect((await c.login('orphan.portal', 'LabPatient#2026')).status).toBe(200);
    expect((await c.get('/api/portal/me')).status).toBe(403);
    expect((await c.get('/api/portal/appointments')).status).toBe(403);
  });

  it('only releases approved results and only the patient\'s own invoices', async () => {
    const p = await as(lab, 'patient.portal');
    const results = (await p.get('/api/portal/results')).body;
    expect(results.data.length).toBeGreaterThanOrEqual(2);
    expect(results.data[0]).toHaveProperty('flag');
    // a freshly entered but unapproved result is never visible
    const req = (await q("INSERT INTO laboratory_requests(patient_id,test_id,ordering_doctor_id,status) VALUES ($1,3,1,'Resulted') RETURNING id", [PATIENT]))[0].id;
    await q("INSERT INTO laboratory_results(request_id,value,approved) VALUES ($1,'9.9',false)", [req]);
    const after = (await p.get('/api/portal/results')).body.data;
    expect(after.some((r: any) => r.value === '9.9')).toBe(false);
    expect(after).toHaveLength(results.data.length);
    // another patient's approved result stays private as well
    const otherReq = (await q("INSERT INTO laboratory_requests(patient_id,test_id,ordering_doctor_id,status) VALUES (6,3,1,'Approved') RETURNING id")) [0].id;
    await q("INSERT INTO laboratory_results(request_id,value,approved) VALUES ($1,'7.7',true)", [otherReq]);
    expect((await p.get('/api/portal/results')).body.data.some((r: any) => r.value === '7.7')).toBe(false);

    const invoices = (await p.get('/api/portal/invoices')).body.data;
    expect(invoices.length).toBeGreaterThanOrEqual(2);
    expect(invoices.every((i: any) => typeof i.balance === 'number')).toBe(true);
    const mine = invoices[0].id;
    const pdf = await p.get(`/api/portal/invoices/${mine}/pdf`).buffer(true).parse((r, cb) => { const b: Buffer[] = []; r.on('data', (c: Buffer) => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).toString('latin1').startsWith('%PDF-')).toBe(true);
    const foreign = (await q('SELECT id FROM invoices WHERE patient_id <> $1 LIMIT 1', [PATIENT]))[0].id;
    expect((await p.get(`/api/portal/invoices/${foreign}/pdf`)).status).toBe(404);
    expect((await p.get('/api/portal/invoices/abc/pdf')).status).toBe(400);
    const rx = (await p.get('/api/portal/prescriptions')).body.data;
    expect(rx.every((r: any) => r.doctor)).toBe(true);
    expect(rx.some((r: any) => /Lisinopril/.test(r.medicines) && r.refills_allowed === 3)).toBe(true);
  });

  it('updates only the permitted contact fields', async () => {
    const p = await as(lab, 'patient.portal');
    expect((await p.patch('/api/portal/me', { contact_preference: 'sms', phone: '555-0123' })).status).toBe(200);
    expect((await q('SELECT contact_preference, phone FROM patients WHERE id=$1', [PATIENT]))[0]).toEqual({ contact_preference: 'sms', phone: '555-0123' });
    expect((await p.patch('/api/portal/me', { contact_preference: 'fax' })).status).toBe(400);
    expect((await p.patch('/api/portal/me', { status: 'Inactive' })).status).toBe(400); // strict: no mass assignment
    expect((await p.patch('/api/portal/me', { primary_doctor_id: 3 })).status).toBe(400);
    expect((await p.patch('/api/portal/me', { email: 'not-an-email' })).status).toBe(400);
    expect((await p.patch('/api/portal/me', {})).status).toBe(400);
    expect((await q('SELECT status FROM patients WHERE id=$1', [PATIENT]))[0].status).toBe('Active');
  });
});

describe('patient portal: self-service booking', () => {
  it('books an available slot, confirms by message, blocks double booking and allows timely cancellation', async () => {
    const p = await as(lab, 'patient.portal');
    const doctors = (await p.get('/api/portal/doctors')).body.data;
    expect(doctors.length).toBeGreaterThanOrEqual(10);
    expect(doctors[0]).not.toHaveProperty('email');
    const doc = (await q("SELECT id FROM staff WHERE staff_code='DOC-006'"))[0].id as number;
    await q("DELETE FROM appointments WHERE patient_id=$1 AND status IN ('Scheduled','Confirmed')", [PATIENT]);
    const { date, time } = await freeSlot(p, doc, 25); // beyond the seeded day-sheets
    const booked = await p.post('/api/portal/appointments', { doctor_id: doc, date, time, reason: 'Annual check-up' });
    expect(booked.status).toBe(201);
    const row = (await q("SELECT status, patient_id, to_char(scheduled_at,'YYYY-MM-DD HH24:MI') AS at FROM appointments WHERE id=$1", [booked.body.id]))[0];
    expect(row).toMatchObject({ status: 'Scheduled', patient_id: PATIENT, at: `${date} ${time}` });
    expect((await q("SELECT channel FROM outbox_messages WHERE related_id=$1 AND kind='appointment_confirmation'", [booked.body.id])).length).toBeGreaterThan(0);

    expect((await p.post('/api/portal/appointments', { doctor_id: doc, date, time })).status).toBe(409); // slot taken
    const other = (await q("SELECT id FROM staff WHERE staff_code='DOC-007'"))[0].id as number;
    await q("INSERT INTO staff_shifts(staff_id,weekday,start_time,end_time) VALUES ($1,$2,'00:00','23:30') ON CONFLICT DO NOTHING", [other, new Date(`${date}T00:00:00Z`).getUTCDay()]);
    expect((await p.post('/api/portal/appointments', { doctor_id: other, date, time })).status).toBe(409); // patient already booked at that time
    expect((await p.post('/api/portal/appointments', { doctor_id: doc, date, time: '03:07' })).status).toBe(409); // not an offered slot
    expect((await p.post('/api/portal/appointments', { doctor_id: doc, date: '2001-01-01', time: '09:00' })).status).toBe(400);
    expect((await p.post('/api/portal/appointments', { doctor_id: doc, date: ymd(new Date(Date.now() + 200 * 86400000)), time: '09:00' })).status).toBe(400);
    expect((await p.post('/api/portal/appointments', { doctor_id: 999999, date, time })).status).toBe(404);
    expect((await p.post('/api/portal/appointments', { doctor_id: (await q("SELECT id FROM staff WHERE staff_code='NUR-001'"))[0].id, date, time })).status).toBe(404);
    expect((await p.post('/api/portal/appointments', { doctor_id: doc, date, time: '9am' })).status).toBe(400);

    const mine = (await p.get('/api/portal/appointments')).body.data;
    expect(mine.some((a: any) => a.id === booked.body.id)).toBe(true);
    expect(mine.every((a: any) => a.doctor)).toBe(true);

    expect((await p.post(`/api/portal/appointments/${booked.body.id}/cancel`)).status).toBe(200);
    expect((await p.post(`/api/portal/appointments/${booked.body.id}/cancel`)).status).toBe(409);
    expect((await q("SELECT 1 FROM outbox_messages WHERE related_id=$1 AND kind='appointment_cancellation'", [booked.body.id])).length).toBeGreaterThan(0);
    // the freed slot can be booked again
    expect((await p.post('/api/portal/appointments', { doctor_id: doc, date, time })).status).toBe(201);
  });

  it('enforces the cancellation cut-off, ownership and the upcoming-appointment limit', async () => {
    const p = await as(lab, 'patient.portal');
    const doc = (await q("SELECT id, department_id FROM staff WHERE staff_code='DOC-008'"))[0];
    await q("DELETE FROM appointments WHERE patient_id=$1 AND status IN ('Scheduled','Confirmed')", [PATIENT]);
    const soon = new Date(Date.now() + 60 * 60_000);
    const soonLocal = `${ymd(soon)}T${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}:00`;
    const near = (await q('INSERT INTO appointments(patient_id,doctor_id,department_id,scheduled_at) VALUES ($1,$2,$3,$4) RETURNING id', [PATIENT, doc.id, doc.department_id, soonLocal]))[0].id;
    expect((await p.post(`/api/portal/appointments/${near}/cancel`)).status).toBe(409); // inside the 2 hour cut-off
    const foreign = (await q("SELECT id FROM appointments WHERE patient_id <> $1 AND status='Scheduled' LIMIT 1", [PATIENT]))[0].id;
    expect((await p.post(`/api/portal/appointments/${foreign}/cancel`)).status).toBe(404);
    expect((await q('SELECT status FROM appointments WHERE id=$1', [foreign]))[0].status).toBe('Scheduled');
    await q("DELETE FROM appointments WHERE id=$1", [near]);

    // at most five upcoming appointments
    const base = new Date(Date.now() + 30 * 86400000);
    for (let i = 0; i < 5; i++) await q('INSERT INTO appointments(patient_id,doctor_id,department_id,scheduled_at) VALUES ($1,$2,$3,$4)', [PATIENT, doc.id, doc.department_id, `${ymd(new Date(base.getTime() + i * 86400000))}T18:00:00`]);
    const { date, time } = await freeSlot(p, (await q("SELECT id FROM staff WHERE staff_code='DOC-006'"))[0].id, 40);
    const over = await p.post('/api/portal/appointments', { doctor_id: (await q("SELECT id FROM staff WHERE staff_code='DOC-006'"))[0].id, date, time });
    expect(over.status).toBe(409);
    expect(over.body.error).toMatch(/at most 5/);
  });

  it('keeps inactive patients out of online booking', async () => {
    await q("UPDATE patients SET status='Inactive' WHERE id=$1", [PATIENT]);
    const p = await as(lab, 'patient.portal');
    const doc = (await q("SELECT id FROM staff WHERE staff_code='DOC-006'"))[0].id as number;
    const { date, time } = await freeSlot(p, doc, 60);
    expect((await p.post('/api/portal/appointments', { doctor_id: doc, date, time })).status).toBe(409);
    await q("UPDATE patients SET status='Active' WHERE id=$1", [PATIENT]);
  });
});

describe('patient accounts', () => {
  it('requires administrators to link a patient account to exactly one patient', async () => {
    const admin = await as(lab, 'admin.hartley');
    const base = { username: 'new.portal', full_name: 'New Portal', email: 'new.portal@example.test', password: 'Blue-Harbor-2026' };
    expect((await admin.post('/api/admin/users', { ...base, role: 'patient' })).status).toBe(400);
    expect((await admin.post('/api/admin/users', { ...base, role: 'patient', patient_id: 999999 })).status).toBe(400);
    expect((await admin.post('/api/admin/users', { ...base, role: 'patient', patient_id: PATIENT })).status).toBe(409); // already has an account
    expect((await admin.post('/api/admin/users', { ...base, role: 'receptionist', patient_id: 7 })).status).toBe(400);
    expect((await admin.post('/api/admin/users', { ...base, role: 'patient', patient_id: 7, password: 'new.portal-2026' })).status).toBe(400); // password contains the username
    expect((await admin.post('/api/admin/users', { ...base, role: 'patient', patient_id: 7, password: 'weakpass' })).status).toBe(400);
    // roles cannot be converted between patient and staff after the fact
    const staffUser = (await q("SELECT id FROM users WHERE username='nurse.okafor'"))[0].id;
    expect((await admin.patch(`/api/admin/users/${staffUser}`, { role: 'patient' })).status).toBe(400);
    const portalUser = (await q("SELECT id FROM users WHERE username='patient.portal'"))[0].id;
    expect((await admin.patch(`/api/admin/users/${portalUser}`, { role: 'doctor' })).status).toBe(400);
    expect((await admin.patch(`/api/admin/users/${portalUser}`, { active: true })).status).toBe(200);
    const ok = await admin.post('/api/admin/users', { ...base, role: 'patient', patient_id: 7 });
    expect(ok.status).toBe(201);
    const c = new Client(lab);
    expect((await c.login('new.portal', 'Blue-Harbor-2026')).status).toBe(200);
    expect((await c.get('/api/portal/me')).body.patient.id).toBe(7);
  });
});
