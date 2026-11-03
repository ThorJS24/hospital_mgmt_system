import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../middleware/context.js';
import { audit, createSession, loadUser, requireAuth, setSessionCookie, SESSION_COOKIE } from '../middleware/context.js';
import { HttpError, parse } from '../utils/http.js';
import { hashPassword, randomToken, verifyPassword } from '../utils/crypto.js';
import { isVulnEnabled } from '../config/index.js';
import { log } from '../utils/logger.js';

const passwordRule = z.string().min(10, 'Use at least 10 characters').max(128);
const MAX_FAILS = 5;
const LOCK_MINUTES = 10;

export function authRoutes({ db, cfg }: Ctx) {
  const r = Router();

  const publicUser = <T,>(u: T) => u;

  r.get('/auth/session', (req, res) => {
    res.json({
      authenticated: !!req.user,
      user: req.user ? publicUser(req.user) : null,
      csrfToken: req.sess.csrf,
      lab: { mode: cfg.labMode, banner: 'ACADEMIC SECURITY LAB — SYNTHETIC DATA ONLY — NOT FOR CLINICAL USE' },
    });
  });

  r.post('/auth/login', async (req, res) => {
    const { username, password } = parse(z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(128) }), req.body);
    const { rows } = await db.query('SELECT id, password_hash, active, failed_logins, locked_until FROM users WHERE username=$1', [username]);
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

    // Rotate the session identifier on login (prevents session fixation).
    await db.query('DELETE FROM sessions WHERE id=$1', [req.sess.id]);
    const s = await createSession(db, cfg, u.id);
    setSessionCookie(res, cfg, s.id);
    const csrf = s.csrf;
    req.sess.userId = u.id;
    req.user = null;
    const user = await loadUser(db, u.id);
    req.user = user;
    await audit(db, req, 'login', 'user', u.id);
    res.json({ authenticated: true, user, csrfToken: csrf });
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
    await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hashPassword(b.new_password), req.user!.id]);
    await db.query('DELETE FROM sessions WHERE user_id=$1 AND id <> $2', [req.user!.id, req.sess.id]);
    await audit(db, req, 'password_change', 'user', req.user!.id);
    res.json({ ok: true });
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
