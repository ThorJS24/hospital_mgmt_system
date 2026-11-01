import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { metrics, sanitizeText } from './assessment.js';
import { sha256 } from '../utils/crypto.js';

export const APP_VERSION = '1.0.0';
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const orPending = (v: unknown, label = 'Pending assessment') => (v === null || v === undefined || v === '' ? label : String(v));

export interface ReportData {
  meta: { reportId: string; generatedAt: string; appVersion: string; application: string; classification: string; format?: string };
  project: { name: string; scope: string; app_version: string; started_on: string };
  metrics: Awaited<ReturnType<typeof metrics>>;
  findings: any[];
  testCases: any[];
  evidence: any[];
}

export async function buildReportData(db: Db, cfg: AppConfig): Promise<ReportData> {
  const manifest = JSON.parse(fs.readFileSync(cfg.manifestPath, 'utf8'));
  const project = (await db.query('SELECT name, scope, app_version, started_on FROM assessment_projects ORDER BY id LIMIT 1')).rows[0];
  const findings = (await db.query('SELECT * FROM assessment_findings ORDER BY origin, id')).rows;
  const evidence = (await db.query('SELECT id, finding_id, evidence_type, collected_at, route, http_method, http_status, request_meta, response_meta, screenshot_ref, notes, file_name, sha256 FROM assessment_evidence ORDER BY id')).rows;
  const retest = (await db.query('SELECT finding_id, status, notes, at FROM remediation_records ORDER BY id')).rows;
  const testCases = (await db.query(`SELECT t.id, t.name, t.objective, t.test_account, t.target_component, t.expected_result, t.finding_id, t.kind,
      (SELECT r.status FROM assessment_results r WHERE r.test_case_id=t.id ORDER BY r.id DESC LIMIT 1) AS last_status,
      (SELECT r.actual_result FROM assessment_results r WHERE r.test_case_id=t.id ORDER BY r.id DESC LIMIT 1) AS actual_result,
      (SELECT r.evidence_id FROM assessment_results r WHERE r.test_case_id=t.id ORDER BY r.id DESC LIMIT 1) AS evidence_id
    FROM assessment_test_cases t ORDER BY t.id`)).rows;
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 12);
  return {
    meta: { reportId: `R-${stamp}`, generatedAt: now.toISOString(), appVersion: APP_VERSION, application: 'MediCore HMS', classification: 'Intentionally vulnerable academic laboratory - synthetic data only' },
    project: { ...project, started_on: String(project.started_on).slice(0, 10) },
    metrics: await metrics(db, manifest.vulnerabilities.length),
    findings: findings.map((f: any) => ({
      ...f,
      cvss_score: f.cvss_score === null ? null : Number(f.cvss_score),
      evidence: evidence.filter((e: any) => e.finding_id === f.id),
      retest: retest.filter((r: any) => r.finding_id === f.id),
    })),
    testCases,
    evidence,
  };
}

const SEV_ORDER = ['Critical', 'High', 'Medium', 'Low', 'Informational', 'Pending'];

export function renderJson(d: ReportData): string {
  return JSON.stringify(d, null, 2);
}

const csvCell = (v: unknown) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return `"${s.replace(/"/g, '""')}"`;
};
export function renderCsv(d: ReportData): string {
  const head = ['id', 'title', 'category', 'origin', 'affected_route', 'status', 'severity', 'cvss_version', 'cvss_score', 'cvss_vector', 'confidence', 'evidence_count'];
  const rows = d.findings.map((f) => [f.id, f.title, f.category, f.origin, f.affected_route, f.status, f.severity ?? 'Pending', f.cvss_version, f.cvss_score ?? '', f.cvss_vector ?? '', f.confidence ?? '', f.evidence.length]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function renderHtml(d: ReportData): string {
  const m = d.metrics;
  const verified = d.findings.filter((f) => ['Confirmed', 'Remediation Proposed', 'Remediated', 'Retest Passed', 'Retest Failed'].includes(f.status));
  const sevCounts = SEV_ORDER.map((s) => [s, d.findings.filter((f) => (f.severity ?? 'Pending') === s).length]);
  const statusLabel = (f: any) => (['Not Tested', 'Planned'].includes(f.status) ? `${f.status} (UNVERIFIED)` : f.status);
  const t = (s: unknown) => esc(sanitizeText(String(s ?? '')));
  const block = (label: string, v: unknown) => `<h4>${label}</h4><p>${orPending(t(v), '<em>Not recorded</em>').replace(/\n/g, '<br>')}</p>`;

  const detail = d.findings.map((f, i) => `
<section class="finding" id="${esc(f.id)}">
  <h3>${i + 1}. ${esc(f.id)} - ${t(f.title)}</h3>
  <table class="kv">
    <tr><th>Status</th><td>${esc(statusLabel(f))}</td><th>Origin</th><td>${esc(f.origin)}</td></tr>
    <tr><th>Severity</th><td>${esc(orPending(f.severity))}</td><th>Confidence</th><td>${esc(orPending(f.confidence))}</td></tr>
    <tr><th>CVSS v${esc(f.cvss_version)}</th><td>${f.cvss_score === null ? 'Pending assessment' : esc(f.cvss_score)}</td><th>Vector</th><td>${esc(orPending(f.cvss_vector))}</td></tr>
    <tr><th>Affected component</th><td colspan="3">${t(f.category)} - ${t(f.affected_route)}</td></tr>
  </table>
  ${['Not Tested', 'Planned'].includes(f.status) ? '<p class="warn">This weakness is listed in the internal register but has <strong>not been assessed</strong>. It is not a confirmed vulnerability.</p>' : ''}
  ${block('Description', f.description)}${block('Technical details', f.technical_details)}
  <h4>Evidence</h4>${f.evidence.length ? `<ul>${f.evidence.map((e: any) => `<li><strong>${esc(e.id)}</strong> (${esc(e.evidence_type)}) ${esc(e.http_method ?? '')} ${t(e.route)} ${e.http_status ?? ''} - ${t(e.notes)} ${e.sha256 ? `<br><code>sha256:${esc(e.sha256)}</code>` : ''}</li>`).join('')}</ul>` : '<p><em>No evidence recorded.</em></p>'}
  ${block('Reproduction / verification procedure', f.verification_steps)}${block('Expected behavior', f.expected_behavior)}${block('Observed behavior', f.observed_behavior)}
  ${block('Impact', f.impact)}${block('Root cause', f.root_cause)}${block('Remediation recommendation', f.remediation)}${block('References', f.refs)}
  <h4>Retest result</h4>${f.retest.length ? `<ul>${f.retest.map((r: any) => `<li>${esc(r.status)} - ${t(r.notes)}</li>`).join('')}</ul>` : '<p><em>Not retested.</em></p>'}
</section>`).join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(d.meta.application)} - Vulnerability Assessment Report ${esc(d.meta.reportId)}</title>
<style>body{font:14px/1.5 system-ui,Segoe UI,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#1b2430}h1,h2,h3{color:#12284c}table{border-collapse:collapse;width:100%;margin:.5rem 0}th,td{border:1px solid #c9d2df;padding:.35rem .5rem;text-align:left;vertical-align:top}th{background:#eef2f8}
.cover{text-align:center;padding:5rem 0;border-bottom:2px solid #12284c;page-break-after:always}.banner{background:#fff4d6;border:1px solid #d9a400;padding:.5rem;font-weight:600}.warn{background:#fff4d6;border-left:4px solid #d9a400;padding:.4rem .6rem}.finding{page-break-inside:avoid;border-top:1px solid #c9d2df;margin-top:1.5rem}.kv th{width:16%}code{word-break:break-all}</style></head><body>
<div class="cover"><div class="banner">ACADEMIC SECURITY LAB - SYNTHETIC DATA ONLY - NOT FOR CLINICAL USE</div>
<h1>${esc(d.meta.application)}<br>Vulnerability Assessment Report</h1><p>Report ${esc(d.meta.reportId)} - application version ${esc(d.meta.appVersion)}<br>Generated ${esc(d.meta.generatedAt)}</p><p>${esc(d.meta.classification)}</p></div>
<h2>Table of contents</h2><ol><li><a href="#exec">Executive summary</a></li><li><a href="#scope">Scope and methodology</a></li><li><a href="#summary">Vulnerability summary</a></li><li><a href="#details">Detailed findings</a></li><li><a href="#plan">Remediation plan</a></li><li><a href="#appx">Appendices</a></li></ol>
<h2 id="exec">1. Executive summary</h2>
<p>This report documents an assessment of <strong>${esc(d.project.name)}</strong>, an intentionally vulnerable academic laboratory. It is <strong>not</strong> an assessment of a real hospital and contains no real patient data.</p>
<ul><li>Registered findings: <strong>${d.findings.length}</strong> (${m.totalIntended} intended, ${d.findings.length - m.totalIntended} additional)</li>
<li>Verified (confirmed or later): <strong>${verified.length}</strong>; awaiting verification: <strong>${m.awaitingVerification}</strong>; not reproduced: ${m.notReproduced}; false positives: ${m.falsePositive}</li>
<li>Assessment verification coverage: ${m.coverage.assessmentVerificationCoverage.percent}% - intended-vulnerability registration: ${m.coverage.intendedVulnerabilityCoverage.percent}% (these are separate measures)</li>
<li>Evidence completeness for confirmed findings: ${m.evidenceCompleteness.percent}%</li></ul>
<h3>Severity distribution</h3><table><tr>${sevCounts.map(([s]) => `<th>${s}</th>`).join('')}</tr><tr>${sevCounts.map(([, n]) => `<td>${n}</td>`).join('')}</tr></table>
${verified.length === 0 ? '<p class="warn">No findings have been verified yet. Entries below are planned or unverified and must not be read as confirmed vulnerabilities.</p>' : ''}
<h3>Limitations</h3><ul><li>Scope is the local synthetic lab only. Severity values are those recorded by the assessor; "Pending assessment" means no justified score exists.</li><li>Scanner output (e.g. OWASP ZAP) is included only where an assessor recorded it as evidence.</li></ul>
<h2 id="scope">2. Scope and methodology</h2>
<table class="kv"><tr><th>Target</th><td>${t(d.project.scope)}</td></tr><tr><th>Application version</th><td>${esc(d.project.app_version)}</td></tr><tr><th>Started</th><td>${esc(d.project.started_on)}</td></tr><tr><th>Excluded</th><td>Any host outside the loopback lab, the database engine, third-party dependencies</td></tr><tr><th>Approach</th><td>Authenticated testing per role, manual HTTP inspection, OWASP ZAP passive/active scan against the isolated lab, comparison of vulnerable routes against their secure counterparts.</td></tr></table>
<h2 id="summary">3. Vulnerability summary</h2>
<table><tr><th>ID</th><th>Title</th><th>Category</th><th>Origin</th><th>Severity</th><th>CVSS</th><th>Status</th></tr>
${d.findings.map((f) => `<tr><td><a href="#${esc(f.id)}">${esc(f.id)}</a></td><td>${t(f.title)}</td><td>${t(f.category)}</td><td>${esc(f.origin)}</td><td>${esc(orPending(f.severity))}</td><td>${f.cvss_score === null ? 'Pending' : esc(f.cvss_score)}</td><td>${esc(statusLabel(f))}</td></tr>`).join('')}</table>
<h2 id="details">4. Detailed findings</h2>${detail}
<h2 id="plan">5. Remediation plan</h2><table><tr><th>ID</th><th>Status</th><th>Recommended remediation</th></tr>${d.findings.map((f) => `<tr><td>${esc(f.id)}</td><td>${esc(f.status)}</td><td>${t(f.remediation)}</td></tr>`).join('')}</table>
<h2 id="appx">6. Appendices</h2><h3>A. Test case results</h3><table><tr><th>ID</th><th>Name</th><th>Kind</th><th>Finding</th><th>Last result</th><th>Evidence</th></tr>
${d.testCases.map((c) => `<tr><td>${esc(c.id)}</td><td>${t(c.name)}</td><td>${esc(c.kind)}</td><td>${esc(c.finding_id ?? '-')}</td><td>${esc(c.last_status ?? 'not executed')}</td><td>${esc(c.evidence_id ?? '-')}</td></tr>`).join('')}</table>
<p>"reproduced" means the intended weakness was observed; it is not evidence that a security control passed.</p>
<h3>B. Evidence index</h3><table><tr><th>ID</th><th>Finding</th><th>Type</th><th>Route</th><th>SHA-256</th></tr>${d.evidence.map((e) => `<tr><td>${esc(e.id)}</td><td>${esc(e.finding_id)}</td><td>${esc(e.evidence_type)}</td><td>${t(e.route)}</td><td><code>${esc(e.sha256 ?? '-')}</code></td></tr>`).join('') || '<tr><td colspan="5"><em>No evidence recorded.</em></td></tr>'}</table>
<p class="warn">Evidence may contain sensitive information. Credentials, cookies and tokens are redacted automatically on entry, but review all evidence before sharing.</p>
</body></html>`;
}

export async function generateAndSave(db: Db, cfg: AppConfig, format: 'html' | 'json' | 'csv') {
  const d = await buildReportData(db, cfg);
  d.meta.format = format;
  const body = format === 'html' ? renderHtml(d) : format === 'json' ? renderJson(d) : renderCsv(d);
  fs.mkdirSync(cfg.reportDir, { recursive: true });
  const filename = `${d.meta.reportId}.${format}`;
  fs.writeFileSync(path.join(cfg.reportDir, filename), body);
  return { filename, body, sha256: sha256(body), reportId: d.meta.reportId };
}
