import { Router } from 'express';
import type { Ctx } from '../middleware/context.js';
import { requireAuth } from '../middleware/context.js';
import { HttpError, intParam } from '../utils/http.js';

/** Per-user in-app notifications. Every query is bound to the signed-in user, so one user can never read or clear another's alerts. */
export function notificationRoutes({ db }: Ctx) {
  const r = Router();

  r.get('/notifications', requireAuth, async (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '30'), 10) || 30));
    const unreadOnly = req.query.unread === '1';
    const data = (await db.query(
      `SELECT id, kind, severity, title, body, link, created_at, read_at FROM notifications
        WHERE user_id=$1 ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC, id DESC LIMIT ${limit}`, [req.user!.id])).rows;
    const unread = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [req.user!.id])).rows[0].n;
    const critical = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL AND severity='critical'", [req.user!.id])).rows[0].n;
    res.json({ data, unread, critical });
  });

  r.post('/notifications/read-all', requireAuth, async (req, res) => {
    const n = (await db.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL RETURNING id', [req.user!.id])).rows.length;
    res.json({ marked: n });
  });

  r.post('/notifications/:id/read', requireAuth, async (req, res) => {
    const id = intParam(req.params.id);
    const row = (await db.query('UPDATE notifications SET read_at=COALESCE(read_at, now()) WHERE id=$1 AND user_id=$2 RETURNING id', [id, req.user!.id])).rows[0];
    if (!row) throw new HttpError(404, 'Notification not found');
    res.json({ ok: true });
  });

  return r;
}
