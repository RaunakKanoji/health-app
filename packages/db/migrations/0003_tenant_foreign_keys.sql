ALTER TABLE users ADD CONSTRAINT users_org_id_unique UNIQUE(organization_id,id);
ALTER TABLE screening_results ADD CONSTRAINT results_org_id_unique UNIQUE(organization_id,id);
ALTER TABLE care_episodes ADD CONSTRAINT episodes_org_id_unique UNIQUE(organization_id,id);
ALTER TABLE referrals ADD CONSTRAINT referrals_org_id_unique UNIQUE(organization_id,id);
ALTER TABLE appointments ADD CONSTRAINT appointments_org_id_unique UNIQUE(organization_id,id);
ALTER TABLE clinical_documents ADD CONSTRAINT documents_org_id_unique UNIQUE(organization_id,id);
ALTER TABLE communications ADD CONSTRAINT communications_org_id_unique UNIQUE(organization_id,id);
ALTER TABLE care_episodes ADD CONSTRAINT episode_patient_scope FOREIGN KEY(organization_id,patient_id) REFERENCES patients(organization_id,id);
ALTER TABLE care_episodes ADD CONSTRAINT episode_result_scope FOREIGN KEY(organization_id,result_id) REFERENCES screening_results(organization_id,id);
ALTER TABLE care_episodes ADD CONSTRAINT episode_owner_scope FOREIGN KEY(organization_id,owner_id) REFERENCES users(organization_id,id);
ALTER TABLE screening_results ADD CONSTRAINT result_patient_scope FOREIGN KEY(organization_id,patient_id) REFERENCES patients(organization_id,id);
ALTER TABLE observations ADD CONSTRAINT observation_patient_scope FOREIGN KEY(organization_id,patient_id) REFERENCES patients(organization_id,id);
ALTER TABLE patient_identifiers ADD CONSTRAINT identifier_patient_scope FOREIGN KEY(organization_id,patient_id) REFERENCES patients(organization_id,id);
ALTER TABLE patient_contacts ADD CONSTRAINT contact_patient_scope FOREIGN KEY(organization_id,patient_id) REFERENCES patients(organization_id,id);
ALTER TABLE patient_consents ADD CONSTRAINT consent_patient_scope FOREIGN KEY(organization_id,patient_id) REFERENCES patients(organization_id,id);
ALTER TABLE appointments ADD CONSTRAINT appointment_referral_scope FOREIGN KEY(organization_id,referral_id) REFERENCES referrals(organization_id,id);
ALTER TABLE encounters ADD CONSTRAINT encounter_appointment_scope FOREIGN KEY(organization_id,appointment_id) REFERENCES appointments(organization_id,id);
ALTER TABLE evidence_records ADD CONSTRAINT evidence_document_scope FOREIGN KEY(organization_id,document_id) REFERENCES clinical_documents(organization_id,id);
ALTER TABLE evidence_records ADD CONSTRAINT evidence_appointment_scope FOREIGN KEY(organization_id,appointment_id) REFERENCES appointments(organization_id,id);
ALTER TABLE message_attempts ADD CONSTRAINT attempt_message_scope FOREIGN KEY(organization_id,communication_id) REFERENCES communications(organization_id,id);
DO $$ DECLARE child text; BEGIN
 FOREACH child IN ARRAY ARRAY['episode_events','episode_owners','episode_tasks','clinical_reviews','referrals','appointments','encounters','communications','acknowledgements','clinical_documents','evidence_records','closure_decisions','access_grants','outbox_events','risk_predictions','ai_recommendations'] LOOP
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY(organization_id,episode_id) REFERENCES care_episodes(organization_id,id)',child,child||'_episode_scope');
 END LOOP;
END $$;
