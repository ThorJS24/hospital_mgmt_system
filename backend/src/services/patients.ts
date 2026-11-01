import type { Db } from '../db/index.js';
import type { SessionUser } from '../middleware/context.js';
import { HttpError, orderBy, type PageQuery } from '../utils/http.js';

/**
 * Object-level authorization policy for patient records.
 *  - patients.read_all roles (admin, reception, lab, pharmacy, billing): every patient (demographics only)
 *  - doctor: patients in their care team (primary doctor, appointment, admission, prescription, lab order)
 *  - nurse: patients admitted to / seen in the nurse's department
 *  - everyone else: nothing
 */
export function scopeClause(user: SessionUser, p = 'p', firstParam = 1): { sql: string; params: unknown[] } {
  if (user.permissions.includes('patients.read_all')) return { sql: 'true', params: [] };
  if (user.role === 'doctor' && user.staffId) {
    const n = `$${firstParam}`;
    return {
      sql: `(${p}.primary_doctor_id = ${n}
        OR EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id=${p}.id AND a.doctor_id=${n})
        OR EXISTS (SELECT 1 FROM admissions ad WHERE ad.patient_id=${p}.id AND ad.doctor_id=${n})
        OR EXISTS (SELECT 1 FROM prescriptions rx WHERE rx.patient_id=${p}.id AND rx.doctor_id=${n})
        OR EXISTS (SELECT 1 FROM laboratory_requests lr WHERE lr.patient_id=${p}.id AND lr.ordering_doctor_id=${n}))`,
      params: [user.staffId],
    };
  }
  if (user.role === 'nurse' && user.departmentId) {
    const n = `$${firstParam}`;
    return {
      sql: `(EXISTS (SELECT 1 FROM admissions ad JOIN beds b ON b.id=ad.bed_id JOIN wards w ON w.id=b.ward_id
                      WHERE ad.patient_id=${p}.id AND ad.status='Admitted' AND w.department_id=${n})
        OR EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id=${p}.id AND a.department_id=${n}))`,
      params: [user.departmentId],
    };
  }
  return { sql: 'false', params: [] };
}

export async function canAccessPatient(db: Db, user: SessionUser, id: number): Promise<boolean> {
  const sc = scopeClause(user, 'p', 2);
  const { rows } = await db.query(`SELECT 1 FROM patients p WHERE p.id=$1 AND ${sc.sql}`, [id, ...sc.params]);
  return rows.length > 0;
}

const SORTS = { id: 'p.id', mrn: 'p.mrn', name: 'p.last_name', dob: 'p.dob', status: 'p.status', created: 'p.created_at' };

export async function listPatients(db: Db, user: SessionUser, pq: PageQuery, status?: string) {
  const sc = scopeClause(user, 'p', 1);
  const params: unknown[] = [...sc.params];
  const where = [sc.sql];
  if (pq.q) {
    params.push(`%${pq.q}%`);
    where.push(`(p.first_name || ' ' || p.last_name ILIKE $${params.length} OR p.mrn ILIKE $${params.length} OR p.phone ILIKE $${params.length})`);
  }
  if (status) {
    params.push(status);
    where.push(`p.status = $${params.length}`);
  }
  const w = where.join(' AND ');
  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM patients p WHERE ${w}`, params)).rows[0].n;
  const rows = (
    await db.query(
      `SELECT p.id, p.mrn, p.first_name, p.last_name, p.dob, p.sex, p.phone, p.status, s.full_name AS primary_doctor
         FROM patients p LEFT JOIN staff s ON s.id=p.primary_doctor_id
        WHERE ${w} ORDER BY ${orderBy(pq, SORTS, 'name')}, p.id LIMIT ${pq.pageSize} OFFSET ${(pq.page - 1) * pq.pageSize}`,
      params,
    )
  ).rows;
  return { data: rows, total, page: pq.page, pageSize: pq.pageSize };
}

export async function getPatient(db: Db, user: SessionUser, id: number) {
  const sc = scopeClause(user, 'p', 2);
  const { rows } = await db.query(
    `SELECT p.*, s.full_name AS primary_doctor FROM patients p LEFT JOIN staff s ON s.id=p.primary_doctor_id WHERE p.id=$1 AND ${sc.sql}`,
    [id, ...sc.params],
  );
  const p = rows[0];
  if (!p) throw new HttpError(404, 'Patient not found');
  const has = (perm: string) => user.permissions.includes(perm);
  const clinical = has('clinical.read');
  const [contacts, allergies, history, appts, invoices, docs, adm, procs, vitals] = await Promise.all([
    db.query('SELECT id,name,relationship,phone FROM patient_contacts WHERE patient_id=$1 ORDER BY id', [id]),
    clinical ? db.query('SELECT id,allergen,reaction,severity FROM patient_allergies WHERE patient_id=$1 ORDER BY id', [id]) : null,
    clinical ? db.query('SELECT id,condition,diagnosed_on,notes FROM medical_histories WHERE patient_id=$1 ORDER BY diagnosed_on DESC NULLS LAST', [id]) : null,
    has('appointments.read')
      ? db.query(`SELECT a.id, a.scheduled_at, a.status, a.reason, s.full_name AS doctor, d.name AS department FROM appointments a JOIN staff s ON s.id=a.doctor_id JOIN departments d ON d.id=a.department_id WHERE a.patient_id=$1 ORDER BY a.scheduled_at DESC`, [id])
      : null,
    has('billing.read')
      ? db.query(`SELECT i.id, i.invoice_no, i.status, i.issued_on, i.due_on, COALESCE((SELECT sum(quantity*unit_price) FROM invoice_items WHERE invoice_id=i.id),0)::float AS total, COALESCE((SELECT sum(amount) FROM payments WHERE invoice_id=i.id),0)::float AS paid FROM invoices i WHERE i.patient_id=$1 ORDER BY i.issued_on DESC`, [id])
      : null,
    has('documents.manage') ? db.query('SELECT id, filename, content_type, size_bytes, created_at FROM patient_documents WHERE patient_id=$1 ORDER BY id DESC', [id]) : null,
    db.query(`SELECT ad.id, ad.status, ad.admitted_at, w.name AS ward, b.label AS bed FROM admissions ad JOIN beds b ON b.id=ad.bed_id JOIN wards w ON w.id=b.ward_id WHERE ad.patient_id=$1 AND ad.status='Admitted'`, [id]),
    clinical ? db.query('SELECT mp.id, mp.code, mp.name, mp.performed_on, mp.cost::float AS cost, mp.outcome, s.full_name AS doctor FROM medical_procedures mp JOIN staff s ON s.id=mp.doctor_id WHERE mp.patient_id=$1 ORDER BY mp.performed_on DESC', [id]) : null,
    clinical ? db.query('SELECT id, recorded_at, systolic, diastolic, heart_rate, temperature_c::float AS temperature_c, spo2, weight_kg::float AS weight_kg FROM patient_vitals WHERE patient_id=$1 ORDER BY recorded_at DESC', [id]) : null,
  ]);
  // sensitive identifiers are masked in the normal API; full values exist only in the database
  const { ssn, drivers_license, insurance_policy_no } = p;
  const mask = (v: string | null, keep = 4) => (v ? `${'*'.repeat(Math.max(0, v.length - keep))}${v.slice(-keep)}` : null);
  p.ssn_masked = ssn ? `***-**-${String(ssn).slice(-4)}` : null;
  p.drivers_license_masked = mask(drivers_license);
  p.insurance_policy_masked = mask(insurance_policy_no);
  delete p.ssn; delete p.drivers_license; delete p.insurance_policy_no;
  if (!clinical) p.notes = '';
  return {
    ...p,
    contacts: contacts.rows,
    allergies: allergies?.rows ?? null,
    history: history?.rows ?? null,
    appointments: appts?.rows ?? null,
    invoices: invoices?.rows ?? null,
    documents: docs?.rows ?? null,
    admission: adm.rows[0] ?? null,
    procedures: procs?.rows ?? null,
    vitals: vitals?.rows ?? null,
  };
}

/** Unscoped clinical summary used ONLY by the intentionally vulnerable HMS-V03 route. */
export async function rawClinicalSummary(db: Db, id: number) {
  const p = (await db.query('SELECT id, mrn, first_name, last_name, dob, sex, status, notes, ssn, drivers_license, blood_type, insurance_provider, insurance_policy_no, insurance_group_no FROM patients WHERE id=$1', [id])).rows[0];
  if (!p) throw new HttpError(404, 'Patient not found');
  const [allergies, history] = await Promise.all([
    db.query('SELECT allergen,reaction,severity FROM patient_allergies WHERE patient_id=$1', [id]),
    db.query('SELECT condition,diagnosed_on,notes FROM medical_histories WHERE patient_id=$1', [id]),
  ]);
  const cards = (await db.query('SELECT card_brand, card_number, card_expiry, card_holder FROM patient_payment_methods WHERE patient_id=$1', [id])).rows;
  return { ...p, allergies: allergies.rows, history: history.rows, payment_methods: cards };
}

export async function nextMrn(db: Db): Promise<string> {
  const { rows } = await db.query<{ n: number }>("SELECT COALESCE(max(substring(mrn from 5)::int),0)+1 AS n FROM patients WHERE mrn ~ '^SYN-[0-9]+$'");
  return `SYN-${String(rows[0].n).padStart(6, '0')}`;
}
