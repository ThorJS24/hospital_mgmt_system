/**
 * INTENTIONALLY VULNERABLE helpers that normal routes call only when the matching scenario is enabled
 * (LAB_MODE=vulnerable). Each function is the single place where the weakness lives.
 *   HMS-V05 mass assignment, HMS-V06 weak reset token, HMS-V07 session fixation.
 */
import type { Db } from '../../db/index.js';

/** HMS-V05: applies ANY column present in the body to the user row (including role). */
export async function applyProfileUpdateUnsafely(db: Db, userId: number, body: Record<string, unknown>): Promise<void> {
  const map: Record<string, string> = { full_name: 'full_name', email: 'email', username: 'username' };
  for (const [k, v] of Object.entries(body)) {
    if (k === 'role_code' && typeof v === 'string') {
      await db.query('UPDATE users SET role_id=(SELECT id FROM roles WHERE code=$1) WHERE id=$2 AND EXISTS (SELECT 1 FROM roles WHERE code=$1)', [v, userId]);
    } else if (map[k] && typeof v === 'string') {
      await db.query(`UPDATE users SET ${map[k]}=$1 WHERE id=$2`, [v, userId]);
    }
  }
}

/** HMS-V06: 4-digit token (10,000 possibilities). */
export const weakResetToken = () => String(Math.floor(Math.random() * 10000)).padStart(4, '0');

/** HMS-V07: promote the pre-login session instead of issuing a new identifier. */
export async function upgradeSessionInPlace(db: Db, sessionId: string, userId: number): Promise<void> {
  await db.query('UPDATE sessions SET user_id=$1 WHERE id=$2', [userId, sessionId]);
}
