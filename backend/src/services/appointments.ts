import type { Db } from '../db/index.js';
import type { SessionUser } from '../middleware/context.js';
import { HttpError } from '../utils/http.js';

export const APPOINTMENT_STATUSES = ['Scheduled', 'Confirmed', 'Checked in', 'In consultation', 'Completed', 'Cancelled', 'No-show'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  Scheduled: ['Confirmed', 'Checked in', 'Cancelled', 'No-show'],
  Confirmed: ['Checked in', 'Cancelled', 'No-show'],
  'Checked in': ['In consultation', 'Cancelled'],
  'In consultation': ['Completed'],
  Completed: [],
  Cancelled: [],
  'No-show': [],
};

export function assertTransition(from: AppointmentStatus, to: AppointmentStatus) {
  if (!TRANSITIONS[from]?.includes(to)) throw new HttpError(409, `Cannot change status from "${from}" to "${to}"`);
}

/** Row-level visibility for appointments: doctors see their own, nurses their department, others by permission. */
export function appointmentScope(user: SessionUser, alias = 'a', firstParam = 1): { sql: string; params: unknown[] } {
  if (user.role === 'doctor') return { sql: `${alias}.doctor_id = $${firstParam}`, params: [user.staffId ?? 0] };
  if (user.role === 'nurse') return { sql: `${alias}.department_id = $${firstParam}`, params: [user.departmentId ?? 0] };
  return { sql: 'true', params: [] };
}

/** True when the doctor already has a non-cancelled appointment overlapping [start, start+minutes). */
export async function hasConflict(db: Db, doctorId: number, start: string, minutes: number, excludeId = 0): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM appointments
      WHERE doctor_id=$1 AND id <> $4 AND status NOT IN ('Cancelled','No-show')
        AND scheduled_at < ($2::timestamp + ($3 || ' minutes')::interval)
        AND (scheduled_at + (duration_min || ' minutes')::interval) > $2::timestamp LIMIT 1`,
    [doctorId, start, String(minutes), excludeId],
  );
  return rows.length > 0;
}

export async function setStatus(db: Db, id: number, to: AppointmentStatus): Promise<void> {
  const row = (await db.query<{ status: AppointmentStatus }>('SELECT status FROM appointments WHERE id=$1', [id])).rows[0];
  if (!row) throw new HttpError(404, 'Appointment not found');
  assertTransition(row.status, to);
  await db.query('UPDATE appointments SET status=$1 WHERE id=$2', [to, id]);
}
