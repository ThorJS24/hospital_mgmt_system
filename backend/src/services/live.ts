import { EventEmitter } from 'node:events';

/**
 * In-process live activity bus. Messages are deliberately anonymised (no patient names/MRNs)
 * so any authenticated user may receive the stream without gaining access to records.
 */
export interface LiveEvent { id: number; at: string; kind: string; message: string }

export const bus = new EventEmitter();
bus.setMaxListeners(200);
let seq = 0;
const recent: LiveEvent[] = [];

export function emitLive(kind: string, message: string): LiveEvent {
  const ev = { id: ++seq, at: new Date().toISOString(), kind, message };
  recent.push(ev);
  if (recent.length > 60) recent.shift();
  bus.emit('event', ev);
  return ev;
}

export const recentEvents = (n = 25) => recent.slice(-n).reverse();

const AUDIT_MESSAGES: Record<string, string> = {
  patient_register: 'New patient registered',
  appointment_create: 'Appointment booked',
  appointment_status: 'Appointment status updated',
  appointment_reschedule: 'Appointment rescheduled',
  admission_create: 'Patient admitted to a ward',
  admission_discharge: 'Patient discharged',
  lab_request: 'Laboratory request created',
  lab_result: 'Laboratory result recorded',
  lab_approve: 'Laboratory result approved',
  prescription_create: 'Prescription issued',
  prescription_dispense: 'Prescription dispensed',
  invoice_create: 'Invoice generated',
  payment_record: 'Payment received',
  refund_record: 'Refund processed',
  claim_decision: 'Insurance claim decided',
  consultation_sign: 'Consultation signed',
  triage_register: 'New arrival in the emergency queue',
  mar_administer: 'Medication dose recorded',
  prescription_refill: 'Prescription refilled',
};
export const auditMessage = (action: string) => AUDIT_MESSAGES[action];
