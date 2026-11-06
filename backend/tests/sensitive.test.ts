import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, makeLab, type Lab } from './helpers.js';

let lab: Lab;
beforeAll(async () => { lab = await makeLab('vulnerable'); });
afterAll(async () => { await lab.db.close(); });

const TEST_PANS = ['4242424242424242', '5555555555554444', '378282246309005', '6011111111111117'];

describe('fake sensitive data is clearly invalid', () => {
  it('uses never-issued SSN area numbers and processor test cards only', async () => {
    const ssn = (await lab.db.query('SELECT ssn FROM patients WHERE ssn IS NOT NULL')).rows;
    expect(ssn.length).toBeGreaterThan(100);
    for (const r of ssn) expect(r.ssn).toMatch(/^9\d{2}-\d{2}-\d{4}$/);
    const cards = (await lab.db.query('SELECT card_number FROM patient_payment_methods')).rows;
    expect(cards.length).toBeGreaterThan(50);
    for (const c of cards) expect(TEST_PANS).toContain(c.card_number);
    expect((await lab.db.query("SELECT count(*)::int AS n FROM patients WHERE insurance_provider IS NULL")).rows[0].n).toBe(0);
  });
  it('seeds procedures and vitals for the clinical tabs', async () => {
    expect((await lab.db.query('SELECT count(*)::int AS n FROM medical_procedures')).rows[0].n).toBeGreaterThan(80);
    expect((await lab.db.query('SELECT count(*)::int AS n FROM patient_vitals')).rows[0].n).toBeGreaterThanOrEqual(360);
  });
});

describe('sensitive identifiers are masked by the normal API but leak through the lab routes', () => {
  it('[control] GET /api/patients/:id never returns raw SSN, licence, policy or card data', async () => {
    const c = await as(lab, 'admin.hartley');
    const p = (await c.get('/api/patients/1')).body;
    expect(p.ssn_masked).toMatch(/^\*\*\*-\*\*-\d{4}$/);
    expect(p.insurance_policy_masked).toMatch(/^\*+\d{4}$/);
    const raw = JSON.stringify(p);
    expect(raw).not.toMatch(/\b9\d{2}-\d{2}-\d{4}\b/);
    expect(raw).not.toMatch(/card_number|4242424242424242|"ssn"|"insurance_policy_no"/);
    expect(Array.isArray(p.procedures)).toBe(true);
    expect(p.vitals.length).toBeGreaterThanOrEqual(3);
  });
  it('receptionist sees insurance but no clinical sections', async () => {
    const p = (await (await as(lab, 'receptionist.lindqvist')).get('/api/patients/1')).body;
    expect(p.insurance_provider).toBeTruthy();
    expect(p.procedures).toBeNull();
    expect(p.vitals).toBeNull();
  });
  it('[expected-vulnerability] HMS-V03 summary route returns full SSN and stored card numbers', async () => {
    const c = await as(lab, 'doctor.mehta');
    const withCard = (await lab.db.query('SELECT patient_id FROM patient_payment_methods LIMIT 1')).rows[0].patient_id;
    const r = (await c.get(`/api/lab/patients/${withCard}/summary`)).body;
    expect(r.ssn).toMatch(/^9\d{2}-\d{2}-\d{4}$/);
    expect(TEST_PANS).toContain(r.payment_methods[0].card_number);
  });
});
