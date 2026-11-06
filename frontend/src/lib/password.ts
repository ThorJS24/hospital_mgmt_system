/** Client-side mirror of the server's password policy (backend/src/utils/password.ts), used for live strength hints only. The server remains the authority. */
export interface PasswordCheck { id: string; label: string; ok: boolean }

const COMMON = ['password', 'qwerty', 'letmein', '123456', 'welcome'];

export const characterClasses = (pw: string) => [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;

export function passwordChecks(pw: string, username = ''): PasswordCheck[] {
  const low = pw.toLowerCase();
  return [
    { id: 'length', label: 'At least 10 characters', ok: pw.length >= 10 },
    { id: 'classes', label: 'Three of: lowercase, uppercase, digit, symbol', ok: characterClasses(pw) >= 3 },
    { id: 'username', label: 'Does not contain your username', ok: !(username.length >= 3 && low.includes(username.toLowerCase())) },
    { id: 'common', label: 'No common words such as "password"', ok: !COMMON.some((c) => low.includes(c)) },
  ];
}

export type Strength = 'empty' | 'weak' | 'fair' | 'strong';

export function passwordStrength(pw: string, username = ''): { level: Strength; score: number } {
  if (!pw) return { level: 'empty', score: 0 };
  const checks = passwordChecks(pw, username);
  const passed = checks.filter((c) => c.ok).length;
  // anything the server would reject is shown as weak, so the label never contradicts the checklist
  if (passed < checks.length) return { level: 'weak', score: passed };
  return { level: pw.length >= 14 && characterClasses(pw) === 4 ? 'strong' : 'fair', score: pw.length >= 14 && characterClasses(pw) === 4 ? 5 : 4 };
}

export const passwordAcceptable = (pw: string, username = '') => passwordChecks(pw, username).every((c) => c.ok);
