# CareLoop Fastify API

Implemented under `src/`. Start from the repository root with `pnpm dev:api` after migrations/seed. Routes are `/api/*`, documented in [API guide](../../docs/architecture/api.md). Sessions, role/patient/tenant checks, Zod, immutable history and transactional writes are enforced server-side. All outbound integrations are synthetic. `buildApp` supports isolated PostgreSQL integration tests.
