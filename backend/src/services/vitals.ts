/** Reference ranges and abnormality flags for vital signs (adult / paediatric). Synthetic teaching ranges, not clinical guidance. */
export type Flag = 'low' | 'high' | 'critical-low' | 'critical-high' | null;

export interface VitalRow { systolic: number; diastolic: number; heart_rate: number; temperature_c: number; spo2: number }

interface Range { lo: number; hi: number; critLo: number; critHi: number }
const ADULT: Record<string, Range> = {
  systolic: { lo: 90, hi: 139, critLo: 80, critHi: 180 },
  diastolic: { lo: 60, hi: 89, critLo: 50, critHi: 120 },
  heart_rate: { lo: 60, hi: 100, critLo: 40, critHi: 130 },
  temperature_c: { lo: 36.0, hi: 37.8, critLo: 35.0, critHi: 39.5 },
  spo2: { lo: 95, hi: 100, critLo: 90, critHi: 101 },
};
const CHILD: Record<string, Range> = {
  ...ADULT,
  systolic: { lo: 80, hi: 120, critLo: 70, critHi: 140 },
  diastolic: { lo: 50, hi: 80, critLo: 40, critHi: 95 },
  heart_rate: { lo: 70, hi: 120, critLo: 50, critHi: 160 },
};

export const ageInYears = (dob: string | Date, now = new Date()) => (now.getTime() - new Date(dob).getTime()) / (365.25 * 86400000);

export const rangesFor = (age: number) => (age < 12 ? CHILD : ADULT);

export function flagValue(metric: string, v: number, age: number): Flag {
  const r = rangesFor(age)[metric];
  if (!r) return null;
  if (v <= r.critLo) return 'critical-low';
  if (v >= r.critHi) return 'critical-high';
  if (v < r.lo) return 'low';
  if (v > r.hi) return 'high';
  return null;
}

export function flagRow(row: VitalRow, age: number): Record<string, Flag> {
  const out: Record<string, Flag> = {};
  for (const m of Object.keys(ADULT)) out[m] = flagValue(m, Number((row as any)[m]), age);
  return out;
}

export const hasCritical = (flags: Record<string, Flag>) => Object.values(flags).some((f) => f === 'critical-low' || f === 'critical-high');
export const hasAbnormal = (flags: Record<string, Flag>) => Object.values(flags).some((f) => !!f);
