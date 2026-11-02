ALTER TABLE referrals ADD COLUMN IF NOT EXISTS result_revision integer NOT NULL DEFAULT 1;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS result_revision integer NOT NULL DEFAULT 1;
ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS result_revision integer NOT NULL DEFAULT 1;
ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS appointment_id text REFERENCES appointments(id);
CREATE INDEX IF NOT EXISTS evidence_episode_revision_idx ON evidence_records(episode_id,result_revision);
