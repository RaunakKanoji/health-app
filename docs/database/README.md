# CareLoop database

CareLoop Prototype uses PostgreSQL through `pg` and typed Drizzle mappings. Next.js calls the existing Fastify API; clinical services enforce Clerk identity, current application roles and patient relationships before querying PostgreSQL. The additive longitudinal-care implementation preserves the original screening-to-care workflows and migrations.

This is a synthetic demonstration, not a system approved for real patient information. The application now uses the user-selected Neon `health-app` project. Its `production` branch contains the verified copy of 715 existing rows, preserving all 16 episodes, 17 patients and 23 users. The local source is unchanged. A separate development branch passed real HTTP, database and private-object-storage verification; that probe used injected test identities, not live Clerk authentication. See [implementation status](implementation-status.md) for execution evidence and limitations.

- [Architecture and existing-page integration](architecture.md)
- [Schema and data dictionary](schema.md) · [entity relationships](entity-relationships.md)
- [Neon setup](neon-setup.md) · [environment variables](environment-variables.md)
- [Migrations](migrations.md) · [synthetic seed](seed-data.md)
- [Clerk integration](clerk-integration.md) · [patient access](patient-data-access.md)
- [AI model and provenance](ai-data-model.md) · [testing](testing.md)

The SQL files in `packages/db/migrations/` are authoritative migration history. Do not modify an applied checksum, reset a database, or run schema synchronization to make a generated model match.

Implementation entry points: [typed schema](../../packages/db/src/schema.ts), [clinical service](../../packages/workflows/src/clinical-records.ts), [document service](../../packages/workflows/src/medical-documents.ts), [clinical API](../../apps/api/src/clinical-records.ts), [document API](../../apps/api/src/documents.ts), [clinical panel](../../apps/web/src/components/patient-clinical-records.tsx), [transfer utility](../../scripts/migrate-local-to-neon.ts), [runtime role provisioning](../../scripts/provision-runtime-database.ts), and [live development verification](../../scripts/verify-neon-development.ts).
