-- Add Clerk identity without changing any existing user IDs or clinical records.
ALTER TABLE users ADD COLUMN clerk_user_id text UNIQUE;
ALTER TABLE users ADD COLUMN account_status text NOT NULL DEFAULT 'active' CHECK(account_status IN ('active','suspended','deleted'));
ALTER TABLE users ADD COLUMN onboarding_completed boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN clerk_updated_at bigint NOT NULL DEFAULT 0;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE clinician_profiles (
  user_id text PRIMARY KEY REFERENCES users(id),
  professional_name text NOT NULL,
  specialty text NOT NULL,
  registration_identifier text NOT NULL,
  institution text NOT NULL DEFAULT '',
  verification_status text NOT NULL DEFAULT 'pending' CHECK(verification_status IN ('pending','approved','rejected')),
  review_reason text,
  approved_at timestamptz,
  approved_by text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clinician_patient_relationships (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  clinician_id text NOT NULL REFERENCES users(id),
  patient_id text NOT NULL REFERENCES patients(id),
  relationship_status text NOT NULL DEFAULT 'active' CHECK(relationship_status IN ('active','revoked')),
  authorization_basis text NOT NULL,
  authorized_by text NOT NULL REFERENCES users(id),
  authorized_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(clinician_id,patient_id),
  FOREIGN KEY(organization_id,clinician_id) REFERENCES users(organization_id,id),
  FOREIGN KEY(organization_id,patient_id) REFERENCES patients(organization_id,id),
  FOREIGN KEY(organization_id,authorized_by) REFERENCES users(organization_id,id),
  CHECK((relationship_status='active' AND revoked_at IS NULL) OR (relationship_status='revoked' AND revoked_at IS NOT NULL))
);
CREATE INDEX care_team_active_idx ON clinician_patient_relationships(clinician_id,patient_id) WHERE relationship_status='active';

-- Minimal delivery metadata only: no identity payloads, tokens or clinical text.
CREATE TABLE clerk_webhook_deliveries (
  delivery_id text PRIMARY KEY,
  event_type text NOT NULL,
  clerk_user_id text NOT NULL,
  event_timestamp bigint NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
-- A deletion arriving before creation must still prevent later resurrection.
CREATE TABLE clerk_identity_tombstones (
  clerk_user_id text PRIMARY KEY,
  deleted_at bigint NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
