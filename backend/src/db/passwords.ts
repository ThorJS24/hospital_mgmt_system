import type { Db } from './index.js';
import { TEST_ACCOUNTS } from './seed.js';
import { hashPassword } from '../utils/crypto.js';

export interface RestoreResult { restored: string[]; missing: string[]; unknown: string[] }

/**
 * Puts the documented development password back on the demo accounts without touching any other data.
 * It also clears lockouts, two-step verification (secret and recovery codes) and open sessions, and re-activates the account,
 * so a demo user who changed their password, enabled 2FA or got locked out can sign in again. Local tooling only (see cli.ts).
 */
export async function restoreDemoPasswords(db: Db, usernames: string[] = []): Promise<RestoreResult> {
  const wanted = usernames.length ? usernames : TEST_ACCOUNTS.map((a) => a.username);
  const known = new Map(TEST_ACCOUNTS.map((a) => [a.username, a]));
  const result: RestoreResult = { restored: [], missing: [], unknown: [] };
  for (const name of wanted) {
    const acct = known.get(name);
    if (!acct) { result.unknown.push(name); continue; }
    const row = (await db.query<{ id: number }>('SELECT id FROM users WHERE username=$1', [name])).rows[0];
    if (!row) { result.missing.push(name); continue; }
    const hash = await hashPassword(acct.password);
    await db.tx(async (t) => {
      await t.query('UPDATE users SET password_hash=$2, must_change_password=false, password_changed_at=now(), active=true, failed_logins=0, locked_until=NULL, totp_enabled=false, totp_secret=NULL, totp_last_step=NULL WHERE id=$1', [row.id, hash]);
      await t.query('DELETE FROM recovery_codes WHERE user_id=$1', [row.id]);
      await t.query('DELETE FROM login_challenges WHERE user_id=$1', [row.id]);
      await t.query('DELETE FROM reset_tokens WHERE user_id=$1', [row.id]);
      await t.query('DELETE FROM password_history WHERE user_id=$1', [row.id]);
      await t.query('DELETE FROM sessions WHERE user_id=$1', [row.id]);
      await t.query("INSERT INTO audit_events(user_id,action,entity,entity_id,detail,request_id) VALUES (NULL,'demo_password_restored','user',$1,'via local CLI','cli')", [String(row.id)]);
    });
    result.restored.push(name);
  }
  return result;
}
