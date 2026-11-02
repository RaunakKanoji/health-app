# Shared application contracts

`src/careloop.ts` defines roles, episode projections, metrics, commands and strict runtime Zod validation. These contracts connect Next.js, Fastify, worker, scenarios and tests. Existing `src/governance` remains preserved reference implementation. Actual endpoint shapes are in the [API guide](../../docs/architecture/api.md).
