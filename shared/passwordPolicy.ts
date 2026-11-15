import policy from './password-policy.json';

/**
 * Password policy shared by the API and the browser (so the hints never disagree with the server).
 * Follows NIST SP 800-63B-4 / OWASP: a long minimum, no composition rules, screening against common passwords and obvious
 * patterns, no forced periodic rotation. Reuse of recent passwords is checked on the server only (it needs the history).
 */
export const MIN_LENGTH: number = policy.minLength;
export const MAX_LENGTH: number = policy.maxLength;
export const HISTORY_DEPTH: number = policy.historyDepth;

export interface PolicyContext { username?: string; fullName?: string; email?: string }
export interface PolicyCheck { id: 'length' | 'common' | 'pattern' | 'personal'; label: string; ok: boolean; message: string }

const BLOCK = new Set<string>(policy.blocklist);
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i' };

/** lower-case, undo common look-alike substitutions, keep letters and digits only */
export const normalise = (pw: string) => [...pw.toLowerCase()].map((c) => LEET[c] ?? c).join('').replace(/[^a-z0-9]/g, '');
const lettersAndDigits = (pw: string) => pw.toLowerCase().replace(/[^a-z0-9]/g, '');
const stripTrailingDigits = (s: string) => s.replace(/\d+$/, '');

const lengthOf = (pw: string) => [...pw].length; // code points, so emoji and accents count once

/** Is the password just a common password, a repeat of one, or one with a short prefix/suffix? */
function isCommon(pw: string): boolean {
  const variants = new Set([lettersAndDigits(pw), normalise(pw)]);
  for (const v of variants) {
    if (BLOCK.has(v) || BLOCK.has(stripTrailingDigits(v))) return true;
    for (const w of BLOCK) {
      if (w.length < 5) continue;
      if (v.startsWith(w) && stripTrailingDigits(v.slice(w.length)).length <= 3) return true; // word + short suffix
      if (v.endsWith(w) && v.length - w.length <= 3) return true; // short prefix + word
      for (const core of [v, stripTrailingDigits(v)]) {
        if (core.length >= w.length * 2 && core.length % w.length === 0 && w.repeat(core.length / w.length) === core) return true; // word repeated (optionally + digits)
      }
    }
  }
  return false;
}

function isPattern(pw: string): boolean {
  const chars = [...pw.toLowerCase()];
  if (new Set(chars).size < 6) return true; // aaaaaaaaaaaaaaaa, abababababababab
  if (/^\s+$/.test(pw)) return true;
  const s = lettersAndDigits(pw);
  for (const seq of policy.sequences) {
    const rev = [...seq].reverse().join('');
    if (s.length >= 8 && (seq.includes(s) || rev.includes(s))) return true; // keyboard or alphabet runs
  }
  // a short unit repeated (abcabcabcabcabc, 12341234...)
  for (let n = 1; n <= Math.floor(s.length / 3); n++) {
    if (s.length % n === 0 && s.slice(0, n).repeat(s.length / n) === s) return true;
  }
  return false;
}

/** Words from the account that must not appear in the password. */
function personalTokens(c: PolicyContext): string[] {
  const t = new Set<string>(['medicore']);
  const add = (x: string | undefined, min: number) => { const n = normalise(x ?? ''); if (n.length >= min) t.add(n); };
  add(c.username, 3);
  add(c.email?.split('@')[0], 4);
  for (const part of (c.fullName ?? '').split(/\s+/)) add(part, 4);
  add(c.fullName, 4);
  return [...t];
}

export function checkPassword(pw: string, ctx: PolicyContext = {}): PolicyCheck[] {
  const len = lengthOf(pw);
  const norm = normalise(pw);
  const personal = personalTokens(ctx).find((tok) => norm.includes(tok));
  return [
    { id: 'length', label: `${MIN_LENGTH} to ${MAX_LENGTH} characters (a passphrase of several words works well)`, ok: len >= MIN_LENGTH && len <= MAX_LENGTH,
      message: len < MIN_LENGTH ? `Use at least ${MIN_LENGTH} characters` : `Use at most ${MAX_LENGTH} characters` },
    { id: 'common', label: 'Not a common password or a trivial variation', ok: !isCommon(pw), message: 'This is a very common password or a trivial variation of one' },
    { id: 'pattern', label: 'Not a repeated or keyboard pattern', ok: !isPattern(pw), message: 'Avoid repeated characters, keyboard runs and simple sequences' },
    { id: 'personal', label: 'Does not contain your username, name or email', ok: !personal, message: 'Do not include your username, name, email address or the product name' },
  ];
}

export const passwordIssues = (pw: string, ctx: PolicyContext = {}) => checkPassword(pw, ctx).filter((c) => !c.ok).map((c) => c.message);
export const passwordAcceptable = (pw: string, ctx: PolicyContext = {}) => checkPassword(pw, ctx).every((c) => c.ok);

export type Strength = 'empty' | 'weak' | 'fair' | 'strong';
/** Advisory meter: anything the server would reject is weak; long, varied passwords are strong. */
export function strengthOf(pw: string, ctx: PolicyContext = {}): Strength {
  if (!pw) return 'empty';
  if (!passwordAcceptable(pw, ctx)) return 'weak';
  const unique = new Set([...pw.toLowerCase()]).size;
  return lengthOf(pw) >= 20 && unique >= 10 ? 'strong' : 'fair';
}
