# Medical document delivery and verification — 2026-11-02

## Existing architecture preserved

The prototype remains a pnpm workspace with Next.js/React, a Fastify API, a Node worker, Clerk identity, Neon PostgreSQL through `pg`/Drizzle, checksummed SQL migrations, and private object storage. Existing care relationships, consent rules, patient IDs, clinical workflows, and unfinished Hindi work were retained. No second application or identity directory was added.

## Delivered implementation

- Integrated patient/clinician document workspace: direct upload queue, metadata, search/tags/filters/counts, preview, versions, correction/review, timeline, and compatible verified trends.
- Private R2/Neon/S3 adapters, signed MIME/length-bound staging uploads, actual-byte verification, separately sealed final objects, short downloads and immutable version checksums.
- Durable database jobs with leases, bounded retries, authorization/version/deletion rechecks, scanner quarantine, native PDF extraction, provisional observations and original-source provenance.
- ClamD, Google Document AI and MedGemma adapters; optional model-selected exact-source summaries. Missing providers produce explicit unavailable states.
- Clinician verification and approval, immutable correction/review history, approved clinical-context measurements, and a small FHIR R4 mapping boundary.
- Soft removal/restoration and retained originals; no destructive retention purge.

## Primary files

| Area | Files |
| --- | --- |
| Migration/schema | `packages/db/migrations/0007_document_management.sql`, `packages/db/src/schema/documents.ts`, `packages/db/src/schema/longitudinal.ts` |
| Shared contracts | `packages/contracts/src/documents.ts` |
| API | `apps/api/src/document-management.ts`, `apps/api/src/app.ts`, legacy guards in `apps/api/src/documents.ts` |
| Services | `packages/workflows/src/documents/{service,storage,processing,scanner,extraction}.ts`, `pdf-worker.mjs` |
| Clinical integration | `packages/workflows/src/clinical-records.ts`, `packages/workflows/src/medical-documents.ts`, `packages/fhir/src/documents.ts`, `apps/worker/src/index.ts` |
| UI | `apps/web/src/components/documents/`, `patient-clinical-records.tsx`, `apps/web/src/lib/document-api.ts` |
| Operations | `scripts/grant-document-runtime.ts`, `scripts/provision-runtime-database.ts`, `scripts/verify-document-development.ts`, `.env.example` |
| Tests/fixtures | `tests/integration/document-*.test.ts`, `tests/unit/document-*.test.ts`, `tests/fixtures/medical-documents/` |

New dependencies are `pdfjs-dist` for real PDF parsing/rendering and `google-auth-library` for Google ADC. AWS SDK v3 and its S3 presigner were already installed and are reused.

Migration 0007 adds nine tables and extends the existing document table. It was tested in disposable local schemas, applied to the isolated Neon development branch, then applied transactionally to the configured production branch. Fingerprints over every pre-existing column and row matched before/after for **715 records across 55 existing tables**, including empty tables. Original migrations 0001–0006 were unchanged. Runtime grants were extended without rotating credentials or granting DDL/DELETE.

## Evidence

The following implementation run included three separate, unfinished Hindi tests in the local workspace. Publication validation uses the selected document-management snapshot and is recorded separately below.

```text
pnpm test
Test Files  30 passed (30)
Tests       276 passed (276)

pnpm typecheck
$ tsc --noEmit && pnpm --filter @careloop/web typecheck
$ tsc --noEmit
exit 0

pnpm lint
$ eslint .
exit 0

npm run build
✓ Compiled successfully
✓ Generating static pages using 7 workers (9/9)
Tasks: 1 successful, 1 total
exit 0

GET http://127.0.0.1:4001/api/health
{"status":"ok"}
GET http://127.0.0.1:3001/api/health
{"status":"ok"}
```

The restricted-role test exercises upload → sealing → real native-PDF processing → correction/approval → verified read/download → removal/restoration using the exact reviewed runtime grants. DELETE, immutable-source UPDATE, CREATE TABLE and ALTER TABLE are denied with PostgreSQL `42501`. Temporary roles/grants/fixtures are rolled back and absence of the role is asserted.

The real-component browser harness passed **24 checks**: PDF worker/canvas, page/zoom/fullscreen, evidence jumps, image preview, historical versions, metadata, clinician correction/review, quarantine, multiple-file queue behavior, XHR progress/cancel/retry, drag/drop, filters, keyboard, mobile fitting, and patient role controls. The accessibility scan reported **23 passes and zero violations**. This harness uses synthetic API responses; it does not claim live Clerk or database authentication. Local screenshots/results are retained in ignored `.local/mdms-ui-harness/`.

The separate guarded live verifier exercised the actual API and Neon development database/private bucket. Its final run performed signed PUT and GET in a real browser at the local app origin, proving cross-origin access and the browser-generated signed Content-Length. It also verified checksum equality, initial quarantine, native extraction, explicit clinician review, approved context, replay, cross-patient denial and anonymous object denial:

```json
{
  "status": "passed",
  "database": "live-neon-development",
  "storage": "live-neon-private",
  "browserStorageRoundtrip": true,
  "signedDirectUpload": true,
  "immutableVersionChecksum": true,
  "quarantineBeforeScan": true,
  "nativePdfExtraction": true,
  "provisionalObservations": true,
  "manualClinicianReview": true,
  "approvedClinicalContext": true,
  "signedDownload": true,
  "anonymousObjectDenied": true,
  "crossPatientDenied": true,
  "idempotencyReplay": true,
  "liveMalwareScannerVerified": false,
  "liveClerkAuthenticationVerified": false,
  "externalClinicalProcessorCalls": 0
}
```

Live verification retained three clearly synthetic documents in the designated development branch. It created no Clerk identities. It used the existing synthetic application's injected identity-verification boundary and the exact fixture-hash scanner. No test document was inserted into production.

## Launch and user workflow

Run `pnpm dev`, then open `http://localhost:3001`. The API uses port 4001 and the document worker runs alongside it. The restarted app reads the migrated existing database and the existing Clerk application.

Open a patient's clinical records and use **Medical documents**. Upload a supported report with metadata; the browser sends it to private storage and completion queues security/extraction. Inspect provisional observations and source pages. An approved treating clinician verifies/corrects or rejects each finding, records the exact-version document review, and approves it. Verified approved measurements then appear in clinical context and compatible trends. Follow-up reports add longitudinal source-linked history.

For a reproducible full extraction demonstration, use the committed synthetic fixtures and the explicitly configured **development** fixture scanner. Production does not accept the fixture scanner bypass; ordinary uploads remain quarantined until a real scanner is available.

## Provider status and limitations

| Integration | Verified status |
| --- | --- |
| Neon PostgreSQL and private Neon storage | Live development roundtrip passed; configured app health passed after migration |
| Native PDF extraction and local PDF/image viewer | Real fixture bytes and browser rendering passed |
| Existing Clerk integration | Preserved; new routes require it; fresh live Clerk login was not exercised in this delivery |
| Cloudflare R2 | Real S3 adapter and signing tests passed; live R2 credentials/bucket not supplied |
| ClamAV | Real local INSTREAM transport tested with controlled server replies; live antivirus/definitions not configured |
| Google Document AI | Adapter/ADC handling and controlled response parsing tested; processor credentials not supplied |
| MedGemma | Structured extraction/summary grounding and controlled protocol tests passed; live endpoint/model credentials not supplied |

See [configuration and API documentation](medical-documents.md) for the complete environment table, bucket CORS, lifecycle rules, permissions and endpoints. Required external configuration is R2 account/bucket credentials, local ClamD, Google project/location/processor plus ADC, and an authorized MedGemma endpoint/model/key. External processing also requires explicit `DOCUMENT_EXTERNAL_PROCESSING_ALLOWED=true`.

The native parser supports conservative formats, not every laboratory layout. OCR is required for raster/scanned content. Evidence summaries do not diagnose or recommend treatment. Signed URLs already issued remain usable until their short expiry. Staging cleanup needs the documented bucket lifecycle rule. Original/legacy files and audit history are retained; hiding a record is not secure erasure. This remains a synthetic prototype, with no regulatory-compliance or external clinical-deployment claim.

## Future enhancements — not delivered claims

- Configure and validate live R2, current antivirus definitions, Google OCR and an authorized medical model.
- Broader validated laboratory layouts, language/terminology support and explicit unit-conversion rules.
- Enterprise retention/erasure and object-lock governance, operational processor metrics and alerts.
- Full external FHIR/SMART/EHR exchange and clinical policy validation.

Publication follows the `development` → `main` workflow. Unrelated local Hindi changes, context files and private verification artifacts are excluded from the document-management commit.


## Publication snapshot verification

The selected document-management commit excludes the unfinished Hindi work and was exported into an isolated directory without private environment files. Its frozen lockfile installed from the local package cache. Validation passed:

```text
pnpm typecheck && pnpm lint && pnpm test
Test Files  29 passed (29)
Tests       273 passed (273)
exit 0

npm run build (non-authenticating public CI placeholder)
Tasks: 1 successful, 1 total
exit 0
```

The three additional tests in the earlier 276-test working-tree run belong to the separate, uncommitted language changes. Binary Git attributes preserve the exact PDF/PNG fixture checksums across platforms.
