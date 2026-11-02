# CareLoop — Initial prototype

The original Codex application implementation from 27 October 2026 (`af9388e`), published as a standalone prototype. Later development, the legacy specification archive, prompts and progress trackers are excluded.

Synthetic demonstration only. No real patient messages or autonomous clinical decisions. This prototype is not clinically validated or approved for production use.

## Run

Requirements: Node.js 24+, pnpm 11.12.0, and PostgreSQL 17+ binaries or Docker.

```sh
pnpm install --frozen-lockfile
pnpm demo:setup
pnpm dev
```

Open **http://localhost:3000**. Use this hostname for the original prototype. Setup creates a local PostgreSQL database, applies four migrations and seeds synthetic records. The web app, Fastify API and worker run together.

Synthetic accounts: `clinician@careloop.demo`, `coordinator@careloop.demo`, `patient@careloop.demo`, `receiver@careloop.demo`, `admin@careloop.demo`. All use **`CareLoop-Demo-2026!`**. These public credentials are for local synthetic use only. `DEMO_MODE=true` is required.

Docker alternative: copy `.env.example` to `.env`, run `docker compose up -d postgres`, then `pnpm db:migrate`, `pnpm db:seed`, and `pnpm dev`.

## Application

- `apps/web`: Next.js patient, clinician, coordinator, receiving-provider and population workspaces; English/Arabic patient interface.
- `apps/api`: Fastify API and synthetic scenario runner.
- `apps/worker`: durable local background processing.
- `packages`: domain rules, contracts, PostgreSQL persistence, FHIR, authentication and read/draft-only assistance.
- `services/ml`: optional synthetic operational-risk research service; see its README.
- `data`: fictional fixtures and replay scenarios.
- `scripts`: setup, seed, simulation and evaluation.
- `tests`: unit, integration, security and Playwright checks.

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
pnpm simulate
pnpm evaluate
```

Database tests use isolated schemas in the local demonstration database unless `TEST_DATABASE_URL` is explicitly configured. Optional Python service setup is documented in `services/ml/README.md`.

The application code is preserved from the original implementation. The only packaging changes are this README and removal of two legacy specification/governance commands and their CI step, whose archived inputs are intentionally excluded. No later bug fixes or feature additions are included. FHIR validation is a structural subset, outbound messaging is simulated, evidence uploads are plain text, and production identity, privacy controls, clinical policy approval and live integrations remain future work.
