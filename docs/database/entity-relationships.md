# Entity relationships

This diagram shows implemented patient-care relationships. Auxiliary policy, messaging, integration and evaluation tables are listed in the [dictionary](schema.md). The two document/encounter families intentionally serve different workflows.

```mermaid
erDiagram
  organizations ||--o{ users : contains
  organizations ||--o{ patients : scopes
  users o|--o| patients : patient_identity
  users ||--o| clinician_profiles : profile
  users ||--o{ clinician_patient_relationships : care_team
  patients ||--o{ clinician_patient_relationships : authorized_care
  patients ||--o{ care_episodes : coordination
  care_episodes ||--o{ referrals : handoff
  referrals ||--o{ appointments : scheduled
  appointments ||--o| encounters : attendance
  care_episodes ||--o{ clinical_documents : text_evidence
  clinical_documents ||--o{ evidence_records : verification
  care_episodes ||--o{ closure_decisions : attestation
  patients ||--o{ observations : measurements
  patients ||--o{ consultations : clinical_visits
  users ||--o{ consultations : clinician
  consultations ||--o{ clinical_notes : documentation
  clinical_notes o|--o| clinical_notes : supersedes
  consultations o|--o{ lab_orders : investigations
  patients ||--o{ medical_documents : private_files
  lab_orders o|--o{ lab_reports : reports
  medical_documents o|--o{ lab_reports : source_document
  lab_reports ||--o{ lab_results : measurements
  lab_results o|--o| lab_results : corrects
  patients ||--o{ ai_analyses : analyses
  consultations o|--o{ ai_analyses : context
  ai_analyses ||--o{ ai_findings : draft_findings
  ai_analyses ||--o{ ai_analysis_sources : provenance
  lab_reports o|--o{ ai_analysis_sources : report_source
  medical_documents o|--o{ ai_analysis_sources : document_source
  observations o|--o{ ai_analysis_sources : observation_source
  consultations o|--o{ ai_analysis_sources : consultation_source
  patients ||--o{ treatment_plans : plans
  consultations o|--o{ treatment_plans : plan_context
  patients ||--o{ followups : followup
  consultations o|--o{ followups : visit_context
  patients ||--o{ clinical_record_commands : replay_ledger
  users ||--o{ clinical_record_commands : authorizes
  users ||--o{ audit_events : audited_action
```

`users.clerk_user_id` is the unique external identity link. The Clerk directory is external; medical data stays in PostgreSQL/private object storage. New longitudinal links use composite foreign keys to enforce organization and patient agreement. The legacy `users.patient_id` association remains application-managed; this migration does not add a foreign key or uniqueness constraint to that existing column. No diagram edge implies cascade deletion or automatic clinical authorization.
