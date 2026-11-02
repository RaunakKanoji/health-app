# Database verification

The database-only publication snapshot passed **226 tests in 22 files**, `pnpm typecheck`, `pnpm lint` and the staged whitespace check. Its fresh `npm run build` passed: 1/1 tasks, zero cached tasks, 20.416 seconds and 9/9 generated pages. Validation used an isolated export of the staged tree with dependencies installed from the frozen lockfile.

The combined local workspace previously passed 229 tests in 23 files; the three additional tests belong to unfinished Hindi work excluded from this database commit. A seed-recovery test explicitly selects `test` so it cannot inherit the application's production environment. The browser checks below were performed in the combined local workspace before publication; live service checks are reported separately.

`pnpm db:check` returned `ok`, six applied migrations and no pending files. The running web proxy at `http://localhost:3001` returned 200 for health and sign-in; protected clinical records returned 401 without authentication. The API runs on port 4001 and the worker started successfully with the restricted runtime connection.

## Commands

```sh
pnpm db:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Run `pnpm db:migrate` only after a safe development target is confirmed. The project preserves its existing checksum SQL migration runner instead of introducing `drizzle-kit push`/a second migration history. There is no need to install a second ORM to run these checks.

## Isolation

`tests/helpers.ts` creates a unique disposable schema, migrates/seeds it and drops it when finished. Tests inject a verifier explicitly through test application construction; runtime authentication still uses Clerk. Never aim destructive tests at a production, shared preview or existing unscoped public database. Scenario simulation is a writer and is not automatically safe merely because the server is local.

## Automated coverage

- Database settings: explicit remote environment, TLS, matching pooled/direct target, malformed/overridden destinations and bounded pools.
- Migrations: fresh application, checksum preservation, constraints, foreign keys, lifecycle checks, immutable signed notes and results.
- Authorization: anonymous, another patient, unrelated staff, unapproved clinician, administrator without care relationship and revoked relationship.
- Clinical journey: persisted consultation/note, laboratory results/units/ranges, report release, explicit analysis review, treatment/follow-up and idempotent replay.
- Source correction: original preserved, report review reset, stale analysis superseded/rejected, patient release projection.
- Documents: bounded MIME-validated upload, private metadata, scoped temporary download, unavailable-storage behavior and idempotency. In-memory test storage is not evidence of a live S3 round trip.
- Existing Clerk/workflow tests: identity mapping, webhook idempotency, roles, provider sharing and closure retain their current regression coverage.

Live Neon connectivity, live private object storage and browser flows must be reported independently from local PostgreSQL/API tests. A compile-only build key is not evidence that live Clerk sign-in succeeded.

## Browser component verification

The actual `PatientClinicalRecords` component, API client, language provider and built application CSS were exercised in standalone Chromium against a temporary in-memory synthetic HTTP fixture. This did not modify application authentication or contact Clerk, Neon or a real database. The in-app browser connector was unavailable; the standalone browser was the documented fallback.

All 16 checks passed across 11 create/review requests: eight clinical forms, explicit signed-note/plan actions, report/analysis review, idempotency-key retention after an uncertain failure, missing-storage controls, patient authoring restrictions, Hindi switching, no runtime errors, and layouts at 1440/800/390/320 px. The long laboratory form scrolls its last input completely above the action footer at 320 px. Desktop/mobile screenshots were visually inspected.

Ignored local artifacts are under `.local/clinical-ui-verification/`: `results.json`, the reproducible fixture harness, record-view screenshots, the mobile form screenshots and the Hindi patient view. These verify UI behavior only; live database/storage/API verification is recorded separately.

## Live Neon development verification

[scripts/verify-neon-development.ts](../../scripts/verify-neon-development.ts) passed on the specifically pinned development branch `br-cold-haze-b30hq0yn`. It uses real HTTP transport, real Neon PostgreSQL and the real private Neon object bucket, with an explicitly injected test identity verifier. It does not enable an application authentication bypass or call Clerk APIs.

Verified outcomes:

- Real bounded upload, stored SHA-256/byte count, idempotent replay and exactly one metadata/replay record.
- A 60-second signed HTTPS download returned the exact bytes with attachment disposition; removing its signature denied anonymous object access.
- Anonymous API access, another patient's download/record access and coordinator clinical writes were denied.
- Consultation, signed note, laboratory order/report and exact decimal measurement persisted; unreviewed results remained hidden until release.
- Reviewed local analysis retained its source provenance; approved treatment plan and follow-up were retrievable through the API and verified in SQL.

Four dedicated synthetic SQL identities were used, with zero Clerk API calls. The result explicitly reports `liveClerkAuthenticationVerified: false`. Fixtures remain in the isolated development branch; production received none. This is cloud persistence/access/storage evidence, not evidence of a new live Clerk sign-in or full browser-to-Clerk-to-Neon journey.

The script requires a complete privately preloaded development connection/storage tuple and refuses another branch. It is a writer; do not run it using ordinary production application settings or merely as a health check.

## Live sign-in rendering

The running application's actual Clerk sign-in page was inspected at a 390 px viewport. The identifier input was fully visible, horizontal overflow was absent and the browser reported zero page errors. The screenshot is retained privately at `.local/neon-live-sign-in.png`. This checks live rendering only; no Clerk sign-in was performed and no authenticated browser-to-Neon journey is claimed from this check.
