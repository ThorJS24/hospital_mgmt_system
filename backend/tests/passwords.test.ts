import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, Client, makeLab, passwordOf, type Lab } from './helpers.js';
import { restoreDemoPasswords } from '../src/db/passwords.js';
import { currentStep, hotp } from '../src/services/totp.js';

let lab: Lab;
beforeAll(async () => { lab = await makeLab('secure'); });
afterAll(async () => { await lab.db.close(); });

describe('restoring demo passwords', () => {
  it('recovers an admin who changed the password, enabled 2FA and got locked out, leaving other accounts alone', async () => {
    const admin = await as(lab, 'admin.hartley');
    expect((await admin.post('/api/profile/password', { current_password: passwordOf('admin.hartley'), new_password: 'Forgotten-Pass-77x' })).status).toBe(200);
    const setup = await admin.post('/api/auth/2fa/setup');
    await admin.post('/api/auth/2fa/enable', { code: hotp(setup.body.secret, currentStep()) });
    for (let i = 0; i < 5; i++) await new Client(lab).login('admin.hartley', 'wrong-guess-1');
    expect((await new Client(lab).login('admin.hartley', passwordOf('admin.hartley'))).status).toBe(429);

    const doc = await as(lab, 'doctor.mehta');
    const r = await restoreDemoPasswords(lab.db, ['admin.hartley', 'nobody.here', 'not-seeded']);
    expect(r.restored).toEqual(['admin.hartley']);
    expect(r.unknown.sort()).toEqual(['nobody.here', 'not-seeded']);

    const back = await new Client(lab).login('admin.hartley');
    expect(back.status).toBe(200);
    expect(back.body.authenticated).toBe(true); // no 2FA prompt any more
    expect((await new Client(lab).login('admin.hartley', 'Forgotten-Pass-77x')).status).toBe(401);
    expect((await admin.get('/api/patients')).status).toBe(401); // old sessions were closed
    expect((await doc.get('/api/patients')).status).toBe(200); // someone else's session untouched
    expect((await lab.db.query("SELECT 1 FROM audit_events WHERE action='demo_password_restored'")).rows.length).toBe(1);
  });

  it('restores every demo account when no name is given, including a deactivated one', async () => {
    await lab.db.query("UPDATE users SET active=false WHERE username='nurse.okafor'");
    await lab.db.query("UPDATE users SET password_hash='x' WHERE username IN ('doctor.mehta','patient.portal')");
    const r = await restoreDemoPasswords(lab.db);
    expect(r.restored).toHaveLength(10);
    for (const u of ['nurse.okafor', 'doctor.mehta', 'patient.portal']) expect((await new Client(lab).login(u)).status, u).toBe(200);
  });
});
