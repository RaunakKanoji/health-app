# Authentication security checklist

This checklist describes the implemented controls, their test evidence and the remaining configuration work. CareLoop remains a synthetic demonstration. This document makes no production-readiness, healthcare compliance or professional credential-verification claim.

## Implemented and verified in the focused authentication tests

- [x] The API accepts Clerk user-session tokens and configures signature/expiration verification, an explicit issuer, and exact authorized application origins. Machine tokens and legacy authentication are not accepted.
- [x] Every authenticated API request also checks the current Clerk session and user. Revoked, ended or removed sessions; deleted, banned, locked or deprovisioned users; mismatched session ownership; and unverified primary email are denied.
- [x] Missing Clerk configuration and Clerk service failures fail closed. An unavailable service returns a retryable error without trusting a stale local session.
- [x] Identity reconciliation uses the unique Clerk ID. A matching email never automatically links an existing local user or clinical records. Explicit trusted provisioning preserves the selected local user and patient IDs.
- [x] Concurrent first sign-ins, competing identities with the same email, and repeated patient onboarding do not create duplicate identities or patient records.
- [x] New incomplete users and pending or rejected clinician applicants cannot enter the clinical workspace. Public onboarding cannot assign administrator roles, and applicants cannot approve themselves.
- [x] Clinician approval does not grant patient access. Explicit patient assignments are required; revocation and local suspension take effect on subsequent requests. Reactivation does not restore revoked grants.
- [x] Administrator role alone does not grant clinical record access. Administrator elevation is available only through the trusted local provisioning command.
- [x] Webhooks verify the exact raw payload before processing. Tests cover invalid signatures, duplicate delivery IDs, stale updates and bans, untrusted metadata role fields, deletion retention, and deletion arriving before creation.
- [x] Account deletion retains patient and care records while disabling the local identity. A tombstone prevents delayed creation or update events from resurrecting it.
- [x] Administrator audit responses contain identity/access events and an explicit metadata allowlist. Tests confirm clinical narratives and token-shaped values in unknown fields are excluded.

The focused run passed **18 tests** in `packages/auth/src/clerk.test.ts` and `tests/integration/identity.test.ts`. TypeScript and ESLint checks also passed for the implementation. The verifier unit tests mock Clerk responses; PostgreSQL integration tests use a directly injected fixture verifier and synthetic webhook signatures. These tests do not independently establish delivery from a deployed Clerk webhook endpoint.

## Additional enforcement and regression coverage

The implementation rechecks current local account state, role, clinician approval and explicit record access inside workflow operations. Test injection exists only as a `buildApp` option supplied by test code; there is no HTTP route or environment switch that enables it in the application entry point.

`tests/security/record-access.test.ts` covers unassigned clinicians, administrators without clinical grants, access revocation before command/FHIR replay, pending approval with a stale service actor, patient response projection, import without implicit access, receiving-provider grant revocation, and seed reruns that preserve revocation decisions. The surrounding security and lifecycle suites cover the existing patient, tenant and workflow boundaries. Use the final validation report for the complete suite results.

API responses use `private, no-store` caching headers. Authentication promises are memoized only within a single request; no cross-request user/session cache bypasses the Clerk checks. Clinical authorization reads current database state. Revocation is enforced on subsequent requests; it does not cancel a request that has already completed or erase data previously rendered in a browser.

## Remaining setup and explicit limitations

- [ ] Configure a publicly reachable deployment webhook endpoint and its `CLERK_WEBHOOK_SIGNING_SECRET`. Live external Clerk-to-application delivery, retries and monitoring remain to be verified. The local endpoint returns 503 when its signing secret is absent. Synthetic signature tests are not a substitute for that deployment check.
- [ ] Configure and enforce the chosen privileged-account MFA policy in Clerk and, if needed, application authorization. Clinician and administrator MFA is **not currently required by this implementation**. Existing OAuth provider connections were not changed.
- [ ] Provision the intended persistent administrator with exact local and Clerk IDs. Temporary test identities and test-only mappings must not become operational access grants.
- [ ] Review the allowed origin, issuer and secret configuration for each deployed environment. Keep secret keys and webhook secrets out of source control, browser bundles, screenshots and logs; the publishable key is intentionally public.
- [ ] Complete an operational review appropriate to the intended use: database backups and restore, secret rotation, access review, retention, monitoring, incident response and deployment transport/security settings. These activities were not established by local authentication tests.

Legacy password hashes and custom-session database rows may remain as dormant migration data. The old password endpoint returns 410 and old cookies do not authenticate. Explicit identity provisioning clears the selected user's old password hash; the migration does not bulk-delete all historical hashes or clinical records. Any later removal should be a separately reviewed data-retention change.

Clerk stores authentication identity. Clinical records, consent, professional details, approval decisions and care relationships stay in the protected application database. Manual clinician approval is labelled as demo approval and does not verify professional registration. No medical data should be placed in Clerk metadata or session claims.

## Reproduce the focused checks

Run against the project's local synthetic PostgreSQL test database:

```sh
pnpm exec vitest run packages/auth/src/clerk.test.ts tests/integration/identity.test.ts tests/security/record-access.test.ts
pnpm typecheck
pnpm lint
```

Integration tests create disposable schemas and use synthetic identities. Broader validation, live Clerk sign-in evidence and any remaining deployment setup should be reported separately from these fixture-based checks.
