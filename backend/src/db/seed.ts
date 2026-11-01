import fs from 'node:fs';
import type { Db } from './index.js';
import type { AppConfig } from '../config/index.js';
import { PERMISSIONS, ROLES, ROLE_NAMES, permissionsFor } from '../services/permissions.js';
import { hashPassword } from '../utils/crypto.js';

/** Development-only synthetic credentials (documented in README). */
export const TEST_ACCOUNTS = [
  { username: 'admin.hartley', role: 'administrator', name: 'Helena Hartley', password: 'LabAdmin#2026', staff: 'ADM-001' },
  { username: 'doctor.mehta', role: 'doctor', name: 'Dr. Arjun Mehta', password: 'LabDoctor#2026', staff: 'DOC-001' },
  { username: 'doctor.svensson', role: 'doctor', name: 'Dr. Ingrid Svensson', password: 'LabDoctor#2026', staff: 'DOC-005' },
  { username: 'nurse.okafor', role: 'nurse', name: 'Nora Okafor', password: 'LabNurse#2026', staff: 'NUR-001' },
  { username: 'receptionist.lindqvist', role: 'receptionist', name: 'Elsa Lindqvist', password: 'LabFront#2026', staff: 'REC-001' },
  { username: 'labtech.alvarez', role: 'lab_technician', name: 'Mateo Alvarez', password: 'LabTech#2026', staff: 'LAB-001' },
  { username: 'pharmacist.rossi', role: 'pharmacist', name: 'Giulia Rossi', password: 'LabPharm#2026', staff: 'PHM-001' },
  { username: 'billing.nakamura', role: 'billing_officer', name: 'Kenji Nakamura', password: 'LabBill#2026', staff: 'BIL-001' },
  { username: 'assessor.vance', role: 'security_assessor', name: 'Priya Vance', password: 'LabAssess#2026', staff: null },
] as const;

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLINICAL_TABLES = [
  'patient_vitals', 'medical_procedures', 'patient_payment_methods', 'audit_events', 'payments', 'invoice_items', 'invoices', 'prescription_items', 'prescriptions', 'medications',
  'laboratory_results', 'laboratory_requests', 'laboratory_tests', 'admissions', 'beds', 'wards', 'appointments',
  'patient_documents', 'medical_histories', 'patient_allergies', 'patient_contacts', 'patients', 'reset_tokens',
  'sessions', 'users', 'staff', 'departments', 'role_permissions', 'permissions', 'roles', 'system_config',
];


export async function seedClinical(db: Db): Promise<void> {
  await db.exec(`TRUNCATE ${CLINICAL_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  const r = rng(20260101);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];

  // roles & permissions
  for (const code of ROLES) await db.query('INSERT INTO roles(code,name) VALUES ($1,$2)', [code, ROLE_NAMES[code]]);
  for (const [code, p] of Object.entries(PERMISSIONS)) await db.query('INSERT INTO permissions(code,description) VALUES ($1,$2)', [code, p.description]);
  for (const code of ROLES)
    for (const perm of permissionsFor(code))
      await db.query('INSERT INTO role_permissions SELECT r.id, p.id FROM roles r, permissions p WHERE r.code=$1 AND p.code=$2', [code, perm]);

  // departments
  const depts: [string, string, string][] = [
    ['Cardiology', 'Heart and vascular care', 'ECG, Echocardiography, Stress testing'],
    ['Emergency', 'Acute and trauma care', 'Triage, Resuscitation, Minor procedures'],
    ['Pediatrics', 'Care for infants and children', 'Immunisation, Growth monitoring'],
    ['Orthopedics', 'Bone and joint care', 'Fracture clinic, Joint injections'],
    ['General Medicine', 'Adult primary and internal medicine', 'Consultations, Chronic disease follow-up'],
    ['Radiology', 'Diagnostic imaging', 'X-ray, Ultrasound'],
    ['Laboratory', 'Clinical laboratory services', 'Haematology, Biochemistry'],
    ['Administration', 'Hospital administration and finance', 'Registration, Billing, Pharmacy dispensing'],
  ];
  for (const d of depts) await db.query('INSERT INTO departments(name,description,services) VALUES ($1,$2,$3)', d);
  const dept = async (n: string) => (await db.query<{ id: number }>('SELECT id FROM departments WHERE name=$1', [n])).rows[0].id;
  const D = Object.fromEntries(await Promise.all(depts.map(async (d) => [d[0], await dept(d[0])]))) as Record<string, number>;

  // staff
  const staff: [string, string, string, string][] = [
    ['ADM-001', 'Helena Hartley', 'Hospital Administrator', 'Administration'],
    ['DOC-001', 'Dr. Arjun Mehta', 'Consultant Cardiologist', 'Cardiology'],
    ['DOC-002', 'Dr. Laila Haddad', 'Cardiologist', 'Cardiology'],
    ['DOC-003', 'Dr. Tomas Brandt', 'Emergency Physician', 'Emergency'],
    ['DOC-004', 'Dr. Yuki Tanabe', 'Emergency Physician', 'Emergency'],
    ['DOC-005', 'Dr. Ingrid Svensson', 'General Practitioner', 'General Medicine'],
    ['DOC-006', 'Dr. Samuel Adeyemi', 'General Practitioner', 'General Medicine'],
    ['DOC-007', 'Dr. Camila Duarte', 'Pediatrician', 'Pediatrics'],
    ['DOC-008', 'Dr. Felix Brenner', 'Pediatrician', 'Pediatrics'],
    ['DOC-009', 'Dr. Mei Zhang', 'Orthopedic Surgeon', 'Orthopedics'],
    ['DOC-010', 'Dr. Oskar Lund', 'Radiologist', 'Radiology'],
    ['NUR-001', 'Nora Okafor', 'Registered Nurse', 'General Medicine'],
    ['NUR-002', 'Pavel Novak', 'Registered Nurse', 'Cardiology'],
    ['NUR-003', 'Amara Singh', 'Registered Nurse', 'Pediatrics'],
    ['NUR-004', 'Lucas Ferreira', 'Registered Nurse', 'Orthopedics'],
    ['REC-001', 'Elsa Lindqvist', 'Receptionist', 'Administration'],
    ['REC-002', 'Dario Costa', 'Receptionist', 'Administration'],
    ['LAB-001', 'Mateo Alvarez', 'Laboratory Technician', 'Laboratory'],
    ['LAB-002', 'Hana Petrova', 'Laboratory Technician', 'Laboratory'],
    ['PHM-001', 'Giulia Rossi', 'Pharmacist', 'Administration'],
    ['PHM-002', 'Ravi Menon', 'Pharmacist', 'Administration'],
    ['BIL-001', 'Kenji Nakamura', 'Billing Officer', 'Administration'],
    ['BIL-002', 'Sofia Marin', 'Billing Officer', 'Administration'],
  ];
  const avail = ['Available', 'Available', 'Available', 'In Surgery', 'On Leave', 'Off Duty'];
  for (const [code, name, title, dn] of staff) {
    const username = name.replace(/^Dr\. /, '').toLowerCase().replace(/\s+/g, '.');
    await db.query(
      'INSERT INTO staff(staff_code,full_name,job_title,department_id,email,availability,schedule) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [code, name, title, D[dn], `${username}@medicore.example.test`, code === 'DOC-001' ? 'Available' : pick(avail), pick(['Mon-Fri 08:00-16:00', 'Mon/Wed/Fri 09:00-17:00', 'Tue-Sat 10:00-18:00'])],
    );
  }
  const sid = async (code: string) => (await db.query<{ id: number }>('SELECT id FROM staff WHERE staff_code=$1', [code])).rows[0].id;
  const doctorIds = (await db.query<{ id: number; department_id: number }>("SELECT id, department_id FROM staff WHERE staff_code LIKE 'DOC-%' ORDER BY id")).rows;

  // users
  for (const a of TEST_ACCOUNTS) {
    await db.query(
      'INSERT INTO users(username,email,full_name,password_hash,role_id,staff_id) SELECT $1,$2,$3,$4,r.id,$5 FROM roles r WHERE r.code=$6',
      [a.username, `${a.username}@medicore.example.test`, a.name, hashPassword(a.password), a.staff ? await sid(a.staff) : null, a.role],
    );
  }

  // ---- time helpers: `timestamp` columns hold naive LOCAL wall-clock time (what the UI shows) ----
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const naive = (d: Date) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  const dayAt = (offset: number, h: number, m = 0) => { const d = new Date(now); d.setDate(d.getDate() + offset); d.setHours(h, m, 0, 0); return d; };

  // ---- patients (120, realistic demographics; names/addresses are fictional) ----
  const firsts = ['Olivia', 'Liam', 'Emma', 'Noah', 'Ava', 'Elijah', 'Sophia', 'Lucas', 'Isabella', 'Mason', 'Mia', 'Logan', 'Amelia', 'Ethan', 'Harper', 'James', 'Evelyn', 'Aiden', 'Abigail', 'Henry',
    'Priya', 'Arjun', 'Fatima', 'Omar', 'Mei', 'Wei', 'Yuki', 'Hiro', 'Sofia', 'Mateo', 'Camila', 'Diego', 'Amara', 'Kwame', 'Zainab', 'Ibrahim', 'Anna', 'Lars', 'Ingrid', 'Erik',
    'Chloe', 'Daniel', 'Grace', 'Samuel', 'Hannah', 'Benjamin', 'Lily', 'Jack', 'Nora', 'Leo', 'Ella', 'Owen', 'Ruby', 'Caleb', 'Zoe', 'Nathan', 'Maya', 'Isaac', 'Leah', 'Adam'];
  const lasts = ['Ashdown', 'Bellamy', 'Carter', 'Dunmore', 'Edwards', 'Fletcher', 'Gallagher', 'Hughes', 'Iverson', 'Jenkins', 'Kowalski', 'Lawson', 'Morales', 'Nguyen', 'Okafor', 'Patel', 'Quinn', 'Reyes', 'Sullivan', 'Thompson',
    'Underwood', 'Vasquez', 'Whitaker', 'Xu', 'Yamamoto', 'Zimmerman', 'Abbott', 'Brennan', 'Castillo', 'Dawson', 'Ellison', 'Foster', 'Grant', 'Hayes', 'Ingram', 'Joshi', 'Keller', 'Lindqvist', 'Mercer', 'Novak',
    'Ortega', 'Pearson', 'Rahman', 'Santos', 'Tanaka', 'Underhill', 'Valdez', 'Walsh', 'Yilmaz', 'Zhang', 'Bishop', 'Cooper', 'Duarte', 'Eriksen', 'Fischer', 'Goldberg', 'Holt', 'Ibarra', 'Jovanovic', 'Khan'];
  const streets = ['Maple Avenue', 'Oak Street', 'Cedar Lane', 'Pine Road', 'Elm Drive', 'Willow Court', 'Lakeview Boulevard', 'Sunset Terrace', 'Hillcrest Way', 'Park Place', 'River Road', 'Meadow Lane'];
  const cities = ['Riverton, OH 44101', 'Fairview, OH 44115', 'Lakewood, OH 44107', 'Brookfield, OH 44122', 'Hamilton, OH 44130', 'Westbrook, OH 44145'];
  const allergens: [string, string, 'Mild' | 'Moderate' | 'Severe'][] = [['Penicillin', 'Rash', 'Moderate'], ['Peanuts', 'Anaphylaxis', 'Severe'], ['Latex', 'Contact dermatitis', 'Mild'], ['Shellfish', 'Hives', 'Moderate'], ['Sulfonamides', 'Rash', 'Moderate'], ['Aspirin', 'Bronchospasm', 'Severe'], ['Pollen', 'Allergic rhinitis', 'Mild'], ['Ibuprofen', 'GI upset', 'Mild']];
  const conditions = ['Essential hypertension (I10)', 'Type 2 diabetes mellitus (E11.9)', 'Asthma, unspecified (J45.909)', 'Hyperlipidaemia (E78.5)', 'Migraine without aura (G43.009)', 'Primary osteoarthritis, knee (M17.11)', 'Hypothyroidism (E03.9)', 'Generalised anxiety disorder (F41.1)', 'Gastro-oesophageal reflux disease (K21.9)', 'Chronic kidney disease, stage 3 (N18.30)', 'Atrial fibrillation (I48.91)', 'Iron deficiency anaemia (D50.9)'];
  const contactRel = ['Spouse', 'Parent', 'Sibling', 'Child', 'Friend'];
  const noteSamples = ['Routine follow-up planned in 3 months.', 'Patient reports good adherence to medication.', 'Discussed lifestyle modification and diet.', 'Referred for further imaging; awaiting results.', 'Blood pressure well controlled on current regimen.'];
  const PATIENTS = 120;
  const FEMALE = new Set(['Olivia', 'Emma', 'Ava', 'Sophia', 'Isabella', 'Mia', 'Amelia', 'Harper', 'Evelyn', 'Abigail', 'Priya', 'Fatima', 'Mei', 'Sofia', 'Camila', 'Amara', 'Zainab', 'Anna', 'Ingrid', 'Chloe', 'Grace', 'Hannah', 'Lily', 'Nora', 'Ella', 'Ruby', 'Zoe', 'Maya', 'Leah']);
  const insurers = ['Northwind Health', 'Evergreen Mutual', 'BlueHarbor Care', 'Summit Medical Plan', 'Pioneer Health Alliance', 'Self-pay'];
  const bloodTypes = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'];
  const marital = ['Single', 'Married', 'Divorced', 'Widowed'];
  // public processor TEST card numbers only (never valid for charging)
  const testCards: [string, string][] = [['Visa', '4242424242424242'], ['Mastercard', '5555555555554444'], ['Amex', '378282246309005'], ['Discover', '6011111111111117']];
  const procedures: [string, string, number][] = [['PRC-1001', 'Electrocardiogram (ECG)', 75], ['PRC-1002', 'Chest X-ray', 140], ['PRC-1003', 'Abdominal ultrasound', 260], ['PRC-1004', 'Echocardiogram', 480], ['PRC-1005', 'Colonoscopy', 1450], ['PRC-1006', 'Knee arthroscopy', 5200], ['PRC-1007', 'MRI scan, brain', 1180], ['PRC-1008', 'Appendectomy', 6800], ['PRC-1009', 'Cast application', 220], ['PRC-1010', 'Skin lesion excision', 390], ['PRC-1011', 'Cardiac stress test', 640], ['PRC-1012', 'Vaccination (adult)', 55]];
  for (let i = 1; i <= PATIENTS; i++) {
    const f = firsts[i % firsts.length], l = lasts[(i * 7 + Math.floor(i / 60) * 11) % lasts.length];
    const doc = doctorIds[(i - 1) % doctorIds.length];
    const ageYears = i % 9 === 0 ? 1 + r() * 14 : 18 + r() * 70; // some paediatric patients
    const dob = ymd(new Date(now.getTime() - ageYears * 365.25 * 86400000));
    const registered = new Date(now.getTime() - (PATIENTS - i) * 6 * 3600000 * 5 - r() * 3600000);
    const { rows } = await db.query<{ id: number }>(
      'INSERT INTO patients(mrn,first_name,last_name,dob,sex,phone,email,address,status,primary_doctor_id,notes,created_at,ssn,drivers_license,blood_type,marital_status,insurance_provider,insurance_policy_no,insurance_group_no) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id',
      [`SYN-${String(i).padStart(6, '0')}`, f, l, dob, FEMALE.has(f) ? 'Female' : 'Male', `555-01${String(i % 100).padStart(2, '0')}`, `${f}.${l}${i}@patients.example.test`.toLowerCase(),
        `${100 + Math.floor(r() * 880)} ${pick(streets)}, ${pick(cities)}`, i % 23 === 0 ? 'Inactive' : 'Active', doc.id, i % 3 === 0 ? pick(noteSamples) : '', registered.toISOString(),
        `9${String(10 + Math.floor(r() * 89))}-${String(10 + Math.floor(r() * 89))}-${String(1000 + Math.floor(r() * 8999))}`, // 9xx area numbers are never issued
        ageYears < 16 ? null : `DL-${String(Math.floor(r() * 90000000) + 10000000)}`, pick(bloodTypes), ageYears < 18 ? 'Single' : pick(marital),
        pick(insurers), `POL-${String(Math.floor(r() * 900000000) + 100000000)}`, `GRP-${String(1000 + Math.floor(r() * 9000))}`],
    );
    const pid = rows[0].id;
    if (ageYears >= 18 && r() < 0.7) {
      const [brand, num] = pick(testCards);
      await db.query('INSERT INTO patient_payment_methods(patient_id,card_brand,card_number,card_expiry,card_holder) VALUES ($1,$2,$3,$4,$5)', [pid, brand, num, `${pad(1 + Math.floor(r() * 12))}/${27 + Math.floor(r() * 5)}`, `${f} ${l}`.toUpperCase()]);
    }
    for (let k = 0; k < Math.floor(r() * 3); k++) {
      const [code, name, cost] = pick(procedures);
      await db.query('INSERT INTO medical_procedures(patient_id,doctor_id,code,name,performed_on,cost,outcome) VALUES ($1,$2,$3,$4,$5,$6,$7)', [pid, pick(doctorIds).id, code, name, ymd(new Date(now.getTime() - (5 + r() * 400) * 86400000)), cost, r() < 0.93 ? 'Successful' : 'Follow-up required']);
    }
    const baseSys = 105 + Math.floor(r() * 40), baseW = ageYears < 15 ? 20 + r() * 35 : 55 + r() * 45;
    for (let k = 0; k < 3; k++)
      await db.query('INSERT INTO patient_vitals(patient_id,recorded_at,systolic,diastolic,heart_rate,temperature_c,spo2,weight_kg) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [pid, naive(dayAt(-k * 21 - Math.floor(r() * 5), 8 + Math.floor(r() * 8))), baseSys + Math.floor(r() * 12) - 6, 65 + Math.floor((baseSys - 105) / 2) + Math.floor(r() * 8), 58 + Math.floor(r() * 40), (36.2 + r() * 1.2).toFixed(1), 94 + Math.floor(r() * 6), (baseW + r() * 2 - 1).toFixed(1)]);
    await db.query('INSERT INTO patient_contacts(patient_id,name,relationship,phone) VALUES ($1,$2,$3,$4)', [pid, `${pick(firsts)} ${l}`, pick(contactRel), `555-02${String(i % 100).padStart(2, '0')}`]);
    if (r() < 0.45) { const a = pick(allergens); await db.query('INSERT INTO patient_allergies(patient_id,allergen,reaction,severity) VALUES ($1,$2,$3,$4)', [pid, ...a]); }
    for (let k = 0; k < (ageYears < 15 ? 0 : r() < 0.6 ? 1 + Math.floor(r() * 2) : 0); k++)
      await db.query('INSERT INTO medical_histories(patient_id,condition,diagnosed_on,notes) VALUES ($1,$2,$3,$4)', [pid, pick(conditions), ymd(new Date(now.getTime() - (200 + r() * 3000) * 86400000)), pick(noteSamples)]);
  }

  // ---- wards & beds: 6 wards x 8 beds ----
  const wards: [string, string][] = [['Cardiology Ward A', 'Cardiology'], ['General Ward B', 'General Medicine'], ['Pediatric Ward C', 'Pediatrics'], ['Orthopedic Ward D', 'Orthopedics'], ['Emergency Observation E', 'Emergency'], ['Intensive Care Unit', 'General Medicine']];
  for (const [n, dn] of wards) {
    const { rows } = await db.query<{ id: number }>('INSERT INTO wards(name,department_id) VALUES ($1,$2) RETURNING id', [n, D[dn]]);
    const prefix = n.split(' ').map((w) => w[0]).join('').slice(0, 3);
    for (let b = 1; b <= 8; b++) await db.query('INSERT INTO beds(ward_id,label) VALUES ($1,$2)', [rows[0].id, `${prefix}-${String(b).padStart(2, '0')}`]);
  }
  const reasonsAdm = ['Observation after chest pain', 'Post-operative care', 'Cardiac monitoring', 'Community-acquired pneumonia', 'Fracture fixation recovery', 'Diabetic ketoacidosis management', 'Acute exacerbation of asthma', 'Cellulitis, IV antibiotics'];
  const ACTIVE = 26; // beds 1..26 occupied by patients 1..26 -> 22 of 48 beds free
  for (let i = 1; i <= ACTIVE; i++)
    await db.query('INSERT INTO admissions(patient_id,bed_id,doctor_id,admitted_at,status,reason) VALUES ($1,$2,$3,$4,$5,$6)', [i, i, doctorIds[(i - 1) % doctorIds.length].id, naive(dayAt(-(i % 7), 6 + (i % 10), (i * 7) % 60)), 'Admitted', pick(reasonsAdm)]);
  for (let i = ACTIVE + 1; i <= ACTIVE + 24; i++)
    await db.query('INSERT INTO admissions(patient_id,bed_id,doctor_id,admitted_at,discharged_at,status,reason) VALUES ($1,$2,$3,$4,$5,$6,$7)', [i, 1 + (i % 48), doctorIds[i % doctorIds.length].id, naive(dayAt(-20 - (i % 15), 9)), naive(dayAt(-14 - (i % 12), 11)), 'Discharged', pick(reasonsAdm)]);

  // ---- appointments: every doctor has a realistic day-sheet (30 min slots, 08:00-16:30), -14..+14 days, weekdays only ----
  const reasons = ['Routine check-up', 'Follow-up visit', 'Blood pressure review', 'Medication review', 'Post-operative review', 'New symptoms', 'Test results discussion', 'Vaccination', 'Chest pain assessment', 'Diabetes review'];
  for (let day = -14; day <= 14; day++) {
    const dow = dayAt(day, 0).getDay();
    const weekend = dow === 0 || dow === 6; // weekend: reduced roster (emergency + cardiology on call)
    for (const doc of doctorIds) {
      if (weekend && ![D['Emergency'], D['Cardiology']].includes(doc.department_id)) continue;
      const slots = new Set<number>();
      const count = 5 + Math.floor(r() * 5);
      while (slots.size < count) slots.add(Math.floor(r() * 17)); // 17 half-hour slots: 08:00 .. 16:00
      for (const s of [...slots].sort((a, b) => a - b)) {
        const at = dayAt(day, 8 + Math.floor(s / 2), s % 2 ? 30 : 0);
        const diffMin = (at.getTime() - now.getTime()) / 60000;
        let status: string;
        if (day < 0) status = r() < 0.82 ? 'Completed' : r() < 0.6 ? 'No-show' : 'Cancelled';
        else if (day === 0) status = diffMin < -45 ? (r() < 0.9 ? 'Completed' : 'No-show') : diffMin < -5 ? 'In consultation' : diffMin < 20 ? 'Checked in' : r() < 0.6 ? 'Confirmed' : 'Scheduled';
        else status = day <= 3 && r() < 0.7 ? 'Confirmed' : r() < 0.06 ? 'Cancelled' : 'Scheduled';
        await db.query('INSERT INTO appointments(patient_id,doctor_id,department_id,scheduled_at,duration_min,status,reason) VALUES ($1,$2,$3,$4,$5,$6,$7)', [1 + Math.floor(r() * PATIENTS), doc.id, doc.department_id, naive(at), 30, status, pick(reasons)]);
      }
    }
  }

  // ---- laboratory ----
  const tests: [string, string, string, string, number][] = [['CBC', 'Complete blood count', '10^9/L', '4.0-11.0', 18], ['GLU', 'Fasting glucose', 'mmol/L', '3.9-5.6', 9], ['LIP', 'Lipid panel (total cholesterol)', 'mmol/L', '<5.2', 24], ['CRP', 'C-reactive protein', 'mg/L', '<5', 14], ['TSH', 'Thyroid stimulating hormone', 'mIU/L', '0.4-4.0', 22], ['HBA', 'HbA1c', '%', '<5.7', 20], ['UEC', 'Creatinine (renal function)', 'umol/L', '60-110', 26], ['LFT', 'Alanine aminotransferase (ALT)', 'U/L', '7-56', 28], ['TRP', 'High-sensitivity troponin I', 'ng/L', '<14', 35], ['HGB', 'Haemoglobin', 'g/dL', '12.0-16.0', 12]];
  for (const t of tests) await db.query('INSERT INTO laboratory_tests(code,name,unit,reference_range,price) VALUES ($1,$2,$3,$4,$5)', t);
  const ranges: Record<number, [number, number]> = { 1: [3.2, 12.5], 2: [3.6, 9.8], 3: [3.1, 7.2], 4: [0.5, 40], 5: [0.2, 8.5], 6: [4.8, 10.2], 7: [48, 150], 8: [10, 90], 9: [2, 60], 10: [9.5, 16.5] };
  const labUser = (await db.query<{ id: number }>("SELECT id FROM users WHERE username='labtech.alvarez'")).rows[0].id;
  const techs = [await sid('LAB-001'), await sid('LAB-002')];
  for (let i = 0; i < 140; i++) {
    const ageH = Math.floor(r() * 24 * 10);
    const status = ageH < 6 ? pick(['Requested', 'In progress']) : ageH < 30 ? pick(['In progress', 'Resulted', 'Approved']) : pick(['Approved', 'Approved', 'Resulted']);
    const testId = 1 + Math.floor(r() * 10);
    const { rows } = await db.query<{ id: number }>('INSERT INTO laboratory_requests(patient_id,test_id,ordering_doctor_id,assigned_tech_id,status,requested_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [1 + Math.floor(r() * PATIENTS), testId, pick(doctorIds).id, status === 'Requested' ? null : pick(techs), status, naive(new Date(now.getTime() - ageH * 3600000))]);
    if (status === 'Resulted' || status === 'Approved') {
      const [lo, hi] = ranges[testId];
      await db.query('INSERT INTO laboratory_results(request_id,value,comment,approved,entered_by,entered_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [rows[0].id, (lo + r() * (hi - lo)).toFixed(1), 'SYNTHETIC RESULT - not for clinical use', status === 'Approved', labUser, naive(new Date(now.getTime() - Math.max(0, ageH - 2) * 3600000))]);
    }
  }

  // ---- pharmacy ----
  const meds: [string, string, string, string, number][] = [['AMX500', 'Amoxicillin', 'Capsule', '500 mg', 640], ['MET850', 'Metformin', 'Tablet', '850 mg', 900], ['ATO20', 'Atorvastatin', 'Tablet', '20 mg', 720], ['LIS10', 'Lisinopril', 'Tablet', '10 mg', 680], ['SAL100', 'Salbutamol inhaler', 'Inhaler', '100 mcg', 190], ['IBU400', 'Ibuprofen', 'Tablet', '400 mg', 1200], ['PAR500', 'Paracetamol', 'Tablet', '500 mg', 2000], ['OME20', 'Omeprazole', 'Capsule', '20 mg', 560], ['AMD5', 'Amlodipine', 'Tablet', '5 mg', 700], ['LEV50', 'Levothyroxine', 'Tablet', '50 mcg', 410], ['SER50', 'Sertraline', 'Tablet', '50 mg', 350], ['CET10', 'Cetirizine', 'Tablet', '10 mg', 800], ['MTP50', 'Metoprolol', 'Tablet', '50 mg', 520], ['WAR5', 'Warfarin', 'Tablet', '5 mg', 240], ['CLO75', 'Clopidogrel', 'Tablet', '75 mg', 330], ['AZI250', 'Azithromycin', 'Tablet', '250 mg', 270]];
  for (const m of meds) await db.query('INSERT INTO medications(code,name,form,strength,stock) VALUES ($1,$2,$3,$4,$5)', m);
  const dosages = ['1 tablet twice daily', '1 capsule three times daily', '2 puffs when required', '1 tablet at night', '1 tablet once daily in the morning', '1 tablet every 8 hours with food'];
  for (let i = 0; i < 90; i++) {
    const ageH = Math.floor(r() * 24 * 14);
    const disp = ageH < 8 ? 'Pending' : pick(['Pending', 'Dispensed', 'Dispensed', 'Dispensed', 'Partially dispensed']);
    const { rows } = await db.query<{ id: number }>('INSERT INTO prescriptions(patient_id,doctor_id,status,dispensing_status,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [1 + Math.floor(r() * PATIENTS), pick(doctorIds).id, disp === 'Dispensed' ? 'Completed' : 'Active', disp, 'Synthetic prescription - not a medical instruction', naive(new Date(now.getTime() - ageH * 3600000))]);
    for (let k = 0; k < 1 + Math.floor(r() * 3); k++)
      await db.query('INSERT INTO prescription_items(prescription_id,medication_id,quantity,dosage) VALUES ($1,$2,$3,$4)', [rows[0].id, 1 + ((i + k * 5) % meds.length), pick([10, 14, 20, 28, 30, 60]), pick(dosages)]);
  }

  // ---- billing ----
  const lineItems: [string, number, number][] = [['Outpatient consultation', 1, 120], ['Specialist consultation', 1, 220], ['Laboratory panel', 1, 85], ['Chest X-ray', 1, 140], ['Ultrasound scan', 1, 260], ['ECG', 1, 75], ['Inpatient bed (per day)', 3, 480], ['Medication supply', 1, 64], ['Minor procedure', 1, 340], ['Physiotherapy session', 4, 70]];
  for (let i = 1; i <= 110; i++) {
    const issued = dayAt(-Math.floor(r() * 75), 9);
    const { rows } = await db.query<{ id: number }>('INSERT INTO invoices(invoice_no,patient_id,status,issued_on,due_on,notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [`INV-${1000 + i}`, 1 + ((i * 7) % PATIENTS), 'Issued', ymd(issued), ymd(new Date(issued.getTime() + 30 * 86400000)), 'Synthetic invoice']);
    let total = 0;
    const n = 1 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) { const [d, q, p] = pick(lineItems); total += q * p; await db.query('INSERT INTO invoice_items(invoice_id,description,quantity,unit_price) VALUES ($1,$2,$3,$4)', [rows[0].id, d, q, p]); }
    const mode = i % 4;
    const paidAt = naive(new Date(issued.getTime() + Math.floor(r() * 10) * 86400000));
    if (mode === 0) { await db.query('INSERT INTO payments(invoice_id,amount,method,paid_at) VALUES ($1,$2,$3,$4)', [rows[0].id, total, pick(['Card (synthetic)', 'Bank transfer (synthetic)', 'Insurance claim (synthetic)']), paidAt]); await db.query("UPDATE invoices SET status='Paid' WHERE id=$1", [rows[0].id]); }
    else if (mode === 1) { await db.query('INSERT INTO payments(invoice_id,amount,method,paid_at) VALUES ($1,$2,$3,$4)', [rows[0].id, Math.round(total / 2), 'Card (synthetic)', paidAt]); await db.query("UPDATE invoices SET status='Partially paid' WHERE id=$1", [rows[0].id]); }
  }

  const cfg: [string, string, string][] = [
    ['hospital_name', 'MediCore Teaching Hospital (fictional)', 'Display name'],
    ['appointment_default_minutes', '30', 'Default appointment length'],
    ['currency', 'USD', 'Billing currency (synthetic)'],
  ];
  for (const c of cfg) await db.query('INSERT INTO system_config(key,value,description) VALUES ($1,$2,$3)', c);
  await db.query("INSERT INTO audit_events(user_id,action,entity,detail) VALUES (NULL,'seed','system','Synthetic dataset created')");
}

/** Insert assessment definitions from the manifest. Idempotent: existing rows (and their recorded results) are kept. */
export async function seedAssessment(db: Db, cfg: Pick<AppConfig, 'manifestPath'>): Promise<void> {
  const manifest = JSON.parse(fs.readFileSync(cfg.manifestPath, 'utf8'));
  const tcFile = JSON.parse(fs.readFileSync(cfg.manifestPath.replace('vulnerabilities.json', 'test-cases.json'), 'utf8'));
  let { rows } = await db.query<{ id: number }>('SELECT id FROM assessment_projects ORDER BY id LIMIT 1');
  if (!rows.length) {
    rows = (await db.query<{ id: number }>(
      "INSERT INTO assessment_projects(name,scope,app_version) VALUES ('MediCore HMS academic assessment','Local synthetic lab only: http://127.0.0.1:4000 and http://127.0.0.1:5173','1.0.0') RETURNING id",
    )).rows;
  }
  const pid = rows[0].id;
  for (const v of manifest.vulnerabilities) {
    await db.query(
      `INSERT INTO assessment_findings(id,project_id,title,category,affected_route,origin,status,description,remediation,refs)
       VALUES ($1,$2,$3,$4,$5,'intended','Not Tested',$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      [v.id, pid, v.title, v.category, v.affected_route, v.intended_weakness, v.remediation, `${v.cwe}; ${v.owasp_category}; ${v.remediation_reference}`],
    );
  }
  for (const t of tcFile.test_cases) {
    await db.query(
      `INSERT INTO assessment_test_cases(id,name,objective,preconditions,test_account,target_component,expected_result,finding_id,kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [t.id, t.name, t.objective, t.preconditions, t.test_account, t.target_component, t.expected_result, t.finding_id, t.kind],
    );
  }
}

export async function seedAll(db: Db, cfg: Pick<AppConfig, 'manifestPath'>): Promise<void> {
  await seedClinical(db);
  await seedAssessment(db, cfg);
}
