# Roles and permissions

Clerk proves identity. Local PostgreSQL account state, role, approval and care assignments determine permissions. A valid Clerk session alone grants no clinical data access.

| Account | Allowed scope |
| --- | --- |
| Signed out, invalid or revoked session | Public sign-in and public health endpoint only; signed webhooks have their own verification. |
| Incomplete account | Identity resolution and onboarding; no clinical workspace. |
| Pending or rejected clinician applicant | Own application state and resubmission; no clinical workspace or self-approval. |
| Patient | Only the patient record attached to the local user and its authorized patient-facing episode view. |
| Approved clinician | Clinical actions and records for explicitly assigned patients, subject to existing workflow rules. Approval alone grants no patient access. |
| Coordinator | Coordination actions and records for explicitly assigned patients; no clinician-only decision authority. |
| Receiving provider | Only episodes explicitly shared with its receiving organization through the existing referral/access-grant workflow. |
| Administrator | Account management, clinician review, care assignments and identity/security audit metadata. Clinical record access requires a separate explicit patient assignment; this does not confer clinician-only action authority. |
| Suspended or deleted account | No authenticated application access, even with an otherwise valid Clerk session. |

The user cannot select an administrator, coordinator or receiving-provider role during public onboarding. The doctor label in the interface maps to the existing `clinician` role. Administrators can assign non-administrator roles through validated API operations; assigning a clinician requires an approved professional profile, and assigning a patient requires an existing patient profile. Patient identities cannot be converted into staff identities. Administrator elevation is restricted to the trusted local provisioning command.

## Administration endpoints

- `GET /api/admin/users`: account state, local role and Clerk mapping.
- `GET /api/admin/clinicians`: professional applications and review state.
- `POST /api/admin/clinicians/:userId/review`: approve or reject with a reason.
- `POST /api/admin/users/:id/status`: suspend or reactivate an eligible non-administrator account.
- `POST /api/admin/users/:id/role`: assign an eligible non-administrator role.
- `GET /api/admin/relationships`: minimal patient directory, eligible care-team accounts and grants.
- `POST /api/admin/relationships`: grant explicit access with an authorization basis.
- `POST /api/admin/relationships/:id/revoke`: revoke a grant immediately.
- `GET /api/admin/audit`: identity/access administration events; clinical narratives are excluded.

All operations check the acting administrator's current local state and organization. Clinical services query active relationships on each request. Suspension, a role change away from an established assignment, clinician rejection and identity deletion revoke existing relationships. Re-enabling an account does not silently restore its old access.

Administrator self-role/status changes are unavailable through the account management API. Local provisioning is explicit and audited. The background overdue worker has an internal service path restricted to its existing overdue transition; browser callers do not receive that capability.

This is a synthetic demo approval process. It is not a professional credential registry or a production clinical access policy.
