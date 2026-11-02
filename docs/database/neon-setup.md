# Neon setup

## Selected project and setup progress

The user explicitly selected:

| Setting | Selected value |
| --- | --- |
| Project | `health-app` (`sweet-water-84984366`) |
| Organization | `org-frosty-pine-20586005` |
| Branch | `production` (`br-cool-star-b3gqgh6v`) |
| Region | Singapore |
| Private bucket | `careloop-medical-documents` |

The existing target was inspected and found empty before transfer work. Neon CLI initialization linked the repository. Its first dependency-install attempt hit pnpm's workspace-root guard; explicitly adding `@neon/config` and `@neon/env` at the workspace root resolved it, and initialization then succeeded. `neon.ts` declares the private bucket; `neon deploy` succeeded and privately pulled the generated environment settings.

The branch remains explicitly `production` in application configuration, while application data remains synthetic (`DEMO_MODE=true`). Routine development seed/migration guards remain in force. After explicit user approval, the controlled transfer applied migrations 0001–0006 and copied 715 existing rows across 43 application tables, preserving 16 episodes, 17 patients and 23 users with their original IDs. Per-table hashes matched before commit; the local source remained unchanged. The application now uses the restricted runtime role. Real HTTP/database/private-storage verification passed separately on the development branch with injected test identities; live Clerk authentication was not exercised by that probe. See [status](implementation-status.md).

## Select and configure development

1. For future development work, use a separately designated development branch in the selected project and the actual database name shown by Neon. The current `production` branch is the user-selected setup target, not a disposable test environment.
2. Use separate development, staging/preview and production environments. For any branch derived from real data, use schema-only branching or an approved de-identified source; never copy real patient records into this synthetic demo.
3. Obtain pooled runtime and direct migration connection strings from that **same branch and database**. Preserve the supplied Neon host/database names. Store them privately as `DATABASE_URL` and `DATABASE_DIRECT_URL`; set `DATABASE_ENVIRONMENT=development` and `DEMO_MODE=true`.
4. Remove the example's local `DATABASE_URL_UNPOOLED` value when selecting Neon, or set that legacy alias to the same direct target. Mismatched branch/database/schema options are rejected. Do not print credentials or put them into `NEXT_PUBLIC_*` variables.
5. Set `sslmode=verify-full`. Remote runtime uses bounded `pg` connections, preserving the application's interactive transactions. The migration connection must be direct and nonpooled.
6. Verify the selected target and inspect existing schema/migration history read-only. Review [migrations](migrations.md), apply additive changes to the selected development environment, and run the isolated tests.
7. Configure a dedicated runtime PostgreSQL role with only required schema/table/sequence operations; use a separate migration role. Runtime startup only checks migrations on remote targets. The selected production branch now has the verified `careloop_runtime` role; new environments require their own reviewed provisioning.
8. Configure the same environment privately in deployment settings, then verify authenticated API reads/writes and worker behavior. Do not switch the preview to a different database without a deliberate record-preserving migration/cutover plan.

## Production boundary

The provided routine migration, seed, simulation and import entry points reject staging/production. Do not bypass this by labeling the selected branch as development. The separately authorized empty-target transfer is a controlled setup operation, not approval for subsequent production mutations. Future promotion requires a reviewed deployment plan, backups and restore exercise, minimum database privileges, secret management, approved data handling and explicit authorization. Neon by itself does not establish healthcare regulatory compliance. Do not run `drizzle-kit push` or reset a branch to deploy this schema.

## Provisioned environments

| Environment | Branch | Current verification |
| --- | --- | --- |
| Production | `br-cool-star-b3gqgh6v` | Six migrations, verified source-data transfer, restricted runtime connection, running API/worker |
| Development | `br-cold-haze-b30hq0yn` | Created before production data transfer, inherited the empty private bucket, migrated independently; live clinical/file probe passed |
| Staging | `br-misty-wave-b39yrxs5` | Created without compute; schema/deployment verification remains pending |

The account rejected a requested compute suspend-timeout override; branch provisioning succeeded using account defaults. No unsupported setting was forced. Four synthetic SQL identity fixtures used by the live probe remain in the development branch only; no probe fixtures were added to production and no Clerk API calls created accounts.

## Restricted application role

[scripts/provision-runtime-database.ts](../../scripts/provision-runtime-database.ts) defaults to a dry-run grant summary for a new role. It requires a matching direct Neon owner connection, applied migrations and an absent role. `--apply` creates the reviewed role and writes a new owner-readable `.env.runtime`; it refuses to overwrite an existing file or alter an existing role. Optional `--role=careloop_runtime` names the role. It never prints the generated credential.

Provisioning is complete for the current target; do not rerun it as a routine health check. `pnpm db:check` is the read-only checker. Runtime privileges were verified: 56 SELECT tables, 49 INSERT tables, 19 UPDATE tables plus the signed-note row-lock column, DELETE only on role assignments, no schema CREATE, clinical DELETE, migration INSERT, superuser, CREATEDB, CREATEROLE or BYPASSRLS.
