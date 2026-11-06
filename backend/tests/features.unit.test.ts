import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, currentStep, generateSecret, hotp, verifyTotp, otpauthUri } from '../src/services/totp.js';
import { buildPdf, textWidth } from '../src/services/pdf.js';
import { parseSchedule, isDate, weekdayOf } from '../src/services/staffing.js';
import { ageInYears, flagRow, flagValue, hasCritical } from '../src/services/vitals.js';
import { rangeFlag } from '../src/routes/portal.js';
import { csvCell, toCsv } from '../src/routes/reports.js';
import { characterClasses, passwordIssues, passwordRule } from '../src/utils/password.js';
import { buildOpenApi } from '../src/routes/docs.js';
import { Router } from 'express';
import { requirePermission, requireAuth } from '../src/middleware/context.js';

describe('TOTP (RFC 6238)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('matches the RFC 6238 SHA-1 test vectors (last six digits)', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(hotp(secret, Math.floor(59 / 30))).toBe('287082');
    expect(hotp(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(hotp(secret, Math.floor(1234567890 / 30))).toBe('005924');
  });
  it('round-trips base32', () => {
    const buf = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7]);
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    expect(() => base32Decode('not*valid')).toThrow();
  });
  it('accepts +/- one step of drift, rejects older codes and malformed input', () => {
    const now = 1_700_000_000_000;
    const step = currentStep(now);
    expect(verifyTotp(secret, hotp(secret, step), now)).toBe(step);
    expect(verifyTotp(secret, hotp(secret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, hotp(secret, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, hotp(secret, step - 2), now)).toBeNull();
    expect(verifyTotp(secret, '12345', now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });
  it('generates distinct 160-bit secrets and a well-formed otpauth URI', () => {
    const a = generateSecret(), b = generateSecret();
    expect(a).not.toBe(b);
    expect(base32Decode(a)).toHaveLength(20);
    expect(otpauthUri(a, 'user name')).toMatch(/^otpauth:\/\/totp\/MediCore%20HMS:user%20name\?secret=[A-Z2-7]+&issuer=MediCore%20HMS/);
  });
});

describe('PDF writer', () => {
  const parse = (buf: Buffer) => {
    const text = buf.toString('latin1');
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1]);
    return { text, startxref };
  };
  it('produces a structurally valid document (header, xref offsets, trailer)', () => {
    const buf = buildPdf({ title: 'Test (with) parens \\ and back\\slash', blocks: [{ type: 'paragraph', text: 'Hello world' }, { type: 'kv', rows: [['A', 'B']] }] });
    const { text, startxref } = parse(buf);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    // every xref entry points at "<n> 0 obj"
    const entries = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(entries.length).toBeGreaterThanOrEqual(6);
    entries.forEach((off, i) => expect(text.slice(off, off + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
  });
  it('paginates long tables and escapes non-Latin characters', () => {
    const rows = Array.from({ length: 150 }, (_, i) => [`Row ${i}`, 'café 中文', String(i)]);
    const buf = buildPdf({ title: 'Long', blocks: [{ type: 'table', columns: [{ label: 'A', width: 3 }, { label: 'B', width: 3 }, { label: 'C', width: 1, align: 'right' }], rows }] });
    const text = buf.toString('latin1');
    expect(Number(/\/Count (\d+)/.exec(text)![1])).toBeGreaterThanOrEqual(3);
    expect(text).toContain('Page 3 of');
    expect(text).toContain('??'); // CJK replaced, never emitted as invalid bytes
  });
  it('wraps long unbroken tokens within the page width', () => {
    expect(textWidth('i'.repeat(10), 10)).toBeLessThan(textWidth('W'.repeat(10), 10));
    const buf = buildPdf({ title: 'Wrap', blocks: [{ type: 'paragraph', text: 'x'.repeat(400) }] });
    expect(buf.length).toBeGreaterThan(500);
  });
});

describe('rosters', () => {
  it('parses the staff directory schedule formats', () => {
    expect(parseSchedule('Mon-Fri 08:00-16:00')).toEqual({ days: [1, 2, 3, 4, 5], start: '08:00', end: '16:00' });
    expect(parseSchedule('Mon/Wed/Fri 09:00-17:00')).toEqual({ days: [1, 3, 5], start: '09:00', end: '17:00' });
    expect(parseSchedule('Tue-Sat 10:00-18:00')).toEqual({ days: [2, 3, 4, 5, 6], start: '10:00', end: '18:00' });
    expect(parseSchedule('Fri-Mon 08:00-12:00')?.days).toEqual([0, 1, 5, 6]);
    expect(parseSchedule('Mon-Fri 16:00-08:00')).toBeNull();
    expect(parseSchedule('whenever')).toBeNull();
  });
  it('validates calendar dates and weekdays', () => {
    expect(isDate('2026-02-30')).toBe(false);
    expect(isDate('2026-13-01')).toBe(false);
    expect(isDate('2026-03-02')).toBe(true);
    expect(weekdayOf('2026-03-02')).toBe(1); // Monday
  });
});

describe('vital sign ranges', () => {
  it('flags adult values and uses paediatric ranges for children', () => {
    expect(flagValue('systolic', 120, 40)).toBeNull();
    expect(flagValue('systolic', 150, 40)).toBe('high');
    expect(flagValue('systolic', 185, 40)).toBe('critical-high');
    expect(flagValue('spo2', 93, 40)).toBe('low');
    expect(flagValue('spo2', 89, 40)).toBe('critical-low');
    expect(flagValue('heart_rate', 110, 40)).toBe('high');
    expect(flagValue('heart_rate', 110, 6)).toBeNull(); // normal for a child
    expect(flagValue('temperature_c', 38.4, 40)).toBe('high');
    expect(flagValue('unknown', 1, 40)).toBeNull();
  });
  it('summarises a row and detects critical readings', () => {
    const flags = flagRow({ systolic: 86, diastolic: 54, heart_rate: 134, temperature_c: 38.9, spo2: 89 }, 50);
    expect(hasCritical(flags)).toBe(true);
    expect(hasCritical(flagRow({ systolic: 118, diastolic: 76, heart_rate: 72, temperature_c: 36.8, spo2: 98 }, 50))).toBe(false);
  });
  it('computes age in years', () => {
    expect(Math.floor(ageInYears('2000-01-01', new Date('2026-06-01')))).toBe(26);
  });
});

describe('reference range flags', () => {
  it('handles ranges, upper and lower bounds', () => {
    expect(rangeFlag('5.0', '4.0-11.0')).toBe('normal');
    expect(rangeFlag('3.2', '4.0-11.0')).toBe('low');
    expect(rangeFlag('12', '4.0-11.0')).toBe('high');
    expect(rangeFlag('7', '<5.2')).toBe('high');
    expect(rangeFlag('4', '<5.2')).toBe('normal');
    expect(rangeFlag('2', '>3')).toBe('low');
    expect(rangeFlag('abc', '4.0-11.0')).toBeNull();
    expect(rangeFlag('5', 'see lab')).toBeNull();
  });
});

describe('CSV export safety', () => {
  it('neutralises spreadsheet formulas but keeps plain negative numbers', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+1+1')).toBe("'+1+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('-12.50')).toBe('-12.50');
    expect(csvCell('plain, with comma')).toBe('"plain, with comma"');
    expect(csvCell(null)).toBe('');
  });
  it('writes a header and CRLF rows', () => {
    const csv = toCsv({ title: 't', columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], rows: [{ a: 1, b: '=x' }] });
    expect(csv).toBe("A,B\r\n1,'=x\r\n");
  });
});

describe('password policy', () => {
  it('counts character classes and lists concrete problems', () => {
    expect(characterClasses('abc')).toBe(1);
    expect(characterClasses('Abc1')).toBe(3);
    expect(characterClasses('Abc1!')).toBe(4);
    expect(passwordIssues('short1A!')).toContain('Use at least 10 characters');
    expect(passwordIssues('alllowercaseletters')).toEqual(['Mix at least three of: lowercase, uppercase, digits, symbols']);
    expect(passwordIssues('Nurse.okafor2026!', 'nurse.okafor')).toContain('Must not contain your username');
    expect(passwordIssues('MyPassword123!')).toContain('Avoid common words such as "password" or "admin"');
    expect(passwordIssues('Blue-Harbor-2026')).toEqual([]);
  });
  it('is enforced as a schema', () => {
    expect(passwordRule.safeParse('Blue-Harbor-2026').success).toBe(true);
    expect(passwordRule.safeParse('weak').success).toBe(false);
    expect(passwordRule.safeParse('A'.repeat(129) + 'a1!').success).toBe(false);
  });
});

describe('OpenAPI generator', () => {
  it('lists routes with parameters, permissions and CSRF requirements', () => {
    const r = Router();
    r.get('/things/:id', requirePermission('things.read'), (_q, s) => void s.json({}));
    r.post('/things', requirePermission('things.write', 'things.admin'), (_q, s) => void s.json({}));
    r.get('/me', requireAuth, (_q, s) => void s.json({}));
    r.get('/open', (_q, s) => void s.json({}));
    const spec = buildOpenApi([r]) as any;
    expect(spec.paths['/things/{id}'].get['x-required-permissions']).toEqual(['things.read']);
    expect(spec.paths['/things/{id}'].get.parameters[0]).toMatchObject({ name: 'id', in: 'path', required: true });
    expect(spec.paths['/things'].post['x-required-permissions']).toEqual(['things.write', 'things.admin']);
    expect(spec.paths['/things'].post['x-csrf-required']).toBe(true);
    expect(spec.paths['/me'].get.security).toEqual([{ sessionCookie: [] }]);
    expect(spec.paths['/open'].get.security).toEqual([]);
    expect(spec.openapi).toBe('3.0.3');
  });
});
