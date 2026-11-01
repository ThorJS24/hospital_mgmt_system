import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { randomToken } from '../utils/crypto.js';
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

export const SESSION_COOKIE = 'sid';

export function setSessionCookie(res: Response, cfg: AppConfig, id: string) {
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // lab runs over plain HTTP on loopback
    path: '/',
    maxAge: cfg.sessionTtlMinutes * 60_000,
  });
}

export async function createSession(db: Db, cfg: AppConfig, userId: number | null = null): Promise<{ id: string; csrf: string }> {
  const id = randomToken(24);
  const csrf = randomToken(16);
  await db.query(
    "INSERT INTO sessions(id,user_id,csrf_token,expires_at) VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)",
    [id, userId, csrf, String(cfg.sessionTtlMinutes)],
  );
  return { id, csrf };
}

export async function loadUser(db: Db, userId: number): Promise<SessionUser | null> {
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.full_name, u.email, u.staff_id, u.active, r.code AS role, r.name AS role_name, s.department_id
       FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN staff s ON s.id = u.staff_id WHERE u.id = $1`,
    [userId],
  );
  const u = rows[0];
  if (!u || !u.active) return null;
  return {
    id: u.id, username: u.username, fullName: u.full_name, email: u.email, role: u.role, roleName: u.role_name,
    staffId: u.staff_id, departmentId: u.department_id, permissions: permissionsFor(u.role),
  };
}

/** Baseline response headers applied to every route (designated lab routes may remove them). */
export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/** Request id, security headers, session loading (anonymous sessions are created on demand). */
export function context({ db, cfg }: Ctx): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    securityHeaders(req, res, () => {});
    try {
      const sid = req.cookies?.[SESSION_COOKIE];
      let row: any = null;
      if (typeof sid === 'string' && sid.length <= 128) {
        row = (await db.query('SELECT id, user_id, csrf_token FROM sessions WHERE id=$1 AND expires_at > now()', [sid])).rows[0];
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

/** CSRF: all unsafe methods need the session-bound token in X-CSRF-Token. */
export const csrfGuard: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.get('x-csrf-token');
  if (!token || token !== req.sess.csrf) {
    log('warn', 'csrf_rejected', { requestId: req.requestId, path: req.path });
    return next(new HttpError(403, 'Missing or invalid CSRF token'));
  }
  next();
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Authentication required'));
  next();
};

export function requirePermission(...perms: string[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Authentication required'));
    if (!perms.some((p) => req.user!.permissions.includes(p))) {
      log('warn', 'authz_denied', { requestId: req.requestId, user: req.user.username, need: perms.join('|'), path: req.path });
      return next(new HttpError(403, 'You do not have permission to perform this action'));
    }
    next();
  };
}

export const can = (req: Request, perm: string) => !!req.user?.permissions.includes(perm);

export async function audit(db: Db, req: Request, action: string, entity = '', entityId: string | number = '', detail = '') {
  await db.query('INSERT INTO audit_events(user_id,action,entity,entity_id,detail,request_id) VALUES ($1,$2,$3,$4,$5,$6)', [
    req.user?.id ?? null, action, entity, String(entityId), detail.slice(0, 500), req.requestId,
  ]);
  const msg = auditMessage(action);
  if (msg) emitLive(entity, msg);
}
