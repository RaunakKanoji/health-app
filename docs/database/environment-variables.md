# Environment variables

Actual values belong in ignored local environment files and secure deployment settings. The server loads generated `.env.runtime` privately without overriding explicit process settings. This document lists names only. `.env.example` contains placeholders and documented synthetic local defaults; it is not a Neon credential source.

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` | Required CLI-owned target connection; pooled endpoint identifies the selected database |
| `DATABASE_RUNTIME_URL` | Restricted application-role URL used by API/worker; must match the same branch/database/schema target |
| `DATABASE_DIRECT_URL` | Same target's direct connection for migration/admin tooling |
| `DATABASE_URL_UNPOOLED` | Backward-compatible direct alias; cannot point to another target |
| `DATABASE_ENVIRONMENT` | `development`, `test`, `staging`, `production`; required explicitly for remote targets |
| `DATABASE_POOL_MAX` | Optional integer 1–20; runtime default 10 |
| `DEMO_MODE` | Must be literal `true`; application supports synthetic workflows |
| `DEFAULT_ORGANIZATION_ID` | Existing onboarding organization |
| `APP_ORIGIN`, `API_PORT` | Existing web/API origin and port settings |
| `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Existing Clerk keys; only publishable key is public |
| `CLERK_WEBHOOK_SIGNING_SECRET`, `CLERK_ISSUER_URL` | Existing webhook verification and optional issuer restriction |
| `DOCUMENT_STORAGE_PROVIDER` | `neon` selects the CLI-owned Neon storage tuple; `s3` selects the explicit S3 tuple |
| `DOCUMENT_STORAGE_PRIVATE` | Literal `true` attestation that the configured bucket is private |
| `DOCUMENT_STORAGE_BUCKET` | Private bucket; Neon defaults to `careloop-medical-documents` |
| `DOCUMENT_STORAGE_REGION` | Region for explicit S3 mode |
| `DOCUMENT_STORAGE_ACCESS_KEY_ID`, `DOCUMENT_STORAGE_SECRET_ACCESS_KEY` | Explicit server-only scoped storage credentials |
| `DOCUMENT_STORAGE_ENDPOINT` | Optional HTTPS endpoint for explicit S3 mode; omitted for AWS S3 |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3` | Neon CLI-owned storage tuple used only when `DOCUMENT_STORAGE_PROVIDER=neon`; keep server-side and do not duplicate into `DOCUMENT_STORAGE_*` credentials |
| `TEST_DATABASE_URL` | Test helper's isolated-database base, when configured |

Remote PostgreSQL URLs require TLS; the client enforces `verify-full`. Remote environments cannot be silently inferred from a hostname. Runtime/direct URLs must agree on branch host (apart from Neon's pooled suffix), database, port and schema options. Credentials can differ for runtime and migration roles.

Database configuration errors identify missing settings without including URLs. Idle connection errors emit only a fixed sanitized event. Storage has no ambient credential lookup, public fallback or local-file fallback. Declaring `DOCUMENT_STORAGE_PRIVATE=true` does not configure a bucket's access policy: provisioning must independently enforce private access and least privilege.

Keep existing Clerk CLI-owned settings intact. Empty root `.env` Clerk values can override otherwise valid values loaded from `apps/web/.env.local`; leave unused settings absent rather than empty.

## Selected Neon setup

The user-selected `health-app` project uses branch `production` in Singapore. Its explicit application setting is `DATABASE_ENVIRONMENT=production` with `DEMO_MODE=true`; the branch is not relabeled as development to bypass seed/migration guards. Neon CLI deployment provisioned the private bucket and pulled the environment values privately. Application code consumes `DOCUMENT_STORAGE_PROVIDER=neon` and `DOCUMENT_STORAGE_PRIVATE=true` together with the CLI-owned `AWS_*` tuple. No values are reproduced here.

Neon mode validates the branch-specific HTTPS storage endpoint and requires the complete tuple. It does not combine a Neon key with legacy S3 settings. The stored provider identity is branch-independent so branch-aware object copies can be addressed through the currently configured endpoint.

The provisioned `careloop_runtime` credential is stored only as `DATABASE_RUNTIME_URL` in ignored `.env.runtime`; owner credentials managed by Neon CLI were preserved. Runtime target validation rejects a different branch, database, port or schema option. The API/worker select the restricted URL while explicit migration/provisioning tools use the owner/direct connection. No runtime secret is exposed through a `NEXT_PUBLIC_*` variable.
