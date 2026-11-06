import type { Db } from '../db/index.js';
import { HttpError } from '../utils/http.js';
import { checkPrescription, type PrescribedItem, type Warning } from './prescribing.js';

export interface IssueInput {
  patientId: number;
  doctorId: number;
  notes: string;
  items: PrescribedItem[];
  refillsAllowed: number;
  overrideReason?: string;
  consultationId?: number | null;
}

export interface IssueResult { id: number; warnings: Warning[]; overridden: boolean }

/**
 * Creates a prescription after running allergy / interaction / dose checks.
 * Blocking findings (severe allergy, major interaction, dose above maximum) reject the request with 409 and the
 * warning list unless the prescriber supplies a documented override reason (min. 10 characters).
 */
export async function issuePrescription(db: Db, input: IssueInput): Promise<IssueResult> {
  const warnings = await checkPrescription(db, input.patientId, input.items);
  const blocking = warnings.filter((w) => w.blocking);
  const override = (input.overrideReason ?? '').trim();
  if (blocking.length && override.length < 10) {
    throw new HttpError(409, 'Prescription blocked by safety checks. Review the warnings or document an override reason.', { warnings });
  }
  const id = await db.tx(async (t) => {
    if (!(await t.query('SELECT 1 FROM patients WHERE id=$1', [input.patientId])).rows.length) throw new HttpError(400, 'Patient not found');
    const { rows } = await t.query(
      'INSERT INTO prescriptions(patient_id,doctor_id,notes,refills_allowed,override_reason,consultation_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [input.patientId, input.doctorId, input.notes, input.refillsAllowed, blocking.length ? override : '', input.consultationId ?? null]);
    for (const it of input.items) {
      if (!(await t.query('SELECT 1 FROM medications WHERE id=$1', [it.medication_id])).rows.length) throw new HttpError(400, `Medication ${it.medication_id} not found`);
      await t.query('INSERT INTO prescription_items(prescription_id,medication_id,quantity,dosage,units_per_dose,doses_per_day) VALUES ($1,$2,$3,$4,$5,$6)',
        [rows[0].id, it.medication_id, it.quantity, it.dosage, it.units_per_dose ?? null, it.doses_per_day ?? null]);
    }
    return rows[0].id as number;
  });
  return { id, warnings, overridden: blocking.length > 0 };
}
