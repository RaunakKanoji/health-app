# CareLoop Clerk authentication

The prototype uses Clerk for identity and sessions, and its existing PostgreSQL database for roles, onboarding, demo clinician approval and patient access. The patient and staff workspaces remain at `/`; administration is at `/admin`.

- [Local setup and trusted identity migration](clerk-setup.md)
- [Authentication architecture](authentication-architecture.md)
- [Roles and permissions](roles-and-permissions.md)
- [Onboarding flow](onboarding-flow.md)
- [Database integration and retention](database-integration.md)
- [Routes and protection](route-protection.md)
- [Security checklist and limitations](security-checklist.md)
- [Verification evidence](testing.md)

The selected existing application is `health-app` (`app_3LXV8vGNwZBBbpPkuSS8rQagSkb`), development instance `ins_3LXV8vC6oRx3IgmAB6ow1mztsl2`. No production instance was provisioned. No existing Clerk user was imported or automatically matched by email.

The authorized migration preserves application user IDs and clinical records. Old `careloop_session` cookies and demo passwords no longer authenticate API requests. Every person must sign in through Clerk. Existing synthetic staff identities need an explicit trusted mapping before they can be used interactively.

This is a synthetic demonstration. Manual clinician approval is labeled demo approval, not professional credential verification. New consultations, medical uploads and other modules from the conceptual brief were not added to the original prototype.

## Implementation inventory

| Area | Created | Modified |
|---|---|---|
| Identity/backend | `packages/auth/src/clerk.ts`, `identity.ts`, `provision.ts`; `apps/api/src/identity.ts`; `packages/contracts/src/identity.ts`; `scripts/provision-identity.ts` | Existing Fastify application, authentication exports, runtime config and package scripts |
| Database | `packages/db/migrations/0005_clerk_identity.sql` | Synthetic seed adds only controlled demo profiles/grants and preserves revoked access |
| Frontend | Sign-in/up catchalls, `/auth/continue`, onboarding routes, account catchall, `/admin`; identity context, onboarding/admin/account components; `src/proxy.ts` | Root layout/provider, branded login, existing patient/staff account controls, API client, styles, localization, Next config |
| Clinical authorization | Record-access integration regression tests | Workflow service, domain guards/contracts, FHIR/scenario boundaries, patient response projection and existing security tests |
| Verification | Identity and Clerk verifier tests; Clerk browser fixture setup/helper | Playwright specs/config, test helpers and test instructions |
| Documentation | All nine documents in this directory | README and verification instructions |

The framework protection covers the existing `/` portal, onboarding, account and administrative pages. Fastify independently authenticates protected APIs, applies trusted roles and scopes clinical resources to the authorized patient or care team. See the route document for the complete mapping and public exceptions.
