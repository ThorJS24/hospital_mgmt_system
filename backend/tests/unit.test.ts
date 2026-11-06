import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLES, permissionsFor } from '../src/services/permissions.js';
import { assertTransition } from '../src/services/appointments.js';
import { calcBalance, calcTotal, deriveStatus } from '../src/services/billing.js';
import { assertConfirmable, assertFindingTransition, sanitizeText, severityForScore, findingUpdate, evidenceCreate } from '../src/services/assessment.js';
import { assertSafeBinding, isVulnEnabled, loadConfig } from '../src/config/index.js';
import { hashPassword, verifyPassword } from '../src/utils/crypto.js';
import { renderCsv, type ReportData } from '../src/services/report.js';

describe('permission matrix', () => {
  it('defines all nine roles and every permission has at least one role', () => {
    expect(ROLES).toHaveLength(9);
    for (const [k, v] of Object.entries(PERMISSIONS)) expect(v.roles.length, k).toBeGreaterThan(0);
  });
  it('keeps assessment permissions away from hospital administrators', () => {
    const admin = permissionsFor('administrator');
    expect(admin.filter((p) => p.startsWith('assessment.'))).toEqual([]);
    expect(permissionsFor('security_assessor')).toEqual(expect.arrayContaining(['assessment.read', 'assessment.write', 'assessment.export']));
  });
  it('gives the assessor no clinical access', () => {
    const a = permissionsFor('security_assessor');
    for (const p of ['patients.read_all', 'patients.read_scoped', 'clinical.read', 'billing.read', 'pharmacy.read', 'lab.read']) expect(a).not.toContain(p);
  });
});

describe('appointment transitions', () => {
  it('allows the normal flow', () => {
    expect(() => assertTransition('Scheduled', 'Confirmed')).not.toThrow();
    expect(() => assertTransition('In consultation', 'Completed')).not.toThrow();
  });
  it('rejects invalid and terminal transitions', () => {
    expect(() => assertTransition('Completed', 'Scheduled')).toThrow();
    expect(() => assertTransition('Cancelled', 'Confirmed')).toThrow();
    expect(() => assertTransition('Scheduled', 'Completed')).toThrow();
  });
});

describe('billing', () => {
  it('computes totals, balances and status', () => {
    expect(calcTotal([{ quantity: 2, unit_price: 10.1 }, { quantity: 1, unit_price: 0.2 }])).toBe(20.4);
    expect(calcBalance(100, 40.5)).toBe(59.5);
    expect(calcBalance(100, 120)).toBe(0);
    expect(deriveStatus(100, 0)).toBe('Issued');
    expect(deriveStatus(100, 30)).toBe('Partially paid');
    expect(deriveStatus(100, 100)).toBe('Paid');
  });
});

describe('assessment rules', () => {
  it('enforces finding transitions', () => {
    expect(() => assertFindingTransition('Not Tested', 'Under Assessment')).not.toThrow();
    expect(() => assertFindingTransition('Not Tested', 'Confirmed')).toThrow();
    expect(() => assertFindingTransition('Confirmed', 'Retest Passed')).toThrow();
    expect(() => assertFindingTransition('Remediated', 'Retest Failed')).not.toThrow();
  });
  it('requires evidence or an explicit decision to confirm', () => {
    expect(() => assertConfirmable(0, '')).toThrow();
    expect(() => assertConfirmable(0, 'short')).toThrow();
    expect(() => assertConfirmable(1, '')).not.toThrow();
    expect(() => assertConfirmable(0, 'Reproduced manually, see notes')).not.toThrow();
  });
  it('maps CVSS 4.0 scores to severity bands', () => {
    expect([0, 3.9, 4, 6.9, 7, 8.9, 9, 10].map(severityForScore)).toEqual(['Informational', 'Low', 'Medium', 'Medium', 'High', 'High', 'Critical', 'Critical']);
  });
  it('validates CVSS pairing and severity consistency', () => {
    const vec = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N';
    expect(findingUpdate.safeParse({ cvss_score: 7.1, cvss_vector: vec, severity: 'High' }).success).toBe(true);
    expect(findingUpdate.safeParse({ cvss_score: 7.1, cvss_vector: vec, severity: 'Low' }).success).toBe(false);
    expect(findingUpdate.safeParse({ cvss_score: 7.1 }).success).toBe(false);
    expect(findingUpdate.safeParse({ cvss_score: 7.1, cvss_vector: 'CVSS:3.1/AV:N' }).success).toBe(false);
    expect(findingUpdate.safeParse({ status: 'Confirmed' }).success).toBe(false); // status only via transition endpoint
  });
  it('redacts credentials, cookies, tokens and long hex from evidence', () => {
    const s = sanitizeText('Cookie: sid=abc123\nAuthorization: Bearer xyz\n{"password":"Hunter2!!"} token=deadbeef sid=abcdef ' + 'a'.repeat(40));
    expect(s).not.toMatch(/abc123|Bearer xyz|Hunter2|deadbeef|abcdef|a{40}/);
    expect(s).toContain('[REDACTED');
  });
  it('validates evidence metadata', () => {
    expect(evidenceCreate.safeParse({ finding_id: 'HMS-V01', evidence_type: 'http-exchange', http_method: 'GET', http_status: 200 }).success).toBe(true);
    expect(evidenceCreate.safeParse({ finding_id: 'HMS-V01', evidence_type: 'http-exchange', http_status: 999 }).success).toBe(false);
    expect(evidenceCreate.safeParse({ finding_id: 'HMS-V01', evidence_type: 'exploit' }).success).toBe(false);
  });
  it('neutralises spreadsheet formulas in CSV export', () => {
    const d = { findings: [{ id: 'HMS-A01', title: '=cmd|calc', category: 'x', origin: 'accidental', affected_route: '', status: 'Not Tested', severity: null, cvss_version: '4.0', cvss_score: null, cvss_vector: null, confidence: null, evidence: [] }] } as unknown as ReportData;
    expect(renderCsv(d)).toContain(`"'=cmd|calc"`);
  });
});

describe('lab containment', () => {
  it('refuses vulnerable mode on a public bind', () => {
    expect(() => assertSafeBinding(loadConfig({ LAB_MODE: 'vulnerable', HOST: '0.0.0.0' }))).toThrow(/loopback/);
    expect(() => assertSafeBinding(loadConfig({ LAB_MODE: 'vulnerable', HOST: '192.168.1.5' }))).toThrow();
  });
  it('allows loopback, and the documented container exception', () => {
    expect(() => assertSafeBinding(loadConfig({ LAB_MODE: 'vulnerable', HOST: '127.0.0.1' }))).not.toThrow();
    expect(() => assertSafeBinding(loadConfig({ LAB_MODE: 'vulnerable', HOST: '0.0.0.0', LAB_ALLOW_CONTAINER_BIND: '1' }))).not.toThrow();
  });
  it('defaults to secure mode, loopback and no vulnerabilities', () => {
    const cfg = loadConfig({});
    expect(cfg.labMode).toBe('secure');
    expect(cfg.host).toBe('127.0.0.1');
    expect(isVulnEnabled(cfg, 'HMS-V01')).toBe(false);
    expect(isVulnEnabled(loadConfig({ LAB_MODE: 'vulnerable', LAB_VULNS: 'HMS-V03' }), 'HMS-V01')).toBe(false);
  });
});

describe('passwords', () => {
  it('hashes with salt and verifies', () => {
    const h = hashPassword('LabPass#1234');
    expect(h).not.toContain('LabPass');
    expect(verifyPassword('LabPass#1234', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
    expect(hashPassword('LabPass#1234')).not.toBe(h);
  });
});
