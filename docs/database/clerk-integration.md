# Clerk integration

Existing Clerk authentication remains the identity provider. Fastify verifies the session, resolves `users.clerk_user_id`, and uses current local status/role/onboarding data. Unique Clerk identity mapping preserves existing local user and patient IDs. Email is not an identity-link key.

`IdentityService` already supports first-login reconciliation, approved patient/clinician onboarding, administrative account/role changes, explicit care relationships and signed Clerk webhook processing. `clerk_webhook_deliveries` and identity timestamps handle duplicate/out-of-order delivery; `clerk_identity_tombstones` prevent deleted identities from reappearing through stale events. Account deletion deactivates/unlinks identity according to the existing flow; it does not cascade-delete clinical history.

The new clinical and document routes call the same authentication boundary. A signed-in clinician must have approved status and an active relationship to the patient. Patients cannot author signed clinical notes, approve treatment or review analyses. Administrators receive no automatic clinical read permission.

Legacy `sessions` and nullable password-hash columns are retained for migration preservation; they do not authenticate the new HTTP flows. No new passwords, fake Clerk users or medical records are stored in Clerk metadata. Synthetic seed identities cannot sign into Clerk until explicitly linked through the existing controlled provisioning workflow.

See [authentication documentation](../authentication/README.md) and [patient access rules](patient-data-access.md). External webhook configuration and live development-account testing must be reported separately from local injected-verifier integration tests.
