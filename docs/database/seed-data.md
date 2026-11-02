# Synthetic demonstration data

The original idempotent coordination seed is retained. The additional `scripts/seed/clinical-journey.ts` fixture creates a small consultation → signed note → laboratory order/report/result → reviewed synthetic summary → approved plan → follow-up journey.

The fixture uses the existing controlled `patient-001`/`SYN-001` synthetic patient and `user-clinician` demonstration clinician. It checks synthetic source identity and clinician approval, uses stable `synthetic-journey-v1:*` command keys and does not discover or attach itself to user-created profiles. Re-running returns the original idempotent records. All clinical text is clearly synthetic and is not medical advice or model-validation evidence.

## Run only after target confirmation

```sh
pnpm db:migrate
pnpm db:seed
pnpm db:seed:clinical
```

These commands write to the configured database. Confirm `DATABASE_ENVIRONMENT=development` or `test`, matching direct/runtime targets and `DEMO_MODE=true` before execution. Do not run against the shared preview for a disposable test; use `testApplication()` or a separately selected schema/Neon branch.

The seed does not create Clerk accounts, alter real development Clerk users or fabricate authentication. UI demo access requires deliberate linkage/authorization using the existing identity provisioning process. The fixture includes laboratory metadata/measurements, not a fake uploaded object; private object storage must be configured and an actual upload performed to demonstrate file retrieval.

Programmatic callers may pass `seedClinicalJourney(db, {reportDocumentId})` to associate the report with an existing document for the controlled synthetic patient. The existing report service checks patient scope and document readiness; the seed creates no upload or object and requires no storage credentials. Omit the option to retain the metadata-only fixture. Choose the document before the first run: stable command keys make replay with the same option idempotent and reject a different document under the same fixture key.

The application must refuse production seeds. Do not run `demo:reset`, scenario simulation or destructive SQL merely to inspect existing data.

The current user-selected Neon branch is named `production`. These routine seed commands intentionally reject it. The initial record-preserving transfer is a separate authorized setup operation; it is not permission to reseed, reset or simulate against that branch. Continue running repeatable tests in disposable local schemas or explicitly selected test branches.

The production transfer preserved existing source records; it did not add the new journey fixture there. Separately, `scripts/verify-neon-development.ts` populated a dedicated development-only verification organization with four SQL identity fixtures, two synthetic patients and a fresh clinical/file journey. Those fixtures remain on the development branch for inspection, and no Clerk API calls were made. The production branch received no verification fixtures.

The simulation and import CLI entry points now also enforce the development/test environment guard and reject production. This prevents an accidental synthetic scenario/import run against the application branch; it does not replace explicit schema isolation for tests.
