# Migrations

The repository's existing SQL migration runner is retained. It executes numbered SQL files in order inside a transaction, takes an advisory transaction lock and records each SHA-256 checksum in `schema_migrations`. Drizzle supplies typed mappings; introducing a second migration ledger or retroactively generating Drizzle Kit snapshots would jeopardize the existing history.

| Migration | Purpose |
| --- | --- |
| `0001_careloop.sql` | Original coordination schema and immutable history |
| `0002_evidence_binding.sql` | Result/evidence binding |
| `0003_tenant_foreign_keys.sql` | Tenant-safe references |
| `0004_consent_ordering.sql` | Deterministic consent ordering |
| `0005_clerk_identity.sql` | Additive Clerk identity, clinician approval and relationships |
| `0006_longitudinal_care.sql` | Twelve additive patient-care/idempotency tables, composite references, indexes and immutability guards |

The inspected local preview had 0001–0005 applied before this work. The user later selected an empty Neon branch named `production`; its controlled initial transfer/migration is tracked separately from routine development commands. Migrations 0001–0006 are now applied to the selected production target; the development verification branch was migrated independently. `pnpm db:check` returned status `ok`, six applied migrations and no pending files. Staging has not yet been migrated/verified.

## Development workflow

1. Confirm the explicit development/test target and inventory existing data.
2. Review the new SQL and direct connection configuration. Preserve every applied migration byte-for-byte.
3. Run the read-only checker: `pnpm db:check`.
4. Apply to the selected development database: `pnpm db:migrate`.
5. Run the checker again and the isolated integration tests. Verify existing IDs/counts and representative workflows.
6. Optionally run the controlled synthetic seed, only in the selected demonstration environment.

The checker tests `SELECT 1`, validates existing checksums and reports pending migration names. It creates no tables. Migrations require `DATABASE_DIRECT_URL` (or matching legacy alias) for remote databases; a local URL can be used directly. The supplied CLI rejects production/staging targets.

Remote API and worker startup verify that migrations are already applied. Local development bootstrap preserves existing local demo behavior. Do not start an application against a shared database just to inspect it: local bootstrap can migrate and seed. Tests must explicitly isolate their schema.

## Rollback and promotion

0006 does not drop or recreate existing tables. Do not implement rollback by deleting clinical histories or disabling immutable triggers. On failure the migration transaction rolls back; on an applied application change prefer a reviewed forward fix. For production, prepare backups, deployment order, least-privilege grants and a restore plan before an authorized deployment. Existing records are not exported or migrated to Neon automatically by changing connection strings.

## Selected target cutover

The selected Neon branch is explicitly classified as production even though this application and its source records are synthetic. The normal CLI continues to reject it. Do not change `DATABASE_ENVIRONMENT` to make a development-only command run. The initial transfer completed with explicit user approval: 715 rows from 43 original application tables were copied and hashed against the read-only source snapshot before commit. The source remained unchanged. Current production data is no longer empty; a repeat transfer must refuse it.

### Transfer utility safety

[scripts/migrate-local-to-neon.ts](../../scripts/migrate-local-to-neon.ts) defaults to a read-only dry run. It requires a privately supplied `SOURCE_DATABASE_URL` selecting an explicit local `careloop_preview_<id>` schema; shared local `public` data is rejected. The destination must be the selected direct Neon endpoint with matching migration history and no application records. The production target additionally requires `--allow-empty-production`; this flag is not a substitute for explicit authorization. `--apply` is the separate write switch.

For a newly authorized empty destination, review the dry run first:

```sh
# SOURCE_DATABASE_URL must already be supplied privately; never print it.
pnpm exec tsx --env-file=.env scripts/migrate-local-to-neon.ts --allow-empty-production
```

Only the specifically approved initialization adds `--apply`. The utility preserves original IDs, JSON/numeric/timestamp values and sequence positions; it compares table hashes in the destination transaction and rolls back on mismatch. It never overwrites existing records or disables immutable-history triggers. This initialization has already completed for the selected target.
