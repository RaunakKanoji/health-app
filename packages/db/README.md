# PostgreSQL and Drizzle

`src/index.ts` provides scoped transactions and checksum-verified migrations; `src/schema.ts` contains typed Drizzle projections. Four versioned SQL migrations implement normalized facts, immutable history, evidence binding, tenant integrity and consent sequence. Run `pnpm db:migrate` then `pnpm db:seed`. See [database guide](../../docs/architecture/database.md).
