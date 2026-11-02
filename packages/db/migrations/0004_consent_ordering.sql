-- Recorded ordering is separate from simulated/source event time, including ties.
ALTER TABLE patient_consents ADD COLUMN sequence bigserial UNIQUE NOT NULL;
CREATE INDEX patient_consent_current_idx ON patient_consents(organization_id,patient_id,purpose,sequence DESC);
