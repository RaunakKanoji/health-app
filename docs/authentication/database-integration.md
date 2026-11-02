# Database integration

Migration `0005_clerk_identity.sql` is additive. It keeps every existing `users.id`, `patients.id`, episode, referral, consent, evidence item and audit record. Clerk IDs are external identity mappings; they never replace application primary keys.

| Storage | Purpose |
| --- | --- |
| `users.clerk_user_id` | Unique nullable Clerk identity mapping. Null means an existing local user has not been explicitly mapped. |
| `users.account_status` | `active`, `suspended` or `deleted`; checked independently of Clerk session validity. |
| `users.onboarding_completed` | Existing accounts retain completion; new reconciled identities explicitly start incomplete. |
| `users.clerk_updated_at` | Monotonic source timestamp for identity synchronization. |
| `users.password_hash` | Nullable legacy data; never used to authenticate HTTP requests. |
| `clinician_profiles` | Local professional details, pending/approved/rejected state, reviewer, review reason and timestamps. |
| `clinician_patient_relationships` | Explicit patient access, authorization basis, authorizer, timestamps and revocation. The historic `clinician_id` column can also identify a coordinator or explicitly authorized administrator. |
| `clerk_webhook_deliveries` | Idempotency key, event type, Clerk user ID, source timestamp and processing timestamp; no raw event payload. |
| `clerk_identity_tombstones` | Terminal identity deletions, including a deletion received before a creation event. |
| `audit_events` | Identity lifecycle and access-control events using IDs and safe operational metadata. |

Relationship rows include organization-scoped foreign keys. A care-team user, patient and granting administrator must belong to the same organization. Role alone never creates a relationship. Patient users access the patient referenced by their persisted local `patient_id`; receiving providers retain the existing explicit episode/referral grant model.

## Explicit legacy mapping

Use the trusted local command with both exact IDs:

```sh
pnpm identity:provision --user user-admin --clerk-user user_SELECTED_ID
pnpm identity:provision --user user-admin --clerk-user user_SELECTED_ID --apply
```

Without `--apply`, the command validates and reports the mapping without changing it. `--role admin` can explicitly promote an eligible non-patient local identity; ordinary HTTP endpoints cannot assign administrator roles. The command reads the selected Clerk account, requires an active user and verified primary email, and modifies only the local database. It never creates or modifies a Clerk account.

Conflicting Clerk mappings or verified emails stop provisioning. There is no automatic record merge or email-based link. A mapped patient's local ID and patient ID remain unchanged. Administrator provisioning does not grant clinical access and revokes any previous patient relationships when explicitly changing the role to administrator.

## Recover an explicitly selected deleted Clerk identity

Deleting and recreating a Clerk account produces a new Clerk user ID. A successful sign-in with the same email therefore cannot open the old local profile automatically. The account-linking screen explains this and allows a manual access check after a trusted operator repairs the mapping.

For an active patient profile whose old Clerk identity has been deleted, select all three IDs explicitly:

```sh
pnpm identity:provision --user <local-user-id> --clerk-user <replacement-clerk-id> --replace-clerk-user <deleted-clerk-id>
pnpm identity:provision --user <local-user-id> --clerk-user <replacement-clerk-id> --replace-clerk-user <deleted-clerk-id> --apply
```

Review the dry-run first. Recovery requires a live Clerk lookup confirming the old ID returns 404, an active replacement identity with a verified primary email matching the stored email, and the expected old mapping still present on the selected active patient. An existing old identity, an unavailable Clerk lookup, a different email, another account's mapping, a disabled local account or a role change stops recovery. Omit `--role`; this recovery cannot promote an account.

The transaction preserves the local user ID, patient ID, profile, onboarding state and role. It records an audit event and tombstones the old Clerk ID so delayed events cannot revive it or affect the replacement mapping. This is a trusted local operation with no public HTTP endpoint. Ordinary sign-in still rejects email collisions, and default provisioning still rejects replacement of a different linked identity.

## Transaction and ordering rules

Identity creation, mapping and synchronization use transaction-scoped advisory locks keyed by Clerk ID and normalized email. Identity creation, organization membership and audit insertion commit together. Onboarding locks the local user, so retried or concurrent requests cannot create duplicate patient records. Review, suspension, role changes and grants recheck administrator and target state inside their transactions.

A webhook delivery is recorded in the same transaction as its effect. Failed processing is retryable. A duplicate ID has no second effect. Stale user updates cannot replace newer identity details or reapply an older ban. Deletion always creates a tombstone because Clerk user IDs are not reused. Clinical records and existing foreign keys survive deletion.

Back up PostgreSQL before applying migrations to a non-disposable installation. The prototype seed remains synthetic; no bulk import of demo users or password hashes into Clerk occurs.
