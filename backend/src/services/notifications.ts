import type { Db } from '../db/index.js';

export interface NotifyInput {
  kind: string;
  severity?: 'info' | 'warn' | 'critical';
  title: string;
  body?: string;
  link?: string;
  /** Identical (user, dedupeKey) pairs are stored once, so periodic scans never repeat an alert. */
  dedupeKey?: string;
}

const INSERT = `INSERT INTO notifications(user_id,kind,severity,title,body,link,dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7)
  ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`;

export async function notifyUsers(db: Db, userIds: number[], n: NotifyInput): Promise<void> {
  for (const id of [...new Set(userIds)]) {
    await db.query(INSERT, [id, n.kind, n.severity ?? 'info', n.title.slice(0, 160), (n.body ?? '').slice(0, 500), n.link ?? '', n.dedupeKey ?? null]);
  }
}

export async function notifyRoles(db: Db, roles: string[], n: NotifyInput, departmentId?: number | null): Promise<void> {
  const params: unknown[] = [roles];
  let dept = '';
  if (departmentId) { params.push(departmentId); dept = ' AND (s.department_id = $2 OR r.code = \'administrator\')'; }
  const ids = (await db.query<{ id: number }>(
    `SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id LEFT JOIN staff s ON s.id=u.staff_id WHERE u.active AND r.code = ANY($1::text[])${dept}`, params)).rows.map((r) => r.id);
  await notifyUsers(db, ids, n);
}

export async function notifyStaff(db: Db, staffId: number, n: NotifyInput): Promise<void> {
  const ids = (await db.query<{ id: number }>('SELECT id FROM users WHERE staff_id=$1 AND active', [staffId])).rows.map((r) => r.id);
  await notifyUsers(db, ids, n);
}

export async function notifyPatient(db: Db, patientId: number, n: NotifyInput): Promise<void> {
  const ids = (await db.query<{ id: number }>('SELECT id FROM users WHERE patient_id=$1 AND active', [patientId])).rows.map((r) => r.id);
  await notifyUsers(db, ids, n);
}

/** Critical laboratory value -> alert the ordering doctor. Idempotent per request. */
export async function checkCriticalLab(db: Db, requestId: number): Promise<boolean> {
  const row = (await db.query<{ value: string; critical_low: number | null; critical_high: number | null; ordering_doctor_id: number; patient_id: number; test: string; unit: string; patient: string }>(
    `SELECT res.value, t.critical_low::float AS critical_low, t.critical_high::float AS critical_high, lr.ordering_doctor_id, lr.patient_id, t.name AS test, t.unit,
            p.first_name || ' ' || p.last_name AS patient
       FROM laboratory_requests lr JOIN laboratory_results res ON res.request_id=lr.id JOIN laboratory_tests t ON t.id=lr.test_id JOIN patients p ON p.id=lr.patient_id
      WHERE lr.id=$1`, [requestId])).rows[0];
  if (!row) return false;
  const v = parseFloat(row.value);
  if (Number.isNaN(v)) return false;
  const low = row.critical_low !== null && v <= row.critical_low;
  const high = row.critical_high !== null && v >= row.critical_high;
  if (!low && !high) return false;
  await notifyStaff(db, row.ordering_doctor_id, {
    kind: 'lab_critical', severity: 'critical', title: `Critical result: ${row.test}`,
    body: `${row.patient}: ${row.value} ${row.unit} (${high ? 'critically high' : 'critically low'}). Review immediately.`,
    link: `/patients/${row.patient_id}`, dedupeKey: `labcrit:${requestId}`,
  });
  return true;
}

/** Bed movement -> nurses of the ward's department and administrators. */
export async function notifyBedChange(db: Db, admissionId: number, action: 'admitted' | 'discharged' | 'transferred'): Promise<void> {
  const row = (await db.query<{ ward: string; bed: string; department_id: number | null }>(
    `SELECT w.name AS ward, b.label AS bed, w.department_id FROM admissions a JOIN beds b ON b.id=a.bed_id JOIN wards w ON w.id=b.ward_id WHERE a.id=$1`, [admissionId])).rows[0];
  if (!row) return;
  await notifyRoles(db, ['nurse', 'administrator'], {
    kind: 'bed_change', severity: 'info', title: `Patient ${action}: ${row.ward}`, body: `Bed ${row.bed} (${row.ward})`, link: '/admissions',
    dedupeKey: `bed:${admissionId}:${action}`,
  }, row.department_id);
}

const today = () => new Date().toISOString().slice(0, 10);

/** Daily summary of overdue invoices for billing staff. Safe to run repeatedly. */
export async function scanOverdueInvoices(db: Db): Promise<number> {
  const rows = (await db.query<{ invoice_no: string; balance: number; days: number }>(
    `SELECT invoice_no, balance::float AS balance, days FROM (
       SELECT i.invoice_no, (current_date - i.due_on) AS days,
              COALESCE((SELECT sum(quantity*unit_price) FROM invoice_items WHERE invoice_id=i.id),0) - COALESCE((SELECT sum(amount) FROM payments WHERE invoice_id=i.id),0) AS balance
         FROM invoices i WHERE i.status IN ('Issued','Partially paid') AND i.due_on < current_date) x
      WHERE balance > 0 ORDER BY days DESC`)).rows;
  if (!rows.length) return 0;
  const total = rows.reduce((s, r) => s + r.balance, 0);
  await notifyRoles(db, ['billing_officer', 'administrator'], {
    kind: 'invoice_overdue', severity: rows.some((r) => r.days > 30) ? 'warn' : 'info',
    title: `${rows.length} overdue invoice${rows.length === 1 ? '' : 's'}`,
    body: `Outstanding ${total.toFixed(2)} USD. Oldest: ${rows[0].invoice_no} (${rows[0].days} days overdue).`,
    link: '/billing', dedupeKey: `overdue:${today()}`,
  });
  return rows.length;
}

/** Daily low-stock / expiry summary for pharmacy staff. */
export async function scanInventory(db: Db): Promise<number> {
  const rows = (await db.query<{ name: string; stock: number; reorder_level: number; expiry_date: string | null }>(
    `SELECT name, stock, reorder_level, expiry_date::text AS expiry_date FROM medications
      WHERE stock <= reorder_level OR (expiry_date IS NOT NULL AND expiry_date <= current_date + 30) ORDER BY name`)).rows;
  if (!rows.length) return 0;
  await notifyRoles(db, ['pharmacist', 'administrator'], {
    kind: 'inventory', severity: 'warn', title: `${rows.length} medication${rows.length === 1 ? '' : 's'} need attention`,
    body: `Low stock or expiring soon: ${rows.slice(0, 4).map((r) => r.name).join(', ')}${rows.length > 4 ? ', ...' : ''}`,
    link: '/inventory', dedupeKey: `inventory:${today()}`,
  });
  return rows.length;
}
