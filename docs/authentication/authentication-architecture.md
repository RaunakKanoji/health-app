# Authentication architecture

CareLoop uses Clerk for identity verification, sign-in, sign-out, email verification and session management. PostgreSQL remains authoritative for account state, application roles, clinician approval, patient identity, consent and access to care records. This remains a synthetic demonstration application; approving a clinician in the prototype does not verify a professional licence.

## Request path

1. The Next.js application uses Clerk's provider, authentication components and middleware. It sends the current Clerk session to the existing Fastify API.
2. `packages/auth/src/clerk.ts` accepts only Clerk session tokens. Clerk verifies token signature, expiration, issuer and authorized party. The issuer comes from the configured issuer URL or the selected application's publishable key. Permitted origins are the configured application origin plus its same-port HTTP localhost/127.0.0.1 alias in local development.
3. The API also reads the session and user from Clerk's Backend API on every request. Revoked/ended sessions, deleted/banned/locked users, and unverified primary email addresses are denied. An unavailable Clerk service produces a retryable 503; authentication never falls back to an old local session.
4. `IdentityService` resolves the unique `clerk_user_id` to the existing local `users.id`. A new verified identity gets an incomplete patient account without a patient record. Matching email addresses never attach an identity to existing care records. Explicit local provisioning handles those mappings.
5. The API rechecks local account, role, approval and record authorization. UI route guards are convenience controls; API and workflow checks enforce access independently. Authentication results are memoized only within the same request.

`GET /api/identity` reports the authoritative onboarding state and destination. Incomplete users go to `/onboarding`; pending or rejected clinician applicants go to `/onboarding/clinician/pending`; administrators go to `/admin`; completed care users use the preserved portal at `/`.

## Identity lifecycle

Patient onboarding creates one local patient record and stores the communication consent choice locally. Clinician onboarding creates a pending professional profile without granting clinical access. An administrator reviews the application before the account becomes a clinician. An approved clinician still needs an explicit patient relationship to read that patient's records.

`POST /api/webhooks/clerk` verifies the exact raw JSON with `@clerk/backend/webhooks`. Its isolated Fastify parser does not change JSON parsing for other routes. Only minimal delivery metadata is retained. Duplicate deliveries are idempotent, older updates are ignored, and deletion tombstones prevent delayed events from resurrecting an identity. Deletion disables the local account and revokes its care relationships; it does not delete clinical records. First sign-in reconciles identity directly, so a delayed creation webhook cannot block a new user's onboarding.

Local suspension also revokes care relationships. Reactivation requires an administrator and does not restore old grants. Clerk account deletion is terminal for that identity. Session revocation does not require webhook arrival because the API checks the session online.

## Boundaries

No diagnoses, patient records, clinical narratives, care assignments or professional approval decisions are written into Clerk metadata. Role claims, browser storage, URL parameters and user-editable Clerk metadata are not authorization inputs. Clerk keys and webhook secrets stay in runtime environment files; the CLI-managed web environment file is loaded by backend configuration without copying or logging its values.

The legacy password endpoint returns 410. Legacy cookies cannot authenticate a request. Old password hashes are dormant and become null when a legacy user is explicitly mapped. Synthetic test identities use a verifier passed directly into `buildApp` by test code; no environment variable or HTTP endpoint enables that injection in the running application.

## Verification

`packages/auth/src/clerk.test.ts` covers production verifier configuration, online revocation and deletion checks, unverified email, missing configuration and service failures. `tests/integration/identity.test.ts` exercises onboarding, explicit mapping, role escalation denial, approval, assignment/revocation, account suspension, signed webhook replay/order handling and retention on deletion against isolated PostgreSQL schemas. The broader record-access suite tests cross-patient and cross-organization boundaries.
