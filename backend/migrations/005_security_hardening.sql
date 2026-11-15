-- MediCore HMS: password lifecycle and audit-trail hardening

-- accounts: remember when the password last changed, and let administrators require a change at next sign-in
ALTER TABLE users
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN password_changed_at timestamptz NOT NULL DEFAULT now();

-- the last few password hashes per user, so recent passwords cannot be reused (hashes only, never plain text)
CREATE TABLE password_history (
  id bigserial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pwhist_user ON password_history(user_id, id DESC);

-- audit trail: record where the request came from, and make the table append-only at the database level
ALTER TABLE audit_events ADD COLUMN ip text NOT NULL DEFAULT '';

CREATE FUNCTION audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% is not permitted)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
