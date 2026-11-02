-- Additive synthetic longitudinal care. Existing coordination and Clerk records are preserved.
ALTER TABLE observations ADD CONSTRAINT observations_patient_identity_unique UNIQUE(organization_id,patient_id,id);

CREATE TABLE consultations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id text NOT NULL, patient_id text NOT NULL,
 clinician_id text NOT NULL, status text NOT NULL DEFAULT 'in_progress' CHECK(status IN ('scheduled','in_progress','completed','cancelled')),
 encounter_type text NOT NULL, chief_complaint text NOT NULL,
 scheduled_at timestamptz, started_at timestamptz, completed_at timestamptz,
 synthetic boolean NOT NULL DEFAULT true CHECK(synthetic), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,patient_id) REFERENCES patients(organization_id,id),
 FOREIGN KEY(organization_id,clinician_id) REFERENCES users(organization_id,id),
 CHECK((status='completed')=(completed_at IS NOT NULL)),
 CHECK(completed_at IS NULL OR started_at IS NULL OR completed_at>=started_at)
);
CREATE INDEX consultations_patient_time_idx ON consultations(organization_id,patient_id,created_at DESC,id);
CREATE INDEX consultations_clinician_status_idx ON consultations(organization_id,clinician_id,status,scheduled_at);

CREATE TABLE clinical_notes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id text NOT NULL, patient_id text NOT NULL,
 consultation_id uuid NOT NULL, author_id text NOT NULL, note_type text NOT NULL, content text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','signed')), signed_at timestamptz,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), supersedes_note_id uuid UNIQUE,
 synthetic boolean NOT NULL DEFAULT true CHECK(synthetic), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,patient_id,id), UNIQUE(organization_id,patient_id,consultation_id,id),
 FOREIGN KEY(organization_id,patient_id) REFERENCES patients(organization_id,id),
 FOREIGN KEY(organization_id,consultation_id,patient_id) REFERENCES consultations(organization_id,id,patient_id),
 FOREIGN KEY(organization_id,author_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,patient_id,consultation_id,supersedes_note_id) REFERENCES clinical_notes(organization_id,patient_id,consultation_id,id),
 CHECK((status='signed')=(signed_at IS NOT NULL)),
 CHECK((revision=1 AND supersedes_note_id IS NULL) OR (revision>1 AND supersedes_note_id IS NOT NULL)),
 CHECK(id IS DISTINCT FROM supersedes_note_id)
);
CREATE INDEX clinical_notes_consultation_idx ON clinical_notes(organization_id,patient_id,consultation_id,created_at DESC);
CREATE FUNCTION protect_clinical_note() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_revision integer;
BEGIN
 IF TG_OP<>'INSERT' AND OLD.status='signed' THEN RAISE EXCEPTION 'signed_note_is_immutable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.supersedes_note_id IS NOT NULL THEN
  SELECT revision INTO previous_revision FROM clinical_notes WHERE id=NEW.supersedes_note_id AND status='signed';
  IF previous_revision IS NULL OR NEW.revision<>previous_revision+1 THEN RAISE EXCEPTION 'invalid_note_revision'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER clinical_notes_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON clinical_notes FOR EACH ROW EXECUTE FUNCTION protect_clinical_note();

CREATE TABLE medical_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id text NOT NULL, patient_id text NOT NULL,
 uploaded_by text NOT NULL, document_type text NOT NULL, original_filename text NOT NULL,
 storage_provider text NOT NULL, storage_key text NOT NULL, mime_type text NOT NULL CHECK(mime_type IN ('application/pdf','image/png','image/jpeg','text/plain')),
 file_size bigint NOT NULL CHECK(file_size>0 AND file_size<=10485760), checksum text NOT NULL CHECK(checksum ~ '^[0-9a-f]{64}$'),
 processing_status text NOT NULL DEFAULT 'pending' CHECK(processing_status IN ('pending','ready','failed')),
 synthetic boolean NOT NULL DEFAULT true CHECK(synthetic), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,patient_id,id), UNIQUE(storage_provider,storage_key),
 FOREIGN KEY(organization_id,patient_id) REFERENCES patients(organization_id,id),
 FOREIGN KEY(organization_id,uploaded_by) REFERENCES users(organization_id,id)
);
CREATE INDEX medical_documents_patient_time_idx ON medical_documents(organization_id,patient_id,created_at DESC,id);

CREATE TABLE lab_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id text NOT NULL, patient_id text NOT NULL,
 consultation_id uuid, ordered_by text NOT NULL, test_name text NOT NULL, test_code text,
 status text NOT NULL DEFAULT 'ordered' CHECK(status IN ('ordered','completed','cancelled')),
 ordered_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 synthetic boolean NOT NULL DEFAULT true CHECK(synthetic), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,patient_id) REFERENCES patients(organization_id,id),
 FOREIGN KEY(organization_id,patient_id,consultation_id) REFERENCES consultations(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,ordered_by) REFERENCES users(organization_id,id),
 CHECK((status='completed')=(completed_at IS NOT NULL))
);
CREATE INDEX lab_orders_patient_time_idx ON lab_orders(organization_id,patient_id,created_at DESC,id);
CREATE INDEX lab_orders_consultation_idx ON lab_orders(consultation_id);

CREATE TABLE lab_reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id text NOT NULL, patient_id text NOT NULL,
 lab_order_id uuid, document_id uuid, created_by text NOT NULL, laboratory_name text NOT NULL, report_date date NOT NULL,
 processing_status text NOT NULL DEFAULT 'pending' CHECK(processing_status IN ('pending','processed','failed')),
 review_status text NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','reviewed','rejected')),
 reviewed_by text, reviewed_at timestamptz,
 synthetic boolean NOT NULL DEFAULT true CHECK(synthetic), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,patient_id) REFERENCES patients(organization_id,id),
 FOREIGN KEY(organization_id,patient_id,lab_order_id) REFERENCES lab_orders(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,patient_id,document_id) REFERENCES medical_documents(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,created_by) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,reviewed_by) REFERENCES users(organization_id,id),
 CHECK((review_status='pending' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR (review_status<>'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX lab_reports_patient_time_idx ON lab_reports(organization_id,patient_id,report_date DESC,id);
CREATE INDEX lab_reports_order_idx ON lab_reports(lab_order_id);
CREATE INDEX lab_reports_document_idx ON lab_reports(document_id);
CREATE INDEX lab_reports_review_queue_idx ON lab_reports(organization_id,review_status,created_at);

CREATE TABLE lab_results (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id text NOT NULL, patient_id text NOT NULL,
 lab_report_id uuid NOT NULL, recorded_by text NOT NULL, test_name text NOT NULL, test_code text,
 numeric_value numeric, text_value text, unit text, reference_low numeric, reference_high numeric, reference_text text, abnormal_flag text,
 collected_at timestamptz, resulted_at timestamptz, source_page integer CHECK(source_page>0),
 extraction_status text NOT NULL DEFAULT 'manual' CHECK(extraction_status IN ('manual','ai_extracted','imported','verified')),
 replaces_result_id uuid UNIQUE, verified_by text, verified_at timestamptz,
 synthetic boolean NOT NULL DEFAULT true CHECK(synthetic), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,patient_id,id), UNIQUE(organization_id,patient_id,lab_report_id,id),
 FOREIGN KEY(organization_id,patient_id) REFERENCES patients(organization_id,id),
 FOREIGN KEY(organization_id,patient_id,lab_report_id) REFERENCES lab_reports(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,recorded_by) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,verified_by) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,patient_id,lab_report_id,replaces_result_id) REFERENCES lab_results(organization_id,patient_id,lab_report_id,id),
 CHECK(num_nonnulls(numeric_value,text_value)=1), CHECK(text_value IS NULL OR length(btrim(text_value))>0),
 CHECK(reference_low IS NULL OR reference_high IS NULL OR reference_low<=reference_high),
 CHECK(numeric_value IS NULL OR numeric_value NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
 CHECK(reference_low IS NULL OR reference_low NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
 CHECK(reference_high IS NULL OR reference_high NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
 CHECK((extraction_status='verified' AND verified_by IS NOT NULL AND verified_at IS NOT NULL) OR (extraction_status<>'verified' AND verified_by IS NULL AND verified_at IS NULL)),
 CHECK(id IS DISTINCT FROM replaces_result_id)
);
CREATE INDEX lab_results_report_idx ON lab_results(organization_id,patient_id,lab_report_id,created_at,id);
CREATE TRIGGER lab_results_immutable BEFORE UPDATE OR DELETE ON lab_results FOR EACH ROW EXECUTE FUNCTION deny_immutable_mutation();

CREATE TABLE ai_analyses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id text NOT NULL, patient_id text NOT NULL,
 consultation_id uuid, created_by text NOT NULL, analysis_type text NOT NULL,
 model_provider text NOT NULL, model_identifier text NOT NULL, model_version text NOT NULL, input_context_version text NOT NULL,
 structured_output jsonb NOT NULL CHECK(jsonb_typeof(structured_output)='object'),
 status text NOT NULL DEFAULT 'pending_review' CHECK(status IN ('pending_review','reviewed','rejected','superseded')),
 reviewed_by text, reviewed_at timestamptz, supersedes_analysis_id uuid UNIQUE,
 synthetic boolean NOT NULL DEFAULT true CHECK(synthetic), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,patient_id) REFERENCES patients(organization_id,id),
 FOREIGN KEY(organization_id,patient_id,consultation_id) REFERENCES consultations(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,patient_id,supersedes_analysis_id) REFERENCES ai_analyses(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,created_by) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,reviewed_by) REFERENCES users(organization_id,id),
 CHECK((reviewed_by IS NULL)=(reviewed_at IS NULL)),
 CHECK(status NOT IN ('reviewed','rejected') OR reviewed_by IS NOT NULL),
 CHECK(status<>'pending_review' OR reviewed_by IS NULL),
 CHECK(id IS DISTINCT FROM supersedes_analysis_id)
);
CREATE INDEX ai_analyses_patient_time_idx ON ai_analyses(organization_id,patient_id,created_at DESC,id);
CREATE INDEX ai_analyses_consultation_idx ON ai_analyses(consultation_id);
CREATE FUNCTION protect_ai_analysis() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'analysis_history_is_immutable'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','reviewed_by','reviewed_at','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','reviewed_by','reviewed_at','updated_at']) THEN RAISE EXCEPTION 'analysis_payload_is_immutable'; END IF;
 IF OLD.status<>'pending_review' AND (NEW.status<>'superseded' OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at) THEN RAISE EXCEPTION 'analysis_review_is_final'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_analysis_history_guard BEFORE UPDATE OR DELETE ON ai_analyses FOR EACH ROW EXECUTE FUNCTION protect_ai_analysis();

CREATE TABLE ai_findings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id text NOT NULL, patient_id text NOT NULL,
 analysis_id uuid NOT NULL, finding_type text NOT NULL, finding_text text NOT NULL,
 severity text NOT NULL DEFAULT 'info' CHECK(severity IN ('info','low','moderate','high')),
 confidence numeric CHECK(confidence>=0 AND confidence<=1),
 review_status text NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','accepted','rejected')),
 reviewed_by text, reviewed_at timestamptz,
 synthetic boolean NOT NULL DEFAULT true CHECK(synthetic), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,patient_id) REFERENCES patients(organization_id,id),
 FOREIGN KEY(organization_id,patient_id,analysis_id) REFERENCES ai_analyses(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,reviewed_by) REFERENCES users(organization_id,id),
 CHECK((review_status='pending' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR (review_status<>'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX ai_findings_analysis_idx ON ai_findings(organization_id,patient_id,analysis_id);

CREATE TABLE ai_analysis_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id text NOT NULL, patient_id text NOT NULL,
 analysis_id uuid NOT NULL, consultation_id uuid, lab_report_id uuid, document_id uuid, observation_id text,
 source_version text NOT NULL CHECK(length(btrim(source_version))>0),
 synthetic boolean NOT NULL DEFAULT true CHECK(synthetic), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,patient_id) REFERENCES patients(organization_id,id),
 FOREIGN KEY(organization_id,patient_id,analysis_id) REFERENCES ai_analyses(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,patient_id,consultation_id) REFERENCES consultations(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,patient_id,lab_report_id) REFERENCES lab_reports(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,patient_id,document_id) REFERENCES medical_documents(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,patient_id,observation_id) REFERENCES observations(organization_id,patient_id,id),
 CHECK(num_nonnulls(consultation_id,lab_report_id,document_id,observation_id)=1)
);
CREATE UNIQUE INDEX ai_sources_consultation_unique ON ai_analysis_sources(analysis_id,consultation_id) WHERE consultation_id IS NOT NULL;
CREATE UNIQUE INDEX ai_sources_report_unique ON ai_analysis_sources(analysis_id,lab_report_id) WHERE lab_report_id IS NOT NULL;
CREATE UNIQUE INDEX ai_sources_document_unique ON ai_analysis_sources(analysis_id,document_id) WHERE document_id IS NOT NULL;
CREATE UNIQUE INDEX ai_sources_observation_unique ON ai_analysis_sources(analysis_id,observation_id) WHERE observation_id IS NOT NULL;
CREATE INDEX ai_sources_patient_analysis_idx ON ai_analysis_sources(organization_id,patient_id,analysis_id);
CREATE TRIGGER ai_analysis_sources_immutable BEFORE UPDATE OR DELETE ON ai_analysis_sources FOR EACH ROW EXECUTE FUNCTION deny_immutable_mutation();
CREATE FUNCTION protect_analysis_children() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE analysis_status text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'analysis_history_is_immutable'; END IF;
 SELECT status INTO analysis_status FROM ai_analyses WHERE id=NEW.analysis_id FOR SHARE;
 IF analysis_status<>'pending_review' THEN RAISE EXCEPTION 'analysis_review_is_final'; END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['review_status','reviewed_by','reviewed_at','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['review_status','reviewed_by','reviewed_at','updated_at']) THEN RAISE EXCEPTION 'finding_payload_is_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_findings_history_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_findings FOR EACH ROW EXECUTE FUNCTION protect_analysis_children();
CREATE TRIGGER ai_sources_review_guard BEFORE INSERT ON ai_analysis_sources FOR EACH ROW EXECUTE FUNCTION protect_analysis_children();

CREATE TABLE treatment_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id text NOT NULL, patient_id text NOT NULL,
 consultation_id uuid, clinician_id text NOT NULL, title text NOT NULL, description text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','completed','cancelled')),
 start_date date, end_date date, approved_by text, approved_at timestamptz,
 synthetic boolean NOT NULL DEFAULT true CHECK(synthetic), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,patient_id) REFERENCES patients(organization_id,id),
 FOREIGN KEY(organization_id,patient_id,consultation_id) REFERENCES consultations(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,clinician_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,approved_by) REFERENCES users(organization_id,id),
 CHECK((approved_by IS NULL)=(approved_at IS NULL)),
 CHECK(status NOT IN ('approved','completed') OR approved_by IS NOT NULL),
 CHECK(status<>'draft' OR approved_by IS NULL),
 CHECK(start_date IS NULL OR end_date IS NULL OR start_date<=end_date)
);
CREATE INDEX treatment_plans_patient_status_idx ON treatment_plans(organization_id,patient_id,status,created_at DESC,id);
CREATE INDEX treatment_plans_consultation_idx ON treatment_plans(consultation_id);

CREATE TABLE followups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id text NOT NULL, patient_id text NOT NULL,
 consultation_id uuid, clinician_id text NOT NULL, due_at timestamptz NOT NULL, scheduled_at timestamptz,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','scheduled','completed','cancelled')), reason text NOT NULL, completed_at timestamptz,
 synthetic boolean NOT NULL DEFAULT true CHECK(synthetic), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,patient_id) REFERENCES patients(organization_id,id),
 FOREIGN KEY(organization_id,patient_id,consultation_id) REFERENCES consultations(organization_id,patient_id,id),
 FOREIGN KEY(organization_id,clinician_id) REFERENCES users(organization_id,id),
 CHECK((status='completed')=(completed_at IS NOT NULL)), CHECK(status<>'scheduled' OR scheduled_at IS NOT NULL)
);
CREATE INDEX followups_patient_due_idx ON followups(organization_id,patient_id,due_at,id);
CREATE INDEX followups_clinician_status_idx ON followups(organization_id,clinician_id,status,due_at);
CREATE INDEX followups_consultation_idx ON followups(consultation_id);

CREATE TABLE clinical_record_commands (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id text NOT NULL, patient_id text NOT NULL, actor_id text NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200), fingerprint text NOT NULL, response jsonb NOT NULL,
 synthetic boolean NOT NULL DEFAULT true CHECK(synthetic), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,patient_id,id), UNIQUE(organization_id,actor_id,idempotency_key),
 FOREIGN KEY(organization_id,patient_id) REFERENCES patients(organization_id,id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id)
);
CREATE INDEX clinical_commands_patient_idx ON clinical_record_commands(organization_id,patient_id,created_at);
