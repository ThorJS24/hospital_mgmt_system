-- Assessment data model: kept separate from clinical tables, no foreign keys into them.
CREATE TABLE assessment_projects (
  id serial PRIMARY KEY,
  name text NOT NULL,
  scope text NOT NULL DEFAULT '',
  app_version text NOT NULL DEFAULT '',
  started_on date NOT NULL DEFAULT current_date
);

CREATE TABLE assessment_findings (
  id text PRIMARY KEY,
  project_id int NOT NULL REFERENCES assessment_projects(id),
  title text NOT NULL,
  category text NOT NULL,
  affected_route text NOT NULL DEFAULT '',
  origin text NOT NULL DEFAULT 'intended' CHECK (origin IN ('intended','accidental','third-party','scanner')),
  status text NOT NULL DEFAULT 'Not Tested' CHECK (status IN
    ('Planned','Not Tested','Under Assessment','Confirmed','False Positive','Not Reproduced',
     'Remediation Proposed','Remediated','Retest Passed','Retest Failed')),
  severity text CHECK (severity IN ('Critical','High','Medium','Low','Informational')),
  cvss_version text NOT NULL DEFAULT '4.0',
  cvss_score numeric(3,1) CHECK (cvss_score BETWEEN 0 AND 10),
  cvss_vector text,
  confidence text CHECK (confidence IN ('High','Medium','Low')),
  likelihood text,
  business_impact text,
  description text NOT NULL DEFAULT '',
  technical_details text NOT NULL DEFAULT '',
  verification_steps text NOT NULL DEFAULT '',
  expected_behavior text NOT NULL DEFAULT '',
  observed_behavior text NOT NULL DEFAULT '',
  impact text NOT NULL DEFAULT '',
  root_cause text NOT NULL DEFAULT '',
  remediation text NOT NULL DEFAULT '',
  refs text NOT NULL DEFAULT '',
  decision_note text NOT NULL DEFAULT '',
  created_by int,
  updated_by int,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((cvss_score IS NULL) = (cvss_vector IS NULL))
);

CREATE TABLE assessment_finding_history (
  id serial PRIMARY KEY,
  finding_id text NOT NULL REFERENCES assessment_findings(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  note text NOT NULL DEFAULT '',
  by_user int,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assessment_test_cases (
  id text PRIMARY KEY,
  name text NOT NULL,
  objective text NOT NULL,
  preconditions text NOT NULL DEFAULT '',
  test_account text NOT NULL DEFAULT '',
  target_component text NOT NULL DEFAULT '',
  expected_result text NOT NULL,
  finding_id text REFERENCES assessment_findings(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'security-control' CHECK (kind IN ('security-control','expected-vulnerability'))
);

CREATE TABLE assessment_evidence (
  id text PRIMARY KEY,
  finding_id text NOT NULL REFERENCES assessment_findings(id) ON DELETE CASCADE,
  evidence_type text NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),
  route text NOT NULL DEFAULT '',
  http_method text,
  http_status int,
  request_meta text NOT NULL DEFAULT '',
  response_meta text NOT NULL DEFAULT '',
  screenshot_ref text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  file_name text,
  sha256 text,
  created_by int
);

CREATE TABLE assessment_results (
  id serial PRIMARY KEY,
  test_case_id text NOT NULL REFERENCES assessment_test_cases(id) ON DELETE CASCADE,
  actual_result text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','pass','fail','reproduced','not-reproduced')),
  evidence_id text REFERENCES assessment_evidence(id) ON DELETE SET NULL,
  notes text NOT NULL DEFAULT '',
  tested_by int,
  tested_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_results_case ON assessment_results(test_case_id);

CREATE TABLE remediation_records (
  id serial PRIMARY KEY,
  finding_id text NOT NULL REFERENCES assessment_findings(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('Proposed','Implemented','Retest Passed','Retest Failed')),
  notes text NOT NULL DEFAULT '',
  by_user int,
  at timestamptz NOT NULL DEFAULT now()
);
