import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { as, Client, makeLab, passwordOf, type Lab } from './helpers.js';
import { currentStep, hotp } from '../src/services/totp.js';

let lab: Lab;
beforeAll(async () => { lab = await makeLab('secure'); });
afterAll(async () => { await lab.db.close(); });

const q = async <T = any>(sql: string, params: unknown[] = []) => (await lab.db.query<T>(sql, params)).rows;
const code = (secret: string, offset = 0) => hotp(secret, currentStep() + offset);

async function enable2fa(username: string) {
  const c = await as(lab, username);
  const setup = await c.post('/api/auth/2fa/setup');
  expect(setup.status).toBe(200);
  const enabled = await c.post('/api/auth/2fa/enable', { code: code(setup.body.secret) });
  expect(enabled.status).toBe(200);
  return { c, secret: setup.body.secret as string, recovery: enabled.body.recoveryCodes as string[] };
}

describe('two-factor authentication', () => {
  it('sets up, requires a valid code to enable and issues single-use recovery codes', async () => {
    const c = await as(lab, 'billing.nakamura');
    expect((await c.get('/api/auth/2fa/status')).body).toEqual({ enabled: false, recoveryCodesLeft: 0 });
    expect((await c.post('/api/auth/2fa/enable', { code: '123456' })).status).toBe(409); // setup first
    const setup = await c.post('/api/auth/2fa/setup');
    expect(setup.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.body.otpauth).toContain('otpauth://totp/MediCore%20HMS:billing.nakamura');
    expect((await c.post('/api/auth/2fa/enable', { code: 'abc' })).status).toBe(400);
    const wrong = hotp(setup.body.secret, currentStep() + 5);
    expect((await c.post('/api/auth/2fa/enable', { code: wrong })).status).toBe(400);
    expect((await c.get('/api/auth/2fa/status')).body.enabled).toBe(false);

    const ok = await c.post('/api/auth/2fa/enable', { code: code(setup.body.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.recoveryCodes).toHaveLength(10);
    expect(new Set(ok.body.recoveryCodes).size).toBe(10);
    expect(ok.body.recoveryCodes[0]).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect((await c.get('/api/auth/2fa/status')).body).toEqual({ enabled: true, recoveryCodesLeft: 10 });
    expect((await c.post('/api/auth/2fa/setup')).status).toBe(409);
    // recovery codes are stored hashed, never in clear text
    const stored = (await q('SELECT code_hash FROM recovery_codes')).map((r: any) => r.code_hash);
    expect(stored.some((h: string) => ok.body.recoveryCodes.includes(h))).toBe(false);
    expect((await c.get('/api/auth/session')).body.user.totpEnabled).toBe(true);
    expect(JSON.stringify((await c.get('/api/auth/session')).body)).not.toContain(setup.body.secret); // the secret never comes back
  });

  it('withholds the session until the second factor is proven, and rejects replays and wrong codes', async () => {
    const { secret } = await enable2fa('pharmacist.rossi');
    const c = new Client(lab);
    await c.init();
    const first = await c.login('pharmacist.rossi');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ authenticated: false, twoFactorRequired: true });
    expect(first.body.csrfToken).toBeUndefined();
    expect((await c.get('/api/pharmacy/medications')).status).toBe(401); // no session yet
    expect((await c.get('/api/auth/session')).body.authenticated).toBe(false);

    const post = (body: unknown) => c.agent.post('/api/auth/login/2fa').set('x-csrf-token', c.csrf).send(body as object);
    expect((await post({ challenge: 'bogus', code: '123456' })).status).toBe(401);
    expect((await post({ challenge: first.body.challenge, code: '000000' })).status).toBe(401);
    expect((await post({ challenge: first.body.challenge, code: 'zzzzzz' })).status).toBe(401);
    const good = await post({ challenge: first.body.challenge, code: code(secret, 1) }); // next step: newer than the one used to enable
    expect(good.status).toBe(200);
    expect(good.body.authenticated).toBe(true);
    c.csrf = good.body.csrfToken;
    expect((await c.get('/api/pharmacy/medications')).status).toBe(200);
    expect((await post({ challenge: first.body.challenge, code: code(secret, 1) })).status).toBe(401); // challenge is consumed

    // the same code cannot be used twice, even on a fresh challenge
    const c2 = new Client(lab);
    const second = await c2.login('pharmacist.rossi');
    const replay = await c2.agent.post('/api/auth/login/2fa').set('x-csrf-token', c2.csrf).send({ challenge: second.body.challenge, code: code(secret, 1) });
    expect(replay.status).toBe(401);
    const fresh = await c2.agent.post('/api/auth/login/2fa').set('x-csrf-token', c2.csrf).send({ challenge: second.body.challenge, code: code(secret, 2) });
    expect(fresh.status).toBe(401); // outside the +/-1 window relative to now
    expect((await q("SELECT 1 FROM audit_events WHERE action='login_2fa_failed'")).length).toBeGreaterThan(0);
  });

  it('limits guesses per challenge and expires challenges', async () => {
    const { secret } = await enable2fa('labtech.alvarez');
    const c = new Client(lab);
    const r = await c.login('labtech.alvarez');
    const post = (body: unknown) => c.agent.post('/api/auth/login/2fa').set('x-csrf-token', c.csrf).send(body as object);
    for (let i = 0; i < 5; i++) expect((await post({ challenge: r.body.challenge, code: '111111' })).status).toBe(401);
    const locked = await post({ challenge: r.body.challenge, code: code(secret, 1) });
    expect(locked.status).toBe(429); // even the right code no longer works
    expect((await post({ challenge: r.body.challenge, code: code(secret, 1) })).status).toBe(401); // challenge deleted

    const r2 = await c.login('labtech.alvarez');
    await q("UPDATE login_challenges SET expires_at = now() - interval '1 minute' WHERE id=$1", [r2.body.challenge]);
    expect((await post({ challenge: r2.body.challenge, code: code(secret, 1) })).status).toBe(401);
  });

  it('accepts each recovery code exactly once and lets the user regenerate or disable', async () => {
    const { c, secret, recovery } = await enable2fa('nurse.okafor');
    const login = async (codeOrRecovery: string) => {
      const x = new Client(lab);
      const r = await x.login('nurse.okafor');
      return x.agent.post('/api/auth/login/2fa').set('x-csrf-token', x.csrf).send({ challenge: r.body.challenge, code: codeOrRecovery });
    };
    expect((await login(recovery[0])).status).toBe(200);
    expect((await login(recovery[0])).status).toBe(401); // used
    expect((await login(recovery[1].replace('-', '').toUpperCase())).status).toBe(200); // hyphen and case are not significant
    expect((await c.get('/api/auth/2fa/status')).body.recoveryCodesLeft).toBe(8);

    const pw = passwordOf('nurse.okafor');
    expect((await c.post('/api/auth/2fa/recovery-codes', { password: 'wrong', code: code(secret, 1) })).status).toBe(400);
    const regen = await c.post('/api/auth/2fa/recovery-codes', { password: pw, code: recovery[2] });
    expect(regen.status).toBe(200);
    expect(regen.body.recoveryCodes).toHaveLength(10);
    expect((await login(recovery[3])).status).toBe(401); // old codes are void

    expect((await c.post('/api/auth/2fa/disable', { password: 'wrong', code: regen.body.recoveryCodes[0] })).status).toBe(400);
    expect((await c.post('/api/auth/2fa/disable', { password: pw, code: '000000' })).status).toBe(400);
    expect((await c.post('/api/auth/2fa/disable', { password: pw, code: regen.body.recoveryCodes[0] })).status).toBe(200);
    expect((await c.get('/api/auth/2fa/status')).body).toEqual({ enabled: false, recoveryCodesLeft: 0 });
    const plain = new Client(lab);
    expect((await plain.login('nurse.okafor')).body.authenticated).toBe(true); // password alone again
    expect((await c.post('/api/auth/2fa/disable', { password: pw, code: '123456' })).status).toBe(409);
  });

  it('requires authentication for every 2FA management call', async () => {
    for (const [m, url] of [['post', '/api/auth/2fa/setup'], ['post', '/api/auth/2fa/enable'], ['post', '/api/auth/2fa/disable'], ['get', '/api/auth/2fa/status'], ['post', '/api/auth/2fa/recovery-codes']] as const) {
      const agent = request.agent(lab.app);
      const session = await agent.get('/api/auth/session');
      const res = m === 'get' ? await agent.get(url) : await agent.post(url).set('x-csrf-token', session.body.csrfToken).send({});
      expect(res.status, url).toBe(401);
    }
  });
});

describe('active sessions', () => {
  it('lists the caller\'s sessions without exposing session ids and can revoke the others', async () => {
    const a = await as(lab, 'receptionist.lindqvist');
    const b = await as(lab, 'receptionist.lindqvist');
    const other = await as(lab, 'doctor.mehta');
    const list = await a.get('/api/auth/sessions');
    expect(list.body.data.length).toBeGreaterThanOrEqual(2);
    expect(list.body.data.filter((s: any) => s.current)).toHaveLength(1);
    expect(list.body.data[0].ref).toMatch(/^[0-9a-f]{16}$/);
    const cookieIds = (await q("SELECT id FROM sessions WHERE user_id=(SELECT id FROM users WHERE username='receptionist.lindqvist')")).map((r: any) => r.id);
    expect(JSON.stringify(list.body)).not.toContain(cookieIds[0]);
    expect(list.body.data.every((s: any) => !('id' in s))).toBe(true);
    expect(list.body.data[0]).toHaveProperty('user_agent');

    const currentRef = list.body.data.find((s: any) => s.current).ref;
    expect((await a.delete(`/api/auth/sessions/${currentRef}`)).status).toBe(409);
    expect((await a.delete('/api/auth/sessions/0123456789abcdef')).status).toBe(404);
    const otherRef = (await other.get('/api/auth/sessions')).body.data[0].ref;
    expect((await a.delete(`/api/auth/sessions/${otherRef}`)).status).toBe(404); // another user's session

    const bRef = (await b.get('/api/auth/sessions')).body.data.find((s: any) => s.current).ref;
    expect((await a.delete(`/api/auth/sessions/${bRef}`)).status).toBe(200);
    expect((await b.get('/api/patients')).status).toBe(401);
    expect((await a.get('/api/patients')).status).toBe(200);

    const c3 = await as(lab, 'receptionist.lindqvist');
    const revoked = await a.post('/api/auth/sessions/revoke-others');
    expect(revoked.body.revoked).toBeGreaterThanOrEqual(1);
    expect((await c3.get('/api/patients')).status).toBe(401);
    expect((await a.get('/api/patients')).status).toBe(200);
    expect((await other.get('/api/patients')).status).toBe(200); // other users untouched
  });

  it('stores client details for display and rotates the session identifier at login', async () => {
    const c = new Client(lab);
    await c.init();
    const before = (await q('SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1'))[0].id;
    const r = await c.agent.post('/api/auth/login').set('x-csrf-token', c.csrf).set('user-agent', 'MediCoreTest/1.0').send({ username: 'billing.nakamura', password: passwordOf('billing.nakamura') });
    expect(r.status === 200 || r.body.twoFactorRequired).toBeTruthy();
    if (r.body.authenticated) {
      const row = (await q("SELECT id, user_agent FROM sessions WHERE user_id=(SELECT id FROM users WHERE username='billing.nakamura') ORDER BY created_at DESC LIMIT 1"))[0];
      expect(row.user_agent).toBe('MediCoreTest/1.0');
      expect(row.id).not.toBe(before);
    }
  });
});

describe('password policy', () => {
  it('rejects weak or personal passwords on change and on reset, and accepts a strong one', async () => {
    const c = await as(lab, 'doctor.svensson');
    const change = (p: string) => c.post('/api/profile/password', { current_password: passwordOf('doctor.svensson'), new_password: p });
    for (const weak of ['short1A!', 'alllowercaseletters', 'ALLUPPERCASELETTERS', '1234567890123', 'Doctor.Svensson-2026', 'Welcome-Home-1']) {
      const r = await change(weak);
      expect(r.status, weak).toBe(400);
    }
    const detail = (await change('alllowercaseletters')).body.details;
    expect(detail[0].message).toMatch(/three of/);
    expect((await change('Blue-Harbor-2026')).status).toBe(200);

    const anon = request.agent(lab.app);
    const s = await anon.get('/api/auth/session');
    await anon.post('/api/auth/password-reset/request').set('x-csrf-token', s.body.csrfToken).send({ username: 'doctor.svensson' });
    const token = (await q("SELECT token FROM reset_tokens WHERE user_id=(SELECT id FROM users WHERE username='doctor.svensson') AND NOT used ORDER BY id DESC LIMIT 1"))[0].token;
    const reset = (pw: string) => anon.post('/api/auth/password-reset/confirm').set('x-csrf-token', s.body.csrfToken).send({ username: 'doctor.svensson', token, new_password: pw });
    expect((await reset('weak')).status).toBe(400);
    expect((await reset('Green-Meadow-2027')).status).toBe(200);
    const login = new Client(lab);
    expect((await login.login('doctor.svensson', 'Green-Meadow-2027')).status).toBe(200);
  });
});
