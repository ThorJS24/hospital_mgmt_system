import { Router, type RequestHandler } from 'express';
import type { Ctx } from '../middleware/context.js';
import { requireAuth } from '../middleware/context.js';
import { HttpError } from '../utils/http.js';
import { bus, recentEvents, type LiveEvent } from '../services/live.js';

/** Server-sent events: anonymised operational activity for any signed-in staff member (patients are never subscribed). */
export function liveRoutes(_ctx: Ctx) {
  const r = Router();
  const staffOnly: RequestHandler = (req, _res, next) => (req.user!.role === 'patient' ? next(new HttpError(403, 'Not available to patient accounts')) : next());

  r.get('/live/recent', requireAuth, staffOnly, (_req, res) => res.json({ data: recentEvents() }));

  r.get('/live', requireAuth, staffOnly, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 4000\n\n');
    const send = (ev: LiveEvent) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    bus.on('event', send);
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
    req.on('close', () => { clearInterval(beat); bus.off('event', send); });
  });

  return r;
}
