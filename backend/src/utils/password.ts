import { z } from 'zod';
import type { Db } from '../db/index.js';
import { HttpError } from './http.js';
import { verifyPassword } from './crypto.js';
import { HISTORY_DEPTH, MAX_LENGTH, passwordIssues, type PolicyContext } from '../../../shared/passwordPolicy.js';

export { passwordIssues, passwordAcceptable, checkPassword, MIN_LENGTH, MAX_LENGTH } from '../../../shared/passwordPolicy.js';

/** Transport-level bound only; the real policy is applied by assertPasswordAllowed (it needs the account context and history). */
export const passwordRule = z.string().min(1).max(MAX_LENGTH + 64, 'Password is too long');

const fieldError = (message: string) => new HttpError(400, 'Validation failed', [{ field: 'new_password', message }]);

/**
 * Enforces the full policy for a new password: length, common/pattern screening, personal data, not the current
 * password and not one of the last few used. Throws 400 with a field error so forms can show it next to the input.
 */
export async function assertPasswordAllowed(db: Db, userId: number | null, pw: string, ctx: PolicyContext): Promise<void> {
  const issues = passwordIssues(pw, ctx);
  if (issues.length) throw fieldError(issues[0]);
  if (userId !== null) {
    const hashes = [
      ...(await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=$1', [userId])).rows.map((r) => r.password_hash),
      ...(await db.query<{ password_hash: string }>('SELECT password_hash FROM password_history WHERE user_id=$1 ORDER BY id DESC LIMIT $2', [userId, HISTORY_DEPTH])).rows.map((r) => r.password_hash),
    ];
    for (const h of hashes) if (await verifyPassword(pw, h)) throw fieldError(`Choose a password you have not used recently (the last ${HISTORY_DEPTH} are remembered)`);
  }
}

/** Stores the new hash, remembers the old one for the reuse check, clears the must-change flag and trims the history. */
export async function setPassword(db: Db, userId: number, newHash: string): Promise<void> {
  await db.tx(async (t) => {
    const old = (await t.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
    if (old) await t.query('INSERT INTO password_history(user_id,password_hash) VALUES ($1,$2)', [userId, old.password_hash]);
    await t.query('UPDATE users SET password_hash=$2, must_change_password=false, password_changed_at=now() WHERE id=$1', [userId, newHash]);
    await t.query('DELETE FROM password_history WHERE user_id=$1 AND id NOT IN (SELECT id FROM password_history WHERE user_id=$1 ORDER BY id DESC LIMIT $2)', [userId, HISTORY_DEPTH]);
  });
}
