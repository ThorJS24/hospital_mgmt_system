import { describe, expect, it } from 'vitest';
import { DICTIONARIES, LANGS, isLang, translate } from './i18n';
import { characterClasses, passwordAcceptable, passwordChecks, passwordStrength } from './password';
import { describeAgent } from './agent';
import { ALL_NAV, NAV_GROUPS, firstAllowedRoute } from './nav';
import { fmtDate, fmtDateTime, money } from './api';

describe('translations', () => {
  it('offers English, Spanish and Hindi', () => {
    expect(LANGS.map((l) => l.code)).toEqual(['en', 'es', 'hi']);
    expect(isLang('es')).toBe(true);
    expect(isLang('fr')).toBe(false);
    expect(isLang(undefined)).toBe(false);
  });
  it('translates and falls back to English, then to the key', () => {
    expect(translate('es', 'nav.patients')).toBe('Pacientes');
    expect(translate('hi', 'nav.patients')).toBe('मरीज़');
    expect(translate('en', 'nav.patients')).toBe('Patients');
    expect(translate('es', 'not.a.key')).toBe('not.a.key');
  });
  it('replaces placeholders and leaves unknown ones intact', () => {
    expect(translate('en', 'tour.step', { n: 2, total: 5 })).toBe('Step 2 of 5');
    expect(translate('es', 'tour.step', { n: 2, total: 5 })).toBe('Paso 2 de 5');
    expect(translate('hi', 'tour.step', { n: 2, total: 5 })).toBe('चरण 2 / 5');
    expect(translate('en', 'tour.step', { n: 2 })).toBe('Step 2 of {total}');
  });
  it('keeps every language complete and free of stray or empty entries', () => {
    const en = Object.keys(DICTIONARIES.en).sort();
    for (const lang of ['es', 'hi'] as const) {
      const d = DICTIONARIES[lang] as Record<string, string>;
      expect(Object.keys(d).sort(), lang).toEqual(en);
      for (const [k, v] of Object.entries(d)) expect(v.trim(), `${lang}:${k}`).not.toBe('');
      // placeholders must match the English source so interpolation never breaks
      for (const k of en) {
        const ph = (x: string) => (x.match(/\{\w+\}/g) ?? []).sort().join(',');
        expect(ph(d[k]), `${lang}:${k}`).toBe(ph((DICTIONARIES.en as Record<string, string>)[k]));
      }
    }
  });
  it('translates every navigation label', () => {
    for (const n of ALL_NAV) for (const lang of ['en', 'es', 'hi'] as const) expect(translate(lang, n.labelKey), `${lang}:${n.labelKey}`).not.toBe(n.labelKey);
    for (const g of NAV_GROUPS) for (const lang of ['en', 'es', 'hi'] as const) expect(translate(lang, g.labelKey)).not.toBe(g.labelKey);
  });
});

describe('navigation model', () => {
  it('has unique routes and unique go-to shortcut keys', () => {
    const routes = ALL_NAV.map((n) => n.to);
    expect(new Set(routes).size).toBe(routes.length);
    const keys = ALL_NAV.map((n) => n.key).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => k !== 'g' && /^[a-z]$/.test(k!))).toBe(true);
  });
  it('lands each kind of user on a page they may open', () => {
    const can = (perms: string[]) => (...p: string[]) => p.some((x) => perms.includes(x));
    expect(firstAllowedRoute(can(['portal.access']))).toBe('/portal');
    expect(firstAllowedRoute(can(['dashboard.read', 'patients.read_all']))).toBe('/dashboard');
    expect(firstAllowedRoute(can(['assessment.read']))).toBe('/assessment');
    expect(firstAllowedRoute(can([]))).toBe('/profile');
  });
});

describe('password hints', () => {
  it('mirrors the server rules', () => {
    expect(characterClasses('Abc1!')).toBe(4);
    expect(passwordAcceptable('Blue-Harbor-2026')).toBe(true);
    expect(passwordAcceptable('short1A!')).toBe(false);
    expect(passwordAcceptable('alllowercaseletters')).toBe(false);
    expect(passwordAcceptable('Doctor.Svensson-2026', 'doctor.svensson')).toBe(false);
    expect(passwordAcceptable('MyPassword123!')).toBe(false);
    expect(passwordChecks('', 'x').every((c) => !c.ok || c.id === 'username' || c.id === 'common')).toBe(true);
  });
  it('grades strength', () => {
    expect(passwordStrength('').level).toBe('empty');
    expect(passwordStrength('abc').level).toBe('weak');
    expect(passwordStrength('Bluebird2026x').level).toBe('fair');
    expect(passwordStrength('Blue-Harbor-2026').level).toBe('strong');
    expect(passwordStrength('Blue-Harbor-Quartz-2026!').level).toBe('strong');
    expect(passwordStrength('abcdefghijkl').level).toBe('weak');
  });
});

describe('session device labels', () => {
  it('summarises user agents', () => {
    expect(describeAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0')).toEqual({ label: 'Edge on Windows', mobile: false });
    expect(describeAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')).toEqual({ label: 'Safari on iOS', mobile: true });
    expect(describeAgent('Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0')).toEqual({ label: 'Firefox on Linux', mobile: false });
    expect(describeAgent('')).toEqual({ label: 'Unknown device', mobile: false });
  });
});

describe('formatting helpers', () => {
  it('handle missing values', () => {
    expect(money(undefined)).toBe('-');
    expect(fmtDate(null)).toBe('-');
    expect(fmtDateTime(undefined)).toBe('-');
    expect(money(-25)).toBe('-$25.00');
  });
});
