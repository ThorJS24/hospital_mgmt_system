import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Client, as, b64, makeLab, type Lab } from './helpers.js';

let lab: Lab;
beforeAll(async () => { lab = await makeLab('secure'); });
afterAll(async () => { await lab.db.close(); });

describe('Workflow A: login / logout', () => {
  it('rejects unauthenticated access', async () => {
    expect((await request(lab.app).get('/api/patients')).status).toBe(401);
    expect((await request(lab.app).get('/api/dashboard')).status).toBe(401);
  });
  it('rejects bad credentials and requires a CSRF token', async () => {
    const c = new Client(lab); await c.init();
    expect((await c.login('doctor.mehta', 'nope')).status).toBe(401);
    const noToken = await c.agent.post('/api/auth/login').send({ username: 'doctor.mehta', password: 'x' });
    expect(noToken.status).toBe(403);
  });
  it('logs in, rotates the session id, and invalidates it at logout', async () => {
    const c = new Client(lab);
    await c.init();
    const before = (c.agent as any).jar.getCookie('sid', { path: '/', domain: '127.0.0.1', script: false, secure: false })?.value;
    const r = await c.login('doctor.mehta');
    expect(r.status).toBe(200);
    expect(r.body.user.role).toBe('doctor');
    const after = r.headers['set-cookie']?.[0]?.match(/sid=([^;]+)/)?.[1];
    expect(after).toBeTruthy();
    if (before) expect(after).not.toBe(before);
    expect((await c.get('/api/dashboard')).status).toBe(200);
    const stolen = after!;
    expect((await c.post('/api/auth/logout')).status).toBe(200);
    const replay = await request(lab.app).get('/api/dashboard').set('Cookie', `sid=${stolen}`);
    expect(replay.status).toBe(401);
  });
  it('locks the account after repeated failures', async () => {
    const c = new Client(lab);
    for (let i = 0; i < 5; i++) await c.login('pharmacist.rossi', 'wrong-password');
    expect((await c.login('pharmacist.rossi')).status).toBe(429);
    await lab.db.query("UPDATE users SET failed_logins=0, locked_until=NULL WHERE username='pharmacist.rossi'");
  });
});

describe('role-based authorization (controls)', () => {
  it('limits admin routes to administrators', async () => {
    for (const u of ['pharmacist.rossi', 'doctor.mehta', 'receptionist.lindqvist', 'assessor.vance']) {
      const c = await as(lab, u);
      expect((await c.get('/api/admin/users')).status, u).toBe(403);
      expect((await c.get('/api/admin/audit')).status, u).toBe(403);
    }
    expect(((await (await as(lab, 'admin.hartley')).get('/api/admin/users')).status)).toBe(200);
  });
  it('keeps assessment data away from hospital administrators and clinical staff', async () => {
    for (const u of ['admin.hartley', 'doctor.mehta', 'billing.nakamura']) {
      const c = await as(lab, u);
      for (const url of ['/api/assessment/dashboard', '/api/assessment/manifest', '/api/assessment/findings', '/api/assessment/evidence'])
        expect((await c.get(url)).status, `${u} ${url}`).toBe(403);
    }
  });
  it('keeps clinical records away from the assessor', async () => {
    const c = await as(lab, 'assessor.vance');
    expect((await c.get('/api/patients')).status).toBe(403);
    expect((await c.get('/api/patients/1')).status).toBe(403);
  });
  it('prevents hospital admins from managing assessor accounts', async () => {
    const c = await as(lab, 'admin.hartley');
    const assessor = (await lab.db.query("SELECT id FROM users WHERE username='assessor.vance'")).rows[0].id;
    expect((await c.patch(`/api/admin/users/${assessor}`, { active: false })).status).toBe(403);
    const mk = await c.post('/api/admin/users', { username: 'new.assessor', full_name: 'New Assessor', email: 'n@x.test', role: 'security_assessor', password: 'LongEnough#123' });
    expect(mk.status).toBe(403);
  });
  it('enforces CSRF on every unsafe method', async () => {
    const c = await as(lab, 'receptionist.lindqvist');
    const r = await c.agent.post('/api/patients').send({});
    expect(r.status).toBe(403);
  });
  it('does not expose vulnerable lab routes in secure mode', async () => {
    const c = await as(lab, 'receptionist.lindqvist');
    expect((await c.get('/api/lab/patients/legacy-search?q=a')).status).toBe(404);
    expect((await c.get('/api/lab/admin/audit-export')).status).toBe(404);
  });
});

describe('Workflow B: patients', () => {
  it('registers, persists, updates and validates', async () => {
    const c = await as(lab, 'receptionist.lindqvist');
    expect((await c.post('/api/patients', { first_name: '', last_name: 'X', dob: '2090-01-01', sex: 'Female' })).status).toBe(400);
    const created = await c.post('/api/patients', { first_name: 'Test', last_name: 'Patient', dob: '1990-05-05', sex: 'Other', phone: '555-0199' });
    expect(created.status).toBe(201);
    expect(created.body.mrn).toMatch(/^SYN-\d{6}$/);
    const detail = await c.get(`/api/patients/${created.body.id}`);
    expect(detail.body.first_name).toBe('Test');
    expect(detail.body.allergies).toBeNull(); // receptionist has no clinical access
    expect((await c.patch(`/api/patients/${created.body.id}`, { phone: '555-0100' })).status).toBe(200);
    expect((await c.get(`/api/patients/${created.body.id}`)).body.phone).toBe('555-0100');
    expect((await c.patch(`/api/patients/${created.body.id}`, { notes: 'x' })).status).toBe(403);
    expect((await c.patch(`/api/patients/${created.body.id}`, { mrn: 'HACK' })).status).toBe(400);
  });
  it('prevents roles without registration permission from registering', async () => {
    for (const u of ['pharmacist.rossi', 'labtech.alvarez', 'doctor.mehta']) {
      const c = await as(lab, u);
      expect((await c.post('/api/patients', { first_name: 'A', last_name: 'B', dob: '1990-01-01', sex: 'Male' })).status, u).toBe(403);
    }
  });
  it('HMS-AC-005 doctors only see their care team; secure search binds parameters (HMS-INJ-002)', async () => {
    const c = await as(lab, 'doctor.mehta');
    const staffId = (await lab.db.query("SELECT staff_id FROM users WHERE username='doctor.mehta'")).rows[0].staff_id;
    const own = (await lab.db.query('SELECT id FROM patients WHERE primary_doctor_id=$1 LIMIT 1', [staffId])).rows[0].id;
    expect((await c.get(`/api/patients/${own}`)).status).toBe(200);
    const stranger = (await lab.db.query(`SELECT p.id FROM patients p WHERE p.primary_doctor_id <> $1
      AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id=p.id AND a.doctor_id=$1)
      AND NOT EXISTS (SELECT 1 FROM admissions a WHERE a.patient_id=p.id AND a.doctor_id=$1)
      AND NOT EXISTS (SELECT 1 FROM prescriptions a WHERE a.patient_id=p.id AND a.doctor_id=$1)
      AND NOT EXISTS (SELECT 1 FROM laboratory_requests a WHERE a.patient_id=p.id AND a.ordering_doctor_id=$1) LIMIT 1`, [staffId])).rows[0].id;
    expect((await c.get(`/api/patients/${stranger}`)).status).toBe(404);
    const list = await c.get('/api/patients?pageSize=100');
    expect(list.body.data.every((p: any) => p.id !== stranger)).toBe(true);
    const rc = await as(lab, 'receptionist.lindqvist');
    const inj = await rc.get(`/api/patients?q=${encodeURIComponent("' OR '1'='1")}`);
    expect(inj.status).toBe(200);
    expect(inj.body.total).toBe(0);
  });
  it('stores patient notes as plain text for the UI to escape', async () => {
    const c = await as(lab, 'doctor.mehta');
    const staffId = (await lab.db.query("SELECT staff_id FROM users WHERE username='doctor.mehta'")).rows[0].staff_id;
    const own = (await lab.db.query('SELECT id FROM patients WHERE primary_doctor_id=$1 LIMIT 1', [staffId])).rows[0].id;
    await c.patch(`/api/patients/${own}`, { notes: '<b>marker</b>' });
    expect((await c.get('/api/auth/session')).body.lab.unsafeNotes).toBeUndefined();
  });
  it('profile update ignores/rejects privilege fields (HMS-API-001 control)', async () => {
    const c = await as(lab, 'nurse.okafor');
    expect((await c.patch('/api/profile', { role_code: 'administrator' })).status).toBe(400);
    expect((await c.get('/api/auth/session')).body.user.role).toBe('nurse');
  });
  it('document upload validates extension and content (HMS-UPL-001 control)', async () => {
    const c = await as(lab, 'receptionist.lindqvist');
    const pid = (await lab.db.query('SELECT id FROM patients ORDER BY id LIMIT 1')).rows[0].id;
    expect((await c.post(`/api/patients/${pid}/documents`, { filename: 'a.html', content_base64: b64('<script>1</script>') })).status).toBe(400);
    expect((await c.post(`/api/patients/${pid}/documents`, { filename: 'a.png', content_base64: b64('<html></html>') })).status).toBe(400);
    const ok = await c.post(`/api/patients/${pid}/documents`, { filename: 'note.txt', content_base64: b64('synthetic note') });
    expect(ok.status).toBe(201);
    const dl = await c.get(`/api/documents/${ok.body.id}`);
    expect(dl.headers['content-disposition']).toMatch(/attachment/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('Workflow C: appointments', () => {
  it('creates, detects conflicts, reschedules, transitions and persists', async () => {
    const c = await as(lab, 'receptionist.lindqvist');
    const when = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 11) + '09:00';
    const doc = (await lab.db.query("SELECT id FROM staff WHERE staff_code='DOC-002'")).rows[0].id;
    const a = await c.post('/api/appointments', { patient_id: 2, doctor_id: doc, scheduled_at: when, duration_min: 30, reason: 'Test' });
    expect(a.status).toBe(201);
    expect((await c.post('/api/appointments', { patient_id: 3, doctor_id: doc, scheduled_at: when })).status).toBe(409);
    expect((await c.post('/api/appointments', { patient_id: 3, doctor_id: doc, scheduled_at: '2020-01-01T09:00' })).status).toBe(400);
    expect((await c.patch(`/api/appointments/${a.body.id}`, { scheduled_at: when.replace('09:00', '11:00') })).status).toBe(200);
    expect((await c.post(`/api/appointments/${a.body.id}/status`, { status: 'Completed' })).status).toBe(409);
    expect((await c.post(`/api/appointments/${a.body.id}/status`, { status: 'Confirmed' })).status).toBe(200);
    expect((await c.get(`/api/appointments/${a.body.id}`)).body.status).toBe('Confirmed');
    const list = await c.get(`/api/appointments?doctor_id=${doc}&status=Confirmed&pageSize=100&dir=desc`);
    expect(list.body.data.some((x: any) => x.id === a.body.id)).toBe(true);
    expect((await c.post(`/api/appointments/${a.body.id}/status`, { status: 'Cancelled' })).status).toBe(200);
    expect((await c.post(`/api/appointments/${a.body.id}/status`, { status: 'Confirmed' })).status).toBe(409);
  });
});

describe('Workflow D: laboratory', () => {
  it('request -> assign -> result -> approve', async () => {
    const doctor = await as(lab, 'doctor.mehta');
    const staffId = (await lab.db.query("SELECT staff_id FROM users WHERE username='doctor.mehta'")).rows[0].staff_id;
    const pid = (await lab.db.query('SELECT id FROM patients WHERE primary_doctor_id=$1 LIMIT 1', [staffId])).rows[0].id;
    const req = await doctor.post('/api/laboratory/requests', { patient_id: pid, test_id: 1 });
    expect(req.status).toBe(201);
    const tech = await as(lab, 'labtech.alvarez');
    expect((await tech.post(`/api/laboratory/requests/${req.body.id}/result`, { value: '5.0' })).status).toBe(409);
    expect((await tech.post(`/api/laboratory/requests/${req.body.id}/assign`, {})).status).toBe(200);
    expect((await tech.post(`/api/laboratory/requests/${req.body.id}/result`, { value: '5.0', comment: 'ok' })).status).toBe(201);
    expect((await tech.post(`/api/laboratory/requests/${req.body.id}/approve`)).status).toBe(403);
    expect((await doctor.post(`/api/laboratory/requests/${req.body.id}/approve`)).status).toBe(200);
    const d = await doctor.get(`/api/laboratory/requests/${req.body.id}`);
    expect(d.body.status).toBe('Approved');
    expect(d.body.result_value).toBe('5.0');
    expect((await as(lab, 'receptionist.lindqvist').then((c) => c.get('/api/laboratory/requests'))).status).toBe(403);
  });
});

describe('Workflow E: billing', () => {
  it('creates invoice, totals line items, applies payments, rejects overpayment', async () => {
    const c = await as(lab, 'billing.nakamura');
    const inv = await c.post('/api/invoices', { patient_id: 1, items: [{ description: 'Consultation', quantity: 1, unit_price: 100 }, { description: 'Lab panel', quantity: 2, unit_price: 25.25 }] });
    expect(inv.status).toBe(201);
    let d = (await c.get(`/api/invoices/${inv.body.id}`)).body;
    expect(d.total).toBe(150.5);
    expect(d.balance).toBe(150.5);
    expect((await c.post(`/api/invoices/${inv.body.id}/payments`, { amount: 50 })).body.status).toBe('Partially paid');
    expect((await c.post(`/api/invoices/${inv.body.id}/payments`, { amount: 500 })).status).toBe(409);
    const last = await c.post(`/api/invoices/${inv.body.id}/payments`, { amount: 100.5 });
    expect(last.body).toMatchObject({ status: 'Paid', balance: 0 });
    d = (await c.get(`/api/invoices/${inv.body.id}`)).body;
    expect(d.status).toBe('Paid');
    expect((await c.post(`/api/invoices/${inv.body.id}/cancel`)).status).toBe(409);
    expect((await (await as(lab, 'receptionist.lindqvist')).post('/api/invoices', { patient_id: 1, items: [{ description: 'x', quantity: 1, unit_price: 1 }] })).status).toBe(403);
    expect((await (await as(lab, 'doctor.mehta')).get('/api/invoices')).status).toBe(403);
  });
});

describe('admissions and pharmacy', () => {
  it('does not allow two active admissions in one bed', async () => {
    const c = await as(lab, 'nurse.okafor');
    const occupied = (await lab.db.query("SELECT bed_id FROM admissions WHERE status='Admitted' LIMIT 1")).rows[0].bed_id;
    const doc = (await lab.db.query("SELECT id FROM staff WHERE staff_code='DOC-001'")).rows[0].id;
    expect((await c.post('/api/admissions', { patient_id: 30, bed_id: occupied, doctor_id: doc })).status).toBe(409);
    const free = (await lab.db.query("SELECT id FROM beds WHERE id NOT IN (SELECT bed_id FROM admissions WHERE status='Admitted') LIMIT 1")).rows[0].id;
    const a = await c.post('/api/admissions', { patient_id: 30, bed_id: free, doctor_id: doc, reason: 'Test' });
    expect(a.status).toBe(201);
    expect((await c.post('/api/admissions', { patient_id: 30, bed_id: free, doctor_id: doc })).status).toBe(409);
    expect((await c.post(`/api/admissions/${a.body.id}/discharge`)).status).toBe(200);
    expect((await c.post(`/api/admissions/${a.body.id}/discharge`)).status).toBe(409);
  });
  it('prescribes and dispenses with stock enforcement', async () => {
    const doc = await as(lab, 'doctor.mehta');
    const staffId = (await lab.db.query("SELECT staff_id FROM users WHERE username='doctor.mehta'")).rows[0].staff_id;
    const pid = (await lab.db.query('SELECT id FROM patients WHERE primary_doctor_id=$1 LIMIT 1', [staffId])).rows[0].id;
    const stockBefore = (await lab.db.query('SELECT stock FROM medications WHERE id=1')).rows[0].stock;
    const rx = await doc.post('/api/pharmacy/prescriptions', { patient_id: pid, items: [{ medication_id: 1, quantity: 10, dosage: '1 capsule daily' }] });
    expect(rx.status).toBe(201);
    const ph = await as(lab, 'pharmacist.rossi');
    expect((await ph.post(`/api/pharmacy/prescriptions/${rx.body.id}/dispense`)).status).toBe(200);
    expect((await lab.db.query('SELECT stock FROM medications WHERE id=1')).rows[0].stock).toBe(stockBefore - 10);
    expect((await ph.post(`/api/pharmacy/prescriptions/${rx.body.id}/dispense`)).status).toBe(409);
    expect((await ph.get('/api/pharmacy/medications/abc')).status).toBe(400);
    const body = (await ph.get('/api/pharmacy/medications/abc')).body;
    expect(JSON.stringify(body)).not.toMatch(/SELECT|stack|at /);
  });
});

describe('password reset (secure)', () => {
  it('issues strong tokens and limits attempts', async () => {
    const c = new Client(lab); await c.init();
    await c.post('/api/auth/password-reset/request', { username: 'nurse.okafor' });
    const tok = (await lab.db.query("SELECT token FROM reset_tokens t JOIN users u ON u.id=t.user_id WHERE u.username='nurse.okafor' AND NOT used ORDER BY t.id DESC LIMIT 1")).rows[0].token;
    expect(tok).toMatch(/^[a-f0-9]{48}$/);
    for (let i = 0; i < 5; i++) expect((await c.post('/api/auth/password-reset/confirm', { username: 'nurse.okafor', token: '0000', new_password: 'BrandNew#12345' })).status).toBe(400);
    expect((await c.post('/api/auth/password-reset/confirm', { username: 'nurse.okafor', token: tok, new_password: 'BrandNew#12345' })).status).toBe(429);
  });
});

describe('dashboard integrity', () => {
  it('reports counts that match the database', async () => {
    const c = await as(lab, 'admin.hartley');
    const d = (await c.get('/api/dashboard')).body;
    const n = async (sql: string) => (await lab.db.query<{ n: number }>(sql)).rows[0].n;
    expect(d.totals.patients).toBe(await n('SELECT count(*)::int AS n FROM patients'));
    expect(d.totals.admitted).toBe(await n("SELECT count(*)::int AS n FROM admissions WHERE status='Admitted'"));
    expect(d.totals.availableBeds).toBe(await n("SELECT (SELECT count(*) FROM beds)::int - (SELECT count(*) FROM admissions WHERE status='Admitted')::int AS n"));
    expect(d.totals.appointmentsToday).toBe(await n('SELECT count(*)::int AS n FROM appointments WHERE scheduled_at::date = current_date'));
    expect(d.totals.pendingLab).toBe(await n("SELECT count(*)::int AS n FROM laboratory_requests WHERE status IN ('Requested','In progress')"));
    const pharm = (await (await as(lab, 'pharmacist.rossi')).get('/api/dashboard')).body;
    expect(pharm.totals.outstandingInvoices).toBeNull();
  });
});
