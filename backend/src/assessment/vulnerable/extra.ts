/**
 * INTENTIONALLY VULNERABLE ROUTES, batch 2 (HMS-V14, HMS-V17). Mounted under /api/lab in vulnerable mode only.
 */
import { Router, type RequestHandler } from 'express';
import type { Ctx } from '../../middleware/context.js';
import { isVulnEnabled } from '../../config/index.js';
import { HttpError } from '../../utils/http.js';

export function extraVulnerableRoutes({ cfg }: Ctx) {
  const r = Router();
  const only = (id: string): RequestHandler => (_req, _res, next) => (isVulnEnabled(cfg, id) ? next() : next(new HttpError(404, 'Not found')));

  // HMS-V14 - open redirect (login "continue" link): only checks the first character.
  r.get('/auth/redirect', only('HMS-V14'), (req, res) => {
    const next = String(req.query.next ?? '/');
    if (!next.startsWith('/')) throw new HttpError(400, 'Invalid redirect target'); // bypass: //host or /\host
    res.redirect(302, next);
  });

  // HMS-V17 - reflected XSS in a search results page
  r.get('/search-page', only('HMS-V17'), (req, res) => {
    const q = String(req.query.q ?? '');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('X-Content-Type-Options');
    res.type('html').send(`<!doctype html><title>Search</title><h1>Search results</h1><p>No records matched <b>${q}</b>.</p><p><a href="/">Back to MediCore</a></p>`); // VULNERABLE: q not encoded
  });

  return r;
}
