import { Router } from 'express';
import type { Ctx } from '../middleware/context.js';
import { requireAuth } from '../middleware/context.js';
import { scopeClause } from '../services/patients.js';

interface Item { id: number | string; title: string; subtitle: string; to: string }
interface Group { type: string; label: string; items: Item[] }

/**
 * Global search (Ctrl+K). Every group is gated by the caller's own permissions and, for patients,
 * by the same care-team scope as the patient list, so search can never reveal a record the user could not open.
 */
export function searchRoutes({ db }: Ctx) {
  const r = Router();

  r.get('/search', requireAuth, async (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 60);
    const groups: Group[] = [];
    if (q.length < 2) return void res.json({ query: q, groups });
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const u = req.user!;
    const has = (p: string) => u.permissions.includes(p);

    if (has('patients.read_all') || has('patients.read_scoped')) {
      const sc = scopeClause(u, 'p', 2);
      const rows = (await db.query(
        `SELECT p.id, p.first_name, p.last_name, p.mrn, p.dob FROM patients p
          WHERE (p.first_name || ' ' || p.last_name ILIKE $1 OR p.mrn ILIKE $1) AND ${sc.sql} ORDER BY p.last_name, p.first_name LIMIT 6`, [like, ...sc.params])).rows;
      if (rows.length) groups.push({ type: 'patient', label: 'Patients', items: rows.map((p: any) => ({ id: p.id, title: `${p.first_name} ${p.last_name}`, subtitle: `${p.mrn} - born ${String(p.dob).slice(0, 10)}`, to: `/patients/${p.id}` })) });
    }
    if (has('billing.read')) {
      const rows = (await db.query(
        `SELECT i.id, i.invoice_no, i.status, p.first_name || ' ' || p.last_name AS patient FROM invoices i JOIN patients p ON p.id=i.patient_id
          WHERE i.invoice_no ILIKE $1 OR p.first_name || ' ' || p.last_name ILIKE $1 ORDER BY i.issued_on DESC, i.id DESC LIMIT 5`, [like])).rows;
      if (rows.length) groups.push({ type: 'invoice', label: 'Invoices', items: rows.map((i: any) => ({ id: i.id, title: i.invoice_no, subtitle: `${i.patient} - ${i.status}`, to: `/billing?invoice=${i.id}` })) });
    }
    if (has('staff.read')) {
      const rows = (await db.query(
        `SELECT s.id, s.full_name, s.job_title, s.staff_code, d.name AS department FROM staff s LEFT JOIN departments d ON d.id=s.department_id
          WHERE s.active AND (s.full_name ILIKE $1 OR s.staff_code ILIKE $1 OR s.job_title ILIKE $1) ORDER BY s.full_name LIMIT 5`, [like])).rows;
      if (rows.length) groups.push({ type: 'staff', label: 'Staff', items: rows.map((s: any) => ({ id: s.id, title: s.full_name, subtitle: `${s.job_title} - ${s.department ?? ''}`, to: `/staff?q=${encodeURIComponent(s.full_name)}` })) });
    }
    if (has('pharmacy.read')) {
      const rows = (await db.query('SELECT id, code, name, strength, form FROM medications WHERE name ILIKE $1 OR code ILIKE $1 ORDER BY name LIMIT 5', [like])).rows;
      if (rows.length) groups.push({ type: 'medication', label: 'Medications', items: rows.map((m: any) => ({ id: m.id, title: `${m.name} ${m.strength}`, subtitle: `${m.code} - ${m.form}`, to: `/pharmacy?q=${encodeURIComponent(m.name)}` })) });
    }
    res.json({ query: q, groups });
  });

  return r;
}
