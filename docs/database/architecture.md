# Architecture and implementation audit

## Existing architecture retained

The pnpm monorepo contains Next.js web, Fastify API and a PostgreSQL-backed worker. `packages/db/src/index.ts` owns bounded `pg.Pool` connections, typed Drizzle access and interactive transactions. Existing services also use parameterized SQL. The API and worker use `DATABASE_RUNTIME_URL` for the restricted application role; CLI-managed owner settings remain available only for explicit administrative commands. No HTTP-only database driver, new application or second ORM was introduced.

`packages/config/src/database.ts` validates the runtime/direct target and explicit remote environment. Remote connections require TLS; the client enforces certificate and hostname verification. Remote API/worker startup verifies migration checksums and pending migrations, without running migration or seed writes. Existing local synthetic bootstrap remains available.

Writes run through the existing identity boundary, then a patient authorization check, a transaction, domain validation and an audit record. Clinical commands use a fingerprinted idempotency ledger. Clinical data and credentials are never imported into browser database clients. Next.js proxies authenticated API requests; the browser receives selected response fields.

## Audit before implementation

The repository already had 39 core tables, four Clerk tables, five checked SQL migrations, a migration ledger and working persisted episode workflows. The inspected local preview had migrations 0001–0005 applied and 16 episodes; it was not empty. Initially no CareLoop Neon target was configured. The user subsequently selected the existing `health-app` project (`sweet-water-84984366`) and its `production` branch. That target was inspected as empty before transfer. After explicit approval, the transfer preserved 715 rows across all 43 existing application tables, including 16 episodes, 17 patients and 23 users. Per-table hashes matched before destination commit; the source was read-only and remained unchanged. Migrations 0001–0006 are now applied on the selected target.

Existing `patients`, `observations`, users, profiles, grants, audit events and webhook ledgers were reused. The prior `encounters` table records attendance at a referred appointment; new `consultations` represent clinical visits without changing that meaning. Existing `clinical_documents` retain text evidence for episode closure; new `medical_documents` hold private object metadata.

Earlier `docs/application-audit/` reports predate the Clerk migration. Their custom-session and broad patient-disclosure descriptions must not be treated as current architecture.

## Page integration map

| Existing page/view | Persistence | Added integration |
| --- | --- | --- |
| Staff overview, episode/review queues | `/api/workspace`, scoped `care_episodes` and normalized facts | Retained |
| Episode detail | Existing action endpoint, event history and closure evidence | Clinical records tab: consultation/note, laboratory, analysis, treatment and follow-up forms/read views |
| New screening result dialog | `/api/fhir/ingest` | Authorized patient directory independent of existing episodes |
| Patient My care | Own-patient episodes, appointments and approved explanations | Consultation, treatment and follow-up summaries, including patients without an episode |
| Patient My results | Reviewed screening explanations | Released clinical notes, reports, measurements and reviewed analyses |
| Patient privacy | Patient consent and language | Retained |
| Provider hand-offs/local inbox | Referrals, grants, communications/outbox | Retained; delivery remains simulated |
| Population health | Derived metrics from authorized persisted episodes | Retained; synthetic reporting |
| Policies & audit | Static demonstration policy definitions plus SQL audit events | Retained |
| Demonstration lab | Scenario definitions and persisted scenario runs | Retained; executing scenarios writes data |
| Onboarding/admin/account | Clerk plus local profiles/roles/relationships | Retained |

The clinical panel extends existing views; no duplicate dashboard or consultation route was created. Core workspace rows are persisted synthetic data, not frontend mock records. Static policy text, scenario definitions and local deterministic summaries remain explicitly demonstration content.

## Deliberate boundaries

Medical files use Neon private Object Storage through the S3-compatible adapter and PostgreSQL metadata. The original explicit S3 credential configuration remains supported. `neon.ts` declares the private `careloop-medical-documents` bucket. Missing storage configuration disables file transfer; it does not fall back to public URLs or database blobs. No external AI transmission, clinical diagnosis engine, prescribing system or live messaging was added. See [status](implementation-status.md).

## Environment separation and runtime access

The selected production branch serves the local application through `careloop_runtime`. A development branch was created while the parent was still empty, isolating later test fixtures from production. Its real HTTP/database/object-storage probe passed. A staging branch exists without compute; schema/deployment verification there remains pending.

The runtime role has SELECT on 56 tables (including the migration ledger), INSERT on 49 reviewed tables, UPDATE on 19 reviewed tables, a narrow `clinical_notes.id` UPDATE privilege needed for row locking, and DELETE only on `role_assignments`. Verification rejected schema creation, clinical-history deletion, migration-ledger insertion and elevated role flags. Application patient authorization remains mandatory; these database privileges do not replace it.
