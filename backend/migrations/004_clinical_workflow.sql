-- MediCore HMS: clinical workflow, operations, patient portal and account security (synthetic data only)

-- ---------- account security & patient portal ----------
ALTER TABLE users
  ADD COLUMN patient_id int REFERENCES patients(id) ON DELETE SET NULL,
  ADD COLUMN totp_secret text,
  ADD COLUMN totp_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN totp_last_step bigint;
CREATE UNIQUE INDEX uq_users_patient ON users(patient_id) WHERE patient_id IS NOT NULL;

ALTER TABLE sessions
  ADD COLUMN ip text NOT NULL DEFAULT '',
  ADD COLUMN user_agent text NOT NULL DEFAULT '';

CREATE TABLE recovery_codes (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used boolean NOT NULL DEFAULT false
);
CREATE INDEX idx_recovery_user ON recovery_codes(user_id);

CREATE TABLE login_challenges (
  id text PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempts int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL
);

ALTER TABLE patients
  ADD COLUMN contact_preference text NOT NULL DEFAULT 'email' CHECK (contact_preference IN ('email','sms','both'));

-- ---------- ICD-10 reference data ----------
CREATE TABLE icd10_codes (
  code text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO icd10_codes(code, description) VALUES
 ('A09','Infectious gastroenteritis and colitis, unspecified'),
 ('A41.9','Sepsis, unspecified organism'),
 ('B34.9','Viral infection, unspecified'),
 ('D50.9','Iron deficiency anemia, unspecified'),
 ('D64.9','Anemia, unspecified'),
 ('E03.9','Hypothyroidism, unspecified'),
 ('E10.10','Type 1 diabetes mellitus with ketoacidosis without coma'),
 ('E10.9','Type 1 diabetes mellitus without complications'),
 ('E11.22','Type 2 diabetes mellitus with diabetic chronic kidney disease'),
 ('E11.65','Type 2 diabetes mellitus with hyperglycemia'),
 ('E11.9','Type 2 diabetes mellitus without complications'),
 ('E55.9','Vitamin D deficiency, unspecified'),
 ('E66.9','Obesity, unspecified'),
 ('E78.5','Hyperlipidemia, unspecified'),
 ('E86.0','Dehydration'),
 ('E87.6','Hypokalemia'),
 ('F32.9','Major depressive disorder, single episode, unspecified'),
 ('F41.1','Generalized anxiety disorder'),
 ('F41.9','Anxiety disorder, unspecified'),
 ('G40.909','Epilepsy, unspecified, not intractable, without status epilepticus'),
 ('G43.909','Migraine, unspecified, not intractable, without status migrainosus'),
 ('G47.00','Insomnia, unspecified'),
 ('H10.9','Unspecified conjunctivitis'),
 ('H66.90','Otitis media, unspecified, unspecified ear'),
 ('I10','Essential (primary) hypertension'),
 ('I11.9','Hypertensive heart disease without heart failure'),
 ('I20.9','Angina pectoris, unspecified'),
 ('I21.9','Acute myocardial infarction, unspecified'),
 ('I25.10','Atherosclerotic heart disease of native coronary artery without angina pectoris'),
 ('I26.99','Other pulmonary embolism without acute cor pulmonale'),
 ('I48.91','Unspecified atrial fibrillation'),
 ('I49.9','Cardiac arrhythmia, unspecified'),
 ('I50.9','Heart failure, unspecified'),
 ('I63.9','Cerebral infarction, unspecified'),
 ('J02.9','Acute pharyngitis, unspecified'),
 ('J03.90','Acute tonsillitis, unspecified'),
 ('J06.9','Acute upper respiratory infection, unspecified'),
 ('J18.9','Pneumonia, unspecified organism'),
 ('J20.9','Acute bronchitis, unspecified'),
 ('J30.9','Allergic rhinitis, unspecified'),
 ('J44.9','Chronic obstructive pulmonary disease, unspecified'),
 ('J45.909','Unspecified asthma, uncomplicated'),
 ('J96.00','Acute respiratory failure, unspecified whether with hypoxia or hypercapnia'),
 ('K21.9','Gastro-esophageal reflux disease without esophagitis'),
 ('K29.70','Gastritis, unspecified, without bleeding'),
 ('K35.80','Unspecified acute appendicitis'),
 ('K40.90','Unilateral inguinal hernia, without obstruction or gangrene, not specified as recurrent'),
 ('K52.9','Noninfective gastroenteritis and colitis, unspecified'),
 ('K59.00','Constipation, unspecified'),
 ('L03.90','Cellulitis, unspecified'),
 ('L30.9','Dermatitis, unspecified'),
 ('L50.9','Urticaria, unspecified'),
 ('M06.9','Rheumatoid arthritis, unspecified'),
 ('M10.9','Gout, unspecified'),
 ('M17.9','Osteoarthritis of knee, unspecified'),
 ('M25.50','Pain in unspecified joint'),
 ('M47.812','Spondylosis without myelopathy or radiculopathy, cervical region'),
 ('M54.50','Low back pain, unspecified'),
 ('M79.10','Myalgia, unspecified site'),
 ('M81.0','Age-related osteoporosis without current pathological fracture'),
 ('N18.9','Chronic kidney disease, unspecified'),
 ('N20.0','Calculus of kidney'),
 ('N39.0','Urinary tract infection, site not specified'),
 ('N40.1','Benign prostatic hyperplasia with lower urinary tract symptoms'),
 ('R00.0','Tachycardia, unspecified'),
 ('R03.0','Elevated blood-pressure reading, without diagnosis of hypertension'),
 ('R05.9','Cough, unspecified'),
 ('R06.02','Shortness of breath'),
 ('R07.89','Other chest pain'),
 ('R07.9','Chest pain, unspecified'),
 ('R10.9','Unspecified abdominal pain'),
 ('R11.2','Nausea with vomiting, unspecified'),
 ('R42','Dizziness and giddiness'),
 ('R50.9','Fever, unspecified'),
 ('R51.9','Headache, unspecified'),
 ('R53.83','Other fatigue'),
 ('R55','Syncope and collapse'),
 ('R56.9','Unspecified convulsions'),
 ('R73.09','Other abnormal glucose'),
 ('S06.0X0A','Concussion without loss of consciousness, initial encounter'),
 ('S62.90XA','Unspecified fracture of unspecified wrist and hand, initial encounter'),
 ('S82.90XA','Unspecified fracture of unspecified lower leg, initial encounter'),
 ('S93.401A','Sprain of unspecified ligament of right ankle, initial encounter'),
 ('T78.2XXA','Anaphylactic shock, unspecified, initial encounter'),
 ('T78.40XA','Allergy, unspecified, initial encounter'),
 ('U07.1','COVID-19'),
 ('Z00.00','Encounter for general adult medical examination without abnormal findings'),
 ('Z00.129','Encounter for routine child health examination without abnormal findings'),
 ('Z09','Encounter for follow-up examination after completed treatment for conditions other than malignant neoplasm'),
 ('Z23','Encounter for immunization'),
 ('Z79.4','Long term (current) use of insulin'),
 ('Z79.82','Long term (current) use of aspirin');

-- ---------- consultations ----------
CREATE TABLE consultations (
  id serial PRIMARY KEY,
  patient_id int NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id int NOT NULL REFERENCES staff(id),
  appointment_id int REFERENCES appointments(id) ON DELETE SET NULL,
  subjective text NOT NULL DEFAULT '',
  objective text NOT NULL DEFAULT '',
  assessment text NOT NULL DEFAULT '',
  plan text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Signed')),
  signed_at timestamptz,
  signed_by int REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'Signed') = (signed_at IS NOT NULL))
);
CREATE INDEX idx_consult_patient ON consultations(patient_id, created_at DESC);
CREATE INDEX idx_consult_doctor ON consultations(doctor_id);
CREATE UNIQUE INDEX uq_consult_appointment ON consultations(appointment_id) WHERE appointment_id IS NOT NULL;

CREATE TABLE consultation_diagnoses (
  id serial PRIMARY KEY,
  consultation_id int NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
  icd_code text NOT NULL REFERENCES icd10_codes(code),
  is_primary boolean NOT NULL DEFAULT false,
  UNIQUE (consultation_id, icd_code)
);
CREATE UNIQUE INDEX uq_consult_primary ON consultation_diagnoses(consultation_id) WHERE is_primary;

ALTER TABLE laboratory_requests ADD COLUMN consultation_id int REFERENCES consultations(id) ON DELETE SET NULL;
ALTER TABLE laboratory_tests ADD COLUMN critical_low numeric, ADD COLUMN critical_high numeric;

-- ---------- pharmacy: suppliers, inventory, prescribing checks, refills ----------
CREATE TABLE suppliers (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  contact_email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true
);
ALTER TABLE medications
  ADD COLUMN drug_class text NOT NULL DEFAULT '',
  ADD COLUMN max_daily_units int CHECK (max_daily_units IS NULL OR max_daily_units > 0),
  ADD COLUMN reorder_level int NOT NULL DEFAULT 100 CHECK (reorder_level >= 0),
  ADD COLUMN expiry_date date,
  ADD COLUMN supplier_id int REFERENCES suppliers(id) ON DELETE SET NULL,
  ADD COLUMN unit_cost numeric(10,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0);

CREATE TABLE drug_interactions (
  id serial PRIMARY KEY,
  medication_a int NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  medication_b int NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  severity text NOT NULL CHECK (severity IN ('Minor','Moderate','Major')),
  description text NOT NULL,
  CHECK (medication_a < medication_b),
  UNIQUE (medication_a, medication_b)
);

CREATE TABLE stock_movements (
  id bigserial PRIMARY KEY,
  medication_id int NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  delta int NOT NULL CHECK (delta <> 0),
  reason text NOT NULL CHECK (reason IN ('Receive','Dispense','Refill','Adjust','Expired')),
  note text NOT NULL DEFAULT '',
  user_id int REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_med ON stock_movements(medication_id, created_at DESC);

ALTER TABLE prescriptions
  ADD COLUMN consultation_id int REFERENCES consultations(id) ON DELETE SET NULL,
  ADD COLUMN refills_allowed int NOT NULL DEFAULT 0 CHECK (refills_allowed BETWEEN 0 AND 5),
  ADD COLUMN refills_used int NOT NULL DEFAULT 0,
  ADD COLUMN override_reason text NOT NULL DEFAULT '',
  ADD COLUMN last_dispensed_at timestamp,
  ADD CONSTRAINT rx_refills_ok CHECK (refills_used <= refills_allowed);
ALTER TABLE prescription_items
  ADD COLUMN units_per_dose int CHECK (units_per_dose IS NULL OR units_per_dose BETWEEN 1 AND 20),
  ADD COLUMN doses_per_day int CHECK (doses_per_day IS NULL OR doses_per_day BETWEEN 1 AND 12);

-- ---------- inpatient: MAR, discharge, triage ----------
CREATE TABLE mar_doses (
  id serial PRIMARY KEY,
  admission_id int NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  prescription_item_id int NOT NULL REFERENCES prescription_items(id) ON DELETE CASCADE,
  scheduled_at timestamp NOT NULL,
  status text NOT NULL DEFAULT 'Scheduled' CHECK (status IN ('Scheduled','Given','Held','Refused','Missed')),
  administered_at timestamp,
  administered_by int REFERENCES users(id) ON DELETE SET NULL,
  note text NOT NULL DEFAULT '',
  UNIQUE (admission_id, prescription_item_id, scheduled_at)
);
CREATE INDEX idx_mar_time ON mar_doses(scheduled_at);
CREATE INDEX idx_mar_adm ON mar_doses(admission_id);

CREATE TABLE discharge_summaries (
  id serial PRIMARY KEY,
  admission_id int NOT NULL UNIQUE REFERENCES admissions(id) ON DELETE CASCADE,
  diagnosis text NOT NULL DEFAULT '',
  hospital_course text NOT NULL DEFAULT '',
  discharge_medications text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  follow_up_appointment_id int REFERENCES appointments(id) ON DELETE SET NULL,
  created_by int REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE triage_entries (
  id serial PRIMARY KEY,
  patient_id int NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  complaint text NOT NULL,
  esi_level int NOT NULL CHECK (esi_level BETWEEN 1 AND 5),
  status text NOT NULL DEFAULT 'Waiting' CHECK (status IN ('Waiting','In treatment','Completed','Left without being seen')),
  arrived_at timestamp NOT NULL DEFAULT now(),
  started_at timestamp,
  completed_at timestamp,
  assigned_doctor_id int REFERENCES staff(id),
  triaged_by int REFERENCES users(id) ON DELETE SET NULL,
  heart_rate int,
  systolic int,
  spo2 int,
  notes text NOT NULL DEFAULT ''
);
CREATE INDEX idx_triage_queue ON triage_entries(status, esi_level, arrived_at);
CREATE UNIQUE INDEX uq_triage_active_patient ON triage_entries(patient_id) WHERE status IN ('Waiting','In treatment');

-- ---------- notifications & outbox ----------
CREATE TABLE notifications (
  id bigserial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','critical')),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  link text NOT NULL DEFAULT '',
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX idx_notif_user ON notifications(user_id, created_at DESC);
CREATE UNIQUE INDEX uq_notif_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE outbox_messages (
  id bigserial PRIMARY KEY,
  channel text NOT NULL CHECK (channel IN ('email','sms')),
  recipient text NOT NULL,
  subject text NOT NULL DEFAULT '',
  body text NOT NULL,
  kind text NOT NULL,
  related_id int,
  patient_id int REFERENCES patients(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_outbox_at ON outbox_messages(created_at DESC);
ALTER TABLE appointments ADD COLUMN reminder_sent_at timestamptz;

-- ---------- staffing: shifts and leave ----------
CREATE TABLE staff_shifts (
  id serial PRIMARY KEY,
  staff_id int NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  weekday int NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time time NOT NULL,
  CHECK (end_time > start_time),
  UNIQUE (staff_id, weekday, start_time)
);
CREATE TABLE staff_leave (
  id serial PRIMARY KEY,
  staff_id int NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  end_date date NOT NULL,
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
  requested_by int REFERENCES users(id) ON DELETE SET NULL,
  decided_by int REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX idx_leave_staff ON staff_leave(staff_id, start_date);

-- ---------- billing: refunds (negative payments) and insurance claims ----------
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_amount_check;
ALTER TABLE payments
  ADD COLUMN kind text NOT NULL DEFAULT 'Payment' CHECK (kind IN ('Payment','Refund')),
  ADD COLUMN refund_of int REFERENCES payments(id) ON DELETE SET NULL,
  ADD COLUMN reason text NOT NULL DEFAULT '',
  ADD COLUMN created_by int REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT payments_amount_sign CHECK ((kind = 'Payment' AND amount > 0) OR (kind = 'Refund' AND amount < 0));

CREATE TABLE insurance_claims (
  id serial PRIMARY KEY,
  invoice_id int NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  provider text NOT NULL,
  policy_no text NOT NULL,
  amount_claimed numeric(10,2) NOT NULL CHECK (amount_claimed > 0),
  amount_approved numeric(10,2) CHECK (amount_approved IS NULL OR amount_approved >= 0),
  status text NOT NULL DEFAULT 'Submitted' CHECK (status IN ('Submitted','Approved','Partially approved','Rejected')),
  note text NOT NULL DEFAULT '',
  submitted_by int REFERENCES users(id) ON DELETE SET NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_by int REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  payment_id int REFERENCES payments(id) ON DELETE SET NULL
);
CREATE INDEX idx_claims_invoice ON insurance_claims(invoice_id);
CREATE UNIQUE INDEX uq_claim_open ON insurance_claims(invoice_id) WHERE status = 'Submitted';
