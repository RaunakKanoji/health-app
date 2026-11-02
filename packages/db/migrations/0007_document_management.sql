-- Additive managed-document lifecycle. Existing document objects and identifiers remain unchanged.
ALTER TABLE medical_documents DROP CONSTRAINT medical_documents_file_size_check;
ALTER TABLE medical_documents ADD CONSTRAINT medical_documents_file_size_check CHECK(file_size>0 AND file_size<=15728640);
ALTER TABLE medical_documents
 ADD COLUMN title text NOT NULL DEFAULT '', ADD COLUMN description text NOT NULL DEFAULT '',
 ADD COLUMN tags text[] NOT NULL DEFAULT '{}', ADD COLUMN document_date date,
 ADD COLUMN healthcare_provider_name text NOT NULL DEFAULT '', ADD COLUMN encounter_id uuid,
 ADD COLUMN source_type text NOT NULL DEFAULT 'patient_upload' CHECK(source_type IN ('patient_upload','doctor_upload','external_import','system_generated')),
 ADD COLUMN storage_bucket text NOT NULL DEFAULT '', ADD COLUMN detected_mime_type text,
 ADD COLUMN mdms_managed boolean NOT NULL DEFAULT false, ADD COLUMN current_version_id uuid,
 ADD COLUMN security_status text NOT NULL DEFAULT 'awaiting_scan' CHECK(security_status IN ('awaiting_scan','safe','infected','unavailable')),
 ADD COLUMN processing_stage text NOT NULL DEFAULT 'legacy' CHECK(processing_stage IN ('uploading','security_checks','extracting','awaiting_review','reviewed','failed','unavailable','cancelled','legacy')),
 ADD COLUMN clinical_review_status text NOT NULL DEFAULT 'pending_review' CHECK(clinical_review_status IN ('pending_review','in_review','approved','corrections_required','rejected')),
 ADD COLUMN search_text text NOT NULL DEFAULT '', ADD COLUMN deleted_at timestamptz,
 ADD FOREIGN KEY(organization_id,patient_id,encounter_id) REFERENCES consultations(organization_id,patient_id,id);
UPDATE medical_documents SET title=original_filename;
ALTER TABLE medical_documents ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple',coalesce(title,'')||' '||coalesce(description,'')||' '||coalesce(document_type,'')||' '||coalesce(healthcare_provider_name,'')||' '||coalesce(search_text,''))) STORED;
CREATE INDEX medical_documents_search_idx ON medical_documents USING gin(search_vector);
CREATE INDEX medical_documents_filter_idx ON medical_documents(organization_id,patient_id,document_type,document_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX medical_documents_review_idx ON medical_documents(organization_id,patient_id,clinical_review_status) WHERE deleted_at IS NULL;
CREATE INDEX medical_documents_encounter_idx ON medical_documents(encounter_id);

CREATE TABLE document_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id text NOT NULL,patient_id text NOT NULL,document_id uuid NOT NULL,
 version_number integer NOT NULL CHECK(version_number>0),storage_provider text NOT NULL,storage_bucket text NOT NULL,storage_key text NOT NULL,
 checksum_sha256 text NOT NULL CHECK(checksum_sha256 ~ '^[0-9a-f]{64}$'),file_size bigint NOT NULL CHECK(file_size>0 AND file_size<=15728640),mime_type text NOT NULL,
 created_by text NOT NULL,change_reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(document_id,version_number),UNIQUE(storage_provider,storage_key),UNIQUE(organization_id,patient_id,document_id,id),
 FOREIGN KEY(organization_id,patient_id,document_id) REFERENCES medical_documents(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,created_by) REFERENCES users(organization_id,id)
);
CREATE TRIGGER document_versions_immutable BEFORE UPDATE OR DELETE ON document_versions FOR EACH ROW EXECUTE FUNCTION deny_immutable_mutation();
ALTER TABLE medical_documents ADD FOREIGN KEY(organization_id,patient_id,id,current_version_id) REFERENCES document_versions(organization_id,patient_id,document_id,id);

CREATE TABLE document_upload_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id text NOT NULL,patient_id text NOT NULL,document_id uuid NOT NULL,
 version_id uuid NOT NULL,version_number integer NOT NULL CHECK(version_number>0),created_by text NOT NULL,
 storage_provider text NOT NULL,storage_bucket text NOT NULL,staging_key text NOT NULL,final_storage_key text NOT NULL,
 filename text NOT NULL,mime_type text NOT NULL,declared_size bigint NOT NULL CHECK(declared_size>0 AND declared_size<=15728640),declared_checksum text,
 change_reason text NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','cancelled','expired')),
 expires_at timestamptz NOT NULL,completed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(document_id,version_number),UNIQUE(storage_provider,staging_key),UNIQUE(storage_provider,final_storage_key),
 FOREIGN KEY(organization_id,patient_id,document_id) REFERENCES medical_documents(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,created_by) REFERENCES users(organization_id,id),
 CHECK(declared_checksum IS NULL OR declared_checksum ~ '^[0-9a-f]{64}$')
);
CREATE INDEX document_upload_expiry_idx ON document_upload_sessions(status,expires_at);

CREATE TABLE document_processing_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id text NOT NULL,patient_id text NOT NULL,document_id uuid NOT NULL,document_version_id uuid NOT NULL,
 processing_type text NOT NULL DEFAULT 'extract',status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed','retry_pending','cancelled')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 10),
 provider text,provider_job_id text,lease_token uuid,lease_expires_at timestamptz,available_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,completed_at timestamptz,
 failure_code text,sanitized_failure_message text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(document_version_id,processing_type),
 FOREIGN KEY(organization_id,patient_id,document_id,document_version_id) REFERENCES document_versions(organization_id,patient_id,document_id,id)
);
CREATE INDEX document_jobs_claim_idx ON document_processing_jobs(status,available_at,lease_expires_at);
CREATE INDEX document_jobs_patient_idx ON document_processing_jobs(organization_id,patient_id,document_id);

CREATE TABLE document_extractions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id text NOT NULL,patient_id text NOT NULL,document_id uuid NOT NULL,document_version_id uuid NOT NULL,
 extraction_version integer NOT NULL DEFAULT 1 CHECK(extraction_version>0),extractor_name text NOT NULL,extractor_model_version text NOT NULL,
 detected_document_type text,detected_language text,extracted_text_reference text,structured_output jsonb NOT NULL CHECK(jsonb_typeof(structured_output)='object'),
 extraction_confidence numeric CHECK(extraction_confidence BETWEEN 0 AND 1),extraction_status text NOT NULL CHECK(extraction_status IN ('completed','partial','manual_review_required')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(document_version_id,extraction_version),UNIQUE(organization_id,patient_id,document_id,document_version_id,id),
 FOREIGN KEY(organization_id,patient_id,document_id,document_version_id) REFERENCES document_versions(organization_id,patient_id,document_id,id)
);
CREATE TRIGGER document_extractions_immutable BEFORE UPDATE OR DELETE ON document_extractions FOR EACH ROW EXECUTE FUNCTION deny_immutable_mutation();

CREATE TABLE clinical_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id text NOT NULL,patient_id text NOT NULL,document_id uuid NOT NULL,document_version_id uuid NOT NULL,encounter_id uuid,extraction_id uuid NOT NULL,
 source_index integer NOT NULL CHECK(source_index>=0),test_name text NOT NULL,standardized_code text,original_value text NOT NULL,numeric_value numeric,text_value text,original_unit text,unit text,normalized_unit text,
 reference_range_low numeric,reference_range_high numeric,reference_range_text text,result_flag text,specimen_type text,method text,observed_at date,
 source_page integer CHECK(source_page>0),source_location jsonb,source_text text NOT NULL,original_source jsonb NOT NULL DEFAULT '{}',confidence numeric CHECK(confidence BETWEEN 0 AND 1),validation_warnings jsonb NOT NULL DEFAULT '[]',
 verification_status text NOT NULL DEFAULT 'unverified' CHECK(verification_status IN ('unverified','verified','rejected','unable_to_verify')),
 verified_by text,verified_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(extraction_id,source_index),UNIQUE(organization_id,patient_id,document_id,id),
 FOREIGN KEY(organization_id,patient_id,document_id,document_version_id,extraction_id) REFERENCES document_extractions(organization_id,patient_id,document_id,document_version_id,id),
 FOREIGN KEY(organization_id,patient_id,encounter_id) REFERENCES consultations(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,verified_by) REFERENCES users(organization_id,id),
 CHECK(num_nonnulls(numeric_value,text_value)<=1),CHECK(reference_range_low IS NULL OR reference_range_high IS NULL OR reference_range_low<=reference_range_high),
 CHECK((verification_status='verified')=(verified_by IS NOT NULL AND verified_at IS NOT NULL)),CHECK(jsonb_typeof(validation_warnings)='array')
);
CREATE INDEX clinical_observations_patient_idx ON clinical_observations(organization_id,patient_id,verification_status,observed_at);
CREATE FUNCTION protect_document_observation_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'document_observation_history_is_retained'; END IF;
 IF (to_jsonb(NEW)-ARRAY['test_name','numeric_value','text_value','unit','reference_range_low','reference_range_high','reference_range_text','observed_at','verification_status','verified_by','verified_at','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['test_name','numeric_value','text_value','unit','reference_range_low','reference_range_high','reference_range_text','observed_at','verification_status','verified_by','verified_at','updated_at']) THEN RAISE EXCEPTION 'document_observation_source_is_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER clinical_observations_source_guard BEFORE UPDATE OR DELETE ON clinical_observations FOR EACH ROW EXECUTE FUNCTION protect_document_observation_source();

CREATE TABLE document_observation_corrections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id text NOT NULL,patient_id text NOT NULL,document_id uuid NOT NULL,observation_id uuid NOT NULL,
 actor_id text NOT NULL,reason text NOT NULL,before_value jsonb NOT NULL,after_value jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,patient_id,document_id,observation_id) REFERENCES clinical_observations(organization_id,patient_id,document_id,id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id)
);
CREATE TRIGGER document_observation_corrections_immutable BEFORE UPDATE OR DELETE ON document_observation_corrections FOR EACH ROW EXECUTE FUNCTION deny_immutable_mutation();

CREATE TABLE clinical_document_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id text NOT NULL,patient_id text NOT NULL,document_id uuid NOT NULL,document_version_id uuid NOT NULL,
 reviewer_id text NOT NULL,status text NOT NULL CHECK(status IN ('pending_review','in_review','approved','corrections_required','rejected')),review_notes text NOT NULL,reviewed_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,patient_id,document_id,document_version_id) REFERENCES document_versions(organization_id,patient_id,document_id,id),
 FOREIGN KEY(organization_id,reviewer_id) REFERENCES users(organization_id,id)
);
CREATE INDEX clinical_document_reviews_document_idx ON clinical_document_reviews(document_id,created_at DESC);
CREATE TRIGGER clinical_document_reviews_immutable BEFORE UPDATE OR DELETE ON clinical_document_reviews FOR EACH ROW EXECUTE FUNCTION deny_immutable_mutation();

CREATE TABLE document_timeline_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id text NOT NULL,patient_id text NOT NULL,document_id uuid NOT NULL,document_version_id uuid,
 event_type text NOT NULL,event_key text NOT NULL UNIQUE,actor_id text,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,patient_id,document_id) REFERENCES medical_documents(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,patient_id,document_id,document_version_id) REFERENCES document_versions(organization_id,patient_id,document_id,id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id)
);
CREATE INDEX document_timeline_patient_idx ON document_timeline_events(organization_id,patient_id,created_at DESC);
CREATE TRIGGER document_timeline_events_immutable BEFORE UPDATE OR DELETE ON document_timeline_events FOR EACH ROW EXECUTE FUNCTION deny_immutable_mutation();

CREATE TABLE document_security_checks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id text NOT NULL,patient_id text NOT NULL,document_id uuid NOT NULL,document_version_id uuid NOT NULL,
 provider text NOT NULL,verdict text NOT NULL CHECK(verdict IN ('safe','infected')),checksum_sha256 text NOT NULL CHECK(checksum_sha256 ~ '^[0-9a-f]{64}$'),scanned_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,patient_id,document_id,document_version_id) REFERENCES document_versions(organization_id,patient_id,document_id,id)
);
CREATE INDEX document_security_checks_version_idx ON document_security_checks(document_version_id,verdict);
CREATE TRIGGER document_security_checks_immutable BEFORE UPDATE OR DELETE ON document_security_checks FOR EACH ROW EXECUTE FUNCTION deny_immutable_mutation();
