import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../middleware/context.js';
import { audit, requirePermission } from '../middleware/context.js';
import { HttpError, intParam, pageQuery, parse } from '../utils/http.js';
import { calcBalance, deriveStatus, round2 } from '../services/billing.js';
import { buildPdf } from '../services/pdf.js';
import { notifyRoles } from '../services/notifications.js';

const STATUSES = ['Draft', 'Issued', 'Partially paid', 'Paid', 'Cancelled'] as const;
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const INVOICE_SELECT = `SELECT i.id, i.invoice_no, i.status, i.issued_on, i.due_on, i.notes, i.patient_id, p.first_name || ' ' || p.last_name AS patient, p.mrn,
    COALESCE((SELECT sum(quantity*unit_price) FROM invoice_items WHERE invoice_id=i.id),0)::float AS total,
    COALESCE((SELECT sum(amount) FROM payments WHERE invoice_id=i.id),0)::float AS paid
  FROM invoices i JOIN patients p ON p.id=i.patient_id`;

const CLAIM_SELECT = `SELECT c.id, c.invoice_id, i.invoice_no, p.first_name || ' ' || p.last_name AS patient, p.mrn, c.provider, c.policy_no, c.amount_claimed::float AS amount_claimed,
    c.amount_approved::float AS amount_approved, c.status, c.note, c.submitted_at, c.decided_at, c.submitted_by, sb.full_name AS submitted_by_name, dbu.full_name AS decided_by_name
  FROM insurance_claims c JOIN invoices i ON i.id=c.invoice_id JOIN patients p ON p.id=i.patient_id LEFT JOIN users sb ON sb.id=c.submitted_by LEFT JOIN users dbu ON dbu.id=c.decided_by`;

const isUniqueViolation = (e: any) => e?.code === '23505' || /unique|duplicate/i.test(String(e?.message));

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
    const [items, payments, claims] = await Promise.all([
      db.query('SELECT id, description, quantity, unit_price::float AS unit_price, (quantity*unit_price)::float AS line_total FROM invoice_items WHERE invoice_id=$1 ORDER BY id', [id]),
      db.query('SELECT id, amount::float AS amount, method, kind, reason, refund_of, paid_at FROM payments WHERE invoice_id=$1 ORDER BY id', [id]),
      db.query(CLAIM_SELECT + ' WHERE c.invoice_id=$1 ORDER BY c.id DESC', [id]),
    ]);
    res.json({ ...inv, balance: calcBalance(inv.total, inv.paid), items: items.rows, payments: payments.rows, claims: claims.rows, currency: 'USD' });
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

  // ---------- payment history ----------
  r.get('/payments', requirePermission('billing.read'), async (req, res) => {
    const pq = pageQuery(req.query);
    const params: unknown[] = [];
    const where = ['true'];
    if (req.query.kind) { params.push(parse(z.enum(['Payment', 'Refund']), req.query.kind)); where.push(`pay.kind=$${params.length}`); }
    if (req.query.invoice_id) { params.push(intParam(req.query.invoice_id, 'invoice_id')); where.push(`pay.invoice_id=$${params.length}`); }
    if (req.query.patient_id) { params.push(intParam(req.query.patient_id, 'patient_id')); where.push(`i.patient_id=$${params.length}`); }
    if (req.query.from) { params.push(parse(dateStr, req.query.from)); where.push(`pay.paid_at::date >= $${params.length}::date`); }
    if (req.query.to) { params.push(parse(dateStr, req.query.to)); where.push(`pay.paid_at::date <= $${params.length}::date`); }
    if (pq.q) { params.push(`%${pq.q}%`); where.push(`(i.invoice_no ILIKE $${params.length} OR p.first_name || ' ' || p.last_name ILIKE $${params.length} OR pay.method ILIKE $${params.length})`); }
    const w = where.join(' AND ');
    const from = 'payments pay JOIN invoices i ON i.id=pay.invoice_id JOIN patients p ON p.id=i.patient_id';
    const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${from} WHERE ${w}`, params)).rows[0].n;
    const net = (await db.query<{ v: number }>(`SELECT COALESCE(sum(pay.amount),0)::float AS v FROM ${from} WHERE ${w}`, params)).rows[0].v;
    const data = (await db.query(`SELECT pay.id, pay.invoice_id, i.invoice_no, p.first_name || ' ' || p.last_name AS patient, p.mrn, pay.amount::float AS amount, pay.method, pay.kind, pay.reason, pay.paid_at
        FROM ${from} WHERE ${w} ORDER BY pay.paid_at DESC, pay.id DESC LIMIT ${pq.pageSize} OFFSET ${(pq.page - 1) * pq.pageSize}`, params)).rows;
    res.json({ data, total, page: pq.page, pageSize: pq.pageSize, net, currency: 'USD' });
  });

  // ---------- refunds ----------
  r.post('/invoices/:id/refunds', requirePermission('refunds.write'), async (req, res) => {
    const id = intParam(req.params.id);
    const b = parse(z.object({ payment_id: z.number().int().positive(), amount: z.number().positive().max(1_000_000), reason: z.string().trim().min(3).max(200) }), req.body);
    const result = await db.tx(async (t) => {
      const inv = (await t.query(`${INVOICE_SELECT} WHERE i.id=$1 FOR UPDATE OF i`, [id])).rows[0];
      if (!inv) throw new HttpError(404, 'Invoice not found');
      const pay = (await t.query("SELECT id, amount::float AS amount FROM payments WHERE id=$1 AND invoice_id=$2 AND kind='Payment'", [b.payment_id, id])).rows[0];
      if (!pay) throw new HttpError(404, 'Payment not found on this invoice');
      const refunded = (await t.query<{ v: number }>("SELECT COALESCE(-sum(amount),0)::float AS v FROM payments WHERE refund_of=$1 AND kind='Refund'", [pay.id])).rows[0].v;
      const refundable = round2(pay.amount - refunded);
      if (round2(b.amount) > refundable) throw new HttpError(409, `Refund exceeds the refundable amount (${refundable.toFixed(2)})`);
      await t.query("INSERT INTO payments(invoice_id,amount,method,kind,refund_of,reason,created_by) VALUES ($1,$2,'Refund (synthetic)','Refund',$3,$4,$5)", [id, -round2(b.amount), pay.id, b.reason, req.user!.id]);
      const net = round2(inv.paid - round2(b.amount));
      const status = inv.status === 'Cancelled' ? 'Cancelled' : deriveStatus(inv.total, net);
      await t.query('UPDATE invoices SET status=$1 WHERE id=$2', [status, id]);
      return { status, balance: calcBalance(inv.total, net) };
    });
    await audit(db, req, 'refund_record', 'invoice', id, `amount=${b.amount}`);
    res.status(201).json(result);
  });

  // ---------- insurance claims ----------
  r.get('/claims', requirePermission('claims.read'), async (req, res) => {
    const pq = pageQuery(req.query);
    const params: unknown[] = [];
    const where = ['true'];
    if (req.query.status) { params.push(parse(z.enum(['Submitted', 'Approved', 'Partially approved', 'Rejected']), req.query.status)); where.push(`c.status=$${params.length}`); }
    if (pq.q) { params.push(`%${pq.q}%`); where.push(`(i.invoice_no ILIKE $${params.length} OR p.first_name || ' ' || p.last_name ILIKE $${params.length} OR c.provider ILIKE $${params.length})`); }
    const w = where.join(' AND ');
    const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM insurance_claims c JOIN invoices i ON i.id=c.invoice_id JOIN patients p ON p.id=i.patient_id WHERE ${w}`, params)).rows[0].n;
    const data = (await db.query(`${CLAIM_SELECT} WHERE ${w} ORDER BY c.submitted_at DESC, c.id DESC LIMIT ${pq.pageSize} OFFSET ${(pq.page - 1) * pq.pageSize}`, params)).rows;
    res.json({ data, total, page: pq.page, pageSize: pq.pageSize });
  });

  r.post('/invoices/:id/claims', requirePermission('claims.write'), async (req, res) => {
    const id = intParam(req.params.id);
    const b = parse(z.object({ amount_claimed: z.number().positive().max(1_000_000) }), req.body);
    const inv = (await db.query(`${INVOICE_SELECT} WHERE i.id=$1`, [id])).rows[0];
    if (!inv) throw new HttpError(404, 'Invoice not found');
    if (!['Issued', 'Partially paid'].includes(inv.status)) throw new HttpError(409, `Claims cannot be filed on a ${inv.status.toLowerCase()} invoice`);
    const pat = (await db.query('SELECT insurance_provider, insurance_policy_no FROM patients WHERE id=$1', [inv.patient_id])).rows[0];
    if (!pat?.insurance_provider || pat.insurance_provider === 'Self-pay' || !pat.insurance_policy_no) throw new HttpError(409, 'The patient has no insurance on file');
    const balance = calcBalance(inv.total, inv.paid);
    if (round2(b.amount_claimed) > balance) throw new HttpError(409, `The claim exceeds the outstanding balance (${balance.toFixed(2)})`);
    try {
      const { rows } = await db.query('INSERT INTO insurance_claims(invoice_id,provider,policy_no,amount_claimed,submitted_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [id, pat.insurance_provider, pat.insurance_policy_no, round2(b.amount_claimed), req.user!.id]);
      await audit(db, req, 'claim_submit', 'invoice', id, `claim=${rows[0].id}`);
      res.status(201).json({ id: rows[0].id });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'An insurance claim is already awaiting a decision for this invoice');
      throw e;
    }
  });

  r.post('/claims/:id/decision', requirePermission('claims.decide'), async (req, res) => {
    const id = intParam(req.params.id);
    const b = parse(z.object({ decision: z.enum(['Approve', 'PartiallyApprove', 'Reject']), amount_approved: z.number().positive().max(1_000_000).optional(), note: z.string().max(300).default('') }), req.body);
    if (b.decision === 'Reject' && b.note.trim().length < 3) throw new HttpError(400, 'A reason is required to reject a claim');
    const out = await db.tx(async (t) => {
      const c = (await t.query('SELECT * FROM insurance_claims WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!c) throw new HttpError(404, 'Claim not found');
      if (c.status !== 'Submitted') throw new HttpError(409, `This claim is already ${c.status.toLowerCase()}`);
      if (c.submitted_by === req.user!.id) throw new HttpError(403, 'A different user must record the insurer decision (four-eyes rule)');
      const claimed = Number(c.amount_claimed);
      if (b.decision === 'Reject') {
        await t.query("UPDATE insurance_claims SET status='Rejected', amount_approved=0, note=$2, decided_by=$3, decided_at=now() WHERE id=$1", [id, b.note, req.user!.id]);
        return { status: 'Rejected', paid: 0 };
      }
      let approved = claimed;
      if (b.decision === 'PartiallyApprove') {
        if (b.amount_approved === undefined || round2(b.amount_approved) >= claimed) throw new HttpError(400, 'A partial approval needs an amount below the claimed amount');
        approved = round2(b.amount_approved);
      }
      const inv = (await t.query(`${INVOICE_SELECT} WHERE i.id=$1 FOR UPDATE OF i`, [c.invoice_id])).rows[0];
      const balance = calcBalance(inv.total, inv.paid);
      const pay = Math.min(approved, balance);
      let paymentId: number | null = null;
      if (pay > 0 && inv.status !== 'Cancelled') {
        paymentId = (await t.query('INSERT INTO payments(invoice_id,amount,method,created_by) VALUES ($1,$2,$3,$4) RETURNING id', [c.invoice_id, pay, `Insurance claim (${c.provider})`, req.user!.id])).rows[0].id;
        await t.query('UPDATE invoices SET status=$1 WHERE id=$2', [deriveStatus(inv.total, round2(inv.paid + pay)), c.invoice_id]);
      }
      const status = b.decision === 'Approve' ? 'Approved' : 'Partially approved';
      await t.query('UPDATE insurance_claims SET status=$2, amount_approved=$3, note=$4, decided_by=$5, decided_at=now(), payment_id=$6 WHERE id=$1', [id, status, approved, b.note, req.user!.id, paymentId]);
      return { status, paid: pay };
    });
    await audit(db, req, 'claim_decision', 'claim', id, out.status);
    if (out.status === 'Rejected') {
      await notifyRoles(db, ['billing_officer', 'administrator'], { kind: 'claim_rejected', severity: 'warn', title: 'Insurance claim rejected', body: b.note, link: '/billing', dedupeKey: `claim:${id}` });
    }
    res.json({ ok: true, ...out });
  });

  // ---------- PDF invoice ----------
  r.get('/invoices/:id/pdf', requirePermission('billing.read'), async (req, res) => {
    const id = intParam(req.params.id);
    const inv = (await db.query(`${INVOICE_SELECT} WHERE i.id=$1`, [id])).rows[0];
    if (!inv) throw new HttpError(404, 'Invoice not found');
    const [items, payments] = await Promise.all([
      db.query('SELECT description, quantity, unit_price::float AS unit_price FROM invoice_items WHERE invoice_id=$1 ORDER BY id', [id]),
      db.query("SELECT amount::float AS amount, method, kind, to_char(paid_at,'YYYY-MM-DD') AS day FROM payments WHERE invoice_id=$1 ORDER BY id", [id]),
    ]);
    const m = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    const pdf = buildPdf({
      title: `Invoice ${inv.invoice_no}`, subtitle: `MediCore Teaching Hospital (fictional)  |  Status: ${inv.status}  |  SYNTHETIC`,
      blocks: [
        { type: 'kv', rows: [['Patient', `${inv.patient} (${inv.mrn})`], ['Issued', String(inv.issued_on).slice(0, 10)], ['Due', String(inv.due_on).slice(0, 10)]] },
        { type: 'heading', text: 'Charges' },
        { type: 'table', columns: [{ label: 'Description', width: 5 }, { label: 'Qty', width: 1, align: 'right' }, { label: 'Unit price', width: 2, align: 'right' }, { label: 'Amount', width: 2, align: 'right' }],
          rows: items.rows.map((i: any) => [i.description, String(i.quantity), m(i.unit_price), m(i.quantity * i.unit_price)]) },
        { type: 'heading', text: 'Payments and refunds' },
        { type: 'table', columns: [{ label: 'Date', width: 2 }, { label: 'Method', width: 4 }, { label: 'Type', width: 2 }, { label: 'Amount', width: 2, align: 'right' }],
          rows: payments.rows.map((p: any) => [p.day, p.method, p.kind, m(p.amount)]) },
        { type: 'heading', text: 'Summary' },
        { type: 'kv', rows: [['Total', m(inv.total)], ['Paid (net of refunds)', m(inv.paid)], ['Balance due', m(calcBalance(inv.total, inv.paid))]] },
      ],
    });
    await audit(db, req, 'invoice_pdf', 'invoice', id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${String(inv.invoice_no).replace(/[^\w.-]/g, '_')}.pdf"`);
    res.send(pdf);
  });

  return r;
}
