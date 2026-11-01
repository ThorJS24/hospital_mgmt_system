import { Router } from 'express';
import type { Ctx } from '../middleware/context.js';
import { requirePermission } from '../middleware/context.js';
import { scopeClause } from '../services/patients.js';
import { appointmentScope } from '../services/appointments.js';

export function dashboardRoutes({ db }: Ctx) {
  const r = Router();

  r.get('/dashboard', requirePermission('dashboard.read'), async (req, res) => {
    const u = req.user!;
    const has = (p: string) => u.permissions.includes(p);
    const ps = scopeClause(u, 'p', 1);
    const as = appointmentScope(u, 'a', 1);
    const one = async <T,>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
    const canPatients = has('patients.read_all') || has('patients.read_scoped');
    const canAppts = has('appointments.read');

    const [patients, today, admitted, beds, labPending, outstanding, staff, recentAppts, recentPatients, dept, trend, admissions] = await Promise.all([
      canPatients ? one<{ n: number }>(`SELECT count(*)::int AS n FROM patients p WHERE ${ps.sql}`, ps.params) : null,
      canAppts ? one<{ n: number }>(`SELECT count(*)::int AS n FROM appointments a WHERE a.scheduled_at::date = current_date AND ${as.sql}`, as.params) : null,
      has('admissions.read') ? one<{ n: number }>("SELECT count(*)::int AS n FROM admissions WHERE status='Admitted'") : null,
      has('admissions.read') ? one<{ n: number }>("SELECT (SELECT count(*) FROM beds)::int - (SELECT count(*) FROM admissions WHERE status='Admitted')::int AS n") : null,
      has('lab.read') ? one<{ n: number }>("SELECT count(*)::int AS n FROM laboratory_requests WHERE status IN ('Requested','In progress')") : null,
      has('billing.read') ? one<{ n: number; amount: number }>(`SELECT count(*)::int AS n, COALESCE(sum(t.total - t.paid),0)::float AS amount FROM (
          SELECT i.id, COALESCE((SELECT sum(quantity*unit_price) FROM invoice_items WHERE invoice_id=i.id),0) AS total,
                 COALESCE((SELECT sum(amount) FROM payments WHERE invoice_id=i.id),0) AS paid FROM invoices i WHERE i.status IN ('Issued','Partially paid')) t`) : null,
      has('staff.read') ? one<{ availability: string; n: number }>("SELECT availability, count(*)::int AS n FROM staff WHERE active GROUP BY availability ORDER BY availability") : null,
      canAppts ? one(`SELECT a.id, a.scheduled_at, a.status, p.first_name || ' ' || p.last_name AS patient, s.full_name AS doctor, d.name AS department
          FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN staff s ON s.id=a.doctor_id JOIN departments d ON d.id=a.department_id
          WHERE ${as.sql} ORDER BY abs(extract(epoch FROM (a.scheduled_at - now()))) LIMIT 6`, as.params) : null,
      canPatients ? one(`SELECT p.id, p.mrn, p.first_name, p.last_name, p.sex, p.dob, p.created_at FROM patients p WHERE ${ps.sql} ORDER BY p.created_at DESC, p.id DESC LIMIT 5`, ps.params) : null,
      canAppts ? one(`SELECT d.name AS department, count(*)::int AS appointments FROM appointments a JOIN departments d ON d.id=a.department_id WHERE a.scheduled_at >= now() - interval '14 days' AND ${as.sql} GROUP BY d.name ORDER BY appointments DESC`, as.params) : null,
      canAppts ? one(`SELECT to_char(d::date,'YYYY-MM-DD') AS day, (SELECT count(*)::int FROM appointments a WHERE a.scheduled_at::date = d::date AND ${as.sql}) AS appointments
          FROM generate_series(current_date - 13, current_date + 7, interval '1 day') d ORDER BY d`, as.params) : null,
      has('admissions.read') ? one("SELECT status, count(*)::int AS n FROM admissions GROUP BY status") : null,
    ]);

    res.json({
      scope: u.role === 'doctor' ? 'care-team' : u.role === 'nurse' ? 'department' : 'all',
      totals: {
        patients: patients?.[0].n ?? null,
        appointmentsToday: today?.[0].n ?? null,
        admitted: admitted?.[0].n ?? null,
        availableBeds: beds?.[0].n ?? null,
        pendingLab: labPending?.[0].n ?? null,
        outstandingInvoices: outstanding?.[0].n ?? null,
        outstandingAmount: outstanding?.[0].amount ?? null,
      },
      staffAvailability: staff,
      recentAppointments: recentAppts,
      recentPatients,
      departmentActivity: dept,
      appointmentTrend: trend,
      admissionStats: admissions,
    });
  });

  r.get('/reports/operational', requirePermission('reports.read'), async (_req, res) => {
    const [byStatus, byDept, revenue, aging, lab] = await Promise.all([
      db.query('SELECT status, count(*)::int AS n FROM appointments GROUP BY status ORDER BY status'),
      db.query('SELECT d.name AS department, count(a.id)::int AS appointments FROM departments d LEFT JOIN appointments a ON a.department_id=d.id GROUP BY d.name ORDER BY appointments DESC'),
      db.query("SELECT to_char(paid_at,'YYYY-MM') AS month, sum(amount)::float AS collected FROM payments GROUP BY 1 ORDER BY 1"),
      db.query(`SELECT bucket, count(*)::int AS invoices, COALESCE(sum(balance),0)::float AS balance FROM (
          SELECT CASE WHEN current_date - i.due_on <= 0 THEN 'Not yet due' WHEN current_date - i.due_on <= 30 THEN '1-30 days' ELSE '31+ days' END AS bucket,
                 (COALESCE((SELECT sum(quantity*unit_price) FROM invoice_items WHERE invoice_id=i.id),0) - COALESCE((SELECT sum(amount) FROM payments WHERE invoice_id=i.id),0)) AS balance
            FROM invoices i WHERE i.status IN ('Issued','Partially paid')) x GROUP BY bucket ORDER BY bucket`),
      db.query('SELECT status, count(*)::int AS n FROM laboratory_requests GROUP BY status ORDER BY status'),
    ]);
    res.json({ appointmentsByStatus: byStatus.rows, appointmentsByDepartment: byDept.rows, collectionsByMonth: revenue.rows, receivablesAging: aging.rows, labByStatus: lab.rows });
  });

  return r;
}
