import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { HttpError } from '../utils/http.js';
import { sha256 } from '../utils/crypto.js';

export const FINDING_STATUSES = ['Planned', 'Not Tested', 'Under Assessment', 'Confirmed', 'False Positive', 'Not Reproduced', 'Remediation Proposed', 'Remediated', 'Retest Passed', 'Retest Failed'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];
export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Informational'] as const;

export const FINDING_TRANSITIONS: Record<FindingStatus, FindingStatus[]> = {
  Planned: ['Not Tested', 'Under Assessment'],
  'Not Tested': ['Under Assessment'],
  'Under Assessment': ['Confirmed', 'False Positive', 'Not Reproduced'],
  Confirmed: ['Remediation Proposed'],
  'False Positive': ['Under Assessment'],
  'Not Reproduced': ['Under Assessment'],
  'Remediation Proposed': ['Remediated'],
  Remediated: ['Retest Passed', 'Retest Failed'],
  'Retest Passed': [],
  'Retest Failed': ['Remediation Proposed'],
};

export function assertFindingTransition(from: FindingStatus, to: FindingStatus) {
  if (!FINDING_TRANSITIONS[from]?.includes(to)) throw new HttpError(409, `Invalid status change: ${from} -> ${to}`);
}

/** A finding can only be Confirmed with recorded evidence or an explicit assessor decision note. */
export function assertConfirmable(evidenceCount: number, decisionNote: string) {
  if (evidenceCount < 1 && decisionNote.trim().length < 10) {
    throw new HttpError(422, 'Confirmation requires at least one evidence record or an explicit decision note (10+ characters)');
  }
}

/** CVSS v4.0 qualitative bands. */
export function severityForScore(score: number): (typeof SEVERITIES)[number] {
  if (score === 0) return 'Informational';
  if (score < 4) return 'Low';
  if (score < 7) return 'Medium';
  if (score < 9) return 'High';
  return 'Critical';
}

// ---------- sanitisation ------------------------------------------------------------
const REDACTIONS: [RegExp, string][] = [
  [/(authorization|proxy-authorization)\s*[:=]\s*[^\r\n]+/gi, '$1: [REDACTED]'],
  [/((?:set-)?cookie)\s*[:=]\s*[^\r\n]+/gi, '$1: [REDACTED]'],
  [/("?(?:password|new_password|current_password|token|csrf_?token|secret|api_?key)"?\s*[:=]\s*)"?[^"\s,&}]+"?/gi, '$1"[REDACTED]"'],
  [/\b(sid|csrf|session)=([^;\s&]+)/gi, '$1=[REDACTED]'],
  [/\b[a-f0-9]{32,}\b/gi, '[REDACTED-HEX]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED-KEY]'],
];
export function sanitizeText(s: string): string {
  return REDACTIONS.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
}

// ---------- schemas ------------------------------------------------------------------
const cvssVector = z.string().regex(/^CVSS:4\.0\/AV:[NALP]\/AC:[LH]\/AT:[NP]\/PR:[NLH]\/UI:[NPA]\/VC:[HLN]\/VI:[HLN]\/VA:[HLN]\/SC:[HLN]\/SI:[HLN]\/SA:[HLN]$/, 'Expected a CVSS:4.0 base vector');
export const findingUpdate = z.object({
  title: z.string().min(3).max(200), category: z.string().min(2).max(80), affected_route: z.string().max(300),
  severity: z.enum(SEVERITIES).nullable(), cvss_score: z.number().min(0).max(10).nullable(), cvss_vector: cvssVector.nullable(),
  confidence: z.enum(['High', 'Medium', 'Low']).nullable(), likelihood: z.string().max(200).nullable(), business_impact: z.string().max(500).nullable(),
  description: z.string().max(4000), technical_details: z.string().max(4000), verification_steps: z.string().max(4000),
  expected_behavior: z.string().max(2000), observed_behavior: z.string().max(2000), impact: z.string().max(2000),
  root_cause: z.string().max(2000), remediation: z.string().max(4000), refs: z.string().max(2000), decision_note: z.string().max(1000),
}).partial().strict().superRefine((v, ctx) => {
  if ((v.cvss_score != null) !== (v.cvss_vector != null) && (v.cvss_score !== undefined || v.cvss_vector !== undefined))
    ctx.addIssue({ code: 'custom', message: 'cvss_score and cvss_vector must be provided together', path: ['cvss_score'] });
  if (v.cvss_score != null && v.severity && severityForScore(v.cvss_score) !== v.severity)
    ctx.addIssue({ code: 'custom', message: `Severity must match CVSS v4.0 band (${severityForScore(v.cvss_score)})`, path: ['severity'] });
});
export const findingCreate = z.object({
  id: z.string().regex(/^HMS-[A-Z]\d{2,3}$/, 'Format HMS-A01 (A=accidental, S=scanner, T=third-party)'),
  origin: z.enum(['accidental', 'third-party', 'scanner']),
  title: z.string().min(3).max(200), category: z.string().min(2).max(80), affected_route: z.string().max(300).default(''), description: z.string().max(4000).default(''),
});

export const EVIDENCE_EXT = new Set(['.txt', '.json', '.md', '.log', '.csv', '.png']);
export const MAX_EVIDENCE = 1024 * 1024;
export const evidenceCreate = z.object({
  finding_id: z.string().min(1), evidence_type: z.enum(['http-exchange', 'screenshot', 'scanner-output', 'log-excerpt', 'note']),
  route: z.string().max(300).default(''), http_method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).optional(),
  http_status: z.number().int().min(100).max(599).optional(), request_meta: z.string().max(4000).default(''), response_meta: z.string().max(4000).default(''),
  screenshot_ref: z.string().max(200).default(''), notes: z.string().max(2000).default(''),
  file_name: z.string().max(120).optional(), content_base64: z.string().max(MAX_EVIDENCE * 2).optional(),
});

// ---------- operations ---------------------------------------------------------------
export async function getFindingStatus(db: Db, id: string): Promise<FindingStatus> {
  const r = (await db.query('SELECT status FROM assessment_findings WHERE id=$1', [id])).rows[0];
  if (!r) throw new HttpError(404, 'Finding not found');
  return r.status;
}

export async function transitionFinding(db: Db, id: string, to: FindingStatus, note: string, userId: number) {
  await db.tx(async (t) => {
    const f = (await t.query('SELECT status, decision_note FROM assessment_findings WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!f) throw new HttpError(404, 'Finding not found');
    assertFindingTransition(f.status, to);
    if (to === 'Confirmed') {
      const n = (await t.query<{ n: number }>('SELECT count(*)::int AS n FROM assessment_evidence WHERE finding_id=$1', [id])).rows[0].n;
      assertConfirmable(n, note || f.decision_note);
    }
    if ((to === 'False Positive' || to === 'Not Reproduced') && note.trim().length < 5) throw new HttpError(422, 'A short justification is required');
    await t.query('UPDATE assessment_findings SET status=$1, decision_note=CASE WHEN $2 <> \'\' THEN $2 ELSE decision_note END, updated_by=$3, updated_at=now() WHERE id=$4', [to, sanitizeText(note), userId, id]);
    await t.query('INSERT INTO assessment_finding_history(finding_id,from_status,to_status,note,by_user) VALUES ($1,$2,$3,$4,$5)', [id, f.status, to, sanitizeText(note), userId]);
  });
}

export async function addEvidence(db: Db, cfg: AppConfig, b: z.infer<typeof evidenceCreate>, userId: number): Promise<string> {
  if (!(await db.query('SELECT 1 FROM assessment_findings WHERE id=$1', [b.finding_id])).rows.length) throw new HttpError(400, 'Finding not found');
  const n = (await db.query<{ n: number }>('SELECT count(*)::int + 1 AS n FROM assessment_evidence')).rows[0].n;
  const id = `EV-${String(n).padStart(4, '0')}`;
  let stored: string | null = null;
  let digest: string | null = null;
  if (b.content_base64) {
    const ext = path.extname(b.file_name ?? '').toLowerCase();
    if (!EVIDENCE_EXT.has(ext)) throw new HttpError(400, `Evidence file type ${ext || '(none)'} is not allowed`);
    const buf = Buffer.from(b.content_base64, 'base64');
    if (!buf.length || buf.length > MAX_EVIDENCE) throw new HttpError(400, 'Evidence file must be 1 byte - 1 MB');
    if (ext === '.png' && !buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) throw new HttpError(400, 'File content does not match .png');
    if (ext !== '.png' && buf.includes(0)) throw new HttpError(400, 'Binary content is not allowed for text evidence');
    fs.mkdirSync(cfg.evidenceDir, { recursive: true });
    stored = `${id}${ext}`; // server-generated name only
    const payload = ext === '.png' ? buf : Buffer.from(sanitizeText(buf.toString('utf8')));
    fs.writeFileSync(path.join(cfg.evidenceDir, stored), payload);
    digest = sha256(payload);
  }
  await db.query(
    `INSERT INTO assessment_evidence(id,finding_id,evidence_type,route,http_method,http_status,request_meta,response_meta,screenshot_ref,notes,file_name,sha256,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, b.finding_id, b.evidence_type, b.route, b.http_method ?? null, b.http_status ?? null, sanitizeText(b.request_meta), sanitizeText(b.response_meta), b.screenshot_ref, sanitizeText(b.notes), stored, digest, userId],
  );
  return id;
}

export const resultCreate = z.object({
  status: z.enum(['pass', 'fail', 'reproduced', 'not-reproduced']), actual_result: z.string().min(3).max(2000), notes: z.string().max(2000).default(''), evidence_id: z.string().optional(),
});

export async function recordResult(db: Db, testCaseId: string, b: z.infer<typeof resultCreate>, userId: number): Promise<number> {
  const tc = (await db.query('SELECT kind, finding_id FROM assessment_test_cases WHERE id=$1', [testCaseId])).rows[0];
  if (!tc) throw new HttpError(404, 'Test case not found');
  const allowed = tc.kind === 'expected-vulnerability' ? ['reproduced', 'not-reproduced'] : ['pass', 'fail'];
  if (!allowed.includes(b.status)) throw new HttpError(422, `Test case kind "${tc.kind}" accepts: ${allowed.join(', ')}`);
  if (b.evidence_id) {
    const ev = (await db.query('SELECT finding_id FROM assessment_evidence WHERE id=$1', [b.evidence_id])).rows[0];
    if (!ev) throw new HttpError(400, 'Evidence not found');
    if (tc.finding_id && ev.finding_id !== tc.finding_id) throw new HttpError(422, 'Evidence belongs to a different finding');
  }
  const { rows } = await db.query('INSERT INTO assessment_results(test_case_id,actual_result,status,evidence_id,notes,tested_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [testCaseId, sanitizeText(b.actual_result), b.status, b.evidence_id ?? null, sanitizeText(b.notes), userId]);
  // An assessor result moves an untouched finding to Under Assessment; it never confirms anything by itself.
  if (tc.finding_id) await db.query("UPDATE assessment_findings SET status='Under Assessment', updated_by=$2, updated_at=now() WHERE id=$1 AND status IN ('Not Tested','Planned')", [tc.finding_id, userId]);
  return rows[0].id;
}

export async function metrics(db: Db, manifestCount: number) {
  const q = async <T,>(sql: string) => (await db.query<T>(sql)).rows;
  const [byStatus, bySeverity, byCategory, evComplete, tcs, rem] = await Promise.all([
    q<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM assessment_findings WHERE origin='intended' GROUP BY status"),
    q<{ severity: string; n: number }>("SELECT COALESCE(severity,'Pending') AS severity, count(*)::int AS n FROM assessment_findings GROUP BY 1"),
    q<{ category: string; n: number }>('SELECT category, count(*)::int AS n FROM assessment_findings GROUP BY 1 ORDER BY 1'),
    q<{ confirmed: number; with_ev: number }>(`SELECT count(*)::int AS confirmed, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM assessment_evidence e WHERE e.finding_id=f.id))::int AS with_ev
        FROM assessment_findings f WHERE status IN ('Confirmed','Remediation Proposed','Remediated','Retest Passed','Retest Failed')`),
    q<{ total: number; executed: number }>(`SELECT count(*)::int AS total, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM assessment_results r WHERE r.test_case_id=t.id))::int AS executed FROM assessment_test_cases t`),
    q<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM remediation_records GROUP BY status'),
  ]);
  const s = Object.fromEntries(byStatus.map((r) => [r.status, r.n])) as Record<string, number>;
  const total = byStatus.reduce((a, r) => a + r.n, 0);
  const decided = ['Confirmed', 'False Positive', 'Not Reproduced', 'Remediation Proposed', 'Remediated', 'Retest Passed', 'Retest Failed'].reduce((a, k) => a + (s[k] ?? 0), 0);
  const confirmed = ['Confirmed', 'Remediation Proposed', 'Remediated', 'Retest Passed', 'Retest Failed'].reduce((a, k) => a + (s[k] ?? 0), 0);
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  return {
    totalIntended: total,
    assessed: decided + (s['Under Assessment'] ?? 0),
    confirmed,
    notReproduced: s['Not Reproduced'] ?? 0,
    falsePositive: s['False Positive'] ?? 0,
    awaitingVerification: (s['Not Tested'] ?? 0) + (s['Planned'] ?? 0) + (s['Under Assessment'] ?? 0),
    byStatus: s,
    bySeverity: Object.fromEntries(bySeverity.map((r) => [r.severity, r.n])),
    byCategory: Object.fromEntries(byCategory.map((r) => [r.category, r.n])),
    coverage: {
      intendedVulnerabilityCoverage: { registered: total, manifest: manifestCount, percent: pct(total, manifestCount) },
      assessmentVerificationCoverage: { decided, total, percent: pct(decided, total) },
      testCaseExecution: { executed: tcs[0].executed, total: tcs[0].total, percent: pct(tcs[0].executed, tcs[0].total) },
    },
    evidenceCompleteness: { confirmedFindings: evComplete[0].confirmed, withEvidence: evComplete[0].with_ev, percent: pct(evComplete[0].with_ev, evComplete[0].confirmed) },
    remediation: Object.fromEntries(rem.map((r) => [r.status, r.n])),
    retest: { passed: s['Retest Passed'] ?? 0, failed: s['Retest Failed'] ?? 0 },
  };
}
