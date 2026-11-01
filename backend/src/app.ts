import express, { type ErrorRequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import type { Db } from './db/index.js';
import { type AppConfig } from './config/index.js';
import { context, csrfGuard, securityHeaders } from './middleware/context.js';
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
import { vulnerableRoutes } from './assessment/vulnerable/routes.js';

export function createApp(db: Db, cfg: AppConfig) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '3mb' }));
  app.use(cookieParser());
  app.use(securityHeaders);

  // Health check: no session, no data.
  app.get('/api/health', async (_req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ status: 'ok', labMode: cfg.labMode });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  const ctx = { db, cfg };
  const api = express.Router();
  api.use(context(ctx));
  api.use(csrfGuard);
  api.use(authRoutes(ctx));
  for (const make of [patientRoutes, appointmentRoutes, inpatientRoutes, orgRoutes, laboratoryRoutes, pharmacyRoutes, billingRoutes, dashboardRoutes, adminRoutes, assessmentRoutes, liveRoutes]) {
    api.use(make(ctx));
  }
  // Intentionally vulnerable scenarios exist ONLY in vulnerable mode; in secure mode /api/lab/* is a plain 404.
  if (cfg.labMode === 'vulnerable') api.use('/lab', vulnerableRoutes(ctx));
  api.use((_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use('/api', api);

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

