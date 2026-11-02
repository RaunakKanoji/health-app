# Verification

`pnpm test` runs Vitest domain, FHIR, PostgreSQL integration, security and workflow tests. Each integration suite uses a temporary schema and drops it after closing connections. `TEST_DATABASE_URL` is explicit; the default is the isolated local synthetic database.

`pnpm test:e2e` runs15 Playwright lifecycle/accessibility/interrupted-response checks; it starts the local app if needed. `pnpm test:governance` preserves6 original Node tests. Python pytest covers17 research cases. See [results](../docs/evaluation/results.md) for actual counts and commands, and [limitations](../docs/evaluation/limitations.md). No penetration-test or clinical-validation claim is made.
