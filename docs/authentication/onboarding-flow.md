# Authentication and onboarding flow

CareLoop uses Clerk for sign-up, sign-in, verification, recovery, account management, and sessions. The CareLoop database remains the authority for application roles, onboarding status, clinician approval, and patient relationships. Public registration never grants administrator, coordinator, or receiving-provider permissions.

## Pages and destinations

| Page | Purpose |
| --- | --- |
| `/sign-in/[[...sign-in]]` | Branded Clerk sign-in and its nested verification/recovery steps. |
| `/sign-up/[[...sign-up]]` | Clerk registration and verification steps. |
| `/auth/continue` | Resolve the authenticated application identity and choose an authorized destination. |
| `/onboarding` | Choose patient onboarding or request clinician access. |
| `/onboarding/patient` | Complete a minimal patient profile. |
| `/onboarding/clinician` | Submit a professional access request. |
| `/onboarding/clinician/pending` | Display pending/rejected status and review reason; allow a manual status refresh. |
| `/account/[[...account]]` | Clerk profile, configured sign-in methods, and session controls. |
| `/` | Existing patient portal or authorized staff workspace. |
| `/admin` | User management, clinician requests, care-team permissions, access audit, and demonstration lab tabs. |

Sign-in/sign-up components are wrapped in Suspense. The provider supplies the installed `@clerk/ui` module explicitly so the bundled components and shadcn stylesheet use the same UI version. Pending Clerk sessions are treated as signed out by application gates; the prebuilt sign-in flow resumes required session tasks before application identity is loaded. A pending session encountered on sign-up is sent to sign-in for that continuation. Both force completion through `/auth/continue`; client-provided destinations do not grant permissions. The same branded shell, Clerk forms, and account controls follow the English/Hindi interface selection. The language preference alone is stored in local storage; medical data and session tokens are not.

`GET /api/identity` returns the application's user, onboarding kind/status, optional clinician profile, and one of four canonical destinations:

- New account: `/onboarding`.
- Pending or rejected clinician: `/onboarding/clinician/pending`.
- Completed patient or approved/provisioned clinical staff: `/`.
- Administrator: `/admin`.

The client uses that response to gate navigation. All protected API calls separately verify identity and authorization.

## Patient setup

`POST /api/onboarding/patient` accepts `name`, `birthDate`, `language` (`en` or `hi`), `consent`, and `privacyAcknowledged: true`. The form explains the synthetic-data boundary and separates the required acknowledgement from optional communications consent. Optional consent is unchecked initially.

The server creates/associates the application's patient record with the authenticated user. The client cannot submit a target patient ID or elevated role. On success, the interface refreshes `/api/identity` and opens the patient's own workspace. A new patient may have no clinical episodes; the existing empty state handles this case.

## Clinician request and review

`POST /api/onboarding/clinician` accepts `professionalName`, `specialty`, `registrationIdentifier`, optional `institution`, and `privacyAcknowledged: true`. The pending page exposes no patient records or clinical workflow controls.

An administrator reviews the request in the Clinician requests tab. `POST /api/admin/clinicians/:userId/review` accepts an `approved` or `rejected` decision plus a review reason. The UI describes approval as **demo approval**, not independent credential verification. Approval and patient authorization are separate: an approved clinician still needs an explicit active care-team relationship before accessing that patient's records.

The pending page offers a manual status refresh and account management. Rejected users can read the decision reason and contact the platform administrator. The UI does not currently provide a self-service resubmission form.

## Administration

The administration UI provides confirmation dialogs for role/status changes, clinician decisions, grants, and revocations. It shows only identity/access information in its audit tab. Admin role provisioning is excluded from the public signup and admin role dropdown; initial administrator linking/provisioning uses the trusted server-side administrative procedure.

Role changes are limited to the server-supported patient, clinician, coordinator, and receiving-provider roles. The server checks whether a transition is permitted; selecting a role in the browser is not sufficient. Suspending/restoring an account preserves its care records. The demonstration lab remains available to administrators, without a link into a clinical episode.

## Session and error behavior

Clerk's UserButton links to `/account` and supports sign-out. The application sign-out action clears identity, workspace state, and pending request eligibility before asking Clerk to end the session. A session/user switch hides the previous identity immediately, and stale responses cannot populate the new user's workspace.

Identity or permission errors display a retry/sign-out screen rather than automatically bouncing between routes. A workspace 401/403 clears loaded care data and refreshes the application identity. Authentication outages return an error with a manual retry. A prolonged initial load exposes a reload action after 15 seconds.

Password resets, email verification, social sign-in, and account security options are rendered according to the selected Clerk application's configuration. This migration does not enable new OAuth connections or import the legacy demo passwords.
