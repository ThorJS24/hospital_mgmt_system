import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { as, makeLab, type Lab } from './helpers.js';
import { runMaintenance } from '../src/services/maintenance.js';

let lab: Lab;
beforeAll(async () => { lab = await makeLab('secure'); });
afterAll(async () => { await lab.db.close(); });

const q = async <T = any>(sql: string, params: unknown[] = []) => (await lab.db.query<T>(sql, params)).rows;
const staff = async (code: string) => (await q('SELECT id FROM staff WHERE staff_code=$1', [code]))[0].id as number;
const userId = async (username: string) => (await q('SELECT id FROM users WHERE username=$1', [username]))[0].id as number;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inDays = (n: number) => ymd(new Date(Date.now() + n * 86400000));
const nextWeekday = (weekday: number, minDays = 2) => { let n = minDays; while (new Date(Date.now() + n * 86400000).getDay() !== weekday) n++; return inDays(n); };
async function newPatient(extra: Record<string, unknown> = {}) {
  const c = await as(lab, 'receptionist.lindqvist');
  const r = await c.post('/api/patients', { first_name: 'Ops', last_name: `Case${Math.floor(Math.random() * 1e6)}`, dob: '1985-02-02', sex: 'Male', ...extra });
  expect(r.status).toBe(201);
  return r.body.id as number;
}

describe('notifications', () => {
  it('alerts the ordering doctor to a critical laboratory value, privately, once', async () => {
    const mehta = await staff('DOC-001');
    const pid = await newPatient({ primary_doctor_id: mehta });
    const doc = await as(lab, 'doctor.mehta');
    const glu = (await q("SELECT id FROM laboratory_tests WHERE code='GLU'"))[0].id;
    const reqId = (await doc.post('/api/laboratory/requests', { patient_id: pid, test_id: glu })).body.id;
    const tech = await as(lab, 'labtech.alvarez');
    await tech.post(`/api/laboratory/requests/${reqId}/assign`);
    expect((await tech.post(`/api/laboratory/requests/${reqId}/result`, { value: '1.4', comment: '' })).status).toBe(201);

    const before = (await doc.get('/api/notifications')).body;
    const crit = before.data.find((n: any) => n.kind === 'lab_critical' && n.body.includes('1.4'));
    expect(crit).toMatchObject({ severity: 'critical', link: `/patients/${pid}`, read_at: null });
    expect(before.unread).toBeGreaterThanOrEqual(1);
    expect(before.critical).toBeGreaterThanOrEqual(1);
    expect((await q("SELECT count(*)::int AS n FROM notifications WHERE dedupe_key=$1", [`labcrit:${reqId}`]))[0].n).toBe(1);

    // other users never see it, and cannot mark it read
    const other = await as(lab, 'doctor.svensson');
    expect((await other.get('/api/notifications')).body.data.some((n: any) => n.id === crit.id)).toBe(false);
    expect((await other.post(`/api/notifications/${crit.id}/read`)).status).toBe(404);

    expect((await doc.post(`/api/notifications/${crit.id}/read`)).status).toBe(200);
    const after = (await doc.get('/api/notifications')).body;
    expect(after.unread).toBe(before.unread - 1);
    expect(after.data.find((n: any) => n.id === crit.id).read_at).toBeTruthy();
    expect((await doc.get('/api/notifications?unread=1')).body.data.every((n: any) => !n.read_at)).toBe(true);
    expect((await doc.post('/api/notifications/read-all')).body.marked).toBe(after.unread);
    expect((await doc.get('/api/notifications')).body.unread).toBe(0);
    expect((await request(lab.app).get('/api/notifications')).status).toBe(401);

    // a normal result raises no alert
    const normal = (await doc.post('/api/laboratory/requests', { patient_id: pid, test_id: glu })).body.id;
    await tech.post(`/api/laboratory/requests/${normal}/assign`);
    await tech.post(`/api/laboratory/requests/${normal}/result`, { value: '5.0', comment: '' });
    expect((await q("SELECT count(*)::int AS n FROM notifications WHERE dedupe_key=$1", [`labcrit:${normal}`]))[0].n).toBe(0);
  });

  it('notifies nurses of bed changes and summarises overdue invoices and stock alerts', async () => {
    const admin = await as(lab, 'admin.hartley');
    // free one bed in the nurse's ward first (the seeded ward is full)
    const taken = (await q("SELECT a.id, a.bed_id FROM admissions a JOIN beds b ON b.id=a.bed_id JOIN wards w ON w.id=b.ward_id WHERE a.status='Admitted' AND w.name='General Ward B' ORDER BY a.id LIMIT 1"))[0];
    await q("UPDATE admissions SET status='Discharged', discharged_at=now() WHERE id=$1", [taken.id]);
    const ward = { bed_id: taken.bed_id };
    const pid = await newPatient();
    const adm = await admin.post('/api/admissions', { patient_id: pid, bed_id: ward.bed_id, doctor_id: await staff('DOC-005'), reason: 'Observation' });
    expect(adm.status).toBe(201);
    const nurse = await as(lab, 'nurse.okafor');
    const bed = (await nurse.get('/api/notifications')).body.data.find((n: any) => n.kind === 'bed_change' && n.title.includes('admitted'));
    expect(bed).toBeTruthy();
    expect(bed.link).toBe('/admissions');

    const billing = await as(lab, 'billing.nakamura');
    const overdue = (await billing.get('/api/notifications')).body.data.find((n: any) => n.kind === 'invoice_overdue');
    expect(overdue.title).toMatch(/overdue invoice/);
    const pharm = await as(lab, 'pharmacist.rossi');
    const inv = (await pharm.get('/api/notifications')).body.data.find((n: any) => n.kind === 'inventory');
    expect(inv.body).toMatch(/Salbutamol|Warfarin|Clopidogrel/);
    // re-running a scan never duplicates the daily summary
    await runMaintenance(lab.db);
    await runMaintenance(lab.db);
    expect((await q("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='invoice_overdue'", [await userId('billing.nakamura')]))[0].n).toBe(1);
  });
});

describe('global search', () => {
  it('only returns records the caller is allowed to open', async () => {
    const mehta = await staff('DOC-001');
    const mine = await newPatient({ primary_doctor_id: mehta, last_name: 'Zebrowski' });
    const notMine = await newPatient({ primary_doctor_id: await staff('DOC-005'), last_name: 'Zebrowska' });
    const doc = await as(lab, 'doctor.mehta');
    const r = (await doc.get('/api/search?q=Zebrow')).body;
    const ids = r.groups.find((g: any) => g.type === 'patient').items.map((i: any) => i.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(notMine);
    expect(r.groups.some((g: any) => g.type === 'invoice')).toBe(false); // doctors have no billing access

    const rec = await as(lab, 'receptionist.lindqvist');
    const recIds = (await rec.get('/api/search?q=Zebrow')).body.groups.find((g: any) => g.type === 'patient').items.map((i: any) => i.id);
    expect(recIds).toEqual(expect.arrayContaining([mine, notMine]));
    const inv = (await rec.get('/api/search?q=INV-100')).body.groups.find((g: any) => g.type === 'invoice');
    expect(inv.items[0].to).toMatch(/^\/billing\?invoice=\d+$/);
    expect((await rec.get('/api/search?q=Warfarin')).body.groups).toEqual([]); // no pharmacy permission
    const ph = await as(lab, 'pharmacist.rossi');
    expect((await ph.get('/api/search?q=Warfarin')).body.groups[0]).toMatchObject({ type: 'medication' });
    expect((await doc.get('/api/search?q=a')).body.groups).toEqual([]);
    expect((await doc.get(`/api/search?q=${encodeURIComponent("%' OR 1=1 --")}`)).body.groups).toEqual([]); // wildcards and quotes are inert
    expect((await doc.get(`/api/search?q=${encodeURIComponent('__')}`)).body.groups).toEqual([]);
    expect((await request(lab.app).get('/api/search?q=abc')).status).toBe(401);
  });
});

describe('rosters, slots and leave', () => {
  it('derives bookable slots from shifts, bookings and approved leave', async () => {
    const mehta = await staff('DOC-001');
    await q('DELETE FROM staff_shifts WHERE staff_id=$1', [mehta]);
    const admin = await as(lab, 'admin.hartley');
    const day = nextWeekday(2, 21); // a Tuesday beyond the seeded day-sheets
    expect((await admin.put(`/api/staff/${mehta}/shifts`, { shifts: [{ weekday: 2, start_time: '09:00', end_time: '11:00' }, { weekday: 2, start_time: '13:00', end_time: '14:00' }] })).status).toBe(200);
    const rec = await as(lab, 'receptionist.lindqvist');
    let slots = (await rec.get(`/api/staff/${mehta}/slots?date=${day}`)).body.slots;
    expect(slots.map((s: any) => s.time)).toEqual(['09:00', '09:30', '10:00', '10:30', '13:00', '13:30']);
    expect(slots.every((s: any) => s.available)).toBe(true);

    const pid = await newPatient();
    const booked = await rec.post('/api/appointments', { patient_id: pid, doctor_id: mehta, scheduled_at: `${day}T09:30`, duration_min: 30 });
    expect(booked.status).toBe(201);
    slots = (await rec.get(`/api/staff/${mehta}/slots?date=${day}`)).body.slots;
    expect(slots.find((s: any) => s.time === '09:30')).toMatchObject({ available: false, reason: 'Booked' });
    expect(slots.find((s: any) => s.time === '10:00').available).toBe(true);
    expect((await rec.get(`/api/staff/${mehta}/slots?date=${nextWeekday(0, 7)}`)).body).toMatchObject({ slots: [], note: 'Not rostered on this day' });
    expect((await rec.get(`/api/staff/${mehta}/slots?date=2026-02-31`)).status).toBe(400);
    expect((await rec.get(`/api/staff/${mehta}/slots`)).status).toBe(400);
    expect((await rec.get(`/api/staff/${await staff('NUR-001')}/slots?date=${day}`)).status).toBe(404); // not a doctor

    await q("INSERT INTO staff_leave(staff_id,start_date,end_date,status) VALUES ($1,$2,$2,'Approved')", [mehta, day]);
    expect((await rec.get(`/api/staff/${mehta}/slots?date=${day}`)).body).toMatchObject({ slots: [], note: 'On approved leave' });
  });

  it('validates shift edits and restricts them to administrators', async () => {
    const admin = await as(lab, 'admin.hartley');
    const id = await staff('DOC-002');
    expect((await admin.put(`/api/staff/${id}/shifts`, { shifts: [{ weekday: 1, start_time: '09:00', end_time: '12:00' }, { weekday: 1, start_time: '11:00', end_time: '14:00' }] })).status).toBe(400); // overlap
    expect((await admin.put(`/api/staff/${id}/shifts`, { shifts: [{ weekday: 1, start_time: '12:00', end_time: '09:00' }] })).status).toBe(400);
    expect((await admin.put(`/api/staff/${id}/shifts`, { shifts: [{ weekday: 9, start_time: '09:00', end_time: '12:00' }] })).status).toBe(400);
    expect((await admin.put('/api/staff/999999/shifts', { shifts: [] })).status).toBe(404);
    expect((await (await as(lab, 'doctor.mehta')).put(`/api/staff/${id}/shifts`, { shifts: [] })).status).toBe(403);
    const roster = await (await as(lab, 'nurse.okafor')).get('/api/roster');
    expect(roster.status).toBe(200);
    expect(roster.body.data.find((s: any) => s.id === id)).toHaveProperty('shifts');
    expect((await (await as(lab, 'nurse.okafor')).get(`/api/roster?department_id=${(await q('SELECT department_id FROM staff WHERE id=$1', [id]))[0].department_id}`)).body.data.every((s: any) => s.department === 'Cardiology')).toBe(true);
  });

  it('runs the leave workflow: request, validation, privacy, decision, withdrawal', async () => {
    const sven = await as(lab, 'doctor.svensson');
    const start = inDays(30), end = inDays(32);
    expect((await sven.post('/api/leave', { start_date: inDays(-3), end_date: inDays(-2) })).status).toBe(400); // past
    expect((await sven.post('/api/leave', { start_date: end, end_date: start })).status).toBe(400); // reversed
    expect((await sven.post('/api/leave', { start_date: start, end_date: inDays(120) })).status).toBe(400); // too long
    const created = await sven.post('/api/leave', { start_date: start, end_date: end, reason: 'Private matter' });
    expect(created.status).toBe(201);
    expect((await sven.post('/api/leave', { start_date: inDays(31), end_date: inDays(33) })).status).toBe(409); // overlap
    const adminUser = await userId('admin.hartley');
    expect((await q("SELECT 1 FROM notifications WHERE user_id=$1 AND dedupe_key=$2", [adminUser, `leave:${created.body.id}`])).length).toBe(1);

    // another colleague sees approved leave only, without the reason; the requester sees everything of their own
    const nurse = await as(lab, 'nurse.okafor');
    expect((await nurse.get('/api/leave')).body.data.some((l: any) => l.id === created.body.id)).toBe(false); // still pending
    expect((await sven.get('/api/leave')).body.data.find((l: any) => l.id === created.body.id).reason).toBe('Private matter');
    expect((await (await as(lab, 'receptionist.lindqvist')).post(`/api/leave/${created.body.id}/decision`, { status: 'Approved' })).status).toBe(403);

    const admin = await as(lab, 'admin.hartley');
    const sId = await staff('DOC-005');
    const dept = (await q('SELECT department_id FROM staff WHERE id=$1', [sId]))[0].department_id;
    await q("INSERT INTO appointments(patient_id,doctor_id,department_id,scheduled_at) VALUES (1,$1,$2,$3)", [sId, dept, `${inDays(31)}T10:00:00`]);
    const decided = await admin.post(`/api/leave/${created.body.id}/decision`, { status: 'Approved' });
    expect(decided.body).toMatchObject({ ok: true, status: 'Approved', appointmentConflicts: 1 });
    expect((await admin.post(`/api/leave/${created.body.id}/decision`, { status: 'Rejected' })).status).toBe(409);
    const seen = (await nurse.get('/api/leave')).body.data.find((l: any) => l.id === created.body.id);
    expect(seen).toMatchObject({ status: 'Approved', reason: '' }); // reason hidden from colleagues
    expect((await q("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='leave_decision'", [await userId('doctor.svensson')])).length).toBe(1);
    expect((await sven.delete(`/api/leave/${created.body.id}`)).status).toBe(409); // decided requests cannot be withdrawn

    // pending requests can be withdrawn by their owner only; nobody decides their own request
    const mine = (await sven.post('/api/leave', { start_date: inDays(50), end_date: inDays(51) })).body.id;
    expect((await nurse.delete(`/api/leave/${mine}`)).status).toBe(404);
    expect((await sven.delete(`/api/leave/${mine}`)).status).toBe(200);
    const own = (await admin.post('/api/leave', { start_date: inDays(60), end_date: inDays(61) })).body.id;
    expect((await admin.post(`/api/leave/${own}/decision`, { status: 'Approved' })).status).toBe(403);
    expect((await (await as(lab, 'billing.nakamura')).post('/api/leave', { start_date: inDays(70), end_date: inDays(71) })).status).toBe(201);
    expect((await (await as(lab, 'assessor.vance')).post('/api/leave', { start_date: inDays(70), end_date: inDays(71) })).status).toBe(403);
  });
});

describe('pharmacy inventory', () => {
  it('reports low, expiring and expired stock and keeps an auditable ledger', async () => {
    const ph = await as(lab, 'pharmacist.rossi');
    const alerts = (await ph.get('/api/inventory/alerts')).body;
    expect(alerts.low.map((m: any) => m.code)).toEqual(expect.arrayContaining(['SAL100', 'WAR5', 'CLO75']));
    expect(alerts.expiring.map((m: any) => m.code)).toEqual(expect.arrayContaining(['WAR5', 'CLO75']));
    expect(alerts.expired.map((m: any) => m.code)).toEqual(['SAL100']);
    expect(alerts.counts).toMatchObject({ low: alerts.low.length, expired: 1 });
    expect(alerts.stockValue).toBeGreaterThan(0);
    const expired = (await ph.get('/api/inventory?filter=expired')).body;
    expect(expired.total).toBe(1);
    expect(expired.data[0]).toMatchObject({ code: 'SAL100', expired: true, low: true });
    expect((await ph.get('/api/inventory?filter=bogus')).status).toBe(400);
    expect((await ph.get('/api/inventory?q=metformin')).body.data[0].code).toBe('MET850');

    const id = (await q("SELECT id FROM medications WHERE code='SAL100'"))[0].id;
    const supplier = (await q('SELECT id FROM suppliers ORDER BY id LIMIT 1'))[0].id;
    const exp = inDays(400);
    const rec = await ph.post(`/api/inventory/${id}/receive`, { quantity: 300, expiry_date: exp, supplier_id: supplier, note: 'PO-4411' });
    expect(rec.status).toBe(201);
    expect(rec.body.stock).toBe(190 + 300);
    expect((await ph.get('/api/inventory?filter=expired')).body.total).toBe(0);
    expect((await ph.post(`/api/inventory/${id}/receive`, { quantity: 5, expiry_date: '2001-01-01' })).status).toBe(400);
    expect((await ph.post(`/api/inventory/${id}/receive`, { quantity: 0 })).status).toBe(400);
    expect((await ph.post(`/api/inventory/${id}/receive`, { quantity: 5, supplier_id: 99999 })).status).toBe(400);
    expect((await ph.post(`/api/inventory/${id}/adjust`, { delta: -1000, note: 'Stock count' })).status).toBe(409); // cannot go negative
    expect((await ph.post(`/api/inventory/${id}/adjust`, { delta: -10, note: 'x' })).status).toBe(400);
    expect((await ph.post(`/api/inventory/${id}/adjust`, { delta: 0, note: 'Nothing' })).status).toBe(400);
    expect((await ph.post(`/api/inventory/${id}/adjust`, { delta: 5, reason: 'Expired', note: 'Wrong direction' })).status).toBe(400);
    const adj = await ph.post(`/api/inventory/${id}/adjust`, { delta: -15, reason: 'Expired', note: 'Damaged packaging' });
    expect(adj.body.stock).toBe(475);
    const ledger = (await ph.get(`/api/inventory/${id}/movements`)).body.data;
    expect(ledger.map((m: any) => `${m.reason}:${m.delta}`).slice(0, 2)).toEqual(['Expired:-15', 'Receive:300']);
    expect(ledger[0].user).toBe('Giulia Rossi');
    expect((await ph.patch(`/api/inventory/${id}`, { reorder_level: 250, unit_cost: 7.25 })).status).toBe(200);
    expect((await ph.patch(`/api/inventory/${id}`, { stock: 99999 })).status).toBe(400); // stock cannot be edited directly
    expect((await ph.get('/api/inventory/999999/movements')).status).toBe(404);

    // doctors prescribe from the formulary but do not manage stock
    const doc = await as(lab, 'doctor.mehta');
    expect((await doc.get('/api/inventory')).status).toBe(403);
    expect((await doc.post(`/api/inventory/${id}/receive`, { quantity: 1 })).status).toBe(403);
  });

  it('manages suppliers', async () => {
    const ph = await as(lab, 'pharmacist.rossi');
    expect((await ph.get('/api/suppliers')).body.data.length).toBeGreaterThanOrEqual(3);
    const made = await ph.post('/api/suppliers', { name: 'Lakeside Wholesale', contact_email: 'orders@lakeside.example.test', phone: '555-0404' });
    expect(made.status).toBe(201);
    expect((await ph.post('/api/suppliers', { name: 'Lakeside Wholesale' })).status).toBe(409);
    expect((await ph.post('/api/suppliers', { name: 'Bad Email', contact_email: 'nope' })).status).toBe(400);
    expect((await ph.patch(`/api/suppliers/${made.body.id}`, { active: false })).status).toBe(200);
    expect((await ph.patch(`/api/suppliers/${made.body.id}`, { name: 'Evergreen Medical Distributors' })).status).toBe(409);
    expect((await ph.patch('/api/suppliers/999999', { active: false })).status).toBe(404);
    const id = (await q("SELECT id FROM medications WHERE code='AMX500'"))[0].id;
    expect((await ph.post(`/api/inventory/${id}/receive`, { quantity: 1, supplier_id: made.body.id })).status).toBe(400); // inactive suppliers cannot be used
  });
});

describe('billing: refunds, claims, payment history and PDF', () => {
  async function invoice(patientId: number, unit = 200) {
    const billing = await as(lab, 'billing.nakamura');
    const r = await billing.post('/api/invoices', { patient_id: patientId, items: [{ description: 'Consultation', quantity: 1, unit_price: unit }] });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }

  it('records refunds against specific payments and keeps the invoice status honest', async () => {
    const pid = await newPatient();
    const id = await invoice(pid);
    const billing = await as(lab, 'billing.nakamura');
    await billing.post(`/api/invoices/${id}/payments`, { amount: 200, method: 'Card (synthetic)' });
    expect((await billing.get(`/api/invoices/${id}`)).body.status).toBe('Paid');
    const payId = (await q("SELECT id FROM payments WHERE invoice_id=$1 AND kind='Payment'", [id]))[0].id;

    const r1 = await billing.post(`/api/invoices/${id}/refunds`, { payment_id: payId, amount: 50, reason: 'Duplicate charge' });
    expect(r1.body).toMatchObject({ status: 'Partially paid', balance: 50 });
    expect((await billing.post(`/api/invoices/${id}/refunds`, { payment_id: payId, amount: 150.01, reason: 'Too much' })).status).toBe(409); // only 150 left to refund
    expect((await billing.post(`/api/invoices/${id}/refunds`, { payment_id: payId, amount: 150, reason: 'Full' })).body).toMatchObject({ status: 'Issued', balance: 200 });
    expect((await billing.post(`/api/invoices/${id}/refunds`, { payment_id: payId, amount: 1, reason: 'Nothing left' })).status).toBe(409);
    expect((await billing.post(`/api/invoices/${id}/refunds`, { payment_id: payId, amount: 10, reason: 'x' })).status).toBe(400);
    expect((await billing.post(`/api/invoices/${id}/refunds`, { payment_id: 999999, amount: 10, reason: 'Unknown payment' })).status).toBe(404);
    const otherInv = await invoice(pid);
    expect((await billing.post(`/api/invoices/${otherInv}/refunds`, { payment_id: payId, amount: 10, reason: 'Wrong invoice' })).status).toBe(404);

    const detail = (await billing.get(`/api/invoices/${id}`)).body;
    expect(detail.paid).toBe(0);
    expect(detail.payments.map((p: any) => p.kind)).toEqual(['Payment', 'Refund', 'Refund']);
    expect(detail.payments.filter((p: any) => p.kind === 'Refund').every((p: any) => p.amount < 0 && p.refund_of === payId)).toBe(true);
    // a refunded invoice can be paid again
    expect((await billing.post(`/api/invoices/${id}/payments`, { amount: 200 })).status).toBe(201);
    expect((await (await as(lab, 'receptionist.lindqvist')).post(`/api/invoices/${id}/refunds`, { payment_id: payId, amount: 1, reason: 'Not allowed' })).status).toBe(403);

    const history = (await billing.get(`/api/payments?invoice_id=${id}`)).body;
    expect(history.total).toBe(4);
    expect(history.net).toBe(200);
    expect((await billing.get('/api/payments?kind=Refund')).body.data.every((p: any) => p.kind === 'Refund' && p.amount < 0)).toBe(true);
    expect((await billing.get('/api/payments?kind=Bogus')).status).toBe(400);
  });

  it('files, decides and pays insurance claims with a four-eyes rule', async () => {
    const pid = await newPatient();
    await q("UPDATE patients SET insurance_provider='Northwind Health', insurance_policy_no='POL-1' WHERE id=$1", [pid]);
    const id = await invoice(pid, 400);
    const billing = await as(lab, 'billing.nakamura');
    const admin = await as(lab, 'admin.hartley');
    expect((await billing.post(`/api/invoices/${id}/claims`, { amount_claimed: 500 })).status).toBe(409); // above the balance
    const claim = await billing.post(`/api/invoices/${id}/claims`, { amount_claimed: 300 });
    expect(claim.status).toBe(201);
    expect((await billing.post(`/api/invoices/${id}/claims`, { amount_claimed: 100 })).status).toBe(409); // one open claim at a time
    expect((await billing.post(`/api/claims/${claim.body.id}/decision`, { decision: 'Approve' })).status).toBe(403); // the submitter cannot decide
    expect((await admin.post(`/api/claims/${claim.body.id}/decision`, { decision: 'PartiallyApprove' })).status).toBe(400); // amount required
    expect((await admin.post(`/api/claims/${claim.body.id}/decision`, { decision: 'PartiallyApprove', amount_approved: 300 })).status).toBe(400); // must be below the claim
    const ok = await admin.post(`/api/claims/${claim.body.id}/decision`, { decision: 'PartiallyApprove', amount_approved: 120, note: 'Covered at 40%' });
    expect(ok.body).toMatchObject({ status: 'Partially approved', paid: 120 });
    expect((await admin.post(`/api/claims/${claim.body.id}/decision`, { decision: 'Approve' })).status).toBe(409); // final
    const inv = (await billing.get(`/api/invoices/${id}`)).body;
    expect(inv).toMatchObject({ status: 'Partially paid', balance: 280 });
    expect(inv.payments[0]).toMatchObject({ amount: 120, method: 'Insurance claim (Northwind Health)' });
    expect(inv.claims[0]).toMatchObject({ status: 'Partially approved', amount_approved: 120 });

    // rejection needs a reason and does not move money
    const second = (await billing.post(`/api/invoices/${id}/claims`, { amount_claimed: 200 })).body.id;
    expect((await admin.post(`/api/claims/${second}/decision`, { decision: 'Reject' })).status).toBe(400);
    expect((await admin.post(`/api/claims/${second}/decision`, { decision: 'Reject', note: 'Policy inactive' })).body).toMatchObject({ status: 'Rejected', paid: 0 });
    expect((await billing.get(`/api/invoices/${id}`)).body.balance).toBe(280);
    expect((await q("SELECT 1 FROM notifications WHERE dedupe_key=$1", [`claim:${second}`])).length).toBeGreaterThan(0);

    // no insurance, no claim; listing is restricted
    const selfPay = await newPatient();
    await q("UPDATE patients SET insurance_provider='Self-pay' WHERE id=$1", [selfPay]);
    expect((await billing.post(`/api/invoices/${await invoice(selfPay)}/claims`, { amount_claimed: 10 })).status).toBe(409);
    const list = await billing.get('/api/claims?status=Rejected');
    expect(list.body.data.every((c: any) => c.status === 'Rejected')).toBe(true);
    expect((await (await as(lab, 'doctor.mehta')).get('/api/claims')).status).toBe(403);
    expect((await (await as(lab, 'receptionist.lindqvist')).post(`/api/invoices/${id}/claims`, { amount_claimed: 1 })).status).toBe(403);
  });

  it('renders invoice PDFs that include refunds and only for permitted roles', async () => {
    const pid = await newPatient();
    const id = await invoice(pid, 80);
    const billing = await as(lab, 'billing.nakamura');
    await billing.post(`/api/invoices/${id}/payments`, { amount: 30 });
    const res = await billing.get(`/api/invoices/${id}/pdf`).buffer(true).parse((r, cb) => { const b: Buffer[] = []; r.on('data', (c: Buffer) => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const text = (res.body as Buffer).toString('latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text).toContain('Balance due');
    expect((await billing.get('/api/invoices/999999/pdf')).status).toBe(404);
    expect((await (await as(lab, 'doctor.mehta')).get(`/api/invoices/${id}/pdf`)).status).toBe(403);
  });
});

describe('operational reports', () => {
  it('summarises occupancy, waits and claims, and exports CSV and PDF', async () => {
    const admin = await as(lab, 'admin.hartley');
    const s = (await admin.get('/api/reports/summary')).body;
    expect(s.occupancy.beds).toBe(48);
    expect(s.occupancy.occupied).toBeGreaterThan(0);
    expect(s.occupancy.percent).toBe(Math.round((s.occupancy.occupied / 48) * 100));
    expect(s.waits.some((w: any) => w.area.startsWith('Emergency triage'))).toBe(true);
    expect(s.waits.some((w: any) => w.area.startsWith('Laboratory'))).toBe(true);
    expect(s.claims.length).toBeGreaterThan(0);
    expect(s.consultationsByMonth.length).toBeGreaterThan(0);

    for (const name of ['occupancy', 'collections', 'waits', 'aging', 'appointments', 'claims']) {
      const csv = await admin.get(`/api/reports/export?report=${name}&format=csv`);
      expect(csv.status, name).toBe(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      expect(csv.headers['content-disposition']).toMatch(new RegExp(`attachment; filename="${name}-\\d{4}-\\d{2}-\\d{2}\\.csv"`));
      expect(csv.text.split('\r\n').length).toBeGreaterThan(2);
    }
    expect((await admin.get('/api/reports/export?report=occupancy&format=csv')).text.split('\r\n')[0]).toBe('Ward,Department,Beds,Occupied,Occupancy %');
    const pdf = await admin.get('/api/reports/export?report=collections&format=pdf').buffer(true).parse((r, cb) => { const b: Buffer[] = []; r.on('data', (c: Buffer) => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).toString('latin1')).toContain('Collections by month');
    expect((await admin.get('/api/reports/export?report=nope')).status).toBe(400);
    expect((await admin.get('/api/reports/export?report=occupancy&format=xls')).status).toBe(400);
    const billing = await as(lab, 'billing.nakamura');
    expect((await billing.get('/api/reports/summary')).status).toBe(200);
    expect((await (await as(lab, 'nurse.okafor')).get('/api/reports/summary')).status).toBe(403);
    expect((await (await as(lab, 'doctor.mehta')).get('/api/reports/export?report=claims')).status).toBe(403);
    expect((await q("SELECT 1 FROM audit_events WHERE action='report_export'")).length).toBeGreaterThan(0);
  });
});

describe('API reference', () => {
  it('is generated from the live routes, excludes lab routes and is administrator-only', async () => {
    const admin = await as(lab, 'admin.hartley');
    const spec = (await admin.get('/api/openapi.json')).body;
    expect(spec.openapi).toBe('3.0.3');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(120);
    expect(spec.paths['/patients/{id}'].get['x-required-permissions']).toEqual(['patients.read_all', 'patients.read_scoped']);
    expect(spec.paths['/consultations/{id}/sign'].post['x-required-permissions']).toEqual(['consultations.write']);
    expect(spec.paths['/auth/login'].post.security).toEqual([]);
    expect(spec.paths['/auth/session'].get.summary).toMatch(/CSRF/);
    expect(Object.keys(spec.paths).some((p) => p.startsWith('/lab/'))).toBe(false);
    expect(spec.paths['/openapi.json']).toBeTruthy();
    for (const [p, ops] of Object.entries<any>(spec.paths)) for (const [m, op] of Object.entries<any>(ops)) expect(op.operationId, `${m} ${p}`).toBeTruthy();
    const ids = Object.values<any>(spec.paths).flatMap((ops) => Object.values<any>(ops).map((o) => o.operationId));
    expect(new Set(ids).size).toBe(ids.length);

    const page = await admin.get('/api/docs');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers['content-security-policy']).not.toContain('unsafe-eval');
    expect(page.text).toContain('/api/docs/viewer.js');
    expect((await admin.get('/api/docs/viewer.js')).status).toBe(200);

    expect((await (await as(lab, 'nurse.okafor')).get('/api/openapi.json')).status).toBe(403);
    expect((await (await as(lab, 'doctor.mehta')).get('/api/docs')).status).toBe(403);
    expect((await request(lab.app).get('/api/openapi.json')).status).toBe(401);
  });
});

describe('appointment reminders and the outbox', () => {
  it('queues one reminder per upcoming appointment, honours contact preference and lists them for administrators', async () => {
    const both = await newPatient({ email: 'both.case@patients.example.test', phone: '555-0199' });
    const smsOnly = await newPatient({ email: 'sms.case@patients.example.test', phone: '555-0198' });
    const mailOnly = await newPatient({ email: 'mail.case@patients.example.test', phone: '555-0197' });
    await q("UPDATE patients SET contact_preference='both' WHERE id=$1", [both]);
    await q("UPDATE patients SET contact_preference='sms' WHERE id=$1", [smsOnly]);
    await q("UPDATE patients SET contact_preference='email' WHERE id=$1", [mailOnly]);
    const doctor = await staff('DOC-010');
    const dept = (await q('SELECT department_id FROM staff WHERE id=$1', [doctor]))[0].department_id;
    const soon = new Date(Date.now() + 3 * 3600_000);
    const local = `${ymd(soon)}T${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}:00`;
    const far = `${inDays(5)}T10:00:00`;
    const appts: Record<string, number> = {};
    for (const [k, pid] of [['both', both], ['sms', smsOnly], ['mail', mailOnly]] as const) appts[k] = (await q('INSERT INTO appointments(patient_id,doctor_id,department_id,scheduled_at) VALUES ($1,$2,$3,$4) RETURNING id', [pid, doctor, dept, local]))[0].id;
    const farAppt = (await q('INSERT INTO appointments(patient_id,doctor_id,department_id,scheduled_at) VALUES ($1,$2,$3,$4) RETURNING id', [both, doctor, dept, far]))[0].id;
    const cancelled = (await q("INSERT INTO appointments(patient_id,doctor_id,department_id,scheduled_at,status) VALUES ($1,$2,$3,$4,'Cancelled') RETURNING id", [both, doctor, dept, local]))[0].id;

    const admin = await as(lab, 'admin.hartley');
    const run = await admin.post('/api/admin/maintenance/run');
    expect(run.status).toBe(200);
    expect(run.body.remindersQueued).toBeGreaterThanOrEqual(3);
    const channels = async (id: number) => (await q("SELECT channel, recipient FROM outbox_messages WHERE related_id=$1 AND kind='appointment_reminder' ORDER BY channel", [id])).map((m: any) => m.channel);
    expect(await channels(appts.both)).toEqual(['email', 'sms']);
    expect(await channels(appts.sms)).toEqual(['sms']);
    expect(await channels(appts.mail)).toEqual(['email']);
    expect(await channels(farAppt)).toEqual([]); // outside the 24 h window
    expect(await channels(cancelled)).toEqual([]);
    const second = await admin.post('/api/admin/maintenance/run');
    expect(second.body.remindersQueued).toBe(0); // idempotent
    expect(await channels(appts.both)).toEqual(['email', 'sms']);

    const listed = await admin.get('/api/admin/outbox/messages?channel=sms');
    expect(listed.status).toBe(200);
    expect(listed.body.data.every((m: any) => m.channel === 'sms')).toBe(true);
    expect(listed.body.data.some((m: any) => m.related_id === appts.both)).toBe(true);
    expect((await admin.get('/api/admin/outbox/messages?channel=pigeon')).status).toBe(400);
    expect((await (await as(lab, 'receptionist.lindqvist')).get('/api/admin/outbox/messages')).status).toBe(403);
    expect((await (await as(lab, 'receptionist.lindqvist')).post('/api/admin/maintenance/run')).status).toBe(403);

    // the reminder window is configurable
    await q("UPDATE system_config SET value='168' WHERE key='reminder_hours'");
    let queued = 0;
    for (let i = 0; i < 12; i++) { // reminders are sent in batches of 200, earliest appointments first
      const n = (await admin.post('/api/admin/maintenance/run')).body.remindersQueued as number;
      queued += n;
      if (n === 0) break;
    }
    expect(queued).toBeGreaterThanOrEqual(1);
    expect(await channels(farAppt)).toEqual(['email', 'sms']);
  });
});
