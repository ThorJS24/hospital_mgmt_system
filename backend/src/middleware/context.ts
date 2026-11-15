import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { randomToken, safeEqual } from '../utils/crypto.js';
import { permissionsFor } from '../services/permissions.js';
import { HttpError } from '../utils/http.js';
import { log } from '../utils/logger.js';
import { auditMessage, emitLive } from '../services/live.js';

export interface SessionUser {
  id: number;
  username: string;
  fullName: string;
  email: string;
  role: string;
  roleName: string;
  staffId: number | null;
  departmentId: number | null;
  patientId: number | null;
  totpEnabled: boolean;
  mustChangePassword: boolean;
  permissions: string[];
}

export interface Ctx {
  db: Db;
  cfg: AppConfig;
}

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    sess: { id: string; csrf: string; userId: number | null };
    user: SessionUser | null;
  }
}

/** With HTTPS the cookie uses the __Host- prefix, which browsers only accept if it is Secure, has Path=/ and no Domain. */
export const sessionCookieName = (cfg: Pick<AppConfig, 'cookieSecure'>) => (cfg.cookieSecure ? '__Host-sid' : 'sid');

export function setSessionCookie(res: Response, cfg: AppConfig, id: string) {
  res.cookie(sessionCookieName(cfg), id, {
    httpOnly: true,
    sameSite: 'strict',
    secure: cfg.cookieSecure, // off only for plain-HTTP loopback development
    path: '/',
    maxAge: cfg.sessionTtlMinutes * 60_000,
  });
}

export interface SessionMeta { ip?: string; userAgent?: string }
export const sessionMeta = (req: Request): SessionMeta => ({ ip: String(req.ip ?? '').slice(0, 64), userAgent: String(req.get('user-agent') ?? '').slice(0, 200) });

export async function createSession(db: Db, cfg: AppConfig, userId: number | null = null, meta: SessionMeta = {}): Promise<{ id: string; csrf: string }> {
  const id = randomToken(24);
  const csrf = randomToken(16);
  await db.query(
    "INSERT INTO sessions(id,user_id,csrf_token,expires_at,ip,user_agent) VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval, $5, $6)",
    [id, userId, csrf, String(cfg.sessionTtlMinutes), meta.ip ?? '', meta.userAgent ?? ''],
  );
  return { id, csrf };
}

export async function loadUser(db: Db, userId: number): Promise<SessionUser | null> {
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.full_name, u.email, u.staff_id, u.patient_id, u.totp_enabled, u.must_change_password, u.active, r.code AS role, r.name AS role_name, s.department_id
       FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN staff s ON s.id = u.staff_id WHERE u.id = $1`,
    [userId],
  );
  const u = rows[0];
  if (!u || !u.active) return null;
  return {
    id: u.id, username: u.username, fullName: u.full_name, email: u.email, role: u.role, roleName: u.role_name,
    staffId: u.staff_id, departmentId: u.department_id, patientId: u.patient_id, totpEnabled: !!u.totp_enabled, mustChangePassword: !!u.must_change_password, permissions: permissionsFor(u.role),
  };
}

/** Baseline response headers applied to every route (designated lab routes may remove them). */
export const securityHeaders = (cfg: Pick<AppConfig, 'cookieSecure'>): RequestHandler => (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Cache-Control', 'no-store');
  if (cfg.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
};

/** Request id, security headers, session loading (anonymous sessions are created on demand). */
export function context({ db, cfg }: Ctx): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    securityHeaders(cfg)(req, res, () => {});
    try {
      const sid = req.cookies?.[sessionCookieName(cfg)];
      let row: any = null;
      if (typeof sid === 'string' && sid.length <= 128) {
        // idle expiry (expires_at slides with activity) AND an absolute lifetime that activity cannot extend
        row = (await db.query("SELECT id, user_id, csrf_token FROM sessions WHERE id=$1 AND expires_at > now() AND created_at > now() - ($2 || ' hours')::interval", [sid, String(cfg.sessionAbsoluteHours)])).rows[0];
      }
      if (!row) {
        const s = await createSession(db, cfg);
        setSessionCookie(res, cfg, s.id);
        row = { id: s.id, user_id: null, csrf_token: s.csrf };
      } else {
        await db.query("UPDATE sessions SET last_seen=now(), expires_at = now() + ($2 || ' minutes')::interval WHERE id=$1", [row.id, String(cfg.sessionTtlMinutes)]);
      }
      req.sess = { id: row.id, csrf: row.csrf_token, userId: row.user_id };
      req.user = row.user_id ? await loadUser(db, row.user_id) : null;
      next();
    } catch (e) {
      next(e);
    }
  };
}

/**
 * CSRF defence in depth for state-changing requests:
 *  1. the session-bound X-CSRF-Token header must match,
 *  2. the browser's Fetch Metadata (Sec-Fetch-Site) must not say the request came from another site,
 *  3. when an Origin header is present its host must be this host (or an explicitly allowed origin).
 * Non-browser clients (no Origin / Sec-Fetch-Site) are still bound by the token.
 */
export const csrfGuard = (cfg: Pick<AppConfig, 'allowedOrigins'>): RequestHandler => (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const reject = (why: string) => {
    log('warn', 'csrf_rejected', { requestId: req.requestId, path: req.path, why });
    return next(new HttpError(403, 'Missing or invalid CSRF token'));
  };
  const origin = req.get('origin');
  const allowed = !!origin && cfg.allowedOrigins.includes(origin);
  const site = req.get('sec-fetch-site');
  if (site && !['same-origin', 'none'].includes(site) && !allowed) return reject(`fetch-site=${site}`);
  if (origin && !allowed) {
    let host = '';
    try { host = new URL(origin).host; } catch { /* "null" and malformed origins fall through to the rejection */ }
    if (!host || host !== req.host) return reject('origin-mismatch');
  }
  const token = req.get('x-csrf-token');
  if (!token || !safeEqual(token, req.sess.csrf)) return reject('token');
  next();
};

/** Until a required password change is done (new accounts, administrator-forced), only the calls needed to do it are allowed. */
const PASSWORD_CHANGE_ALLOWED = new Set(['/auth/session', '/auth/logout', '/profile/password']);
export const passwordChangeGate: RequestHandler = (req, _res, next) => {
  if (req.user?.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(req.path)) {
    return next(new HttpError(403, 'You must change your password before continuing', { code: 'PASSWORD_CHANGE_REQUIRED' }));
  }
  next();
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Authentication required'));
  next();
};
// Markers read by the OpenAPI generator (routes/docs.ts); they do not affect request handling.
(requireAuth as any).authRequired = true;

export function requirePermission(...perms: string[]): RequestHandler {
  const handler: RequestHandler = (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Authentication required'));
    if (!perms.some((p) => req.user!.permissions.includes(p))) {
      log('warn', 'authz_denied', { requestId: req.requestId, user: req.user.username, need: perms.join('|'), path: req.path });
      return next(new HttpError(403, 'You do not have permission to perform this action'));
    }
    next();
  };
  (handler as any).requiredPermissions = perms;
  return handler;
}

export const can = (req: Request, perm: string) => !!req.user?.permissions.includes(perm);

export async function audit(db: Db, req: Request, action: string, entity = '', entityId: string | number = '', detail = '') {
  await db.query('INSERT INTO audit_events(user_id,action,entity,entity_id,detail,request_id,ip) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    req.user?.id ?? null, action, entity, String(entityId), detail.slice(0, 500), req.requestId, String(req.ip ?? '').slice(0, 64),
  ]);
  const msg = auditMessage(action);
  if (msg) emitLive(entity, msg);
}
