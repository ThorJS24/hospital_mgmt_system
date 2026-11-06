import { Router, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from '../middleware/context.js';
import { audit, createSession, loadUser, requireAuth, sessionMeta, setSessionCookie, SESSION_COOKIE } from '../middleware/context.js';
import { HttpError, parse } from '../utils/http.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../utils/crypto.js';
import { passwordRule } from '../utils/password.js';
import { isVulnEnabled } from '../config/index.js';
import { generateSecret, otpauthUri, verifyTotp } from '../services/totp.js';
import { log } from '../utils/logger.js';

const MAX_FAILS = 5;
const LOCK_MINUTES = 10;
const CHALLENGE_MINUTES = 5;
const CHALLENGE_MAX_ATTEMPTS = 5;

/** Public, non-secret handle for a session (the session id itself is the credential and is never returned). */
const sessionRef = (id: string) => createHash('sha256').update(`ref:${id}`).digest('hex').slice(0, 16);
const recoveryHash = (code: string) => sha256(`recovery:${code.replace(/[^a-z0-9]/gi, '').toLowerCase()}`);

export function authRoutes({ db, cfg }: Ctx) {
  const r = Router();

  const publicUser = <T,>(u: T) => u;

  r.get('/auth/session', (req, res) => {
    res.json({
      authenticated: !!req.user,
      user: req.user ? publicUser(req.user) : null,
      csrfToken: req.sess.csrf,
      lab: { mode: cfg.labMode, banner: 'ACADEMIC SECURITY LAB - SYNTHETIC DATA ONLY - NOT FOR CLINICAL USE' },
    });
  });

  /** Rotate the session identifier (prevents session fixation) and return the signed-in state. */
  async function completeLogin(req: Request, res: Response, userId: number) {
    await db.query('DELETE FROM sessions WHERE id=$1', [req.sess.id]);
    const s = await createSession(db, cfg, userId, sessionMeta(req));
    setSessionCookie(res, cfg, s.id);
    req.sess.userId = userId;
    req.user = null;
    const user = await loadUser(db, userId);
    req.user = user;
    await audit(db, req, 'login', 'user', userId);
    res.json({ authenticated: true, user, csrfToken: s.csrf });
  }

  r.post('/auth/login', async (req, res) => {
    const { username, password } = parse(z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(128) }), req.body);
    const { rows } = await db.query('SELECT id, password_hash, active, failed_logins, locked_until, totp_enabled FROM users WHERE username=$1', [username]);
    const u = rows[0];
    if (u?.locked_until && new Date(u.locked_until) > new Date()) {
      await audit(db, req, 'login_locked', 'user', u.id);
      throw new HttpError(429, 'Account temporarily locked. Try again later.');
    }
    // Always run a hash comparison to keep timing similar for unknown users.
    const ok = u && u.active && verifyPassword(password, u.password_hash);
    if (!ok) {
      if (u) {
        const fails = u.failed_logins + 1;
        await db.query("UPDATE users SET failed_logins=$1::int, locked_until = CASE WHEN $1::int >= $2::int THEN now() + ($3::text || ' minutes')::interval ELSE locked_until END WHERE id=$4", [fails, MAX_FAILS, String(LOCK_MINUTES), u.id]);
      }
      log('warn', 'login_failed', { requestId: req.requestId, username });
      await audit(db, req, 'login_failed', 'user', u?.id ?? '', `username=${username.slice(0, 40)}`);
      // HMS-V18: distinct messages reveal which usernames exist (user enumeration)
      if (isVulnEnabled(cfg, 'HMS-V18')) throw new HttpError(401, u ? 'Incorrect password' : 'Unknown username');
      throw new HttpError(401, 'Invalid username or password');
    }
    await db.query('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [u.id]);

    if (u.totp_enabled) {
      // Password accepted: a second factor is required before any session is issued.
      await db.query('DELETE FROM login_challenges WHERE user_id=$1 OR expires_at < now()', [u.id]);
      const challenge = randomToken(24);
      await db.query("INSERT INTO login_challenges(id,user_id,expires_at) VALUES ($1,$2, now() + ($3 || ' minutes')::interval)", [challenge, u.id, String(CHALLENGE_MINUTES)]);
      await audit(db, req, 'login_2fa_required', 'user', u.id);
      return void res.json({ authenticated: false, twoFactorRequired: true, challenge });
    }
    await completeLogin(req, res, u.id);
  });

  /** Verify a TOTP code (replay-protected) or a one-time recovery code for the user. */
  async function verifySecondFactor(userId: number, code: string): Promise<boolean> {
    const u = (await db.query<{ totp_secret: string | null; totp_last_step: number | null }>('SELECT totp_secret, totp_last_step FROM users WHERE id=$1', [userId])).rows[0];
    if (!u?.totp_secret) return false;
    const trimmed = code.trim();
    if (/^\d{6}$/.test(trimmed)) {
      const step = verifyTotp(u.totp_secret, trimmed);
      if (step === null || (u.totp_last_step !== null && step <= u.totp_last_step)) return false; // wrong code or replay
      const upd = await db.query('UPDATE users SET totp_last_step=$1 WHERE id=$2 AND (totp_last_step IS NULL OR totp_last_step < $1) RETURNING id', [step, userId]);
      return upd.rows.length > 0;
    }
    if (/^[a-z0-9]{4}-?[a-z0-9]{4}$/i.test(trimmed)) {
      const used = await db.query('UPDATE recovery_codes SET used=true WHERE user_id=$1 AND code_hash=$2 AND NOT used RETURNING id', [userId, recoveryHash(trimmed)]);
      return used.rows.length > 0;
    }
    return false;
  }

  r.post('/auth/login/2fa', async (req, res) => {
    const { challenge, code } = parse(z.object({ challenge: z.string().min(1).max(128), code: z.string().min(6).max(20) }), req.body);
    const c = (await db.query('SELECT id, user_id, attempts FROM login_challenges WHERE id=$1 AND expires_at > now()', [challenge])).rows[0];
    if (!c) throw new HttpError(401, 'Verification expired. Sign in again.');
    if (c.attempts >= CHALLENGE_MAX_ATTEMPTS) {
      await db.query('DELETE FROM login_challenges WHERE id=$1', [c.id]);
      throw new HttpError(429, 'Too many attempts. Sign in again.');
    }
    if (!(await verifySecondFactor(c.user_id, code))) {
      await db.query('UPDATE login_challenges SET attempts=attempts+1 WHERE id=$1', [c.id]);
      await audit(db, req, 'login_2fa_failed', 'user', c.user_id);
      throw new HttpError(401, 'Invalid verification code');
    }
    await db.query('DELETE FROM login_challenges WHERE id=$1', [c.id]);
    const user = await loadUser(db, c.user_id);
    if (!user) throw new HttpError(401, 'Account unavailable');
    await completeLogin(req, res, c.user_id);
  });

  r.post('/auth/logout', async (req, res) => {
    await audit(db, req, 'logout', 'user', req.user?.id ?? '');
    await db.query('DELETE FROM sessions WHERE id=$1', [req.sess.id]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // ---- profile -----------------------------------------------------------
  r.patch('/profile', requireAuth, async (req, res) => {
    const body = parse(z.object({ full_name: z.string().min(2).max(100).optional(), email: z.email().max(200).optional() }).strict(), req.body);
    if (body.full_name) await db.query('UPDATE users SET full_name=$1 WHERE id=$2', [body.full_name, req.user!.id]);
    if (body.email) await db.query('UPDATE users SET email=$1 WHERE id=$2', [body.email, req.user!.id]);
    await audit(db, req, 'profile_update', 'user', req.user!.id);
    res.json({ user: await loadUser(db, req.user!.id) });
  });

  r.post('/profile/password', requireAuth, async (req, res) => {
    const b = parse(z.object({ current_password: z.string().min(1), new_password: passwordRule }), req.body);
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id=$1', [req.user!.id]);
    if (!verifyPassword(b.current_password, rows[0].password_hash)) throw new HttpError(400, 'Current password is incorrect');
    if (b.new_password.toLowerCase().includes(req.user!.username.toLowerCase())) throw new HttpError(400, 'Password must not contain your username');
    await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hashPassword(b.new_password), req.user!.id]);
    await db.query('DELETE FROM sessions WHERE user_id=$1 AND id <> $2', [req.user!.id, req.sess.id]);
    await audit(db, req, 'password_change', 'user', req.user!.id);
    res.json({ ok: true });
  });

  // ---- two-factor authentication (TOTP) --------------------------------------
  r.get('/auth/2fa/status', requireAuth, async (req, res) => {
    const left = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM recovery_codes WHERE user_id=$1 AND NOT used', [req.user!.id])).rows[0].n;
    res.json({ enabled: req.user!.totpEnabled, recoveryCodesLeft: left });
  });

  r.post('/auth/2fa/setup', requireAuth, async (req, res) => {
    if (req.user!.totpEnabled) throw new HttpError(409, 'Two-factor authentication is already enabled');
    const secret = generateSecret();
    await db.query('UPDATE users SET totp_secret=$1, totp_last_step=NULL WHERE id=$2', [secret, req.user!.id]);
    await audit(db, req, '2fa_setup_started', 'user', req.user!.id);
    res.json({ secret, otpauth: otpauthUri(secret, req.user!.username) });
  });

  async function issueRecoveryCodes(userId: number): Promise<string[]> {
    await db.query('DELETE FROM recovery_codes WHERE user_id=$1', [userId]);
    const codes: string[] = [];
    for (let i = 0; i < 10; i++) {
      const raw = randomToken(4); // 8 hex chars
      codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
      await db.query('INSERT INTO recovery_codes(user_id,code_hash) VALUES ($1,$2)', [userId, recoveryHash(codes[i])]);
    }
    return codes;
  }

  r.post('/auth/2fa/enable', requireAuth, async (req, res) => {
    const { code } = parse(z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }), req.body);
    const u = (await db.query<{ totp_secret: string | null; totp_enabled: boolean }>('SELECT totp_secret, totp_enabled FROM users WHERE id=$1', [req.user!.id])).rows[0];
    if (u.totp_enabled) throw new HttpError(409, 'Two-factor authentication is already enabled');
    if (!u.totp_secret) throw new HttpError(409, 'Start setup first');
    const step = verifyTotp(u.totp_secret, code);
    if (step === null) throw new HttpError(400, 'Invalid verification code');
    await db.query('UPDATE users SET totp_enabled=true, totp_last_step=$1 WHERE id=$2', [step, req.user!.id]);
    const recoveryCodes = await issueRecoveryCodes(req.user!.id);
    await audit(db, req, '2fa_enabled', 'user', req.user!.id);
    res.json({ enabled: true, recoveryCodes });
  });

  r.post('/auth/2fa/disable', requireAuth, async (req, res) => {
    const b = parse(z.object({ password: z.string().min(1).max(128), code: z.string().min(6).max(20) }), req.body);
    if (!req.user!.totpEnabled) throw new HttpError(409, 'Two-factor authentication is not enabled');
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id=$1', [req.user!.id]);
    if (!verifyPassword(b.password, rows[0].password_hash)) throw new HttpError(400, 'Password is incorrect');
    if (!(await verifySecondFactor(req.user!.id, b.code))) throw new HttpError(400, 'Invalid verification code');
    await db.query('UPDATE users SET totp_enabled=false, totp_secret=NULL, totp_last_step=NULL WHERE id=$1', [req.user!.id]);
    await db.query('DELETE FROM recovery_codes WHERE user_id=$1', [req.user!.id]);
    await audit(db, req, '2fa_disabled', 'user', req.user!.id);
    res.json({ enabled: false });
  });

  r.post('/auth/2fa/recovery-codes', requireAuth, async (req, res) => {
    const b = parse(z.object({ password: z.string().min(1).max(128), code: z.string().min(6).max(20) }), req.body);
    if (!req.user!.totpEnabled) throw new HttpError(409, 'Two-factor authentication is not enabled');
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id=$1', [req.user!.id]);
    if (!verifyPassword(b.password, rows[0].password_hash)) throw new HttpError(400, 'Password is incorrect');
    if (!(await verifySecondFactor(req.user!.id, b.code))) throw new HttpError(400, 'Invalid verification code');
    await audit(db, req, '2fa_recovery_regenerated', 'user', req.user!.id);
    res.json({ recoveryCodes: await issueRecoveryCodes(req.user!.id) });
  });

  // ---- active sessions -------------------------------------------------------
  r.get('/auth/sessions', requireAuth, async (req, res) => {
    const rows = (await db.query<{ id: string; created_at: string; last_seen: string; expires_at: string; ip: string; user_agent: string }>(
      'SELECT id, created_at, last_seen, expires_at, ip, user_agent FROM sessions WHERE user_id=$1 AND expires_at > now() ORDER BY last_seen DESC', [req.user!.id])).rows;
    res.json({ data: rows.map((s) => ({ ref: sessionRef(s.id), created_at: s.created_at, last_seen: s.last_seen, expires_at: s.expires_at, ip: s.ip, user_agent: s.user_agent, current: s.id === req.sess.id })) });
  });

  r.delete('/auth/sessions/:ref', requireAuth, async (req, res) => {
    const ref = String(req.params.ref);
    const rows = (await db.query<{ id: string }>('SELECT id FROM sessions WHERE user_id=$1', [req.user!.id])).rows;
    const target = rows.find((s) => sessionRef(s.id) === ref);
    if (!target) throw new HttpError(404, 'Session not found');
    if (target.id === req.sess.id) throw new HttpError(409, 'This is your current session. Use sign out instead.');
    await db.query('DELETE FROM sessions WHERE id=$1', [target.id]);
    await audit(db, req, 'session_revoked', 'user', req.user!.id);
    res.json({ ok: true });
  });

  r.post('/auth/sessions/revoke-others', requireAuth, async (req, res) => {
    const n = (await db.query('DELETE FROM sessions WHERE user_id=$1 AND id <> $2 RETURNING id', [req.user!.id, req.sess.id])).rows.length;
    await audit(db, req, 'sessions_revoked_others', 'user', req.user!.id, `count=${n}`);
    res.json({ revoked: n });
  });

  // ---- password reset (local, synthetic; token lands in the admin-only local outbox) ----
  r.post('/auth/password-reset/request', async (req, res) => {
    const { username } = parse(z.object({ username: z.string().min(1).max(64) }), req.body);
    const { rows } = await db.query('SELECT id FROM users WHERE username=$1 AND active', [username]);
    if (rows[0]) {
      const token = randomToken(24);
      await db.query('UPDATE reset_tokens SET used=true WHERE user_id=$1', [rows[0].id]);
      await db.query("INSERT INTO reset_tokens(user_id,token,expires_at) VALUES ($1,$2, now() + interval '30 minutes')", [rows[0].id, token]);
      await audit(db, req, 'password_reset_requested', 'user', rows[0].id);
    }
    res.json({ message: 'If the account exists, a reset code was placed in the local synthetic outbox.' });
  });

  r.post('/auth/password-reset/confirm', async (req, res) => {
    const b = parse(z.object({ username: z.string().min(1).max(64), token: z.string().min(1).max(64), new_password: passwordRule }), req.body);
    const { rows } = await db.query(
      `SELECT t.id, t.token, t.attempts, u.id AS uid FROM reset_tokens t JOIN users u ON u.id=t.user_id
        WHERE u.username=$1 AND NOT t.used AND t.expires_at > now() ORDER BY t.id DESC LIMIT 1`,
      [b.username],
    );
    const t = rows[0];
    if (!t) throw new HttpError(400, 'Invalid or expired reset code');
    if (t.attempts >= 5) {
      await db.query('UPDATE reset_tokens SET used=true WHERE id=$1', [t.id]);
      throw new HttpError(429, 'Too many attempts. Request a new code.');
    }
    if (t.token !== b.token) {
      await db.query('UPDATE reset_tokens SET attempts=attempts+1 WHERE id=$1', [t.id]);
      throw new HttpError(400, 'Invalid or expired reset code');
    }
    await db.query('UPDATE reset_tokens SET used=true WHERE id=$1', [t.id]);
    await db.query('UPDATE users SET password_hash=$1, failed_logins=0, locked_until=NULL WHERE id=$2', [hashPassword(b.new_password), t.uid]);
    await db.query('DELETE FROM sessions WHERE user_id=$1', [t.uid]);
    await audit(db, req, 'password_reset_completed', 'user', t.uid);
    res.json({ ok: true });
  });

  return r;
}
