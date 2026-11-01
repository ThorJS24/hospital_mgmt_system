-- Extended synthetic patient data: identifiers, insurance, procedures, vitals, stored payment methods.
-- ALL values are fabricated: SSNs use the never-issued 9xx area range, cards are public payment-processor test numbers.
ALTER TABLE patients
  ADD COLUMN ssn text,
  ADD COLUMN drivers_license text,
  ADD COLUMN blood_type text,
  ADD COLUMN marital_status text,
  ADD COLUMN insurance_provider text,
  ADD COLUMN insurance_policy_no text,
  ADD COLUMN insurance_group_no text;

CREATE TABLE patient_payment_methods (
  id serial PRIMARY KEY,
  patient_id int NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  card_brand text NOT NULL,
  card_number text NOT NULL,
  card_expiry text NOT NULL,
  card_holder text NOT NULL
);

CREATE TABLE medical_procedures (
  id serial PRIMARY KEY,
  patient_id int NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id int NOT NULL REFERENCES staff(id),
  code text NOT NULL,
  name text NOT NULL,
  performed_on date NOT NULL,
  cost numeric(10,2) NOT NULL CHECK (cost >= 0),
  outcome text NOT NULL DEFAULT 'Successful'
);
CREATE INDEX idx_proc_patient ON medical_procedures(patient_id);

CREATE TABLE patient_vitals (
  id serial PRIMARY KEY,
  patient_id int NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  recorded_at timestamp NOT NULL,
  systolic int NOT NULL,
  diastolic int NOT NULL,
  heart_rate int NOT NULL,
  temperature_c numeric(4,1) NOT NULL,
  spo2 int NOT NULL,
  weight_kg numeric(5,1) NOT NULL
);
CREATE INDEX idx_vitals_patient ON patient_vitals(patient_id, recorded_at DESC);
