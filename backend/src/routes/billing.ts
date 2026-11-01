import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../middleware/context.js';
import { audit, requirePermission } from '../middleware/context.js';
import { HttpError, intParam, pageQuery, parse } from '../utils/http.js';
import { calcBalance, deriveStatus, round2 } from '../services/billing.js';

const STATUSES = ['Draft', 'Issued', 'Partially paid', 'Paid', 'Cancelled'] as const;
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const INVOICE_SELECT = `SELECT i.id, i.invoice_no, i.status, i.issued_on, i.due_on, i.notes, i.patient_id, p.first_name || ' ' || p.last_name AS patient, p.mrn,
    COALESCE((SELECT sum(quantity*unit_price) FROM invoice_items WHERE invoice_id=i.id),0)::float AS total,
    COALESCE((SELECT sum(amount) FROM payments WHERE invoice_id=i.id),0)::float AS paid
  FROM invoices i JOIN patients p ON p.id=i.patient_id`;

export function billingRoutes({ db }: Ctx) {
  const r = Router();

  r.get('/invoices', requirePermission('billing.read'), async (req, res) => {
    const pq = pageQuery(req.query);
    const params: unknown[] = [];
    const where = ['true'];
    if (req.query.status) { params.push(parse(z.enum(STATUSES), req.query.status)); where.push(`i.status=$${params.length}`); }
    if (req.query.from) { params.push(parse(dateStr, req.query.from)); where.push(`i.issued_on >= $${params.length}::date`); }
    if (req.query.to) { params.push(parse(dateStr, req.query.to)); where.push(`i.issued_on <= $${params.length}::date`); }
    if (req.query.patient_id) { params.push(intParam(req.query.patient_id)); where.push(`i.patient_id=$${params.length}`); }
    if (pq.q) { params.push(`%${pq.q}%`); where.push(`(i.invoice_no ILIKE $${params.length} OR p.first_name || ' ' || p.last_name ILIKE $${params.length} OR p.mrn ILIKE $${params.length})`); }
    const w = where.join(' AND ');
    const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM invoices i JOIN patients p ON p.id=i.patient_id WHERE ${w}`, params)).rows[0].n;
    const rows = (await db.query(`${INVOICE_SELECT} WHERE ${w} ORDER BY i.issued_on DESC, i.id DESC LIMIT ${pq.pageSize} OFFSET ${(pq.page - 1) * pq.pageSize}`, params)).rows;
    res.json({ data: rows.map((x: any) => ({ ...x, balance: calcBalance(x.total, x.paid) })), total, page: pq.page, pageSize: pq.pageSize, currency: 'USD' });
  });

  r.get('/invoices/:id', requirePermission('billing.read'), async (req, res) => {
    const id = intParam(req.params.id);
    const inv = (await db.query(`${INVOICE_SELECT} WHERE i.id=$1`, [id])).rows[0];
    if (!inv) throw new HttpError(404, 'Invoice not found');
    const [items, payments] = await Promise.all([
      db.query('SELECT id, description, quantity, unit_price::float AS unit_price, (quantity*unit_price)::float AS line_total FROM invoice_items WHERE invoice_id=$1 ORDER BY id', [id]),
      db.query('SELECT id, amount::float AS amount, method, paid_at FROM payments WHERE invoice_id=$1 ORDER BY id', [id]),
    ]);
    res.json({ ...inv, balance: calcBalance(inv.total, inv.paid), items: items.rows, payments: payments.rows, currency: 'USD' });
  });

  r.post('/invoices', requirePermission('billing.write'), async (req, res) => {
    const b = parse(z.object({
      patient_id: z.number().int().positive(), due_on: dateStr.optional(), notes: z.string().max(300).default(''),
      items: z.array(z.object({ description: z.string().trim().min(2).max(120), quantity: z.number().int().min(1).max(1000), unit_price: z.number().min(0).max(1_000_000) })).min(1).max(30),
    }), req.body);
    const id = await db.tx(async (t) => {
      if (!(await t.query('SELECT 1 FROM patients WHERE id=$1', [b.patient_id])).rows.length) throw new HttpError(400, 'Patient not found');
      const n = (await t.query<{ n: number }>("SELECT COALESCE(max(substring(invoice_no from 5)::int),1000)+1 AS n FROM invoices WHERE invoice_no ~ '^INV-[0-9]+$'")).rows[0].n;
      const due = b.due_on ?? new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const { rows } = await t.query("INSERT INTO invoices(invoice_no,patient_id,issued_on,due_on,notes) VALUES ($1,$2,current_date,$3,$4) RETURNING id", [`INV-${n}`, b.patient_id, due, b.notes]);
      for (const it of b.items) await t.query('INSERT INTO invoice_items(invoice_id,description,quantity,unit_price) VALUES ($1,$2,$3,$4)', [rows[0].id, it.description, it.quantity, round2(it.unit_price)]);
      return rows[0].id;
    });
    await audit(db, req, 'invoice_create', 'invoice', id);
    res.status(201).json({ id });
  });

  r.post('/invoices/:id/payments', requirePermission('billing.write'), async (req, res) => {
    const id = intParam(req.params.id);
    const b = parse(z.object({ amount: z.number().positive().max(1_000_000), method: z.string().trim().min(2).max(40).default('Synthetic transfer') }), req.body);
    const result = await db.tx(async (t) => {
      const inv = (await t.query(`${INVOICE_SELECT} WHERE i.id=$1 FOR UPDATE OF i`, [id])).rows[0];
      if (!inv) throw new HttpError(404, 'Invoice not found');
      if (inv.status === 'Cancelled') throw new HttpError(409, 'Invoice is cancelled');
      const balance = calcBalance(inv.total, inv.paid);
      if (round2(b.amount) > balance) throw new HttpError(409, `Payment exceeds outstanding balance (${balance.toFixed(2)})`);
      await t.query('INSERT INTO payments(invoice_id,amount,method) VALUES ($1,$2,$3)', [id, round2(b.amount), b.method]);
      const status = deriveStatus(inv.total, inv.paid + round2(b.amount));
      await t.query('UPDATE invoices SET status=$1 WHERE id=$2', [status, id]);
      return { status, balance: calcBalance(inv.total, inv.paid + round2(b.amount)) };
    });
    await audit(db, req, 'payment_record', 'invoice', id, `amount=${b.amount}`);
    res.status(201).json(result);
  });

  r.post('/invoices/:id/cancel', requirePermission('billing.write'), async (req, res) => {
    const id = intParam(req.params.id);
    const inv = (await db.query('SELECT status FROM invoices WHERE id=$1', [id])).rows[0];
    if (!inv) throw new HttpError(404, 'Invoice not found');
    if (inv.status === 'Paid' || inv.status === 'Partially paid') throw new HttpError(409, 'Invoices with payments cannot be cancelled');
    await db.query("UPDATE invoices SET status='Cancelled' WHERE id=$1", [id]);
    await audit(db, req, 'invoice_cancel', 'invoice', id);
    res.json({ ok: true });
  });

  return r;
}
