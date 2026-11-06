import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { as, b64, makeLab, type Lab } from './helpers.js';
import { sha256 } from '../src/utils/crypto.js';

let lab: Lab;
beforeAll(async () => { lab = await makeLab('secure'); });
afterAll(async () => { await lab.db.close(); });

const VEC = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N';

describe('assessment baseline', () => {
  it('seeds 5 intended findings as Not Tested with no severity and nothing confirmed', async () => {
    const c = await as(lab, 'assessor.vance');
    const d = (await c.get('/api/assessment/dashboard')).body;
    expect(d.totalIntended).toBe(5);
    expect(d.confirmed).toBe(0);
    expect(d.awaitingVerification).toBe(5);
    expect(d.bySeverity).toEqual({ Pending: 5 });
    expect(d.coverage.intendedVulnerabilityCoverage.percent).toBe(100);
    expect(d.coverage.assessmentVerificationCoverage.percent).toBe(0); // separate measure
    const f = (await c.get('/api/assessment/findings')).body.data;
    expect(f.every((x: any) => x.status === 'Not Tested' && x.severity === null && x.cvss_score === null)).toBe(true);
  });
  it('baseline report marks everything unverified and fabricates nothing', async () => {
    const c = await as(lab, 'assessor.vance');
    const g = await c.post('/api/assessment/reports', { format: 'html' });
    expect(g.status).toBe(201);
    const html = (await c.get(`/api/assessment/reports/${g.body.filename}`)).text;
    expect(html).toContain('No findings have been verified yet');
    expect(html).toContain('Not Tested (UNVERIFIED)');
    expect(html).toContain('Pending assessment');
    expect(html).toContain('ACADEMIC SECURITY LAB');
  });
  it('manifest is readable by the assessor and exposes no password material', async () => {
    const c = await as(lab, 'assessor.vance');
    const m = (await c.get('/api/assessment/manifest')).body;
    expect(m.vulnerabilities).toHaveLength(5);
    for (const v of m.vulnerabilities) for (const k of ['id', 'title', 'category', 'cwe', 'owasp_category', 'affected_component', 'affected_route', 'vulnerability_type', 'intended_weakness', 'expected_observation', 'assessment_method', 'evidence_requirements', 'severity_rationale', 'remediation', 'remediation_reference', 'test_case_ids', 'status']) expect(v, `${v.id}.${k}`).toHaveProperty(k);
    expect(new Set(m.vulnerabilities.map((v: any) => v.id)).size).toBe(5);
  });
});

describe('Workflow F: assessor workflow', () => {
  it('cannot confirm without evidence or an explicit decision', async () => {
    const c = await as(lab, 'assessor.vance');
    expect((await c.post('/api/assessment/findings/HMS-V03/transition', { to: 'Confirmed' })).status).toBe(409); // Not Tested -> Confirmed invalid
    expect((await c.post('/api/assessment/findings/HMS-V03/transition', { to: 'Under Assessment' })).status).toBe(200);
    expect((await c.post('/api/assessment/findings/HMS-V03/transition', { to: 'Confirmed' })).status).toBe(422);
    expect((await c.get('/api/assessment/findings/HMS-V03')).body.status).toBe('Under Assessment');
  });

  it('validates result kinds; recording a result never confirms a finding', async () => {
    const c = await as(lab, 'assessor.vance');
    expect((await c.post('/api/assessment/test-cases/HMS-AC-004/results', { status: 'pass', actual_result: 'looked fine' })).status).toBe(422); // expected-vulnerability accepts reproduced/not-reproduced
    expect((await c.post('/api/assessment/test-cases/HMS-AC-006/results', { status: 'reproduced', actual_result: 'x yz' })).status).toBe(422);
    expect((await c.post('/api/assessment/test-cases/HMS-AC-006/results', { status: 'pass', actual_result: '403 returned for pharmacist' })).status).toBe(201);
    const r = await c.post('/api/assessment/test-cases/HMS-AC-004/results', { status: 'reproduced', actual_result: 'Tautology returned all rows' });
    expect(r.status).toBe(201);
    expect((await c.get('/api/assessment/findings/HMS-V03')).body.status).toBe('Under Assessment');
  });

  it('stores sanitised evidence with a verifiable SHA-256 and rejects bad files', async () => {
    const c = await as(lab, 'assessor.vance');
    const ev = await c.post('/api/assessment/evidence', {
      finding_id: 'HMS-V03', evidence_type: 'http-exchange', route: '/api/lab/patients/legacy-search', http_method: 'GET', http_status: 200,
      request_meta: 'GET /api/lab/patients/legacy-search?q=x\nCookie: sid=SUPERSECRETVALUE\nAuthorization: Bearer abc',
      response_meta: '{"token":"leaky","total":40}', notes: 'Result count 40 vs 1 for benign query',
      file_name: 'exchange.txt', content_base64: b64('Cookie: sid=SECRETINFILE\nrows=40\n'),
    });
    expect(ev.status).toBe(201);
    const row = (await lab.db.query('SELECT * FROM assessment_evidence WHERE id=$1', [ev.body.id])).rows[0];
    expect(`${row.request_meta}${row.response_meta}`).not.toMatch(/SUPERSECRET|Bearer abc|leaky/);
    const stored = fs.readFileSync(path.join(lab.cfg.evidenceDir, row.file_name));
    expect(stored.toString()).not.toContain('SECRETINFILE');
    expect(row.sha256).toBe(sha256(stored));
    const bad = (name: string, data: Buffer | string) => c.post('/api/assessment/evidence', { finding_id: 'HMS-V03', evidence_type: 'note', file_name: name, content_base64: b64(data) });
    expect((await bad('shell.php', '<?php ?>')).status).toBe(400);
    expect((await bad('run.exe', 'MZ')).status).toBe(400);
    expect((await bad('fake.png', 'not a png')).status).toBe(400);
    const traversal = await bad('../../escape.txt', 'x'); // client name is ignored; stored name is server-generated
    expect(traversal.status).toBe(201);
    const storedName = (await lab.db.query('SELECT file_name FROM assessment_evidence WHERE id=$1', [traversal.body.id])).rows[0].file_name;
    expect(storedName).toMatch(/^EV-\d{4}\.txt$/);
    expect(fs.existsSync(path.join(lab.cfg.evidenceDir, storedName))).toBe(true);
    expect(fs.existsSync(path.join(lab.cfg.evidenceDir, '..', '..', 'escape.txt'))).toBe(false);
    expect((await c.post('/api/assessment/evidence', { finding_id: 'NOPE', evidence_type: 'note' })).status).toBe(400);
  });

  it('links a result to evidence of the same finding only', async () => {
    const c = await as(lab, 'assessor.vance');
    const evId = (await lab.db.query("SELECT id FROM assessment_evidence WHERE finding_id='HMS-V03' LIMIT 1")).rows[0].id;
    expect((await c.post('/api/assessment/test-cases/HMS-XSS-002/results', { status: 'reproduced', actual_result: 'markup interpreted', evidence_id: evId })).status).toBe(422);
    expect((await c.post('/api/assessment/test-cases/HMS-AC-004/results', { status: 'reproduced', actual_result: 'confirmed again', evidence_id: evId })).status).toBe(201);
  });

  it('confirms with evidence, scores with CVSS, and walks remediation to retest', async () => {
    const c = await as(lab, 'assessor.vance');
    expect((await c.patch('/api/assessment/findings/HMS-V03', { severity: 'Low', cvss_score: 7.1, cvss_vector: VEC })).status).toBe(400);
    expect((await c.patch('/api/assessment/findings/HMS-V03', { status: 'Confirmed' })).status).toBe(400);
    expect((await c.patch('/api/assessment/findings/HMS-V03', { severity: 'High', cvss_score: 7.1, cvss_vector: VEC, confidence: 'High', impact: 'Read access to all synthetic patients', root_cause: 'String concatenation', observed_behavior: 'All rows returned' })).status).toBe(200);
    expect((await c.post('/api/assessment/findings/HMS-V03/transition', { to: 'Confirmed', note: 'Evidence EV-0001 attached' })).status).toBe(200);
    expect((await c.post('/api/assessment/findings/HMS-V03/remediation', { status: 'Implemented', notes: 'too early' })).status).toBe(409);
    expect((await c.post('/api/assessment/findings/HMS-V03/remediation', { status: 'Proposed', notes: 'Use parameterised queries' })).status).toBe(201);
    expect((await c.post('/api/assessment/findings/HMS-V03/remediation', { status: 'Implemented', notes: 'Route removed' })).status).toBe(201);
    expect((await c.post('/api/assessment/findings/HMS-V03/remediation', { status: 'Retest Failed', notes: 'Still reachable' })).status).toBe(201);
    expect((await c.post('/api/assessment/findings/HMS-V03/remediation', { status: 'Proposed', notes: 'Remove route entirely' })).status).toBe(201);
    expect((await c.post('/api/assessment/findings/HMS-V03/remediation', { status: 'Implemented', notes: 'Removed' })).status).toBe(201);
    expect((await c.post('/api/assessment/findings/HMS-V03/remediation', { status: 'Retest Passed', notes: '404 now' })).status).toBe(201);
    const f = (await c.get('/api/assessment/findings/HMS-V03')).body;
    expect(f.status).toBe('Retest Passed');
    expect(f.history.length).toBeGreaterThanOrEqual(7);
    expect(f.updated_by).toBeTruthy();
  });

  it('requires justification for not-reproduced / false positive and supports accidental findings', async () => {
    const c = await as(lab, 'assessor.vance');
    await c.post('/api/assessment/findings/HMS-V10/transition', { to: 'Under Assessment' });
    expect((await c.post('/api/assessment/findings/HMS-V10/transition', { to: 'Not Reproduced' })).status).toBe(422);
    expect((await c.post('/api/assessment/findings/HMS-V10/transition', { to: 'Not Reproduced', note: 'Headers present on route in this build' })).status).toBe(200);
    expect((await c.post('/api/assessment/findings', { id: 'HMS-A01', origin: 'accidental', title: 'Verbose 500 on malformed JSON', category: 'Information Disclosure' })).status).toBe(201);
    expect((await c.post('/api/assessment/findings', { id: 'HMS-A01', origin: 'accidental', title: 'dup', category: 'Dup' })).status).toBe(409);
    expect((await c.post('/api/assessment/findings', { id: 'HMS-V77', origin: 'intended', title: 'bad origin', category: 'x' })).status).toBe(400);
  });

  it('reports separate coverage metrics from stored records', async () => {
    const c = await as(lab, 'assessor.vance');
    const d = (await c.get('/api/assessment/dashboard')).body;
    expect(d.confirmed).toBe(1); // HMS-V03 reached Retest Passed (counted as confirmed history)
    expect(d.notReproduced).toBe(1);
    expect(d.retest.passed).toBe(1);
    expect(d.coverage.assessmentVerificationCoverage.decided).toBe(2);
    expect(d.evidenceCompleteness.percent).toBe(100);
    expect(d.bySeverity.High).toBe(1);
    expect(d.coverage.testCaseExecution.executed).toBe(2);
  });

  it('exports CSV/JSON and generates an HTML report from saved data', async () => {
    const c = await as(lab, 'assessor.vance');
    const csv = await c.get('/api/assessment/export/register.csv');
    expect(csv.status).toBe(200);
    expect(csv.text.split('\r\n')[0]).toContain('"id","title"');
    expect(csv.text).toContain('HMS-V03');
    expect(csv.text).toContain('HMS-A01');
    const json = (await c.get('/api/assessment/export/register.json')).body;
    expect(json.findings.find((f: any) => f.id === 'HMS-V03')).toMatchObject({ status: 'Retest Passed', severity: 'High', cvss_score: 7.1 });
    const g = await c.post('/api/assessment/reports', { format: 'html' });
    const html = (await c.get(`/api/assessment/reports/${g.body.filename}`)).text;
    expect(html).toContain('Retest Passed');
    expect(html).toContain('CVSS v4.0');
    expect(html).toContain('Read access to all synthetic patients');
    expect(html).toContain('EV-0001');
    expect(html).toContain('Not Reproduced');
    expect(html).toContain('Not Tested (UNVERIFIED)');
    expect(html).toContain('accidental');
    expect(html).not.toMatch(/SUPERSECRET|SECRETINFILE|Bearer abc/);
    expect((await c.get('/api/assessment/reports/..%2F..%2Fpackage.json')).status).toBeGreaterThanOrEqual(400);
  });

  it('keeps assessment records away from other roles, including exports', async () => {
    for (const u of ['admin.hartley', 'doctor.mehta']) {
      const c = await as(lab, u);
      expect((await c.get('/api/assessment/export/register.csv')).status).toBe(403);
      expect((await c.post('/api/assessment/reports', { format: 'html' })).status).toBe(403);
      expect((await c.post('/api/assessment/evidence', { finding_id: 'HMS-V03', evidence_type: 'note' })).status).toBe(403);
    }
    expect((await request(lab.app).get('/api/assessment/manifest')).status).toBe(401);
  });
});
