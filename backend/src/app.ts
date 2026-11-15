import fs from 'node:fs';
import path from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import type { Db } from './db/index.js';
import { type AppConfig } from './config/index.js';
import { context, csrfGuard, passwordChangeGate, securityHeaders } from './middleware/context.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { HttpError } from './utils/http.js';
import { log } from './utils/logger.js';
import { authRoutes } from './routes/auth.js';
import { patientRoutes } from './routes/patients.js';
import { appointmentRoutes } from './routes/appointments.js';
import { inpatientRoutes } from './routes/inpatient.js';
import { orgRoutes } from './routes/org.js';
import { laboratoryRoutes } from './routes/laboratory.js';
import { pharmacyRoutes } from './routes/pharmacy.js';
import { billingRoutes } from './routes/billing.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { adminRoutes } from './routes/admin.js';
import { assessmentRoutes } from './routes/assessment.js';
import { liveRoutes } from './routes/live.js';
import { consultationRoutes } from './routes/consultations.js';
import { clinicalRoutes } from './routes/clinical.js';
import { notificationRoutes } from './routes/notifications.js';
import { searchRoutes } from './routes/search.js';
import { staffingRoutes } from './routes/staffing.js';
import { inventoryRoutes } from './routes/inventory.js';
import { reportRoutes } from './routes/reports.js';
import { portalRoutes } from './routes/portal.js';
import { docsRoutes } from './routes/docs.js';
import { vulnerableRoutes } from './assessment/vulnerable/routes.js';

export function createApp(db: Db, cfg: AppConfig) {
  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', /^\d+$/.test(cfg.trustProxy) ? Number(cfg.trustProxy) : cfg.trustProxy);
  app.use(securityHeaders(cfg));

  // Health check: no session, no data.
  app.get('/api/health', async (_req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ status: 'ok', labMode: cfg.labMode });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  // Throttle before any body parsing, session lookup or password hashing: a general per-client limit, and a much
  // tighter one on the endpoints that check secrets (sign-in, second factor, password reset).
  const apiLimiter = createRateLimiter({ name: 'api', max: cfg.rateLimit.apiMax, windowMs: cfg.rateLimit.apiWindowMs });
  const authLimiter = createRateLimiter({ name: 'auth', max: cfg.rateLimit.authMax, windowMs: cfg.rateLimit.authWindowMs });

  const ctx = { db, cfg };
  const api = express.Router();
  api.use(apiLimiter);
  api.use(['/auth/login', '/auth/login/2fa', '/auth/password-reset/request', '/auth/password-reset/confirm'], authLimiter);
  api.use(express.json({ limit: '3mb' }));
  api.use(cookieParser());
  api.use(context(ctx));
  api.use(csrfGuard(cfg));
  api.use(passwordChangeGate);
  const auth = authRoutes(ctx);
  api.use(auth);
  const routers = [patientRoutes, appointmentRoutes, inpatientRoutes, orgRoutes, laboratoryRoutes, pharmacyRoutes, billingRoutes, dashboardRoutes, adminRoutes, assessmentRoutes, liveRoutes,
    consultationRoutes, clinicalRoutes, notificationRoutes, searchRoutes, staffingRoutes, inventoryRoutes, reportRoutes, portalRoutes].map((make) => make(ctx));
  for (const router of routers) api.use(router);
  const docs = docsRoutes(ctx, () => [auth, ...routers, docs]);
  api.use(docs);
  // Intentionally vulnerable scenarios exist ONLY in vulnerable mode; in secure mode /api/lab/* is a plain 404.
  if (cfg.labMode === 'vulnerable') api.use('/lab', vulnerableRoutes(ctx));
  api.use((_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use('/api', api);

  // Optional: serve the built front end from this process (SERVE_FRONTEND=1) with a strict Content-Security-Policy.
  if (cfg.serveFrontend && fs.existsSync(path.join(cfg.frontendDir, 'index.html'))) {
    const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; " +
      "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
    app.use((req, res, next) => { if (!req.path.startsWith('/api')) { res.setHeader('Content-Security-Policy', csp); res.setHeader('Cache-Control', 'no-cache'); } next(); });
    app.use(express.static(cfg.frontendDir, {
      index: false, dotfiles: 'ignore',
      setHeaders: (res, file) => { if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); },
    }));
    app.use((req, res, next) => ((req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api') ? res.sendFile(path.join(cfg.frontendDir, 'index.html')) : next()));
  }

  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof HttpError) {
      return void res.status(err.status).json({ error: err.message, details: err.details, requestId: req.requestId });
    }
    if (err?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'Malformed JSON body', requestId: req.requestId });
    if (err?.type === 'entity.too.large') return void res.status(413).json({ error: 'Request body too large', requestId: req.requestId });
    log('error', 'unhandled_error', { requestId: req.requestId, path: req.path, message: String(err?.message ?? err) });
    res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
  };
  app.use(onError);
  return app;
}

