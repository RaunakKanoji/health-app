# Local Clerk setup

## Installed integration

Clerk CLI 4.1.0 initialized the selected existing application from `apps/web`, using `--app app_3LXV8vGNwZBBbpPkuSS8rQagSkb --no-skills --yes`. The CLI wrote development keys into ignored `apps/web/.env.local`; the root runtime configuration loads this file without overriding process settings. The root `.env` retains database and synthetic-mode configuration. Do not display or commit either file.

The approved development-instance configuration was updated with `npx -y clerk@latest config patch`, using an explicit application ID, `--instance dev`, and a successful dry-run before each apply. Read-back through both the configuration API and public Frontend API confirmed that email is required and verified by email code, passwords are enabled and required, and phone numbers and usernames are optional. The existing email-code sign-in alternative remains available. The CLI schema exposes `auth_password.enabled` as the password authentication control; Clerk documents that enabling Password permits password sign-in. See [Clerk sign-in options](https://clerk.com/docs/guides/configure/auth-strategies/sign-up-sign-in-options).

Mandatory Clerk organization selection was also disabled because CareLoop resolves organization access through its existing database and approved local relationships. The only changed settings were `auth_phone.required_for_sign_up=false`, `auth_username.required_for_sign_up=false` and `organization_settings.force_organization_selection=false`. Full before/after comparison confirmed that OAuth provider configuration, organization enablement and all other settings were unchanged, excluding the configuration revision. No Clerk memberships were changed. These checks verify configuration; live sign-in and password recovery results are recorded separately in the validation report.

Installed versions: `@clerk/nextjs` 7.9.23, `@clerk/ui` 1.42.2, `@clerk/backend` 3.26.5, `@clerk/localizations` 4.24.4 and `@clerk/testing` 2.2.53. The workspace uses pnpm; do not introduce a nested npm lockfile.

## Start

```sh
pnpm install --frozen-lockfile
pnpm demo:setup
```

Configure the development keys as described below before running `pnpm dev`, then open `http://localhost:3001`. The API defaults to port 4001. These ports keep the prototype separate from `careloop-app`. Existing process/environment overrides take precedence; `APP_ORIGIN` must match the browser origin and `API_URL` the API. The equivalent HTTP loopback hostname on the same port is accepted for development. Leave the optional Clerk assignments commented out in the root environment template when keys are pulled into `apps/web/.env.local`; empty root assignments would override those pulled values.

On a new checkout, authenticate the Clerk CLI from the host terminal, then restore keys for the same selected application with the supported CLI. Never create a replacement application or overwrite working credentials:

```sh
cd apps/web
npx -y clerk@latest auth login
npx -y clerk@latest link --app app_3LXV8vGNwZBBbpPkuSS8rQagSkb
npx -y clerk@latest env pull
npx -y clerk@latest doctor --json
```

## Configuration names

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Browser and server identity instance |
| `CLERK_SECRET_KEY` | Server-only Clerk verification and trusted provisioning |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Server-only signature verification for a configured webhook endpoint |
| `CLERK_ISSUER_URL` | Optional expected issuer override; otherwise derived from publishable key |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | `/sign-in` |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | `/sign-up` |
| `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL` | `/auth/continue` |
| `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL` | `/onboarding` |
| `DEFAULT_ORGANIZATION_ID` | Existing demo tenant, default `org-screening` |
| `DEMO_MODE`, `DATABASE_URL`, `APP_ORIGIN`, `API_PORT`, `API_URL` | Existing synthetic application configuration |

Only the publishable key belongs in public client configuration. No roles or clinical data are stored in Clerk metadata. Missing authentication configuration fails closed.

## Initial administrator and existing staff

Create or identify an independently verified Clerk identity. A trusted operator must explicitly select the local user ID and Clerk user ID. There is no email-based merge or public administrator assignment. Review before applying:

```sh
pnpm identity:provision --user user-admin --clerk-user user_REPLACE --role admin
pnpm identity:provision --user user-admin --clerk-user user_REPLACE --role admin --apply
```

Use the same command without `--role admin` to map an existing clinician, coordinator, receiver or patient account while retaining its role and ID. The tool checks live Clerk identity and verified email, rejects already-linked/conflicting/deleted users, removes the obsolete password hash for the mapped account and records an audit event. Administrator provisioning revokes clinical grants; administration does not imply clinical access. Choose the correct tenant-local account explicitly; never map a real identity to arbitrary synthetic care records.

New patients complete `/onboarding/patient`. New clinician applicants complete `/onboarding/clinician`; an administrator approves them and separately grants patient access. Public registration cannot create an administrator, coordinator or receiving-provider role.

If a patient deleted and recreated their Clerk identity, follow the [explicit deleted-identity recovery procedure](database-integration.md#recover-an-explicitly-selected-deleted-clerk-identity). Signing in again does not change an existing local mapping; never resolve the conflict with automatic email linking.

## Webhook delivery

The signed endpoint is `POST /api/webhooks/clerk`, forwarded through Next to Fastify. Subscribe the selected development instance to `user.created`, `user.updated` and `user.deleted`, then supply that endpoint's signing secret to the server through private runtime configuration. For local testing, the CLI supports `npx -y clerk@latest webhooks listen --forward-to http://127.0.0.1:4001/api/webhooks/clerk`; this starts a relay, not an automatic Clerk subscription. Keep its configuration private.

External webhook delivery and its signing secret still require endpoint configuration; no stable public URL is available for this local preview. Signed payload handling is covered by isolated tests. Sign-in reconciliation works synchronously without webhooks, and each protected request also verifies the live Clerk session/user, so a missed webhook does not grant access to a deleted or revoked identity.

## References

- [Clerk CLI](https://clerk.com/docs/cli)
- [Next.js quickstart](https://clerk.com/docs/nextjs/getting-started/quickstart)
- [Clerk migration guidance](https://clerk.com/docs/guides/development/migrating/overview)
- [Reserved test emails and phones](https://clerk.com/docs/guides/development/testing/test-emails-and-phones)
