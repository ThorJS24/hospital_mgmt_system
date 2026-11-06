import type { Db } from './index.js';
import { hashPassword } from '../utils/crypto.js';
import { parseSchedule } from '../services/staffing.js';
import { checkCriticalLab, notifyStaff, notifyUsers, scanInventory, scanOverdueInvoices } from '../services/notifications.js';
import { sendDueReminders } from '../services/reminders.js';
import { deriveStatus, round2 } from '../services/billing.js';

export interface TestAccount { username: string; role: string; name: string; password: string; staff: string | null; patientId?: number }

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const naive = (d: Date) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

/**
 * Synthetic data for the clinical-workflow, operations and patient-portal features
 * (consultations, MAR, triage, inventory, rosters, claims, notifications). Runs after the core dataset.
 */
export async function seedExtended(db: Db, accounts: readonly TestAccount[]): Promise<void> {
  const r = rng(20260202);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];
  const now = new Date();
  const dayAt = (offset: number, h: number, m = 0) => { const d = new Date(now); d.setDate(d.getDate() + offset); d.setHours(h, m, 0, 0); return d; };
  const one = async <T = any>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
  const userId = async (username: string) => (await one<{ id: number }>('SELECT id FROM users WHERE username=$1', [username])).id;
  const staffId = async (code: string) => (await one<{ id: number }>('SELECT id FROM staff WHERE staff_code=$1', [code])).id;
  const medId = async (code: string) => (await one<{ id: number }>('SELECT id FROM medications WHERE code=$1', [code])).id;

  // ---------- patient contact preference and portal accounts ----------
  await db.exec("UPDATE patients SET contact_preference = CASE WHEN id % 3 = 0 THEN 'sms' WHEN id % 3 = 1 THEN 'email' ELSE 'both' END");
  for (const a of accounts.filter((x) => x.role === 'patient' && x.patientId)) {
    await db.query("UPDATE patients SET status='Active' WHERE id=$1", [a.patientId]);
    const p = await one<{ first_name: string; last_name: string; email: string }>('SELECT first_name, last_name, email FROM patients WHERE id=$1', [a.patientId]);
    await db.query('INSERT INTO users(username,email,full_name,password_hash,role_id,patient_id) SELECT $1,$2,$3,$4,r.id,$5 FROM roles r WHERE r.code=$6',
      [a.username, p.email, `${p.first_name} ${p.last_name}`, hashPassword(a.password), a.patientId, a.role]);
  }

  // ---------- suppliers, inventory and prescribing reference data ----------
  const suppliers: [string, string, string][] = [
    ['Northwind Pharma Supply', 'orders@northwind-pharma.example.test', '555-0301'],
    ['Evergreen Medical Distributors', 'sales@evergreen-med.example.test', '555-0302'],
    ['Harbor Biologics', 'supply@harbor-bio.example.test', '555-0303'],
  ];
  const supplierIds: number[] = [];
  for (const s of suppliers) supplierIds.push((await one<{ id: number }>('INSERT INTO suppliers(name,contact_email,phone) VALUES ($1,$2,$3) RETURNING id', s)).id);
  // code -> [drug class, max units/day, reorder level, expiry offset (days), unit cost]
  const medInfo: Record<string, [string, number, number, number, number]> = {
    AMX500: ['Penicillin', 6, 200, 420, 0.35], MET850: ['Biguanide', 3, 200, 540, 0.12], ATO20: ['Statin', 4, 150, 600, 0.28], LIS10: ['ACE inhibitor', 4, 150, 480, 0.15],
    SAL100: ['Beta agonist', 16, 200, -12, 6.8], IBU400: ['NSAID', 6, 300, 380, 0.08], PAR500: ['Analgesic', 8, 400, 700, 0.05], OME20: ['Proton pump inhibitor', 2, 150, 300, 0.22],
    AMD5: ['Calcium channel blocker', 2, 150, 520, 0.14], LEV50: ['Thyroid hormone', 4, 150, 450, 0.18], SER50: ['SSRI', 4, 100, 360, 0.3], CET10: ['Antihistamine', 1, 150, 640, 0.09],
    MTP50: ['Beta blocker', 8, 120, 410, 0.2], WAR5: ['Anticoagulant', 2, 250, 22, 0.4], CLO75: ['Antiplatelet', 1, 340, 25, 0.55], AZI250: ['Macrolide', 4, 100, 90, 0.6],
  };
  let n = 0;
  for (const [code, [cls, maxUnits, reorder, expiryDays, cost]] of Object.entries(medInfo)) {
    await db.query('UPDATE medications SET drug_class=$2, max_daily_units=$3, reorder_level=$4, expiry_date=current_date + $5::int, unit_cost=$6, supplier_id=$7 WHERE code=$1',
      [code, cls, maxUnits, reorder, expiryDays, cost, supplierIds[n++ % supplierIds.length]]);
  }
  await db.exec("INSERT INTO stock_movements(medication_id,delta,reason,note) SELECT id, stock, 'Receive', 'Opening balance' FROM medications WHERE stock > 0");

  const interactions: [string, string, 'Minor' | 'Moderate' | 'Major', string][] = [
    ['WAR5', 'IBU400', 'Major', 'NSAIDs raise the risk of serious bleeding in patients taking warfarin'],
    ['WAR5', 'CLO75', 'Major', 'Anticoagulant plus antiplatelet therapy markedly increases bleeding risk'],
    ['WAR5', 'SER50', 'Moderate', 'SSRIs can potentiate the bleeding risk of warfarin; monitor INR'],
    ['WAR5', 'AZI250', 'Moderate', 'Macrolides may raise INR; monitor closely'],
    ['WAR5', 'PAR500', 'Minor', 'Regular high-dose paracetamol can slightly raise INR'],
    ['SER50', 'IBU400', 'Moderate', 'SSRI plus NSAID increases the risk of gastrointestinal bleeding'],
    ['LIS10', 'IBU400', 'Moderate', 'NSAIDs can blunt the effect of ACE inhibitors and stress the kidneys'],
    ['LIS10', 'AMD5', 'Minor', 'Additive blood-pressure lowering; usually intended'],
    ['MTP50', 'AMD5', 'Moderate', 'Additive hypotension and bradycardia; monitor heart rate and blood pressure'],
    ['CLO75', 'OME20', 'Moderate', 'Omeprazole can reduce the antiplatelet effect of clopidogrel'],
    ['CLO75', 'IBU400', 'Moderate', 'Combined antiplatelet and NSAID use raises bleeding risk'],
    ['ATO20', 'AZI250', 'Minor', 'Small increase in statin exposure; monitor for muscle symptoms'],
  ];
  for (const [a, b, severity, description] of interactions) {
    const ia = await medId(a), ib = await medId(b);
    await db.query('INSERT INTO drug_interactions(medication_a,medication_b,severity,description) VALUES ($1,$2,$3,$4)', [Math.min(ia, ib), Math.max(ia, ib), severity, description]);
  }

  // laboratory critical values
  const crit: [string, number | null, number | null][] = [['GLU', 2.8, 20], ['TRP', null, 100], ['HGB', 7, null], ['CBC', 2, 30], ['UEC', null, 500], ['HBA', null, 14], ['LFT', null, 500]];
  for (const [code, lo, hi] of crit) await db.query('UPDATE laboratory_tests SET critical_low=$2, critical_high=$3 WHERE code=$1', [code, lo, hi]);

  // ---------- rosters and leave ----------
  const staffRows = (await db.query<{ id: number; schedule: string }>('SELECT id, schedule FROM staff WHERE active')).rows;
  for (const s of staffRows) {
    const sch = parseSchedule(s.schedule);
    if (!sch) continue;
    for (const day of sch.days) await db.query('INSERT INTO staff_shifts(staff_id,weekday,start_time,end_time) VALUES ($1,$2,$3,$4)', [s.id, day, sch.start, sch.end]);
  }
  const admin = await userId('admin.hartley');
  const leaveSeeds: [string, number, number, string, 'Approved' | 'Pending' | 'Rejected'][] = [
    ['DOC-004', 3, 6, 'Conference attendance', 'Approved'], ['DOC-006', 10, 12, 'Family event', 'Pending'], ['NUR-002', 5, 5, 'Medical appointment', 'Pending'],
    ['DOC-002', -20, -16, 'Annual leave', 'Approved'], ['LAB-002', 7, 9, 'Training course', 'Rejected'],
  ];
  for (const [code, from, to, reason, status] of leaveSeeds) {
    const l = await one<{ id: number }>('INSERT INTO staff_leave(staff_id,start_date,end_date,reason,status,decided_by,decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [await staffId(code), ymd(dayAt(from, 0)), ymd(dayAt(to, 0)), reason, status, status === 'Pending' ? null : admin, status === 'Pending' ? null : naive(now)]);
    if (status === 'Pending') await notifyUsers(db, [admin], { kind: 'leave_request', title: 'Leave request awaiting decision', body: `${code}: ${reason}`, link: '/roster', dedupeKey: `leave:${l.id}` });
  }

  // ---------- extra vitals for current inpatients (rich trend charts) ----------
  for (let i = 1; i <= 26; i++) {
    const baseSys = 112 + Math.floor(r() * 36);
    for (let k = 0; k < 6; k++) {
      const at = new Date(now.getTime() - (5 - k) * 7 * 3600_000);
      const critical = i === 3 && k === 5;
      await db.query('INSERT INTO patient_vitals(patient_id,recorded_at,systolic,diastolic,heart_rate,temperature_c,spo2,weight_kg) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [i, naive(at), critical ? 86 : baseSys + Math.floor(r() * 14) - 7, critical ? 54 : 70 + Math.floor(r() * 16), critical ? 134 : 62 + Math.floor(r() * 36), critical ? 38.9 : (36.3 + r() * 1.3).toFixed(1), critical ? 89 : 93 + Math.floor(r() * 7), (62 + r() * 30).toFixed(1)]);
    }
  }

  // ---------- inpatient orders and the medication administration record ----------
  const nurse = await userId('nurse.okafor');
  const mars = (await db.query<{ id: number; patient_id: number; doctor_id: number }>("SELECT id, patient_id, doctor_id FROM admissions WHERE status='Admitted' AND id <= 20 ORDER BY id")).rows;
  const orders: [string, string, string[]][] = [
    ['PAR500', '1 tablet every 8 hours', ['08:00', '14:00', '20:00']],
    ['OME20', '1 capsule each morning', ['08:00']],
    ['AMD5', '1 tablet once daily', ['09:00']],
  ];
  for (const adm of mars) {
    const rx = await one<{ id: number }>("INSERT INTO prescriptions(patient_id,doctor_id,status,dispensing_status,notes,created_at) VALUES ($1,$2,'Active','Pending','Inpatient orders',$3) RETURNING id", [adm.patient_id, adm.doctor_id, naive(dayAt(-1, 9))]);
    const chosen = orders.filter((_, idx) => idx === 0 || (idx === 1 && adm.id % 2 === 0) || (idx === 2 && adm.id % 3 === 0));
    for (const [code, dosage, times] of chosen) {
      const item = await one<{ id: number }>('INSERT INTO prescription_items(prescription_id,medication_id,quantity,dosage,units_per_dose,doses_per_day) VALUES ($1,$2,$3,$4,1,$5) RETURNING id', [rx.id, await medId(code), times.length * 7, dosage, times.length]);
      for (const day of [-1, 0]) {
        for (const t of times) {
          const [h, m] = t.split(':').map(Number);
          const at = dayAt(day, h, m);
          const ageMin = (now.getTime() - at.getTime()) / 60000;
          let status = 'Scheduled', administered: string | null = null, by: number | null = null, note = '';
          if (ageMin > 90) {
            if (r() < 0.07) { status = 'Held'; note = 'Patient nil by mouth for procedure'; } else status = 'Given';
            administered = naive(new Date(at.getTime() + (3 + Math.floor(r() * 15)) * 60000));
            by = nurse;
          }
          await db.query('INSERT INTO mar_doses(admission_id,prescription_item_id,scheduled_at,status,administered_at,administered_by,note) VALUES ($1,$2,$3,$4,$5,$6,$7)', [adm.id, item.id, naive(at), status, administered, by, note]);
        }
      }
    }
  }

  // ---------- discharge summaries with follow-up appointments ----------
  const discharged = (await db.query<{ id: number; patient_id: number; doctor_id: number; reason: string }>("SELECT id, patient_id, doctor_id, reason FROM admissions WHERE status='Discharged' ORDER BY id LIMIT 6")).rows;
  const courses = ['Responded well to treatment and was mobilising independently before discharge.', 'Uncomplicated stay. Observations stable for 24 hours before discharge.', 'Symptoms resolved with intravenous therapy, then oral medication.'];
  const instructions = ['Rest for one week, drink plenty of fluids and return if symptoms worsen.', 'Take medication as prescribed. Avoid strenuous activity for two weeks.', 'Keep the wound clean and dry. Attend the follow-up appointment.'];
  for (const [idx, d] of discharged.entries()) {
    const dept = (await one<{ department_id: number }>('SELECT department_id FROM staff WHERE id=$1', [d.doctor_id])).department_id;
    const appt = await one<{ id: number }>("INSERT INTO appointments(patient_id,doctor_id,department_id,scheduled_at,duration_min,reason) VALUES ($1,$2,$3,$4,30,'Post-discharge follow-up') RETURNING id", [d.patient_id, d.doctor_id, dept, naive(dayAt(3 + idx, 17, 0))]);
    await db.query('INSERT INTO discharge_summaries(admission_id,diagnosis,hospital_course,discharge_medications,instructions,follow_up_appointment_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [d.id, d.reason || 'Observation', courses[idx % courses.length], 'Paracetamol 500 mg - 1 tablet every 8 hours as needed\nOmeprazole 20 mg - 1 capsule each morning', instructions[idx % instructions.length], appt.id, admin]);
  }

  // ---------- emergency triage queue and history ----------
  const pool = (await db.query<{ id: number }>("SELECT id FROM patients WHERE status='Active' AND id BETWEEN 40 AND 110 ORDER BY id")).rows.map((x) => x.id);
  const emDocs = (await db.query<{ id: number }>("SELECT s.id FROM staff s JOIN departments d ON d.id=s.department_id WHERE s.staff_code LIKE 'DOC-%' AND d.name='Emergency' ORDER BY s.id")).rows.map((x) => x.id);
  const complaints: [string, number][] = [['Chest pain radiating to the left arm', 2], ['Shortness of breath', 2], ['Laceration to the forearm', 4], ['Ankle injury after a fall', 4], ['Persistent fever and cough', 3], ['Abdominal pain', 3], ['Sore throat', 5], ['Minor burn to the hand', 4], ['Severe allergic reaction', 1], ['Headache and dizziness', 3], ['Vomiting and dehydration', 3], ['Back pain after lifting', 5]];
  const waitFor: Record<number, [number, number]> = { 1: [1, 3], 2: [6, 16], 3: [18, 48], 4: [30, 75], 5: [40, 95] };
  let pi = 0;
  const nextPatient = () => pool[pi++ % pool.length];
  // 18 completed in the last two days
  for (let k = 0; k < 18; k++) {
    const [complaint, esi] = pick(complaints);
    const [lo, hi] = waitFor[esi];
    const wait = lo + Math.floor(r() * (hi - lo + 1));
    const ago = 200 + Math.floor(r() * 2600);
    await db.query(`INSERT INTO triage_entries(patient_id,complaint,esi_level,status,arrived_at,started_at,completed_at,assigned_doctor_id,triaged_by)
        VALUES ($1,$2,$3,'Completed', now() - make_interval(mins => $4::int), now() - make_interval(mins => $5::int), now() - make_interval(mins => $6::int), $7, $8)`,
      [nextPatient(), complaint, esi, ago, ago - wait, ago - wait - 40, pick(emDocs), nurse]);
  }
  // two in treatment, five waiting
  for (const [complaint, esi, mins] of [['Chest pain radiating to the left arm', 2, 38], ['Fracture of the wrist after a fall', 3, 55]] as [string, number, number][]) {
    await db.query(`INSERT INTO triage_entries(patient_id,complaint,esi_level,status,arrived_at,started_at,assigned_doctor_id,triaged_by)
        VALUES ($1,$2,$3,'In treatment', now() - make_interval(mins => $4::int), now() - make_interval(mins => $5::int), $6, $7)`, [nextPatient(), complaint, esi, mins, mins - 12, pick(emDocs), nurse]);
  }
  for (const [complaint, esi, mins] of [['Shortness of breath', 2, 14], ['Abdominal pain', 3, 32], ['Persistent fever and cough', 3, 24], ['Ankle injury after a fall', 4, 41], ['Sore throat', 5, 9]] as [string, number, number][]) {
    await db.query(`INSERT INTO triage_entries(patient_id,complaint,esi_level,status,arrived_at,triaged_by) VALUES ($1,$2,$3,'Waiting', now() - make_interval(mins => $4::int), $5)`, [nextPatient(), complaint, esi, mins, nurse]);
  }

  // ---------- the demo patient's own records for the portal ----------
  for (const a of accounts.filter((x) => x.role === 'patient' && x.patientId)) {
    const pid = a.patientId!;
    // keep the demo patient's future calendar small so that online booking has room (the random day-sheets would otherwise fill the 5-appointment limit)
    await db.query("DELETE FROM appointments WHERE patient_id=$1 AND scheduled_at > now()", [pid]);
    const mehta = await staffId('DOC-001');
    const cardio = (await one<{ department_id: number }>('SELECT department_id FROM staff WHERE id=$1', [mehta])).department_id;
    await db.query("INSERT INTO appointments(patient_id,doctor_id,department_id,scheduled_at,duration_min,status,reason) VALUES ($1,$2,$3,$4,30,'Confirmed','Blood pressure review')", [pid, mehta, cardio, naive(dayAt(3, 17, 30))]);
    for (const [testId, value, daysAgo] of [[1, '6.8', 9], [2, '5.1', 9]] as [number, string, number][]) {
      const req = await one<{ id: number }>("INSERT INTO laboratory_requests(patient_id,test_id,ordering_doctor_id,assigned_tech_id,status,requested_at) VALUES ($1,$2,$3,$4,'Approved',$5) RETURNING id", [pid, testId, mehta, await staffId('LAB-001'), naive(dayAt(-daysAgo, 9))]);
      await db.query("INSERT INTO laboratory_results(request_id,value,comment,approved,entered_by,entered_at) VALUES ($1,$2,'SYNTHETIC RESULT - not for clinical use',true,$3,$4)", [req.id, value, await userId('labtech.alvarez'), naive(dayAt(-daysAgo, 13))]);
    }
    const rx = await one<{ id: number }>("INSERT INTO prescriptions(patient_id,doctor_id,status,dispensing_status,notes,refills_allowed,refills_used,last_dispensed_at,created_at) VALUES ($1,$2,'Active','Dispensed','Long-term therapy',3,1,$3,$3) RETURNING id", [pid, mehta, naive(dayAt(-20, 10))]);
    await db.query("INSERT INTO prescription_items(prescription_id,medication_id,quantity,dosage,units_per_dose,doses_per_day) VALUES ($1,$2,30,'1 tablet once daily',1,1), ($1,$3,30,'1 tablet at night',1,1)", [rx.id, await medId('LIS10'), await medId('ATO20')]);
    const mk = async (no: string, status: string, dueOffset: number, issuedOffset: number, items: [string, number, number][], paid: number) => {
      const inv = await one<{ id: number }>('INSERT INTO invoices(invoice_no,patient_id,status,issued_on,due_on) VALUES ($1,$2,$3,$4,$5) RETURNING id', [no, pid, status, ymd(dayAt(issuedOffset, 9)), ymd(dayAt(dueOffset, 9))]);
      for (const [d, q, p] of items) await db.query('INSERT INTO invoice_items(invoice_id,description,quantity,unit_price) VALUES ($1,$2,$3,$4)', [inv.id, d, q, p]);
      if (paid > 0) await db.query("INSERT INTO payments(invoice_id,amount,method,paid_at) VALUES ($1,$2,'Card (synthetic)',$3)", [inv.id, paid, naive(dayAt(issuedOffset + 2, 11))]);
    };
    await mk('INV-1111', 'Partially paid', 10, -20, [['Specialist consultation', 1, 220], ['ECG', 1, 75]], 150);
    await mk('INV-1112', 'Issued', -10, -40, [['Outpatient consultation', 1, 120], ['Laboratory panel', 1, 85]], 0);
  }

  // ---------- insurance claims and a refund ----------
  const billing = await userId('billing.nakamura');
  const candidates = (await db.query<{ id: number; provider: string; policy: string; total: number; paid: number }>(
    `SELECT i.id, p.insurance_provider AS provider, p.insurance_policy_no AS policy,
            COALESCE((SELECT sum(quantity*unit_price) FROM invoice_items WHERE invoice_id=i.id),0)::float AS total,
            COALESCE((SELECT sum(amount) FROM payments WHERE invoice_id=i.id),0)::float AS paid
       FROM invoices i JOIN patients p ON p.id=i.patient_id
      WHERE i.status='Issued' AND p.insurance_provider IS NOT NULL AND p.insurance_provider <> 'Self-pay' AND i.patient_id <> ALL($1::int[]) ORDER BY i.id LIMIT 9`,
    [accounts.filter((a) => a.patientId).map((a) => a.patientId)])).rows;
  const claimPlan: ('Submitted' | 'Approved' | 'Partially approved' | 'Rejected')[] = ['Submitted', 'Submitted', 'Submitted', 'Approved', 'Partially approved', 'Rejected', 'Rejected'];
  for (const [idx, status] of claimPlan.entries()) {
    const c = candidates[idx];
    if (!c) break;
    const claimed = round2((c.total - c.paid) * 0.8);
    if (claimed <= 0) continue;
    if (status === 'Submitted') {
      await db.query("INSERT INTO insurance_claims(invoice_id,provider,policy_no,amount_claimed,submitted_by,submitted_at) VALUES ($1,$2,$3,$4,$5,$6)", [c.id, c.provider, c.policy, claimed, billing, naive(dayAt(-1 - idx, 10))]);
    } else if (status === 'Rejected') {
      await db.query("INSERT INTO insurance_claims(invoice_id,provider,policy_no,amount_claimed,amount_approved,status,note,submitted_by,decided_by,decided_at) VALUES ($1,$2,$3,$4,0,'Rejected',$5,$6,$7,now())",
        [c.id, c.provider, c.policy, claimed, idx === 5 ? 'Policy inactive on the date of service' : 'Pre-authorisation missing', billing, admin]);
    } else {
      const approved = status === 'Approved' ? claimed : round2(claimed / 2);
      const pay = await one<{ id: number }>("INSERT INTO payments(invoice_id,amount,method,created_by) VALUES ($1,$2,$3,$4) RETURNING id", [c.id, approved, `Insurance claim (${c.provider})`, admin]);
      await db.query('UPDATE invoices SET status=$2 WHERE id=$1', [c.id, deriveStatus(c.total, round2(c.paid + approved))]);
      await db.query('INSERT INTO insurance_claims(invoice_id,provider,policy_no,amount_claimed,amount_approved,status,submitted_by,decided_by,decided_at,payment_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9)',
        [c.id, c.provider, c.policy, claimed, approved, status, billing, admin, pay.id]);
    }
  }
  const refundable = await one<{ id: number; invoice_id: number; amount: number; total: number; paid: number }>(
    `SELECT pay.id, pay.invoice_id, pay.amount::float AS amount,
            COALESCE((SELECT sum(quantity*unit_price) FROM invoice_items WHERE invoice_id=i.id),0)::float AS total,
            COALESCE((SELECT sum(amount) FROM payments WHERE invoice_id=i.id),0)::float AS paid
       FROM payments pay JOIN invoices i ON i.id=pay.invoice_id WHERE i.status='Paid' AND pay.kind='Payment' AND pay.amount >= 100 ORDER BY pay.id LIMIT 1`);
  if (refundable) {
    await db.query("INSERT INTO payments(invoice_id,amount,method,kind,refund_of,reason,created_by) VALUES ($1,-25,'Refund (synthetic)','Refund',$2,'Duplicate charge corrected',$3)", [refundable.invoice_id, refundable.id, admin]);
    await db.query('UPDATE invoices SET status=$2 WHERE id=$1', [refundable.invoice_id, deriveStatus(refundable.total, round2(refundable.paid - 25))]);
  }

  // ---------- signed consultations (history) and today's draft ----------
  const dx: [string, string][] = [['I10', 'Essential (primary) hypertension'], ['E11.9', 'Type 2 diabetes mellitus without complications'], ['J45.909', 'Unspecified asthma, uncomplicated'], ['E78.5', 'Hyperlipidemia, unspecified'],
    ['M54.50', 'Low back pain, unspecified'], ['J06.9', 'Acute upper respiratory infection, unspecified'], ['R07.9', 'Chest pain, unspecified'], ['Z00.00', 'General adult medical examination']];
  const plans = ['Continue current therapy. Review in 3 months.', 'Start lifestyle measures and recheck blood pressure in 4 weeks.', 'Order baseline bloods; follow up with results.', 'Rest, fluids and simple analgesia. Return if symptoms worsen.'];
  const done = (await db.query<{ id: number; patient_id: number; doctor_id: number; scheduled_at: string }>(
    "SELECT id, patient_id, doctor_id, to_char(scheduled_at,'YYYY-MM-DD\"T\"HH24:MI:SS') AS scheduled_at FROM appointments WHERE status='Completed' AND scheduled_at < now() AND id % 37 = 0 ORDER BY id LIMIT 18")).rows;
  for (const a of done) {
    const [code1] = pick(dx);
    const c = await one<{ id: number }>(
      `INSERT INTO consultations(patient_id,doctor_id,appointment_id,subjective,objective,assessment,plan,status,signed_at,signed_by,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Signed',$8,(SELECT id FROM users WHERE staff_id=$2 LIMIT 1),$8,$8) RETURNING id`,
      [a.patient_id, a.doctor_id, a.id, 'Patient reports ongoing symptoms and good adherence to treatment. No new concerns.', 'Alert and comfortable. Vital signs reviewed. Examination unremarkable.',
        'Condition stable on current management.', pick(plans), a.scheduled_at]);
    await db.query('INSERT INTO consultation_diagnoses(consultation_id,icd_code,is_primary) VALUES ($1,$2,true)', [c.id, code1]);
    const second = pick(dx)[0];
    if (second !== code1 && r() < 0.5) await db.query('INSERT INTO consultation_diagnoses(consultation_id,icd_code,is_primary) VALUES ($1,$2,false)', [c.id, second]);
  }
  const today = await one<{ id: number; patient_id: number; doctor_id: number }>(
    `SELECT a.id, a.patient_id, a.doctor_id FROM appointments a WHERE a.status='In consultation' AND a.scheduled_at::date = current_date
        AND NOT EXISTS (SELECT 1 FROM consultations c WHERE c.appointment_id=a.id) ORDER BY (a.doctor_id = (SELECT id FROM staff WHERE staff_code='DOC-001')) DESC, a.id LIMIT 1`);
  if (today) await db.query("INSERT INTO consultations(patient_id,doctor_id,appointment_id,subjective) VALUES ($1,$2,$3,'Patient reports intermittent chest tightness on exertion for two weeks.')", [today.patient_id, today.doctor_id, today.id]);

  // ---------- notifications and outbox ----------
  const everyone = (await db.query<{ id: number }>('SELECT id FROM users WHERE active')).rows.map((u) => u.id);
  await notifyUsers(db, everyone, { kind: 'welcome', title: 'Welcome to MediCore', body: 'Press Ctrl+K to search, ? for keyboard shortcuts, and use the bell for alerts.', link: '/profile', dedupeKey: 'welcome-v1' });
  const recentLabs = (await db.query<{ id: number }>("SELECT lr.id FROM laboratory_requests lr JOIN laboratory_results res ON res.request_id=lr.id WHERE lr.requested_at > now() - interval '72 hours'")).rows;
  for (const l of recentLabs) await checkCriticalLab(db, l.id);
  const doc3 = await one<{ primary_doctor_id: number | null }>('SELECT primary_doctor_id FROM patients WHERE id=3');
  if (doc3?.primary_doctor_id) await notifyStaff(db, doc3.primary_doctor_id, { kind: 'vitals_critical', severity: 'critical', title: 'Critical vital signs', body: 'Latest observations are in the critical range (SpO2 89%, HR 134).', link: '/patients/3', dedupeKey: 'seed-vitcrit-3' });
  await scanOverdueInvoices(db);
  await scanInventory(db);
  await sendDueReminders(db);
}
