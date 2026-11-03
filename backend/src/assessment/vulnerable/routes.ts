/**
 * INTENTIONALLY VULNERABLE ROUTES - mounted at /api/lab ONLY when LAB_MODE=vulnerable.
 * Only the scenarios left in the build for assessors remain here (HMS-V03, V10, V14, V17, V18 in auth.ts).
 * All other documented weaknesses have been remediated and removed from the code base.
 */
import { Router, type RequestHandler } from 'express';
import type { Ctx } from '../../middleware/context.js';
import { requirePermission } from '../../middleware/context.js';
import { isVulnEnabled } from '../../config/index.js';
import { HttpError, intParam } from '../../utils/http.js';
import { rawClinicalSummary } from '../../services/patients.js';
import { extraVulnerableRoutes } from './extra.js';

export function vulnerableRoutes(ctx: Ctx) {
  const { db, cfg } = ctx;
  const r = Router();
  const only = (id: string): RequestHandler => (_req, _res, next) =>
    isVulnEnabled(cfg, id) ? next() : next(new HttpError(404, 'Not found'));

  // HMS-V03 - BOLA: no care-team scope check
  r.get('/patients/:id/summary', only('HMS-V03'), requirePermission('clinical.read'), async (req, res) => {
    res.json(await rawClinicalSummary(db, intParam(req.params.id)));
  });

  // HMS-V10 - verbose error disclosure
  r.get('/pharmacy/medications/:id', only('HMS-V10'), requirePermission('pharmacy.read'), async (req, res) => {
    const sql = 'SELECT id, code, name, form, strength, stock FROM medications WHERE id = $1';
    try {
      const m = (await db.query(sql, [req.params.id])).rows[0];
      if (!m) throw new HttpError(404, 'Medication not found');
      res.json(m);
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      // VULNERABLE: internals returned to the client
      res.status(500).json({ error: String(e.message), sql, stack: String(e.stack ?? '').split('\n').slice(0, 5) });
    }
  });

  r.use(extraVulnerableRoutes(ctx)); // HMS-V14, HMS-V17

  return r;
}
