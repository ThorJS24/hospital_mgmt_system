import { z } from 'zod';

/** Number of character classes (lower, upper, digit, symbol) present in a password. */
export const characterClasses = (pw: string) =>
  [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;

const COMMON = ['password', 'qwerty', 'letmein', '123456', 'welcome'];

/** Human-readable problems with a candidate password (empty array = acceptable). Mirrors the UI strength hints. */
export function passwordIssues(pw: string, username = ''): string[] {
  const issues: string[] = [];
  if (pw.length < 10) issues.push('Use at least 10 characters');
  if (characterClasses(pw) < 3) issues.push('Mix at least three of: lowercase, uppercase, digits, symbols');
  const low = pw.toLowerCase();
  if (username && username.length >= 3 && low.includes(username.toLowerCase())) issues.push('Must not contain your username');
  if (COMMON.some((c) => low.includes(c))) issues.push('Avoid common words such as "password" or "admin"');
  return issues;
}

export const passwordRule = z.string().max(128).superRefine((pw, ctx) => {
  for (const message of passwordIssues(pw)) ctx.addIssue({ code: 'custom', message });
});
