# CareLoop — Initial prototype

The original Codex application implementation from 27 October 2026 (`af9388e`), published as a standalone prototype. Later development, the legacy specification archive, prompts and progress trackers are excluded.

Synthetic demonstration only. No real patient messages or autonomous clinical decisions. This prototype is not clinically validated or approved for production use.

## Run

Requirements: Node.js 24+, pnpm 11.12.0, and PostgreSQL 17+ binaries or Docker.

```sh
pnpm install --frozen-lockfile
pnpm demo:setup
```

For a fresh local installation, configure the selected Clerk development application using [authentication setup](docs/authentication/clerk-setup.md), then run `pnpm dev` and open **http://localhost:3001**. Setup creates a local PostgreSQL database, applies six migrations and seeds synthetic records. The web app, Fastify API (port 4001) and worker run together.

The current workspace is connected to the selected Neon `health-app` project. Its `production` branch contains the preserved synthetic prototype dataset; separate `development` and `staging` branches isolate future work. For this configured workspace, use `pnpm db:check` and `pnpm dev`; local setup/reset commands are not part of the Neon startup flow. See [database setup and verified implementation](docs/database/README.md), [schema](docs/database/schema.md), and [entity relationships](docs/database/entity-relationships.md).

Neon CLI manages the owner connection and private-storage credentials. The API and worker use a restricted `DATABASE_RUNTIME_URL` from ignored `.env.runtime`. Remote startup checks migrations without applying or seeding them. Keep `.env*`, `.neon`, and local context out of Git. New clinical-record forms persist consultations, signed notes, laboratory measurements, reviewed synthetic summaries, clinician-authored plans and follow-ups; private document uploads use Neon object storage.

Authentication uses Clerk. Public registration leads to patient onboarding or a clinician access request; clinicians need demo approval and explicit patient assignments. Existing synthetic user IDs and records are preserved, but old demo passwords and sessions no longer authenticate. Trusted operators explicitly link existing accounts using `pnpm identity:provision`; see the setup guide. `DEMO_MODE=true` is required.

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
The seed, scenario simulation and Synthea import commands require a development/test target and refuse the configured production environment. Use the isolated tests for verification of the running Neon setup; see [database testing](docs/database/testing.md).

The original clinical workspaces and workflows are retained. The Clerk migration adds identity synchronization, patient and clinician onboarding, administration, record-level access checks and patient-specific responses; see [implementation and verification](docs/authentication/README.md). Authentication screens and the new clinical-record panel support English and Hindi; the broader workspace translation work is separate. FHIR validation remains a structural subset, outbound messaging is simulated and existing episode evidence remains plain text. The [medical-document workspace](docs/medical-documents.md) supports private versioned PDF/JPEG/PNG uploads, quarantine, native PDF extraction, clinician review, evidence history and verified trends. R2, ClamAV, Google OCR and MedGemma adapters require their own configuration; unavailable providers are reported explicitly. Clinical policy approval, regulatory agreements and external clinical integrations remain outside this synthetic prototype. The Neon branch name does not make this synthetic prototype approved for real patient use.
