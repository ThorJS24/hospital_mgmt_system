import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../middleware/context.js';
import { audit, requirePermission } from '../middleware/context.js';
import { HttpError, intParam, pageQuery, parse } from '../utils/http.js';
import { scanInventory } from '../services/notifications.js';

const isUniqueViolation = (e: any) => e?.code === '23505' || /unique|duplicate/i.test(String(e?.message));
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const INV_SELECT = `SELECT m.id, m.code, m.name, m.form, m.strength, m.stock, m.reorder_level, m.max_daily_units, m.drug_class, m.unit_cost::float AS unit_cost,
    to_char(m.expiry_date,'YYYY-MM-DD') AS expiry_date, m.supplier_id, s.name AS supplier,
    (m.expiry_date - current_date) AS days_to_expiry,
    (m.stock <= m.reorder_level) AS low,
    (m.expiry_date IS NOT NULL AND m.expiry_date < current_date) AS expired,
    (m.expiry_date IS NOT NULL AND m.expiry_date >= current_date AND m.expiry_date <= current_date + 30) AS expiring
  FROM medications m LEFT JOIN suppliers s ON s.id=m.supplier_id`;

export function inventoryRoutes({ db }: Ctx) {
  const r = Router();

  r.get('/inventory', requirePermission('inventory.read'), async (req, res) => {
    const pq = pageQuery(req.query);
    const params: unknown[] = [];
    const where = ['true'];
    const filter = String(req.query.filter ?? 'all');
    if (filter === 'low') where.push('m.stock <= m.reorder_level');
    else if (filter === 'expiring') where.push('m.expiry_date IS NOT NULL AND m.expiry_date >= current_date AND m.expiry_date <= current_date + 30');
    else if (filter === 'expired') where.push('m.expiry_date IS NOT NULL AND m.expiry_date < current_date');
    else if (filter !== 'all') throw new HttpError(400, 'Unknown filter');
    if (req.query.supplier_id) { params.push(intParam(req.query.supplier_id, 'supplier_id')); where.push(`m.supplier_id=$${params.length}`); }
    if (pq.q) { params.push(`%${pq.q}%`); where.push(`(m.name ILIKE $${params.length} OR m.code ILIKE $${params.length})`); }
    const w = where.join(' AND ');
    const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM medications m WHERE ${w}`, params)).rows[0].n;
    const data = (await db.query(`${INV_SELECT} WHERE ${w} ORDER BY m.name LIMIT ${pq.pageSize} OFFSET ${(pq.page - 1) * pq.pageSize}`, params)).rows;
    res.json({ data, total, page: pq.page, pageSize: pq.pageSize });
  });

  r.get('/inventory/alerts', requirePermission('inventory.read'), async (_req, res) => {
    const pick = async (cond: string) => (await db.query(`${INV_SELECT} WHERE ${cond} ORDER BY m.name LIMIT 50`)).rows;
    const [low, expiring, expired] = await Promise.all([
      pick('m.stock <= m.reorder_level'),
      pick('m.expiry_date IS NOT NULL AND m.expiry_date >= current_date AND m.expiry_date <= current_date + 30'),
      pick('m.expiry_date IS NOT NULL AND m.expiry_date < current_date'),
    ]);
    const value = (await db.query<{ v: number }>('SELECT COALESCE(sum(stock * unit_cost),0)::float AS v FROM medications')).rows[0].v;
    res.json({ counts: { low: low.length, expiring: expiring.length, expired: expired.length }, low, expiring, expired, stockValue: value });
  });

  r.get('/inventory/:id/movements', requirePermission('inventory.read'), async (req, res) => {
    const id = intParam(req.params.id);
    if (!(await db.query('SELECT 1 FROM medications WHERE id=$1', [id])).rows.length) throw new HttpError(404, 'Medication not found');
    const data = (await db.query(`SELECT sm.id, sm.delta, sm.reason, sm.note, sm.created_at, u.full_name AS user FROM stock_movements sm LEFT JOIN users u ON u.id=sm.user_id
        WHERE sm.medication_id=$1 ORDER BY sm.id DESC LIMIT 50`, [id])).rows;
    res.json({ data });
  });

  r.post('/inventory/:id/receive', requirePermission('inventory.manage'), async (req, res) => {
    const id = intParam(req.params.id);
    const b = parse(z.object({
      quantity: z.number().int().min(1).max(100000), expiry_date: dateStr.optional(), supplier_id: z.number().int().positive().optional(), note: z.string().max(200).default(''),
    }), req.body);
    if (b.expiry_date && b.expiry_date <= new Date().toISOString().slice(0, 10)) throw new HttpError(400, 'Received stock must expire in the future');
    if (b.supplier_id && !(await db.query('SELECT 1 FROM suppliers WHERE id=$1 AND active', [b.supplier_id])).rows.length) throw new HttpError(400, 'Supplier not found');
    const out = await db.tx(async (t) => {
      const upd = await t.query('UPDATE medications SET stock = stock + $2, expiry_date = COALESCE($3::date, expiry_date), supplier_id = COALESCE($4, supplier_id) WHERE id=$1 RETURNING stock', [id, b.quantity, b.expiry_date ?? null, b.supplier_id ?? null]);
      if (!upd.rows.length) throw new HttpError(404, 'Medication not found');
      await t.query("INSERT INTO stock_movements(medication_id,delta,reason,note,user_id) VALUES ($1,$2,'Receive',$3,$4)", [id, b.quantity, b.note, req.user!.id]);
      return upd.rows[0].stock as number;
    });
    await audit(db, req, 'stock_receive', 'medication', id, `qty=${b.quantity}`);
    res.status(201).json({ stock: out });
  });

  r.post('/inventory/:id/adjust', requirePermission('inventory.manage'), async (req, res) => {
    const id = intParam(req.params.id);
    const b = parse(z.object({
      delta: z.number().int().refine((n) => n !== 0, 'Adjustment cannot be zero').refine((n) => Math.abs(n) <= 100000, 'Adjustment is too large'),
      reason: z.enum(['Adjust', 'Expired']).default('Adjust'), note: z.string().trim().min(3, 'Explain the adjustment').max(200),
    }), req.body);
    if (b.reason === 'Expired' && b.delta > 0) throw new HttpError(400, 'Writing off expired stock must reduce the quantity');
    const out = await db.tx(async (t) => {
      const upd = await t.query('UPDATE medications SET stock = stock + $2 WHERE id=$1 AND stock + $2 >= 0 RETURNING stock', [id, b.delta]);
      if (!upd.rows.length) {
        if (!(await t.query('SELECT 1 FROM medications WHERE id=$1', [id])).rows.length) throw new HttpError(404, 'Medication not found');
        throw new HttpError(409, 'Stock cannot go below zero');
      }
      await t.query('INSERT INTO stock_movements(medication_id,delta,reason,note,user_id) VALUES ($1,$2,$3,$4,$5)', [id, b.delta, b.reason, b.note, req.user!.id]);
      return upd.rows[0].stock as number;
    });
    await audit(db, req, 'stock_adjust', 'medication', id, `delta=${b.delta}`);
    await scanInventory(db);
    res.json({ stock: out });
  });

  r.patch('/inventory/:id', requirePermission('inventory.manage'), async (req, res) => {
    const id = intParam(req.params.id);
    const b = parse(z.object({
      reorder_level: z.number().int().min(0).max(100000).optional(), max_daily_units: z.number().int().min(1).max(200).nullable().optional(),
      unit_cost: z.number().min(0).max(100000).optional(), supplier_id: z.number().int().positive().nullable().optional(), expiry_date: dateStr.nullable().optional(),
    }).strict(), req.body);
    const cols = Object.entries(b).filter(([, v]) => v !== undefined);
    if (!cols.length) throw new HttpError(400, 'No fields to update');
    if (b.supplier_id && !(await db.query('SELECT 1 FROM suppliers WHERE id=$1', [b.supplier_id])).rows.length) throw new HttpError(400, 'Supplier not found');
    const n = (await db.query(`UPDATE medications SET ${cols.map(([k], i) => `${k}=$${i + 2}`).join(', ')} WHERE id=$1 RETURNING id`, [id, ...cols.map(([, v]) => v)])).rows.length;
    if (!n) throw new HttpError(404, 'Medication not found');
    await audit(db, req, 'inventory_update', 'medication', id, cols.map(([k]) => k).join(','));
    res.json({ ok: true });
  });

  // ---------- suppliers ----------
  r.get('/suppliers', requirePermission('inventory.read'), async (_req, res) => {
    res.json({ data: (await db.query(`SELECT s.id, s.name, s.contact_email, s.phone, s.active, (SELECT count(*)::int FROM medications m WHERE m.supplier_id=s.id) AS medications FROM suppliers s ORDER BY s.name`)).rows });
  });

  r.post('/suppliers', requirePermission('inventory.manage'), async (req, res) => {
    const b = parse(z.object({ name: z.string().trim().min(2).max(100), contact_email: z.union([z.email().max(200), z.literal('')]).default(''), phone: z.string().max(30).default('') }), req.body);
    try {
      const { rows } = await db.query('INSERT INTO suppliers(name,contact_email,phone) VALUES ($1,$2,$3) RETURNING id', [b.name, b.contact_email, b.phone]);
      await audit(db, req, 'supplier_create', 'supplier', rows[0].id);
      res.status(201).json({ id: rows[0].id });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'A supplier with this name already exists');
      throw e;
    }
  });

  r.patch('/suppliers/:id', requirePermission('inventory.manage'), async (req, res) => {
    const id = intParam(req.params.id);
    const b = parse(z.object({ name: z.string().trim().min(2).max(100).optional(), contact_email: z.union([z.email().max(200), z.literal('')]).optional(), phone: z.string().max(30).optional(), active: z.boolean().optional() }).strict(), req.body);
    const cols = Object.entries(b).filter(([, v]) => v !== undefined);
    if (!cols.length) throw new HttpError(400, 'No fields to update');
    try {
      const n = (await db.query(`UPDATE suppliers SET ${cols.map(([k], i) => `${k}=$${i + 2}`).join(', ')} WHERE id=$1 RETURNING id`, [id, ...cols.map(([, v]) => v)])).rows.length;
      if (!n) throw new HttpError(404, 'Supplier not found');
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'A supplier with this name already exists');
      throw e;
    }
    await audit(db, req, 'supplier_update', 'supplier', id);
    res.json({ ok: true });
  });

  return r;
}
