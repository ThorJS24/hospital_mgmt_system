-- MediCore HMS core schema (synthetic data only)
CREATE TABLE roles (
  id serial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL
);
CREATE TABLE permissions (
  id serial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT ''
);
CREATE TABLE role_permissions (
  role_id int NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id int NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE departments (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  services text NOT NULL DEFAULT ''
);

CREATE TABLE staff (
  id serial PRIMARY KEY,
  staff_code text NOT NULL UNIQUE,
  full_name text NOT NULL,
  job_title text NOT NULL,
  department_id int REFERENCES departments(id),
  email text NOT NULL,
  availability text NOT NULL DEFAULT 'Available' CHECK (availability IN ('Available','In Surgery','On Leave','Off Duty')),
  schedule text NOT NULL DEFAULT 'Mon-Fri 08:00-16:00',
  active boolean NOT NULL DEFAULT true
);
CREATE INDEX idx_staff_department ON staff(department_id);

CREATE TABLE users (
  id serial PRIMARY KEY,
  username text NOT NULL UNIQUE,
  email text NOT NULL,
  full_name text NOT NULL,
  password_hash text NOT NULL,
  role_id int NOT NULL REFERENCES roles(id),
  staff_id int REFERENCES staff(id),
  active boolean NOT NULL DEFAULT true,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id int REFERENCES users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE reset_tokens (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  used boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE patients (
  id serial PRIMARY KEY,
  mrn text NOT NULL UNIQUE,
  first_name text NOT NULL,
  last_name text NOT NULL,
  dob date NOT NULL,
  sex text NOT NULL CHECK (sex IN ('Female','Male','Other')),
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive','Deceased')),
  primary_doctor_id int REFERENCES staff(id),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_patients_name ON patients(last_name, first_name);
CREATE INDEX idx_patients_doctor ON patients(primary_doctor_id);

CREATE TABLE patient_contacts (
  id serial PRIMARY KEY,
  patient_id int NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  name text NOT NULL,
  relationship text NOT NULL,
  phone text NOT NULL
);
CREATE TABLE patient_allergies (
  id serial PRIMARY KEY,
  patient_id int NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  allergen text NOT NULL,
  reaction text NOT NULL DEFAULT '',
  severity text NOT NULL DEFAULT 'Mild' CHECK (severity IN ('Mild','Moderate','Severe'))
);
CREATE TABLE medical_histories (
  id serial PRIMARY KEY,
  patient_id int NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  condition text NOT NULL,
  diagnosed_on date,
  notes text NOT NULL DEFAULT ''
);
CREATE TABLE patient_documents (
  id serial PRIMARY KEY,
  patient_id int NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  filename text NOT NULL,
  stored_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes int NOT NULL,
  uploaded_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE appointments (
  id serial PRIMARY KEY,
  patient_id int NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id int NOT NULL REFERENCES staff(id),
  department_id int NOT NULL REFERENCES departments(id),
  scheduled_at timestamp NOT NULL,
  duration_min int NOT NULL DEFAULT 30 CHECK (duration_min BETWEEN 5 AND 240),
  status text NOT NULL DEFAULT 'Scheduled'
    CHECK (status IN ('Scheduled','Confirmed','Checked in','In consultation','Completed','Cancelled','No-show')),
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_appt_time ON appointments(scheduled_at);
CREATE INDEX idx_appt_patient ON appointments(patient_id);
CREATE INDEX idx_appt_doctor ON appointments(doctor_id);

CREATE TABLE wards (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  department_id int REFERENCES departments(id)
);
CREATE TABLE beds (
  id serial PRIMARY KEY,
  ward_id int NOT NULL REFERENCES wards(id) ON DELETE CASCADE,
  label text NOT NULL,
  UNIQUE (ward_id, label)
);
CREATE TABLE admissions (
  id serial PRIMARY KEY,
  patient_id int NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  bed_id int NOT NULL REFERENCES beds(id),
  doctor_id int NOT NULL REFERENCES staff(id),
  admitted_at timestamp NOT NULL,
  discharged_at timestamp,
  status text NOT NULL DEFAULT 'Admitted' CHECK (status IN ('Admitted','Discharged')),
  reason text NOT NULL DEFAULT '',
  CHECK ((status = 'Discharged') = (discharged_at IS NOT NULL))
);
-- two active admissions cannot occupy the same bed, nor one patient admitted twice
CREATE UNIQUE INDEX uq_active_bed ON admissions(bed_id) WHERE status = 'Admitted';
CREATE UNIQUE INDEX uq_active_patient ON admissions(patient_id) WHERE status = 'Admitted';

CREATE TABLE laboratory_tests (
  id serial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  unit text NOT NULL DEFAULT '',
  reference_range text NOT NULL DEFAULT '',
  price numeric(10,2) NOT NULL
);
CREATE TABLE laboratory_requests (
  id serial PRIMARY KEY,
  patient_id int NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  test_id int NOT NULL REFERENCES laboratory_tests(id),
  ordering_doctor_id int NOT NULL REFERENCES staff(id),
  assigned_tech_id int REFERENCES staff(id),
  status text NOT NULL DEFAULT 'Requested' CHECK (status IN ('Requested','In progress','Resulted','Approved','Cancelled')),
  requested_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX idx_labreq_patient ON laboratory_requests(patient_id);
CREATE TABLE laboratory_results (
  id serial PRIMARY KEY,
  request_id int NOT NULL UNIQUE REFERENCES laboratory_requests(id) ON DELETE CASCADE,
  value text NOT NULL,
  comment text NOT NULL DEFAULT '',
  approved boolean NOT NULL DEFAULT false,
  entered_by int REFERENCES users(id),
  entered_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE medications (
  id serial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  form text NOT NULL,
  strength text NOT NULL,
  stock int NOT NULL DEFAULT 0 CHECK (stock >= 0)
);
CREATE TABLE prescriptions (
  id serial PRIMARY KEY,
  patient_id int NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id int NOT NULL REFERENCES staff(id),
  status text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Completed','Cancelled')),
  dispensing_status text NOT NULL DEFAULT 'Pending' CHECK (dispensing_status IN ('Pending','Dispensed','Partially dispensed')),
  notes text NOT NULL DEFAULT '',
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX idx_rx_patient ON prescriptions(patient_id);
CREATE TABLE prescription_items (
  id serial PRIMARY KEY,
  prescription_id int NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  medication_id int NOT NULL REFERENCES medications(id),
  quantity int NOT NULL CHECK (quantity > 0),
  dosage text NOT NULL
);

CREATE TABLE invoices (
  id serial PRIMARY KEY,
  invoice_no text NOT NULL UNIQUE,
  patient_id int NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'Issued' CHECK (status IN ('Draft','Issued','Partially paid','Paid','Cancelled')),
  issued_on date NOT NULL,
  due_on date NOT NULL,
  notes text NOT NULL DEFAULT ''
);
CREATE INDEX idx_invoice_patient ON invoices(patient_id);
CREATE TABLE invoice_items (
  id serial PRIMARY KEY,
  invoice_id int NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description text NOT NULL,
  quantity int NOT NULL CHECK (quantity > 0),
  unit_price numeric(10,2) NOT NULL CHECK (unit_price >= 0)
);
CREATE TABLE payments (
  id serial PRIMARY KEY,
  invoice_id int NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  method text NOT NULL DEFAULT 'Synthetic transfer',
  paid_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_id int,
  action text NOT NULL,
  entity text NOT NULL DEFAULT '',
  entity_id text NOT NULL DEFAULT '',
  detail text NOT NULL DEFAULT '',
  request_id text NOT NULL DEFAULT ''
);
CREATE INDEX idx_audit_at ON audit_events(at DESC);

CREATE TABLE system_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  description text NOT NULL DEFAULT ''
);
