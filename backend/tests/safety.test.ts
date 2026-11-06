import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ROOT } from '../src/config/index.js';
import { seedClinical } from '../src/db/seed.js';
import { as, makeLab, type Lab } from './helpers.js';

let lab: Lab;
beforeAll(async () => { lab = await makeLab('vulnerable'); });
afterAll(async () => { await lab.db.close(); });

const walk = (dir: string, out: string[] = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', '.pglite', 'out', 'files'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};

describe('assessment data is not publicly served', () => {
  it('has no static file serving for manifest, evidence, lab data or uploads', async () => {
    for (const url of ['/vulnerabilities.json', '/assessment/manifest/vulnerabilities.json', '/assessment/evidence/', '/lab-data/restricted-docs/formulary-internal.txt', '/api/manifest', '/api/lab/../assessment/manifest'])
      expect((await request(lab.app).get(url)).status, url).toBe(404);
  });
  it('keeps evidence/manifest outside the frontend tree', () => {
    expect(lab.cfg.evidenceDir.startsWith(path.join(ROOT, 'frontend'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'frontend', 'public', 'vulnerabilities.json'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'frontend', 'dist', 'vulnerabilities.json'))).toBe(false);
  });
});

describe('synthetic data only', () => {
  it('uses reserved/fictional identifiers everywhere', async () => {
    const { rows } = await lab.db.query('SELECT mrn, email, phone FROM patients');
    expect(rows).toHaveLength(120);
    for (const p of rows) {
      expect(p.mrn).toMatch(/^SYN-\d{6}$/);
      expect(p.email).toMatch(/\.example\.test$/);
      expect(p.phone).toMatch(/^555-0[12]\d\d$/);
    }
    const users = (await lab.db.query('SELECT email FROM users')).rows;
    for (const u of users) expect(u.email).toMatch(/\.example\.test$/);
    expect((await lab.db.query("SELECT count(*)::int AS n FROM laboratory_results WHERE comment NOT LIKE 'SYNTHETIC%'")).rows[0].n).toBe(0);
  });
  it('has no committed private keys, cloud keys or .env files', () => {
    const files = walk(ROOT).filter((f) => !/package-lock\.json$/.test(f));
    expect(files.some((f) => path.basename(f) === '.env')).toBe(false);
    const rx = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /AKIA[0-9A-Z]{16}/, /ghp_[A-Za-z0-9]{30,}/, /sk-[A-Za-z0-9]{32,}/];
    for (const f of files) {
      if (/\.(png|jpg|ico|woff2?)$/.test(f) || f.endsWith('safety.test.ts')) continue;
      const text = fs.readFileSync(f, 'utf8');
      for (const r of rx) expect(r.test(text), `${f} matches ${r}`).toBe(false);
    }
  });
  it('contains no outbound HTTP client code', () => {
    const src = walk(path.join(ROOT, 'backend', 'src')).filter((f) => !f.endsWith('docs.ts')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    expect(src).not.toMatch(/\bfetch\(|https?\.request|https?\.get\(|axios|node-fetch|XMLHttpRequest/);
  });
});

describe('reset policy', () => {
  it('rebuilds the clinical baseline deterministically and keeps assessment records', async () => {
    const snap = async () => JSON.stringify((await lab.db.query('SELECT mrn, first_name, last_name, dob, sex, primary_doctor_id FROM patients ORDER BY id')).rows) +
      JSON.stringify((await lab.db.query('SELECT patient_id, doctor_id, status FROM appointments ORDER BY id')).rows);
    const before = await snap();
    const c = await as(lab, 'assessor.vance');
    await c.post('/api/assessment/findings', { id: 'HMS-A09', origin: 'accidental', title: 'Reset survives', category: 'Test' });
    await lab.db.query("UPDATE patients SET first_name='CHANGED' WHERE id=1");
    await lab.db.query('DELETE FROM appointments');
    await seedClinical(lab.db);
    expect(await snap()).toBe(before);
    expect((await lab.db.query("SELECT 1 FROM assessment_findings WHERE id='HMS-A09'")).rows).toHaveLength(1);
  });
  it('CLI refuses non-local databases and production', () => {
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'src/db/cli.ts', 'reset', '--yes'], { cwd: path.join(ROOT, 'backend'), env: { ...process.env, ...env }, encoding: 'utf8' });
    const remote = run({ DATABASE_URL: 'postgres://user:pw@db.example.com:5432/prod' });
    expect(remote.status).not.toBe(0);
    expect(remote.stderr).toMatch(/non-local/);
    const prod = run({ NODE_ENV: 'production', PGLITE_DIR: path.join(ROOT, '.pglite-safety') });
    expect(prod.status).not.toBe(0);
    expect(prod.stderr).toMatch(/production/);
    fs.rmSync(path.join(ROOT, '.pglite-safety'), { recursive: true, force: true });
  });
  it('exposes no HTTP reset endpoint', async () => {
    const c = await as(lab, 'admin.hartley');
    for (const url of ['/api/admin/reset', '/api/reset', '/api/lab/reset', '/api/db/reset']) {
      expect((await c.post(url)).status, url).toBe(404);
    }
  });
});

describe('server refuses unsafe binding', () => {
  it('exits before listening when vulnerable mode is bound publicly', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: path.join(ROOT, 'backend'), env: { ...process.env, LAB_MODE: 'vulnerable', HOST: '0.0.0.0', PORT: '4999' }, encoding: 'utf8', timeout: 60000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Refusing to start/);
  });
});

describe('docker compose exposure', () => {
  it('publishes only loopback ports and never the database', () => {
    const f = path.join(ROOT, 'docker-compose.yml');
    if (!fs.existsSync(f)) return;
    const text = fs.readFileSync(f, 'utf8');
    const ports = [...text.matchAll(/-\s*"?([\d.]*:?\d+:\d+)"?\s*$/gm)].map((m) => m[1]);
    expect(ports.length).toBeGreaterThan(0);
    for (const p of ports) expect(p.startsWith('127.0.0.1:'), p).toBe(true);
    expect(text).not.toMatch(/5432:5432/);
  });
});

