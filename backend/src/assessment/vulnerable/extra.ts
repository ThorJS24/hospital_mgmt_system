/**
 * INTENTIONALLY VULNERABLE ROUTES, batch 2 (HMS-V13 .. HMS-V19). Mounted under /api/lab in vulnerable mode only.
 */
import { Router, type RequestHandler } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Ctx } from '../../middleware/context.js';
import { requireAuth, requirePermission } from '../../middleware/context.js';
import { isVulnEnabled } from '../../config/index.js';
import { HttpError } from '../../utils/http.js';
import { fetchLoopbackOnly, naiveSsrfCheck } from './ssrf.js';

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const SECRET = randomBytes(32); // per-process; never logged or returned

export function signToken(claims: Record<string, unknown>): string {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(claims));
  return `${h}.${p}.${b64u(createHmac('sha256', SECRET).update(`${h}.${p}`).digest())}`;
}

/** VULNERABLE: honours the attacker-controlled "alg" header, accepting "none" with no signature check. */
export function verifyTokenUnsafely(token: string): Record<string, any> {
  const [h, p, sig] = token.split('.');
  if (!h || !p) throw new HttpError(401, 'Malformed token');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  if (header.alg !== 'none') {
    const expected = createHmac('sha256', SECRET).update(`${h}.${p}`).digest();
    const given = Buffer.from(sig ?? '', 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, 'Invalid signature');
  }
  return JSON.parse(Buffer.from(p, 'base64url').toString());
}

export function extraVulnerableRoutes({ db, cfg }: Ctx) {
  const r = Router();
  const only = (id: string): RequestHandler => (_req, _res, next) => (isVulnEnabled(cfg, id) ? next() : next(new HttpError(404, 'Not found')));

  // HMS-V13 - SSRF: "drug monograph fetch". Containment lives in ssrf.ts (loopback literals only).
  r.get('/integrations/fetch', only('HMS-V13'), requirePermission('pharmacy.read'), async (req, res) => {
    let url: URL;
    try { url = naiveSsrfCheck(String(req.query.url ?? '')); } catch (e: any) { throw new HttpError(400, e.message); }
    try { res.json(await fetchLoopbackOnly(url)); } catch (e: any) { throw new HttpError(502, `Fetch failed: ${e.message}`); }
  });

  // HMS-V14 - open redirect (login "continue" link): only checks the first character.
  r.get('/auth/redirect', only('HMS-V14'), (req, res) => {
    const next = String(req.query.next ?? '/');
    if (!next.startsWith('/')) throw new HttpError(400, 'Invalid redirect target'); // bypass: //host or /\host
    res.redirect(302, next);
  });

  // HMS-V15 - JWT alg=none
  r.post('/api-token', only('HMS-V15'), requireAuth, (req, res) => {
    res.json({ token: signToken({ sub: req.user!.username, role: req.user!.role, iat: Math.floor(Date.now() / 1000) }) });
  });
  r.get('/token-admin/summary', only('HMS-V15'), async (req, res) => {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') ?? '');
    if (!m) throw new HttpError(401, 'Bearer token required');
    let claims: Record<string, any>;
    try { claims = verifyTokenUnsafely(m[1]); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(401, 'Malformed token'); }
    if (claims.role !== 'administrator') throw new HttpError(403, 'Administrator role required');
    const roles = (await db.query('SELECT r.code AS role, count(*)::int AS users FROM users u JOIN roles r ON r.id=u.role_id GROUP BY r.code ORDER BY r.code')).rows;
    res.json({ subject: claims.sub, usersByRole: roles });
  });

  // HMS-V16 - blind / time-based SQL injection (boolean oracle). Containment: read-only, single statement, 3 s timeout.
  r.get('/patients/exists', only('HMS-V16'), requirePermission('patients.read_all'), async (req, res) => {
    const mrn = String(req.query.mrn ?? '');
    try {
      const found = await db.tx(async (t) => {
        await t.exec('SET TRANSACTION READ ONLY');
        await t.exec("SET LOCAL statement_timeout = '3000ms'");
        return (await t.query(`SELECT 1 FROM patients WHERE $1::int = 1 AND mrn = '${mrn}' LIMIT 1`, [1])).rows.length > 0; // VULNERABLE
      });
      res.json({ exists: found });
    } catch { res.json({ exists: false }); } // errors are swallowed: the oracle is blind
  });

  // HMS-V17 - reflected XSS in a search results page
  r.get('/search-page', only('HMS-V17'), (req, res) => {
    const q = String(req.query.q ?? '');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('X-Content-Type-Options');
    res.type('html').send(`<!doctype html><title>Search</title><h1>Search results</h1><p>No records matched <b>${q}</b>.</p><p><a href="/">Back to MediCore</a></p>`); // VULNERABLE: q not encoded
  });

  // HMS-V19 - exposed debug endpoint (no authentication)
  r.get('/debug/config', only('HMS-V19'), (_req, res) => {
    res.json({
      app: 'MediCore HMS', version: '1.0.0', node: process.version, uptimeSeconds: Math.round(process.uptime()),
      database: db.kind, labMode: cfg.labMode, host: cfg.host, port: cfg.port, sessionTtlMinutes: cfg.sessionTtlMinutes,
      mountedLabRoutes: ['/patients/legacy-search', '/patients/exists', '/patients/:id/summary', '/admin/audit-export', '/integrations/fetch', '/api-token', '/token-admin/summary', '/search-page', '/auth/redirect', '/reports/download'],
    });
  });

  return r;
}
