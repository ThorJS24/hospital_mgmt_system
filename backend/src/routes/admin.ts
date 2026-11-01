import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../middleware/context.js';
import { audit, requirePermission } from '../middleware/context.js';
import { HttpError, intParam, pageQuery, parse } from '../utils/http.js';
import { hashPassword } from '../utils/crypto.js';
import { ROLES } from '../services/permissions.js';

/** Ordinary hospital administrators must not create, promote or demote assessors (assessment administration is separate). */
const ASSESSOR = 'security_assessor';
const roleEnum = z.enum(ROLES);

export function adminRoutes({ db }: Ctx) {
  const r = Router();

  r.get('/admin/users', requirePermission('users.manage'), async (req, res) => {
    const pq = pageQuery(req.query);
    const params: unknown[] = [];
    let where = 'true';
    if (pq.q) { params.push(`%${pq.q}%`); where = '(u.username ILIKE $1 OR u.full_name ILIKE $1)'; }
    const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users u WHERE ${where}`, params)).rows[0].n;
    const data = (await db.query(`SELECT u.id, u.username, u.full_name, u.email, u.active, r.code AS role, r.name AS role_name, u.staff_id, u.created_at
      FROM users u JOIN roles r ON r.id=u.role_id WHERE ${where} ORDER BY u.username LIMIT ${pq.pageSize} OFFSET ${(pq.page - 1) * pq.pageSize}`, params)).rows;
    res.json({ data, total, page: pq.page, pageSize: pq.pageSize });
  });

  r.post('/admin/users', requirePermission('users.manage'), async (req, res) => {
    const b = parse(z.object({
      username: z.string().regex(/^[a-z][a-z0-9._-]{2,31}$/, 'Lowercase letters, digits, . _ - (3-32 chars)'), full_name: z.string().min(2).max(100),
      email: z.email().max(200), role: roleEnum, staff_id: z.number().int().positive().nullable().optional(), password: z.string().min(10).max(128),
    }), req.body);
    if (b.role === ASSESSOR) throw new HttpError(403, 'Assessor accounts are provisioned through assessment administration, not hospital administration');
    if ((await db.query('SELECT 1 FROM users WHERE username=$1', [b.username])).rows.length) throw new HttpError(409, 'Username already exists');
    const { rows } = await db.query('INSERT INTO users(username,email,full_name,password_hash,role_id,staff_id) SELECT $1,$2,$3,$4,r.id,$5 FROM roles r WHERE r.code=$6 RETURNING id', [b.username, b.email, b.full_name, hashPassword(b.password), b.staff_id ?? null, b.role]);
    await audit(db, req, 'user_create', 'user', rows[0].id, `role=${b.role}`);
    res.status(201).json({ id: rows[0].id });
  });

  r.patch('/admin/users/:id', requirePermission('users.manage'), async (req, res) => {
    const id = intParam(req.params.id);
    const b = parse(z.object({ role: roleEnum.optional(), active: z.boolean().optional(), full_name: z.string().min(2).max(100).optional(), email: z.email().optional() }).strict(), req.body);
    const cur = (await db.query('SELECT u.id, r.code AS role FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'User not found');
    if (cur.role === ASSESSOR || b.role === ASSESSOR) throw new HttpError(403, 'Assessor accounts cannot be modified by hospital administrators');
    if (id === req.user!.id && (b.active === false || (b.role && b.role !== 'administrator'))) throw new HttpError(409, 'You cannot demote or deactivate your own account');
    if (b.role) await db.query('UPDATE users SET role_id=(SELECT id FROM roles WHERE code=$1) WHERE id=$2', [b.role, id]);
    if (b.active !== undefined) await db.query('UPDATE users SET active=$1 WHERE id=$2', [b.active, id]);
    if (b.full_name) await db.query('UPDATE users SET full_name=$1 WHERE id=$2', [b.full_name, id]);
    if (b.email) await db.query('UPDATE users SET email=$1 WHERE id=$2', [b.email, id]);
    if (b.role || b.active === false) await db.query('DELETE FROM sessions WHERE user_id=$1', [id]);
    await audit(db, req, 'user_update', 'user', id, Object.keys(b).join(','));
    res.json({ ok: true });
  });

  r.get('/admin/config', requirePermission('config.manage'), async (_req, res) => {
    res.json({ data: (await db.query('SELECT key, value, description FROM system_config ORDER BY key')).rows });
  });
  r.put('/admin/config/:key', requirePermission('config.manage'), async (req, res) => {
    const { value } = parse(z.object({ value: z.string().max(200) }), req.body);
    const n = (await db.query('UPDATE system_config SET value=$1 WHERE key=$2 RETURNING key', [value, String(req.params.key)])).rows.length;
    if (!n) throw new HttpError(404, 'Unknown configuration key');
    await audit(db, req, 'config_update', 'config', String(req.params.key));
    res.json({ ok: true });
  });

  r.get('/admin/audit', requirePermission('audit.read'), async (req, res) => {
    const pq = pageQuery(req.query);
    const params: unknown[] = [];
    let where = 'true';
    if (pq.q) { params.push(`%${pq.q}%`); where = '(e.action ILIKE $1 OR e.entity ILIKE $1 OR u.username ILIKE $1 OR e.detail ILIKE $1)'; }
    const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events e LEFT JOIN users u ON u.id=e.user_id WHERE ${where}`, params)).rows[0].n;
    const data = (await db.query(`SELECT e.id, e.at, u.username, e.action, e.entity, e.entity_id, e.detail, e.request_id FROM audit_events e LEFT JOIN users u ON u.id=e.user_id WHERE ${where} ORDER BY e.id DESC LIMIT ${pq.pageSize} OFFSET ${(pq.page - 1) * pq.pageSize}`, params)).rows;
    res.json({ data, total, page: pq.page, pageSize: pq.pageSize });
  });

  /** Local synthetic mail outbox: where password-reset codes are delivered in this offline lab. */
  r.get('/admin/outbox', requirePermission('users.manage'), async (_req, res) => {
    if (process.env.NODE_ENV === 'production') throw new HttpError(404, 'Not found');
    res.json({ data: (await db.query("SELECT t.id, u.username, t.token AS code, t.created_at, t.expires_at, t.used FROM reset_tokens t JOIN users u ON u.id=t.user_id WHERE t.created_at > now() - interval '1 day' ORDER BY t.id DESC LIMIT 20")).rows, note: 'Synthetic local outbox - no email is sent.' });
  });

  return r;
}
