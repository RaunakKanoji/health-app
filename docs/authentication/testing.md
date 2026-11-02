# Authentication verification

Verified on 2 November 2026 against the selected Clerk development instance and local PostgreSQL. The separate `careloop-app` service was not used as a test target.

## Automated checks

| Check | Result |
|---|---|
| `pnpm test` | PASS: 187 tests in 16 files in the authentication-only publication checkout |
| `pnpm typecheck` | PASS: backend/shared and Next.js TypeScript |
| `pnpm lint` | PASS |
| `pnpm build` | PASS: production Next.js build and protected route compilation |
| Isolated `pnpm simulate` / `pnpm evaluate` | PASS: all 15 scenarios and their evaluation in a disposable schema |
| `git diff --check` | PASS |
| Clerk CLI `doctor --json` | PASS for authentication, selected application, development keys and configuration; optional production instance/shell completion not configured |

The suite includes real PostgreSQL transactions in disposable schemas, forged/missing/legacy credentials, live-verifier failure cases, role escalation denial, explicit ID provisioning, concurrent first sign-in and onboarding, clinician approval, account status, cross-patient denial, explicit/revoked staff grants, receiver grants, patient response projections, idempotent replays, signed/duplicate/stale/deleted webhook events and retained records. A deterministic concurrency regression proves revocation waits for an authorized transaction to commit and denies subsequent access. Existing FHIR, lifecycle, scenario and research-boundary tests remain included. Three tests for the separate unfinished workspace-translation feature are excluded from this publication; the combined development checkout passed 190 tests in 17 files.

Integration tests inject an identity verifier through `buildApp` in test construction only. The production entry point never supplies this injection, and there is no HTTP or environment authentication bypass. Browser checks use real Clerk sessions and the official testing token.

## Live browser and API verification

The user authorized four temporary synthetic identities: two patients, a clinician applicant and an administrator fixture. Three were created with the CLI; the second patient completed public prebuilt Clerk sign-up and reserved email/phone verification in Chromium. Clinical data and administrator provisioning were confined to a new local schema.

Observed successful checks:

- Public registration and verification, branded sign-in and registration forms.
- Password sign-in through Clerk UI, including verification of a new device by test email.
- Password recovery through Clerk UI, verified email code and a new password; a new session opens the existing patient portal.
- Patient onboarding for two distinct profiles and persistence across refresh.
- Patient administration denial in both navigation and direct API requests.
- Clinician application and pending page; clinical/admin API denial before approval.
- Administrator approval through the UI; an approved clinician initially sees no patient records.
- Explicit patient assignment, existing FHIR intake and authorized clinician/patient reads.
- Other-patient and unassigned-administrator record denial.
- Grant revocation for an already signed-in clinician.
- Suspension/restoration without a new session.
- Clerk account management rendering.
- Sign-out redirects, cleared portal UI and rejection of the previously valid token by the API.
- Deleting the temporary Clerk identity invalidates its still-held token even without webhook delivery.

All four temporary Clerk identities were deleted after verification. No existing Clerk identity was changed. The disposable database schema was removed, and temporary credentials/session-state files were deleted. The regular prototype preview uses its existing database and contains no test-account mappings from this run.

Migration preview check: `http://localhost:3001/sign-in` returns 200, proxied health is healthy and anonymous `/api/identity` returns 401. The final registration form requires only email and password. At migration completion its existing database retained 16 care episodes, contained zero temporary test users and zero preselected Clerk identity mappings. An operator must explicitly provision the initial administrator.

The local Next/Clerk rewrite loop found during verification was fixed using documented `skipProxyUrlNormalize`. Public pages and API rewrites were retested successfully. Browser navigation waits use document readiness because third-party resources may delay the full window load event.

## Deleted-identity recovery follow-up

An actual patient sign-in encountered `IDENTITY_LINK_REQUIRED` after their Clerk account was deleted and recreated. The existing local profile still referenced the deleted Clerk ID. A live trusted-command dry-run confirmed that the old identity returned 404 and the new active identity had the same verified primary email. The explicitly selected mapping was then repaired locally; no Clerk account was created or changed.

Before/after comparison confirmed that the local user ID, patient ID, name, email, role, account status and onboarding state stayed unchanged. Hashes of all patient rows, role assignments and care relationships matched. The database retained 23 users, 17 patients and 16 episodes. The former Clerk ID was tombstoned, and recovery was audited.

The combined development checkout passed 190 tests across 17 files at recovery completion; the authentication-only publication was subsequently rechecked as described above. New coverage verifies the exact-old-ID requirement, unchanged profile/authorization, non-mutating dry-run, rejected email/identity/role conflicts, rejection of forged absence evidence, failure on live or unavailable old identities, and protection against delayed old deletion/update events. Typecheck, lint and anonymous preview smoke checks pass. The English/Hindi conflict screen now explains the required link and offers sign-out or an access recheck without redirecting signed-in users back through sign-in. The current user's browser session was not automated during this repair; refreshing it uses the repaired mapping.

## GitHub Actions checks

The `Credential-free application verification` job runs on every push and pull request. It starts disposable PostgreSQL, applies migrations and seeds, and runs TypeScript, lint, Vitest, the production build, Python tests, simulations and evaluation. The build receives a syntactically valid public placeholder for `clerk.example.test`; no Clerk secret is supplied. This placeholder is confined to the build step, cannot authenticate users and is not an application authentication fallback. These checks establish compilation and fixture-based behavior, not live Clerk authentication.

The separate `Live Clerk browser verification (opt-in)` job runs only when the repository variable `CLERK_E2E_ENABLED` equals `true`, after the mandatory job succeeds. It accepts pushes and pull requests from the same repository; fork pull requests cannot run it with credentials. A skipped live job is **not a passing browser or authentication verification**.

Before enabling it, a trusted operator must approve and independently create five dedicated synthetic users in a Clerk **development** instance, with verified primary emails. Configure:

| Repository setting | Location | Requirement |
|---|---|---|
| `CLERK_E2E_ENABLED` | Variable | Set to `true` only after fixture approval and configuration. |
| `CLERK_E2E_PUBLISHABLE_KEY` | Variable | Development publishable key beginning `pk_test_`. |
| `CLERK_E2E_SECRET_KEY` | Secret | Matching development secret key beginning `sk_test_`. |
| `CLERK_E2E_<ROLE>_USER_ID` | Variable, one per role | Exact existing Clerk user ID; never an email lookup or an automatically created identity. |
| `CLERK_E2E_<ROLE>_EMAIL` | Variable, one per role | That user's verified primary synthetic email. |

Replace `<ROLE>` with each of `CLINICIAN`, `PATIENT`, `COORDINATOR`, `RECEIVER` and `ADMIN`. All five IDs and all five emails must be distinct. Preserve the coordinator fixture's display name `Nadia Al Farsi`, which the retained care-workflow browser assertions expect. The development instance must support the documented Clerk sign-in flow and the application origin `http://localhost:3001`.

When enabled, the job fails if configuration is missing or invalid and reports configuration names without their values. Before any local mappings, it checks each exact Clerk ID against its configured verified email and active account state. It then seeds its own PostgreSQL service and uses `identity:provision --apply` to link those five IDs to `user-clinician`, `user-patient`, `user-coordinator`, `user-receiver` and `user-admin`, preserving the existing synthetic roles without a role-promotion argument. The workflow does not create or modify remote Clerk users. Browser testing establishes sessions for the approved fixtures and exercises the existing synthetic workflows.

Live runs are serialized to avoid overlapping use of the shared test identities. Authentication tracing is disabled and live browser artifacts are not uploaded because they may contain session material. The mandatory job uploads only synthetic evaluation reports. No repository variables, secrets, remote identities or GitHub settings were configured by adding this workflow; a live run remains unverified until an operator supplies the prerequisites and the job completes successfully.

## Repeat locally

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

The preserved full Playwright workflow suite additionally requires real development Clerk keys and explicitly provisioned synthetic clinician, patient, coordinator, receiver and administrator identities. Supply `CLERK_E2E_CLINICIAN_EMAIL`, `CLERK_E2E_PATIENT_EMAIL`, `CLERK_E2E_COORDINATOR_EMAIL`, `CLERK_E2E_RECEIVER_EMAIL` and `CLERK_E2E_ADMIN_EMAIL`, mapped to their corresponding fixed demo user IDs using trusted provisioning. `PLAYWRIGHT_BASE_URL` defaults to `http://localhost:3001`. Never run destructive scenario fixtures against an unrelated or production database.

The full multi-role Playwright suite was not rerun with live Clerk accounts: the approved four-account scope did not include coordinator/receiver identities. Their workflow behavior is covered by the automated API/domain suite. Signed webhook handling was tested locally; an externally delivered Clerk webhook remains unverified until an endpoint and signing secret are configured. OAuth providers, real email/SMS delivery, production deployment, privileged MFA policy and real clinical credentials were not claimed as verified.
