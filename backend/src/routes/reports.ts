import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../middleware/context.js';
import { audit, requirePermission } from '../middleware/context.js';
import { parse } from '../utils/http.js';
import { buildPdf } from '../services/pdf.js';

export interface Dataset { title: string; columns: { key: string; label: string; align?: 'left' | 'right' }[]; rows: Record<string, string | number | null>[] }

/** Neutralise spreadsheet formula injection: cells that start with = + - @ (or tab/CR) are prefixed with an apostrophe. */
export const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const toCsv = (d: Dataset): string => [d.columns.map((c) => csvCell(c.label)).join(','), ...d.rows.map((r) => d.columns.map((c) => csvCell(r[c.key])).join(','))].join('\r\n') + '\r\n';

export const REPORTS = ['occupancy', 'collections', 'waits', 'aging', 'appointments', 'claims'] as const;
export type ReportName = (typeof REPORTS)[number];

export async function reportDataset(db: Ctx['db'], name: ReportName): Promise<Dataset> {
  switch (name) {
    case 'occupancy': {
      const rows = (await db.query(`SELECT w.name AS ward, d.name AS department,
          (SELECT count(*)::int FROM beds b WHERE b.ward_id=w.id) AS beds,
          (SELECT count(*)::int FROM beds b JOIN admissions a ON a.bed_id=b.id AND a.status='Admitted' WHERE b.ward_id=w.id) AS occupied
        FROM wards w LEFT JOIN departments d ON d.id=w.department_id ORDER BY w.name`)).rows;
      return { title: 'Bed occupancy by ward', columns: [{ key: 'ward', label: 'Ward' }, { key: 'department', label: 'Department' }, { key: 'beds', label: 'Beds', align: 'right' }, { key: 'occupied', label: 'Occupied', align: 'right' }, { key: 'percent', label: 'Occupancy %', align: 'right' }],
        rows: rows.map((r: any) => ({ ...r, percent: r.beds ? Math.round((r.occupied / r.beds) * 100) : 0 })) };
    }
    case 'collections': {
      const rows = (await db.query(`SELECT to_char(paid_at,'YYYY-MM') AS month, COALESCE(sum(amount) FILTER (WHERE kind='Payment'),0)::float AS collected,
          COALESCE(-sum(amount) FILTER (WHERE kind='Refund'),0)::float AS refunded, sum(amount)::float AS net FROM payments GROUP BY 1 ORDER BY 1`)).rows;
      return { title: 'Collections by month', columns: [{ key: 'month', label: 'Month' }, { key: 'collected', label: 'Collected', align: 'right' }, { key: 'refunded', label: 'Refunded', align: 'right' }, { key: 'net', label: 'Net', align: 'right' }],
        rows: rows.map((r: any) => ({ month: r.month, collected: r.collected.toFixed(2), refunded: r.refunded.toFixed(2), net: r.net.toFixed(2) })) };
    }
    case 'waits': {
      const triage = (await db.query(`SELECT esi_level, count(*)::int AS patients, round(avg(extract(epoch FROM (started_at - arrived_at)) / 60))::int AS avg_wait_min,
          round(max(extract(epoch FROM (started_at - arrived_at)) / 60))::int AS max_wait_min FROM triage_entries WHERE started_at IS NOT NULL GROUP BY esi_level ORDER BY esi_level`)).rows;
      const lab = (await db.query(`SELECT t.name AS test, count(*)::int AS requests, round(avg(extract(epoch FROM (res.entered_at - lr.requested_at)) / 3600)::numeric, 1)::float AS avg_hours
          FROM laboratory_requests lr JOIN laboratory_results res ON res.request_id=lr.id JOIN laboratory_tests t ON t.id=lr.test_id GROUP BY t.name ORDER BY avg_hours DESC LIMIT 12`)).rows;
      return { title: 'Wait times: emergency triage (minutes) and laboratory turnaround (hours)', columns: [{ key: 'area', label: 'Area' }, { key: 'group', label: 'Group' }, { key: 'count', label: 'Count', align: 'right' }, { key: 'avg', label: 'Average', align: 'right' }, { key: 'max', label: 'Longest', align: 'right' }],
        rows: [
          ...triage.map((t: any) => ({ area: 'Emergency triage (min)', group: `ESI ${t.esi_level}`, count: t.patients, avg: t.avg_wait_min, max: t.max_wait_min })),
          ...lab.map((l: any) => ({ area: 'Laboratory turnaround (hours)', group: l.test, count: l.requests, avg: l.avg_hours, max: null })),
        ] };
    }
    case 'aging': {
      const rows = (await db.query(`SELECT bucket, count(*)::int AS invoices, COALESCE(sum(balance),0)::float AS balance FROM (
          SELECT CASE WHEN current_date - i.due_on <= 0 THEN 'Not yet due' WHEN current_date - i.due_on <= 30 THEN '1-30 days' ELSE '31+ days' END AS bucket,
                 (COALESCE((SELECT sum(quantity*unit_price) FROM invoice_items WHERE invoice_id=i.id),0) - COALESCE((SELECT sum(amount) FROM payments WHERE invoice_id=i.id),0)) AS balance
            FROM invoices i WHERE i.status IN ('Issued','Partially paid')) x GROUP BY bucket ORDER BY bucket`)).rows;
      return { title: 'Receivables aging', columns: [{ key: 'bucket', label: 'Bucket' }, { key: 'invoices', label: 'Invoices', align: 'right' }, { key: 'balance', label: 'Balance (USD)', align: 'right' }],
        rows: rows.map((r: any) => ({ bucket: r.bucket, invoices: r.invoices, balance: r.balance.toFixed(2) })) };
    }
    case 'appointments': {
      const rows = (await db.query(`SELECT d.name AS department, count(a.id)::int AS total,
          count(a.id) FILTER (WHERE a.status='Completed')::int AS completed, count(a.id) FILTER (WHERE a.status='No-show')::int AS no_show, count(a.id) FILTER (WHERE a.status='Cancelled')::int AS cancelled
        FROM departments d LEFT JOIN appointments a ON a.department_id=d.id GROUP BY d.name ORDER BY total DESC`)).rows;
      return { title: 'Appointments by department', columns: [{ key: 'department', label: 'Department' }, { key: 'total', label: 'Total', align: 'right' }, { key: 'completed', label: 'Completed', align: 'right' }, { key: 'no_show', label: 'No-show', align: 'right' }, { key: 'cancelled', label: 'Cancelled', align: 'right' }], rows };
    }
    case 'claims': {
      const rows = (await db.query(`SELECT status, count(*)::int AS claims, COALESCE(sum(amount_claimed),0)::float AS claimed, COALESCE(sum(amount_approved),0)::float AS approved FROM insurance_claims GROUP BY status ORDER BY status`)).rows;
      return { title: 'Insurance claims by status', columns: [{ key: 'status', label: 'Status' }, { key: 'claims', label: 'Claims', align: 'right' }, { key: 'claimed', label: 'Claimed (USD)', align: 'right' }, { key: 'approved', label: 'Approved (USD)', align: 'right' }],
        rows: rows.map((r: any) => ({ status: r.status, claims: r.claims, claimed: r.claimed.toFixed(2), approved: r.approved.toFixed(2) })) };
    }
  }
}

export function reportRoutes({ db }: Ctx) {
  const r = Router();

  r.get('/reports/summary', requirePermission('reports.read'), async (_req, res) => {
    const [occupancy, waits, claims, consults, rx] = await Promise.all([
      reportDataset(db, 'occupancy'), reportDataset(db, 'waits'), reportDataset(db, 'claims'),
      db.query("SELECT to_char(signed_at,'YYYY-MM') AS month, count(*)::int AS signed FROM consultations WHERE status='Signed' GROUP BY 1 ORDER BY 1"),
      db.query("SELECT count(*) FILTER (WHERE override_reason <> '')::int AS overridden, count(*)::int AS total FROM prescriptions"),
    ]);
    const beds = occupancy.rows.reduce((s, x) => s + Number(x.beds), 0);
    const occ = occupancy.rows.reduce((s, x) => s + Number(x.occupied), 0);
    res.json({
      occupancy: { rows: occupancy.rows, beds, occupied: occ, percent: beds ? Math.round((occ / beds) * 100) : 0 },
      waits: waits.rows, claims: claims.rows, consultationsByMonth: consults.rows, prescriptionOverrides: rx.rows[0],
    });
  });

  r.get('/reports/export', requirePermission('reports.read'), async (req, res) => {
    const q = parse(z.object({ report: z.enum(REPORTS), format: z.enum(['csv', 'pdf']).default('csv') }), req.query);
    const data = await reportDataset(db, q.report);
    await audit(db, req, 'report_export', 'report', q.report, q.format);
    const stamp = new Date().toISOString().slice(0, 10);
    if (q.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${q.report}-${stamp}.csv"`);
      return void res.send(toCsv(data));
    }
    const pdf = buildPdf({
      title: data.title, subtitle: `Generated ${stamp}  |  MediCore HMS  |  SYNTHETIC DATA`,
      blocks: [{ type: 'table', columns: data.columns.map((c) => ({ label: c.label, width: 2, align: c.align })), rows: data.rows.map((row) => data.columns.map((c) => String(row[c.key] ?? ''))) }],
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${q.report}-${stamp}.pdf"`);
    res.send(pdf);
  });

  return r;
}
