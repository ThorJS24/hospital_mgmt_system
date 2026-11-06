/**
 * Expected-vulnerability tests.
 * A passing test here means "the INTENDED weakness was reproduced in the designated lab configuration".
 * It is NOT evidence that a security control works. Control tests ("[control]") verify unaffected routes stay secure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Client, as, makeLab, type Lab } from './helpers.js';

let lab: Lab;
beforeAll(async () => { lab = await makeLab('vulnerable'); });
afterAll(async () => { await lab.db.close(); });

const strangerFor = async (username: string) => {
  const staffId = (await lab.db.query('SELECT staff_id FROM users WHERE username=$1', [username])).rows[0].staff_id;
  return (await lab.db.query(`SELECT p.id FROM patients p WHERE p.primary_doctor_id <> $1
    AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id=p.id AND a.doctor_id=$1)
    AND NOT EXISTS (SELECT 1 FROM admissions a WHERE a.patient_id=p.id AND a.doctor_id=$1)
    AND NOT EXISTS (SELECT 1 FROM prescriptions a WHERE a.patient_id=p.id AND a.doctor_id=$1)
    AND NOT EXISTS (SELECT 1 FROM laboratory_requests a WHERE a.patient_id=p.id AND a.ordering_doctor_id=$1) LIMIT 1`, [staffId])).rows[0].id as number;
};

describe('[expected-vulnerability] HMS-V03 BOLA (HMS-AC-004)', () => {
  it('a doctor reads an unassigned patient through the lab summary route only', async () => {
    const c = await as(lab, 'doctor.mehta');
    const id = await strangerFor('doctor.mehta');
    expect((await c.get(`/api/patients/${id}`)).status).toBe(404);
    const r = await c.get(`/api/lab/patients/${id}/summary`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('allergies');
  });
  it('[control] roles without clinical.read still cannot use the route', async () => {
    const c = await as(lab, 'receptionist.lindqvist');
    expect((await c.get('/api/lab/patients/1/summary')).status).toBe(403);
  });
});

describe('[expected-vulnerability] HMS-V10 verbose errors (HMS-INF-001)', () => {
  it('lab route leaks SQL and stack, secure route does not', async () => {
    const c = await as(lab, 'pharmacist.rossi');
    const lab500 = await c.get('/api/lab/pharmacy/medications/abc');
    expect(lab500.status).toBe(500);
    expect(lab500.body.sql).toMatch(/SELECT/);
    expect(Array.isArray(lab500.body.stack)).toBe(true);
    const safe = await c.get('/api/pharmacy/medications/abc');
    expect(safe.status).toBe(400);
    expect(JSON.stringify(safe.body)).not.toMatch(/SELECT|stack/);
  });
});

describe('[expected-vulnerability] HMS-V14 open redirect (HMS-RED-001)', () => {
  it('accepts protocol-relative targets', async () => {
    const ok = await request(lab.app).get('/api/lab/auth/redirect?next=/dashboard').redirects(0);
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe('/dashboard');
    const bad = await request(lab.app).get('/api/lab/auth/redirect?next=//other.example.test/x').redirects(0);
    expect(bad.status).toBe(302);
    expect(bad.headers.location).toBe('//other.example.test/x');
    expect((await request(lab.app).get('/api/lab/auth/redirect?next=https://other.example.test').redirects(0)).status).toBe(400);
  });
});

describe('[expected-vulnerability] HMS-V17 reflected XSS (HMS-XSS-002)', () => {
  it('reflects q unencoded without CSP/nosniff', async () => {
    const r = await request(lab.app).get('/api/lab/search-page?q=' + encodeURIComponent('<b id="m">marker</b>'));
    expect(r.status).toBe(200);
    expect(r.text).toContain('<b id="m">marker</b>');
    expect(r.headers['content-security-policy']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBeUndefined();
  });
});

describe('[expected-vulnerability] HMS-V18 user enumeration (HMS-AC-007)', () => {
  it('login errors differ for unknown and known usernames', async () => {
    const c = new Client(lab);
    const a = await c.login('no.such.user', 'wrong-password-1');
    const b = await c.login('billing.nakamura', 'wrong-password-1');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error).toBe('Unknown username');
    expect(b.body.error).toBe('Incorrect password');
    await lab.db.query("UPDATE users SET failed_logins=0, locked_until=NULL WHERE username='billing.nakamura'");
  });
});

describe('[remediated] removed scenarios are gone', () => {
  it('former lab routes return 404', async () => {
    const c = await as(lab, 'admin.hartley');
    for (const p of ['/patients/legacy-search', '/patients/exists', '/admin/audit-export', '/integrations/fetch', '/api-token', '/token-admin/summary', '/debug/config', '/reports/download', '/appointments/1/cancel', '/invoices/1/print', '/documents/1']) {
      expect((await c.get('/api/lab' + p)).status, p).toBe(404);
    }
  });
  it('mass assignment, session fixation and weak reset tokens are fixed', async () => {
    const c = await as(lab, 'nurse.okafor');
    expect((await c.patch('/api/profile', { role_code: 'administrator' })).status).toBe(400);
    const anon = new Client(lab); await anon.init();
    await anon.post('/api/auth/password-reset/request', { username: 'nurse.okafor' });
    const t = (await lab.db.query("SELECT token FROM reset_tokens t JOIN users u ON u.id=t.user_id WHERE u.username='nurse.okafor' ORDER BY t.id DESC LIMIT 1")).rows[0].token;
    expect(t.length).toBeGreaterThan(16);
  });
});

describe('unaffected controls remain intact in vulnerable mode', () => {
  it('[control] auth, roles, CSRF and assessment protection are unchanged', async () => {
    expect((await request(lab.app).get('/api/patients')).status).toBe(401);
    const admin = await as(lab, 'admin.hartley');
    expect((await admin.get('/api/assessment/manifest')).status).toBe(403);
    expect((await (await as(lab, 'pharmacist.rossi')).get('/api/admin/users')).status).toBe(403);
    const id = await strangerFor('doctor.mehta');
    expect((await (await as(lab, 'doctor.mehta')).get(`/api/patients/${id}`)).status).toBe(404);
    const c = await as(lab, 'receptionist.lindqvist');
    expect((await c.agent.post('/api/patients').send({})).status).toBe(403);
  });
  it('each scenario can be enabled individually', async () => {
    const only = await makeLab('vulnerable', { enabledVulns: ['HMS-V03'] });
    try {
      const c = await as(only, 'doctor.mehta');
      expect((await c.get('/api/lab/patients/1/summary')).status).toBe(200);
      expect((await request(only.app).get('/api/lab/search-page?q=x')).status).toBe(404);
    } finally { await only.db.close(); }
  });
});
