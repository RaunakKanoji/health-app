# Schema and data dictionary

SQL migrations are authoritative. The typed entry point is `packages/db/src/schema.ts`, with modules under `packages/db/src/schema/`. Existing text identifiers and records remain intact; additive longitudinal tables use UUID primary keys.

There are 55 application tables after migration 0006: 39 original, four Clerk identity/access tables and 12 additions. `schema_migrations` is the separate migration ledger. All new clinical tables include organization/patient scope, synthetic marking and timezone-aware creation/update timestamps. No new clinical-history foreign key uses cascading deletion.

## Existing tables reused

| Domain | Tables | Meaning |
| --- | --- | --- |
| Tenancy/identity | `organizations`, `users`, `organization_memberships`, `role_assignments`, `sessions` | Preserved local identities and legacy records; Clerk now authenticates requests |
| Patient profiles | `patients`, `patient_identifiers`, `patient_contacts`, `patient_consents` | Demographics, source identifiers and ordered consent history |
| Clerk and access | `clinician_profiles`, `clinician_patient_relationships`, `clerk_webhook_deliveries`, `clerk_identity_tombstones` | Approval, explicit care relationships, webhook deduplication and deleted identity protection |
| Source/policy | `clinical_policies`, `policy_versions`, `fhir_resources`, `screening_results`, `observations` | Versioned synthetic sources, coded measurements and policy references |
| Episode coordination | `care_episodes`, `episode_events`, `episode_owners`, `episode_tasks`, `clinical_reviews` | Workflow projection and normalized actions |
| Referral attendance | `referrals`, `referral_events`, `appointments`, `encounters` | Provider hand-offs and recorded attendance |
| Communication | `communications`, `message_attempts`, `acknowledgements` | Simulated contact and distinct patient acknowledgement |
| Closure evidence | `clinical_documents`, `evidence_records`, `closure_decisions` | Text evidence, clinical verification and immutable closure attestations |
| Reliability/access | `audit_events`, `access_grants`, `inbox_events`, `outbox_events`, `workflow_executions` | Audit, explicitly shared episodes, inbound/outbound work and idempotency |
| Existing AI/evaluation | `model_registry`, `risk_predictions`, `ai_recommendations`, `model_evaluations`, `scenario_runs` | Operational synthetic research, deterministic episode responses and scenario execution |

## Added tables

| Table | Main columns | Integrity/lifecycle |
| --- | --- | --- |
| `consultations` | patient, clinician, encounter type, chief complaint, scheduled/started/completed times | `scheduled`, `in_progress`, `completed`, `cancelled`; completed timestamp consistency |
| `clinical_notes` | consultation, author, type, content, signed time, revision, superseded-note ID | Draft/signed; signed records immutable; same-consultation revision chain |
| `medical_documents` | uploader, document type, original filename, private provider/key, MIME, bytes, SHA-256 | Pending/ready/failed; metadata only; API upload limit 500 KB |
| `lab_orders` | consultation, ordering clinician, test name/code, timestamps | Ordered/completed/cancelled |
| `lab_reports` | optional order/document, laboratory, report date, processing/review state | Same-patient links; explicit reviewer and timestamp |
| `lab_results` | report, test name/code, numeric or text value, unit, reference range/text, source page, extraction status, correction reference | PostgreSQL `numeric`; exactly one value type; immutable records and explicit corrections |
| `ai_analyses` | consultation, provider/model/version, input-context hash, structured output, review state | Pending review/reviewed/rejected/superseded; immutable payload |
| `ai_findings` | analysis, finding text/type, severity, optional confidence, review | Separate model possibilities from clinical decisions; review provenance |
| `ai_analysis_sources` | analysis and exactly one consultation/report/document/observation reference, source version | Same-patient composite foreign keys; immutable source references |
| `treatment_plans` | consultation, clinical author, title/description, dates, approving clinician/time | Draft/approved/completed/cancelled; approval required for approved/completed |
| `followups` | consultation, clinician, due/scheduled/completed times, reason | Pending/scheduled/completed/cancelled with timestamp constraints |
| `clinical_record_commands` | actor, patient, idempotency key, fingerprint, stored response | Unique organization/actor/key; repeat request returns original result |

## Constraints and indexes

Composite organization/patient foreign keys prevent links to another patient's consultation, report, document or analysis. Unique active-care relationship constraints are retained from 0005. New indexes support patient chronology, clinician workload, report review queues, source links and command replay. Original immutable episode/audit/closure triggers remain in place.

Measurements preserve source units and reference ranges. JSONB remains appropriate for original structured FHIR values and versioned analysis output; it is not the sole longitudinal patient-record store. General conditions, allergies, medication/prescription and notification tables are deferred and do not appear in this schema.
