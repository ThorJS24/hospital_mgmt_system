import type { Db } from '../db/index.js';
import { HttpError } from '../utils/http.js';

const DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** Parses the free-text roster used by the staff directory ("Mon-Fri 08:00-16:00", "Mon/Wed/Fri 09:00-17:00"). */
export function parseSchedule(text: string): { days: number[]; start: string; end: string } | null {
  const m = /^\s*([A-Za-z/-]+)\s+(\d{2}:\d{2})-(\d{2}:\d{2})\s*$/.exec(text);
  if (!m) return null;
  const [, dayPart, start, end] = m;
  const days = new Set<number>();
  if (dayPart.includes('/')) {
    for (const d of dayPart.split('/')) { const n = DAYS[d.slice(0, 3).toLowerCase()]; if (n === undefined) return null; days.add(n); }
  } else if (dayPart.includes('-')) {
    const [a, b] = dayPart.split('-').map((d) => DAYS[d.slice(0, 3).toLowerCase()]);
    if (a === undefined || b === undefined) return null;
    for (let d = a; ; d = (d + 1) % 7) { days.add(d); if (d === b) break; }
  } else {
    const n = DAYS[dayPart.slice(0, 3).toLowerCase()];
    if (n === undefined) return null;
    days.add(n);
  }
  if (end <= start) return null;
  return { days: [...days].sort(), start, end };
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export const isDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // rejects overflow such as 2026-02-30
};
export const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

const localNow = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export interface Slot { time: string; available: boolean; reason?: string }

/** Appointment slots for one clinician on one date, derived from shifts, approved leave and existing bookings. */
export async function slotsFor(db: Db, staffId: number, date: string, minutes = 30): Promise<{ slots: Slot[]; note?: string }> {
  if (!isDate(date)) throw new HttpError(400, 'Use YYYY-MM-DD');
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240) throw new HttpError(400, 'Invalid duration');
  const leave = (await db.query(`SELECT 1 FROM staff_leave WHERE staff_id=$1 AND status='Approved' AND $2::date BETWEEN start_date AND end_date LIMIT 1`, [staffId, date])).rows.length;
  if (leave) return { slots: [], note: 'On approved leave' };
  const shifts = (await db.query<{ s: string; e: string }>(
    `SELECT to_char(start_time,'HH24:MI') AS s, to_char(end_time,'HH24:MI') AS e FROM staff_shifts WHERE staff_id=$1 AND weekday=$2 ORDER BY start_time`, [staffId, weekdayOf(date)])).rows;
  if (!shifts.length) return { slots: [], note: 'Not rostered on this day' };
  const booked = (await db.query<{ s: string; d: number }>(
    `SELECT to_char(scheduled_at,'HH24:MI') AS s, duration_min AS d FROM appointments
      WHERE doctor_id=$1 AND scheduled_at::date = $2::date AND status NOT IN ('Cancelled','No-show')`, [staffId, date])).rows
    .map((b) => ({ start: toMin(b.s), end: toMin(b.s) + b.d }));
  const now = localNow();
  const slots: Slot[] = [];
  for (const sh of shifts) {
    for (let t = toMin(sh.s); t + minutes <= toMin(sh.e); t += minutes) {
      const time = toHHMM(t);
      const clash = booked.some((b) => b.start < t + minutes && b.end > t);
      const past = `${date}T${time}` < now;
      slots.push({ time, available: !clash && !past, ...(clash ? { reason: 'Booked' } : past ? { reason: 'Past' } : {}) });
    }
  }
  return { slots };
}

/** True when a requested start falls on an offered, available slot (used by self-service booking). */
export async function isSlotAvailable(db: Db, staffId: number, date: string, time: string, minutes = 30): Promise<boolean> {
  const { slots } = await slotsFor(db, staffId, date, minutes);
  return slots.some((s) => s.time === time && s.available);
}
