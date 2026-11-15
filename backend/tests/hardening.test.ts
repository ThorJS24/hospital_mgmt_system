import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { as, Client, makeLab, passwordOf, type Lab } from './helpers.js';
import { loadConfig } from '../src/config/index.js';
import { connect, migrate } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { randomizedAccounts, seedAll } from '../src/db/seed.js';
import { burnPasswordCheck, hashPassword, needsRehash, safeEqual, verifyPassword } from '../src/utils/crypto.js';

let lab: Lab;
beforeAll(async () => { lab = await makeLab('secure'); });
afterAll(async () => { await lab.db.close(); });
const q = async <T = any>(sql: string, params: unknown[] = []) => (await lab.db.query<T>(sql, params)).rows;

describe('password hashing', () => {
  it('stores the work factor, verifies, normalises Unicode and rejects malformed hashes', async () => {
    const h = await hashPassword('Quiet-River-Maple-Lantern');
    expect(h.split('$')).toHaveLength(6);
    expect(needsRehash(h)).toBe(false);
    expect(await verifyPassword('Quiet-River-Maple-Lantern', h)).toBe(true);
    expect(await verifyPassword('quiet-river-maple-lantern', h)).toBe(false);
    // the same visible text in two Unicode forms is the same password
    const composed = await hashPassword('café-café-café-café');
    expect(await verifyPassword('café-café-café-café', composed)).toBe(true);
    for (const bad of ['', 'plain', 'scrypt$1$2', 'scrypt$1$8$1$aa$bb', 'bcrypt$x$y', 'scrypt$4096$8$1$$']) expect(await verifyPassword('x', bad), bad).toBe(false);
    expect(await verifyPassword('x', 'scrypt$4096$8$1$' + 'ab'.repeat(16) + '$' + 'cd'.repeat(32))).toBe(false);
    expect(await burnPasswordCheck('anything')).toBe(false);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('upgrades a legacy hash to the current format at the next successful sign-in', async () => {
    const salt = randomBytes(16);
    const legacy = `scrypt$${salt.toString('hex')}$${scryptSync('Old-School-Password-123', salt, 32).toString('hex')}`; // pre-upgrade format, N=16384
    expect(needsRehash(legacy)).toBe(true);
    expect(await verifyPassword('Old-School-Password-123', legacy)).toBe(true);
    await q("UPDATE users SET password_hash=$1 WHERE username='labtech.alvarez'", [legacy]);
    const c = new Client(lab);
    expect((await c.login('labtech.alvarez', 'wrong-password-here')).status).toBe(401);
    expect((await q("SELECT password_hash FROM users WHERE username='labtech.alvarez'"))[0].password_hash).toBe(legacy); // a failed attempt changes nothing
    expect((await c.login('labtech.alvarez', 'Old-School-Password-123')).status).toBe(200);
    const upgraded = (await q("SELECT password_hash FROM users WHERE username='labtech.alvarez'"))[0].password_hash as string;
    expect(upgraded).not.toBe(legacy);
    expect(upgraded.split('$')).toHaveLength(6);
    expect(await verifyPassword('Old-School-Password-123', upgraded)).toBe(true);
    await q("UPDATE users SET password_hash=$1 WHERE username='labtech.alvarez'", [await hashPassword(passwordOf('labtech.alvarez'))]);
  });

  it('answers unknown, disabled and wrong-password sign-ins identically', async () => {
    await q("UPDATE users SET active=false WHERE username='billing.nakamura'");
    const msgs = new Set<string>();
    for (const [u, p] of [['nobody.at.all', 'whatever-password-1'], ['billing.nakamura', passwordOf('billing.nakamura')], ['pharmacist.rossi', 'wrong-password-123']] as const) {
      const r = await new Client(lab).login(u, p);
      expect(r.status).toBe(401);
      msgs.add(r.body.error);
    }
    expect([...msgs]).toEqual(['Invalid username or password']);
    await q("UPDATE users SET active=true WHERE username='billing.nakamura'");
    await q("UPDATE users SET failed_logins=0, locked_until=NULL WHERE username='pharmacist.rossi'");
  });
});

describe('password lifecycle', () => {
  it('remembers recent passwords, refuses reuse of the current one and stores only hashes', async () => {
    const c = await as(lab, 'receptionist.lindqvist');
    const change = (cur: string, next: string) => c.post('/api/profile/password', { current_password: cur, new_password: next });
    const p0 = passwordOf('receptionist.lindqvist');
    const p1 = 'Granite-Falcon-Orchard-11', p2 = 'Granite-Falcon-Orchard-22', p3 = 'Granite-Falcon-Orchard-33';
    const reuseCurrent = await change(p0, p0);
    expect(reuseCurrent.status).toBe(400); // too short for the new policy AND the same as the current one
    expect((await change('not-my-password-123', p1)).status).toBe(400); // wrong current password
    expect((await q("SELECT 1 FROM audit_events WHERE action='password_change_failed'")).length).toBeGreaterThan(0);
    expect((await change(p0, p1)).status).toBe(200);
    expect((await change(p1, p1)).status).toBe(400);
    expect((await change(p1, p2)).status).toBe(200);
    const again = await change(p2, p1);
    expect(again.status).toBe(400);
    expect(again.body.details[0].message).toMatch(/not used recently/);
    expect((await change(p2, p3)).status).toBe(200);
    const hist = await q("SELECT password_hash FROM password_history WHERE user_id=(SELECT id FROM users WHERE username='receptionist.lindqvist')");
    expect(hist).toHaveLength(3);
    expect(hist.every((r: any) => /^scrypt\$\d+\$8\$\d+\$[0-9a-f]+\$[0-9a-f]+$/.test(r.password_hash))).toBe(true);
    expect((await q("SELECT password_changed_at > now() - interval '1 minute' AS fresh FROM users WHERE username='receptionist.lindqvist'"))[0].fresh).toBe(true);
    // history is bounded
    for (let i = 4; i <= 9; i++) expect((await change(i === 4 ? p3 : `Granite-Falcon-Orchard-${i - 1}${i - 1}`, `Granite-Falcon-Orchard-${i}${i}`)).status).toBe(200);
    expect((await q("SELECT count(*)::int AS n FROM password_history WHERE user_id=(SELECT id FROM users WHERE username='receptionist.lindqvist')"))[0].n).toBe(5);
    await q("UPDATE users SET password_hash=$1 WHERE username='receptionist.lindqvist'", [await hashPassword(passwordOf('receptionist.lindqvist'))]);
  });

  it('forces a change at first sign-in for administrator-created accounts, and only allows what is needed to do it', async () => {
    const admin = await as(lab, 'admin.hartley');
    expect((await admin.post('/api/admin/users', { username: 'temp.clerk', full_name: 'Temp Clerk', email: 'temp.clerk@example.test', role: 'receptionist', password: 'temp.clerk-2026-pass' })).status).toBe(400); // contains the username
    expect((await admin.post('/api/admin/users', { username: 'temp.clerk', full_name: 'Temp Clerk', email: 'temp.clerk@example.test', role: 'receptionist', password: 'Willow-Anchor-Pebble-42' })).status).toBe(201);
    expect((await q("SELECT must_change_password FROM users WHERE username='temp.clerk'"))[0].must_change_password).toBe(true);
    const c = new Client(lab);
    const r = await c.login('temp.clerk', 'Willow-Anchor-Pebble-42');
    expect(r.body.user.mustChangePassword).toBe(true);
    for (const url of ['/api/patients', '/api/dashboard', '/api/notifications', '/api/search?q=abc', '/api/live/recent']) {
      const x = await c.get(url);
      expect(x.status, url).toBe(403);
      expect(x.body.details).toEqual({ code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    expect((await c.get('/api/auth/session')).body.user.mustChangePassword).toBe(true);
    expect((await c.post('/api/profile/password', { current_password: 'Willow-Anchor-Pebble-42', new_password: 'Willow-Anchor-Pebble-42' })).status).toBe(400); // must be different
    expect((await c.post('/api/profile/password', { current_password: 'Willow-Anchor-Pebble-42', new_password: 'Cobalt-Meadow-Lighthouse-7' })).status).toBe(200);
    expect((await c.get('/api/patients')).status).toBe(200);
    expect((await c.get('/api/auth/session')).body.user.mustChangePassword).toBe(false);
    // an administrator can also require a change for an existing account
    await q("UPDATE users SET must_change_password=true WHERE username='temp.clerk'");
    expect((await c.get('/api/patients')).status).toBe(403);
    const out = await c.post('/api/auth/logout');
    expect(out.status).toBe(200);
  });
});

describe('request guards', () => {
  it('rejects cross-site state changes using Origin and Fetch Metadata, even with a valid token', async () => {
    const c = await as(lab, 'receptionist.lindqvist');
    const attempt = (headers: Record<string, string>) => c.agent.post('/api/appointments/1/status').set('x-csrf-token', c.csrf).set('Host', 'hms.local:8443').set(headers).send({ status: 'Cancelled' });
    const host = 'hms.local:8443'; // supertest uses a new port per request, so pin the Host header
    for (const h of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { Origin: 'http://hms.local.evil.example:8443' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
      const r = await attempt(h);
      expect(r.status, JSON.stringify(h)).toBe(403);
      expect(r.body.error).toBe('Missing or invalid CSRF token');
    }
    // same-origin browsers and token-bearing API clients are fine (the request gets past the guard: 404/409/403 from the route, not the CSRF 403)
    const ok = await attempt({ Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' });
    expect(ok.body.error).not.toBe('Missing or invalid CSRF token');
    expect((await c.agent.post('/api/notifications/read-all').set('x-csrf-token', 'wrong-token')).status).toBe(403);
    expect((await c.agent.post('/api/notifications/read-all').set('x-csrf-token', c.csrf)).status).toBe(200);
  });

  it('allows an explicitly configured origin', async () => {
    const other = await makeLab('secure', { allowedOrigins: ['https://hms.example.test'] });
    try {
      const c = await as(other, 'receptionist.lindqvist');
      const r = await c.agent.post('/api/notifications/read-all').set('x-csrf-token', c.csrf).set('Origin', 'https://hms.example.test').set('Sec-Fetch-Site', 'cross-site');
      expect(r.status).toBe(200);
      expect((await c.agent.post('/api/notifications/read-all').set('x-csrf-token', c.csrf).set('Origin', 'https://other.example.test')).status).toBe(403);
    } finally { await other.db.close(); }
  });

  it('rate-limits sign-in and password-reset endpoints per client, and the API as a whole', async () => {
    const tight = await makeLab('secure', { rateLimit: { authMax: 4, authWindowMs: 60_000, apiMax: 40, apiWindowMs: 60_000 } });
    try {
      const c = new Client(tight);
      await c.init();
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await c.agent.post('/api/auth/login').set('x-csrf-token', c.csrf).send({ username: 'nobody', password: 'x'.repeat(16) })).status);
      expect(codes).toEqual([401, 401, 401, 401, 429, 429]);
      const limited = await c.agent.post('/api/auth/password-reset/request').set('x-csrf-token', c.csrf).send({ username: 'nobody' });
      expect(limited.status).toBe(429); // the auth budget is shared by the sign-in and reset endpoints
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(limited.headers['ratelimit-limit']).toBe('4');
      expect(limited.body.error).toMatch(/Too many requests/);
      // a blocked client creates no sessions and reaches no handlers
      const before = (await tight.db.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n;
      for (let i = 0; i < 3; i++) await request(tight.app).post('/api/auth/login').send({});
      expect((await tight.db.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n).toBe(before);
      // the general API limit
      let last = 0;
      for (let i = 0; i < 60 && last !== 429; i++) last = (await request(tight.app).get('/api/auth/session')).status;
      expect(last).toBe(429);
      expect((await request(tight.app).get('/api/health')).status).toBe(200); // health checks are not throttled
    } finally { await tight.db.close(); }
  });
});

describe('transport and browser hardening', () => {
  it('sends the full set of security headers on API responses', async () => {
    const r = await request(lab.app).get('/api/auth/session');
    expect(r.headers).toMatchObject({
      'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
      'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin', 'x-permitted-cross-domain-policies': 'none',
    });
    expect(r.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    expect(r.headers['permissions-policy']).toContain('camera=()');
    expect(r.headers['strict-transport-security']).toBeUndefined(); // plain-HTTP development
    expect(r.headers['x-powered-by']).toBeUndefined();
    const cookie = (r.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toMatch(/^sid=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect((await request(lab.app).get('/api/nope')).headers['content-security-policy']).toBeTruthy();
  });

  it('uses a Secure __Host- cookie and HSTS when served over HTTPS', async () => {
    const https = await makeLab('secure', { cookieSecure: true });
    try {
      const r = await request(https.app).get('/api/auth/session');
      const cookie = (r.headers['set-cookie'] as unknown as string[])[0];
      expect(cookie).toMatch(/^__Host-sid=/);
      expect(cookie).toMatch(/; Secure/);
      expect(cookie).toMatch(/Path=\//);
      expect(cookie).not.toMatch(/Domain=/);
      expect(r.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
      // a session cookie under the old name is not accepted
      const sid = (await https.db.query('SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1')).rows[0].id;
      const spoof = await request(https.app).get('/api/auth/session').set('Cookie', `sid=${sid}`);
      expect((spoof.headers['set-cookie'] as unknown as string[])[0]).toMatch(/^__Host-sid=/); // issued a fresh anonymous session instead
    } finally { await https.db.close(); }
  });

  it('honours the proxy setting for the client address, and ignores forwarded headers otherwise', async () => {
    const proxied = await makeLab('secure', { trustProxy: '1' });
    try {
      const c = new Client(proxied);
      await c.init();
      await c.agent.post('/api/auth/login').set('x-csrf-token', c.csrf).set('X-Forwarded-For', '203.0.113.7').send({ username: 'doctor.mehta', password: passwordOf('doctor.mehta') });
      expect((await proxied.db.query("SELECT ip FROM audit_events WHERE action='login' ORDER BY id DESC LIMIT 1")).rows[0].ip).toBe('203.0.113.7');
    } finally { await proxied.db.close(); }
    const c = new Client(lab);
    await c.init();
    await c.agent.post('/api/auth/login').set('x-csrf-token', c.csrf).set('X-Forwarded-For', '203.0.113.9').send({ username: 'doctor.mehta', password: passwordOf('doctor.mehta') });
    expect((await q("SELECT ip FROM audit_events WHERE action='login' ORDER BY id DESC LIMIT 1"))[0].ip).not.toContain('203.0.113.9');
  });

  it('serves the built front end with a strict CSP and an SPA fallback, and keeps /api for the API', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medicore-fe-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/assets/app.js"></script>');
    fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
    fs.writeFileSync(path.join(os.tmpdir(), 'medicore-secret.txt'), 'top secret');
    const web = await makeLab('secure', { serveFrontend: true, frontendDir: dir });
    try {
      const page = await request(web.app).get('/patients/12');
      expect(page.status).toBe(200);
      expect(page.text).toContain('id="root"');
      const csp = page.headers['content-security-policy'];
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain('unsafe-eval');
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(page.headers['x-content-type-options']).toBe('nosniff');
      const asset = await request(web.app).get('/assets/app.js');
      expect(asset.headers['cache-control']).toMatch(/immutable/);
      expect((await request(web.app).get('/api/not-a-route')).body.error).toBe('Not found'); // not swallowed by the SPA fallback
      expect((await request(web.app).get('/%2e%2e/medicore-secret.txt')).text).not.toContain('top secret');
      expect((await request(web.app).get('/..%2fmedicore-secret.txt')).text).not.toContain('top secret');
      expect((await request(web.app).post('/anything').send({})).status).toBe(404);
    } finally { await web.db.close(); }
  });
});

describe('sessions', () => {
  it('ends a session after its absolute lifetime even if it is still being used', async () => {
    const c = await as(lab, 'nurse.okafor');
    expect((await c.get('/api/dashboard')).status).toBe(200);
    await q("UPDATE sessions SET created_at = now() - interval '13 hours' WHERE user_id=(SELECT id FROM users WHERE username='nurse.okafor')");
    expect((await c.get('/api/dashboard')).status).toBe(401);
    // and an idle one expires too
    const d = await as(lab, 'nurse.okafor');
    await q("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id=(SELECT id FROM users WHERE username='nurse.okafor')");
    expect((await d.get('/api/dashboard')).status).toBe(401);
  });
});

describe('audit trail', () => {
  it('is append-only at the database level', async () => {
    const id = (await q('SELECT max(id) AS id FROM audit_events'))[0].id;
    await expect(lab.db.query("UPDATE audit_events SET detail='tampered' WHERE id=$1", [id])).rejects.toThrow(/append-only/);
    await expect(lab.db.query('DELETE FROM audit_events WHERE id=$1', [id])).rejects.toThrow(/append-only/);
    await expect(lab.db.query('DELETE FROM audit_events')).rejects.toThrow(/append-only/);
    expect((await lab.db.query("INSERT INTO audit_events(action,entity) VALUES ('test_append','system') RETURNING id")).rows).toHaveLength(1);
  });

  it('records who viewed which clinical record, from where', async () => {
    const doc = await as(lab, 'doctor.mehta');
    const pid = (await q("SELECT id FROM patients WHERE primary_doctor_id=(SELECT staff_id FROM users WHERE username='doctor.mehta') LIMIT 1"))[0].id;
    expect((await doc.get(`/api/patients/${pid}`)).status).toBe(200);
    const ev = (await q("SELECT user_id, entity, entity_id, ip, request_id FROM audit_events WHERE action='patient_view' ORDER BY id DESC LIMIT 1"))[0];
    expect(ev).toMatchObject({ entity: 'patient', entity_id: String(pid) });
    expect(ev.ip).not.toBe('');
    expect(ev.request_id).toBeTruthy();
    expect(ev.user_id).toBe((await q("SELECT id FROM users WHERE username='doctor.mehta'"))[0].id);
    // a refused read is not logged as a view
    const before = (await q("SELECT count(*)::int AS n FROM audit_events WHERE action='patient_view'"))[0].n;
    const stranger = (await q("SELECT id FROM patients WHERE primary_doctor_id <> (SELECT staff_id FROM users WHERE username='doctor.mehta') AND id NOT IN (SELECT patient_id FROM appointments WHERE doctor_id=(SELECT staff_id FROM users WHERE username='doctor.mehta')) AND id NOT IN (SELECT patient_id FROM admissions WHERE doctor_id=(SELECT staff_id FROM users WHERE username='doctor.mehta')) AND id NOT IN (SELECT patient_id FROM prescriptions WHERE doctor_id=(SELECT staff_id FROM users WHERE username='doctor.mehta')) AND id NOT IN (SELECT patient_id FROM laboratory_requests WHERE ordering_doctor_id=(SELECT staff_id FROM users WHERE username='doctor.mehta')) LIMIT 1"))[0].id;
    expect((await doc.get(`/api/patients/${stranger}`)).status).toBe(404);
    expect((await q("SELECT count(*)::int AS n FROM audit_events WHERE action='patient_view'"))[0].n).toBe(before);
  });
});

describe('first run in production', () => {
  it('creates the accounts with random one-time passwords that must be changed, never the published ones', async () => {
    const cfg = loadConfig({ NODE_ENV: 'production' });
    expect(cfg.production).toBe(true);
    expect(cfg.cookieSecure).toBe(true); // Secure + __Host- cookie by default in production
    const db = await connect(cfg, true);
    await migrate(db);
    const accounts = randomizedAccounts();
    await seedAll(db, cfg, { accounts, mustChangePassword: true });
    const app = createApp(db, { ...cfg, cookieSecure: false });
    const probe = { app, db, cfg: { ...cfg, cookieSecure: false } } as Lab;
    try {
      expect(accounts.every((a) => a.password.length >= 38)).toBe(true);
      expect(new Set(accounts.map((a) => a.password)).size).toBe(accounts.length);
      expect((await new Client(probe).login('admin.hartley', passwordOf('admin.hartley'))).status).toBe(401); // the published password does not exist here
      const c = new Client(probe);
      const admin = accounts.find((a) => a.username === 'admin.hartley')!;
      const r = await c.login(admin.username, admin.password);
      expect(r.body.user.mustChangePassword).toBe(true);
      expect((await c.get('/api/admin/users')).status).toBe(403);
      expect((await db.query('SELECT count(*)::int AS n FROM users WHERE must_change_password')).rows[0].n).toBe(accounts.length);
    } finally { await db.close(); }
  });
});
