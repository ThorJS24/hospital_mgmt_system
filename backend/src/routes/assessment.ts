import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Ctx } from '../middleware/context.js';
import { audit, requirePermission } from '../middleware/context.js';
import { HttpError, parse } from '../utils/http.js';
import {
  FINDING_STATUSES, addEvidence, evidenceCreate, findingCreate, findingUpdate, metrics, recordResult, resultCreate, sanitizeText, transitionFinding,
} from '../services/assessment.js';
import { generateAndSave } from '../services/report.js';

/** Assessment administration is separate from hospital administration: only the assessor role holds assessment.* permissions. */
export function assessmentRoutes({ db, cfg }: Ctx) {
  const r = Router();
  const manifest = () => JSON.parse(fs.readFileSync(cfg.manifestPath, 'utf8'));
  const read = requirePermission('assessment.read');
  const write = requirePermission('assessment.write');
  const exportP = requirePermission('assessment.export');

  r.get('/assessment/dashboard', read, async (_req, res) => {
    res.json(await metrics(db, manifest().vulnerabilities.length));
  });

  r.get('/assessment/manifest', read, async (_req, res) => {
    res.json(manifest());
  });

  r.get('/assessment/test-cases', read, async (_req, res) => {
    const data = (await db.query(`SELECT t.*,
        (SELECT json_agg(json_build_object('id',r.id,'status',r.status,'actual_result',r.actual_result,'evidence_id',r.evidence_id,'tested_at',r.tested_at) ORDER BY r.id DESC) FROM assessment_results r WHERE r.test_case_id=t.id) AS results
      FROM assessment_test_cases t ORDER BY t.id`)).rows;
    res.json({ data });
  });

  r.post('/assessment/test-cases/:id/results', write, async (req, res) => {
    const id = await recordResult(db, String(req.params.id), parse(resultCreate, req.body), req.user!.id);
    await audit(db, req, 'assessment_result', 'test_case', String(req.params.id));
    res.status(201).json({ id });
  });

  r.get('/assessment/findings', read, async (req, res) => {
    const params: unknown[] = [];
    const where = ['true'];
    if (req.query.status) { params.push(parse(z.enum(FINDING_STATUSES), req.query.status)); where.push(`status=$${params.length}`); }
    if (req.query.origin) { params.push(String(req.query.origin)); where.push(`origin=$${params.length}`); }
    const data = (await db.query(`SELECT f.id, f.title, f.category, f.affected_route, f.origin, f.status, f.severity, f.cvss_score::float AS cvss_score, f.confidence, f.updated_at,
        (SELECT count(*)::int FROM assessment_evidence e WHERE e.finding_id=f.id) AS evidence_count
      FROM assessment_findings f WHERE ${where.join(' AND ')} ORDER BY f.id`, params)).rows;
    res.json({ data, total: data.length });
  });

  r.get('/assessment/findings/:id', read, async (req, res) => {
    const id = String(req.params.id);
    const f = (await db.query('SELECT * FROM assessment_findings WHERE id=$1', [id])).rows[0];
    if (!f) throw new HttpError(404, 'Finding not found');
    const [evidence, history, remediation, tests] = await Promise.all([
      db.query('SELECT * FROM assessment_evidence WHERE finding_id=$1 ORDER BY id', [id]),
      db.query('SELECT h.*, u.username FROM assessment_finding_history h LEFT JOIN users u ON u.id=h.by_user WHERE finding_id=$1 ORDER BY h.id', [id]),
      db.query('SELECT * FROM remediation_records WHERE finding_id=$1 ORDER BY id', [id]),
      db.query('SELECT id, name, kind FROM assessment_test_cases WHERE finding_id=$1 ORDER BY id', [id]),
    ]);
    const mf = manifest().vulnerabilities.find((v: any) => v.id === id) ?? null;
    res.json({ ...f, cvss_score: f.cvss_score === null ? null : Number(f.cvss_score), evidence: evidence.rows, history: history.rows, remediation_records: remediation.rows, test_cases: tests.rows, manifest: mf });
  });

  r.post('/assessment/findings', write, async (req, res) => {
    const b = parse(findingCreate, req.body);
    if ((await db.query('SELECT 1 FROM assessment_findings WHERE id=$1', [b.id])).rows.length) throw new HttpError(409, 'Finding ID already exists');
    const pid = (await db.query('SELECT id FROM assessment_projects ORDER BY id LIMIT 1')).rows[0].id;
    await db.query("INSERT INTO assessment_findings(id,project_id,title,category,affected_route,origin,status,description,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,'Under Assessment',$7,$8,$8)", [b.id, pid, b.title, b.category, b.affected_route, b.origin, sanitizeText(b.description), req.user!.id]);
    await audit(db, req, 'finding_create', 'finding', b.id);
    res.status(201).json({ id: b.id });
  });

  r.patch('/assessment/findings/:id', write, async (req, res) => {
    const id = String(req.params.id);
    const b = parse(findingUpdate, req.body) as Record<string, unknown>;
    const cols = Object.entries(b).filter(([, v]) => v !== undefined);
    if (!cols.length) throw new HttpError(400, 'No fields to update');
    const TEXT = new Set(['description', 'technical_details', 'verification_steps', 'expected_behavior', 'observed_behavior', 'impact', 'root_cause', 'remediation', 'refs', 'decision_note', 'likelihood', 'business_impact']);
    const vals = cols.map(([k, v]) => (TEXT.has(k) && typeof v === 'string' ? sanitizeText(v) : v));
    const sets = cols.map(([k], i) => `${k}=$${i + 3}`).join(', ');
    const n = (await db.query(`UPDATE assessment_findings SET ${sets}, updated_by=$2, updated_at=now() WHERE id=$1 RETURNING id`, [id, req.user!.id, ...vals])).rows.length;
    if (!n) throw new HttpError(404, 'Finding not found');
    await audit(db, req, 'finding_update', 'finding', id, cols.map(([k]) => k).join(','));
    res.json({ ok: true });
  });

  r.post('/assessment/findings/:id/transition', write, async (req, res) => {
    const b = parse(z.object({ to: z.enum(FINDING_STATUSES), note: z.string().max(1000).default('') }), req.body);
    await transitionFinding(db, String(req.params.id), b.to, b.note, req.user!.id);
    await audit(db, req, 'finding_transition', 'finding', String(req.params.id), b.to);
    res.json({ ok: true, status: b.to });
  });

  r.post('/assessment/findings/:id/remediation', write, async (req, res) => {
    const id = String(req.params.id);
    const b = parse(z.object({ status: z.enum(['Proposed', 'Implemented', 'Retest Passed', 'Retest Failed']), notes: z.string().min(3).max(2000) }), req.body);
    const to = ({ Proposed: 'Remediation Proposed', Implemented: 'Remediated', 'Retest Passed': 'Retest Passed', 'Retest Failed': 'Retest Failed' } as const)[b.status];
    await transitionFinding(db, id, to, b.notes, req.user!.id);
    await db.query('INSERT INTO remediation_records(finding_id,status,notes,by_user) VALUES ($1,$2,$3,$4)', [id, b.status, sanitizeText(b.notes), req.user!.id]);
    res.status(201).json({ ok: true, status: to });
  });

  r.get('/assessment/evidence', read, async (req, res) => {
    const params: unknown[] = [];
    let where = 'true';
    if (req.query.finding_id) { params.push(String(req.query.finding_id)); where = 'finding_id=$1'; }
    res.json({ data: (await db.query(`SELECT * FROM assessment_evidence WHERE ${where} ORDER BY id`, params)).rows, warning: 'Evidence may contain sensitive information. Sanitise before sharing.' });
  });

  r.post('/assessment/evidence', write, async (req, res) => {
    const id = await addEvidence(db, cfg, parse(evidenceCreate, req.body), req.user!.id);
    await audit(db, req, 'evidence_add', 'evidence', id);
    res.status(201).json({ id });
  });

  // ---- exports & reports ----
  r.get('/assessment/export/register.:fmt', exportP, async (req, res) => {
    const fmt = parse(z.enum(['csv', 'json']), req.params.fmt);
    const g = await generateAndSave(db, cfg, fmt);
    res.type(fmt === 'csv' ? 'text/csv' : 'application/json').setHeader('Content-Disposition', `attachment; filename="register.${fmt}"`);
    res.send(g.body);
  });

  r.post('/assessment/reports', exportP, async (req, res) => {
    const { format } = parse(z.object({ format: z.enum(['html', 'json', 'csv']) }), req.body);
    const g = await generateAndSave(db, cfg, format);
    await audit(db, req, 'report_generate', 'report', g.filename);
    res.status(201).json({ filename: g.filename, reportId: g.reportId, sha256: g.sha256 });
  });

  r.get('/assessment/reports', exportP, (_req, res) => {
    const files = fs.existsSync(cfg.reportDir) ? fs.readdirSync(cfg.reportDir).filter((f) => /^R-\d{12}\.(html|json|csv)$/.test(f)).sort().reverse() : [];
    res.json({ data: files });
  });

  r.get('/assessment/reports/:file', exportP, (req, res) => {
    const file = String(req.params.file);
    if (!/^R-\d{12}\.(html|json|csv)$/.test(file)) throw new HttpError(400, 'Invalid report name');
    const p = path.join(cfg.reportDir, file);
    if (!fs.existsSync(p)) throw new HttpError(404, 'Report not found');
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    res.type(path.extname(file) === '.html' ? 'text/html' : path.extname(file) === '.json' ? 'application/json' : 'text/csv').send(fs.readFileSync(p));
  });

  return r;
}
