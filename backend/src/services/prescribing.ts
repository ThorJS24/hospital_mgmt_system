import type { Db } from '../db/index.js';

export interface PrescribedItem { medication_id: number; quantity: number; dosage: string; units_per_dose?: number | null; doses_per_day?: number | null }
export interface Warning {
  type: 'allergy' | 'interaction' | 'dose' | 'stock' | 'duplicate';
  severity: 'Minor' | 'Moderate' | 'Major';
  /** Blocking warnings need an explicit documented override to prescribe. */
  blocking: boolean;
  message: string;
  medication_ids: number[];
}

/** Cross-reactivity: an allergy to the key also matches medications in these drug classes. */
const CROSS_CLASS: Record<string, string[]> = {
  aspirin: ['nsaid'],
  nsaid: ['nsaid'],
  nsaids: ['nsaid'],
  penicillin: ['penicillin'],
  amoxicillin: ['penicillin'],
};

/**
 * Prescription safety checks against the patient's recorded allergies, the interaction table, active medicines
 * and maximum daily dose. Educational rules on synthetic data only: not a substitute for clinical decision support.
 */
export async function checkPrescription(db: Db, patientId: number, items: PrescribedItem[]): Promise<Warning[]> {
  const warnings: Warning[] = [];
  const ids = [...new Set(items.map((i) => i.medication_id))];
  if (!ids.length) return warnings;
  const meds = (await db.query<{ id: number; name: string; drug_class: string; max_daily_units: number | null; stock: number }>(
    'SELECT id, name, drug_class, max_daily_units, stock FROM medications WHERE id = ANY($1::int[])', [ids])).rows;
  const byId = new Map(meds.map((m) => [m.id, m]));

  // allergies
  const allergies = (await db.query<{ allergen: string; reaction: string; severity: 'Mild' | 'Moderate' | 'Severe' }>(
    'SELECT allergen, reaction, severity FROM patient_allergies WHERE patient_id=$1', [patientId])).rows;
  for (const m of meds) {
    for (const a of allergies) {
      const key = a.allergen.trim().toLowerCase();
      const classes = CROSS_CLASS[key] ?? [];
      const cls = m.drug_class.toLowerCase();
      const hit = key === m.name.toLowerCase() || (cls !== '' && key === cls) || classes.includes(cls);
      if (!hit) continue;
      warnings.push({
        type: 'allergy', severity: a.severity === 'Severe' ? 'Major' : a.severity === 'Moderate' ? 'Moderate' : 'Minor',
        blocking: a.severity === 'Severe',
        message: `${m.name}: patient has a recorded ${a.severity.toLowerCase()} allergy to ${a.allergen}${a.reaction ? ` (${a.reaction})` : ''}`,
        medication_ids: [m.id],
      });
    }
  }

  // interactions between the new items, and with the patient's other active prescriptions
  const active = (await db.query<{ medication_id: number }>(
    `SELECT DISTINCT pi.medication_id FROM prescription_items pi JOIN prescriptions rx ON rx.id=pi.prescription_id
      WHERE rx.patient_id=$1 AND rx.status='Active'`, [patientId])).rows.map((r) => r.medication_id);
  const all = [...new Set([...ids, ...active])];
  if (all.length > 1) {
    const rows = (await db.query<{ medication_a: number; medication_b: number; severity: 'Minor' | 'Moderate' | 'Major'; description: string; na: string; nb: string }>(
      `SELECT di.medication_a, di.medication_b, di.severity, di.description, a.name AS na, b.name AS nb
         FROM drug_interactions di JOIN medications a ON a.id=di.medication_a JOIN medications b ON b.id=di.medication_b
        WHERE di.medication_a = ANY($1::int[]) AND di.medication_b = ANY($1::int[])`, [all])).rows;
    for (const r of rows) {
      // only report pairs that involve at least one medication in the new prescription
      if (!ids.includes(r.medication_a) && !ids.includes(r.medication_b)) continue;
      const existing = !ids.includes(r.medication_a) || !ids.includes(r.medication_b);
      warnings.push({
        type: 'interaction', severity: r.severity, blocking: r.severity === 'Major',
        message: `${r.na} + ${r.nb}${existing ? ' (already prescribed)' : ''}: ${r.description}`,
        medication_ids: [r.medication_a, r.medication_b],
      });
    }
  }
  for (const id of ids) {
    if (active.includes(id)) warnings.push({ type: 'duplicate', severity: 'Moderate', blocking: false, message: `${byId.get(id)?.name ?? id}: the patient already has an active prescription for this medication`, medication_ids: [id] });
  }

  // dosing and stock
  for (const it of items) {
    const m = byId.get(it.medication_id);
    if (!m) continue;
    if (it.units_per_dose && it.doses_per_day && m.max_daily_units && it.units_per_dose * it.doses_per_day > m.max_daily_units) {
      warnings.push({ type: 'dose', severity: 'Major', blocking: true, message: `${m.name}: ${it.units_per_dose * it.doses_per_day} units/day exceeds the maximum of ${m.max_daily_units} units/day`, medication_ids: [m.id] });
    }
    if (m.stock < it.quantity) {
      warnings.push({ type: 'stock', severity: 'Minor', blocking: false, message: `${m.name}: only ${m.stock} units in stock (${it.quantity} requested)`, medication_ids: [m.id] });
    }
  }
  return warnings;
}
