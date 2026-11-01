/**
 * INTENTIONALLY VULNERABLE ROUTES - mounted at /api/lab ONLY when LAB_MODE=vulnerable.
 * Every handler is a deliberate, documented weakness (see assessment/manifest/vulnerabilities.json).
 * Each weakness is confined to synthetic data and to this file; containment guards are noted inline.
 */
import { Router, type RequestHandler } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../../middleware/context.js';
import { audit, requireAuth, requirePermission } from '../../middleware/context.js';
import { isVulnEnabled } from '../../config/index.js';
import { HttpError, intParam, parse } from '../../utils/http.js';
import { randomToken } from '../../utils/crypto.js';
import { canAccessPatient, rawClinicalSummary } from '../../services/patients.js';
import { setStatus } from '../../services/appointments.js';
import { INVOICE_SELECT } from '../../routes/billing.js';
import { z } from 'zod';
import { extraVulnerableRoutes } from './extra.js';

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const MIME_ALLOWED = ['image/png', 'image/jpeg', 'application/pdf', 'text/plain'];
const EXT_TYPES: Record<string, string> = { '.html': 'text/html', '.htm': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.pdf': 'application/pdf', '.txt': 'text/plain' };

export function vulnerableRoutes(ctx: Ctx) {
  const { db, cfg } = ctx;
  const r = Router();
  const only = (id: string): RequestHandler => (_req, _res, next) =>
    isVulnEnabled(cfg, id) ? next() : next(new HttpError(404, 'Not found'));

  // HMS-V01 - SQL injection (string concatenation). Containment: single statement + read-only transaction.
  r.get('/patients/legacy-search', only('HMS-V01'), requirePermission('patients.read_all'), async (req, res) => {
    const q = String(req.query.q ?? '');
    try {
      const rows = await db.tx(async (t) => {
        await t.exec('SET TRANSACTION READ ONLY');
        // VULNERABLE: q is concatenated into the statement. The dummy bound parameter forces the extended
        // protocol, which rejects stacked statements, keeping the lab impact to read-only queries.
        return (await t.query(`SELECT id, mrn, first_name, last_name, dob FROM patients WHERE $1::int = 1 AND last_name ILIKE '%${q}%' ORDER BY id`, [1])).rows;
      });
      res.json({ data: rows, total: rows.length });
    } catch {
      throw new HttpError(500, 'Search failed');
    }
  });

  // HMS-V03 - BOLA: no care-team scope check
  r.get('/patients/:id/summary', only('HMS-V03'), requirePermission('clinical.read'), async (req, res) => {
    res.json(await rawClinicalSummary(db, intParam(req.params.id)));
  });

  // HMS-V04 - missing function-level authorization (no audit.read check)
  r.get('/admin/audit-export', only('HMS-V04'), requireAuth, async (_req, res) => {
    res.json({ data: (await db.query('SELECT e.id, e.at, u.username, e.action, e.entity, e.entity_id FROM audit_events e LEFT JOIN users u ON u.id=e.user_id ORDER BY e.id DESC LIMIT 100')).rows });
  });

  // HMS-V08 - upload trusts the client-declared content type. Containment: size limit, stored outside web root, never executed.
  r.post('/patients/:id/documents', only('HMS-V08'), requirePermission('documents.manage'), async (req, res) => {
    const id = intParam(req.params.id);
    if (!(await canAccessPatient(db, req.user!, id))) throw new HttpError(404, 'Patient not found');
    const b = parse(z.object({ filename: z.string().min(1).max(120), content_type: z.string().max(80), content_base64: z.string().max(1_100_000) }), req.body);
    if (!MIME_ALLOWED.includes(b.content_type)) throw new HttpError(400, 'Unsupported file type'); // VULNERABLE: declared type only
    const buf = Buffer.from(b.content_base64, 'base64');
    if (buf.length === 0 || buf.length > 512 * 1024) throw new HttpError(400, 'File too large');
    fs.mkdirSync(cfg.uploadDir, { recursive: true });
    const ext = (path.extname(b.filename).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin').slice(0, 8); // VULNERABLE: original extension kept
    const stored = `${randomToken(12)}${ext}`;
    fs.writeFileSync(path.join(cfg.uploadDir, stored), buf);
    const name = path.basename(b.filename).replace(/[^\w.\- ]/g, '_');
    const { rows } = await db.query('INSERT INTO patient_documents(patient_id,filename,stored_name,content_type,size_bytes,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [id, name, stored, b.content_type, buf.length, req.user!.id]);
    await audit(db, req, 'document_upload_lab', 'patient', id);
    res.status(201).json({ id: rows[0].id });
  });

  r.get('/documents/:id', only('HMS-V08'), requirePermission('documents.manage'), async (req, res) => {
    const d = (await db.query('SELECT * FROM patient_documents WHERE id=$1', [intParam(req.params.id)])).rows[0];
    if (!d || !(await canAccessPatient(db, req.user!, d.patient_id))) throw new HttpError(404, 'Document not found');
    const ext = path.extname(d.stored_name).toLowerCase();
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('X-Content-Type-Options');
    res.setHeader('Content-Type', EXT_TYPES[ext] ?? d.content_type); // VULNERABLE: served inline, type inferred from extension
    res.send(fs.readFileSync(path.join(cfg.uploadDir, d.stored_name)));
  });

  // HMS-V09 - security headers omitted on this designated route
  r.get('/invoices/:id/print', only('HMS-V09'), requirePermission('billing.read'), async (req, res) => {
    const inv = (await db.query(`${INVOICE_SELECT} WHERE i.id=$1`, [intParam(req.params.id)])).rows[0];
    if (!inv) throw new HttpError(404, 'Invoice not found');
    const items = (await db.query('SELECT description, quantity, unit_price::float AS unit_price FROM invoice_items WHERE invoice_id=$1', [inv.id])).rows;
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('X-Content-Type-Options');
    res.type('html').send(`<!doctype html><title>${esc(inv.invoice_no)}</title><h1>Invoice ${esc(inv.invoice_no)}</h1><p>${esc(inv.patient)} (${esc(inv.mrn)}) - SYNTHETIC</p>
<table border="1" cellpadding="4">${items.map((i: any) => `<tr><td>${esc(i.description)}</td><td>${i.quantity}</td><td>${i.unit_price.toFixed(2)}</td></tr>`).join('')}</table>
<p>Total ${inv.total.toFixed(2)} - Paid ${inv.paid.toFixed(2)}</p>`);
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

  // HMS-V11 - state change over GET, outside the CSRF token check
  r.get('/appointments/:id/cancel', only('HMS-V11'), requirePermission('appointments.write'), async (req, res) => {
    const id = intParam(req.params.id);
    await setStatus(db, id, 'Cancelled');
    await audit(db, req, 'appointment_cancel_get', 'appointment', id);
    res.json({ ok: true, status: 'Cancelled' });
  });

  r.use(extraVulnerableRoutes(ctx)); // HMS-V13 .. HMS-V19

  // HMS-V12 - path traversal via single-pass filter. Containment: hard sandbox to lab-data/.
  r.get('/reports/download', only('HMS-V12'), requirePermission('lab.read'), async (req, res) => {
    const file = String(req.query.file ?? '');
    const publicDir = path.join(cfg.labDataDir, 'public-docs');
    const target = path.resolve(publicDir, file.replace('../', '')); // VULNERABLE: removes '../' once
    const rel = path.relative(cfg.labDataDir, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new HttpError(400, 'Invalid file'); // lab containment guard
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new HttpError(404, 'File not found');
    res.type('text/plain').send(fs.readFileSync(target, 'utf8'));
  });

  return r;
}
