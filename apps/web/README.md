# CareLoop web workspace

Next.js App Router, React, Tailwind CSS, Lucide icons and a shadcn-style Radix Slot button primitive. The local Fastify API is reached through the same-origin `/api` rewrite; server-side sessions and authorization remain authoritative.

Run `pnpm demo:setup` and `pnpm dev` from the repository root. Open <http://localhost:3000>. The sign-in screen exposes the synthetic demonstration accounts; all use the local-only password documented in the root README. The site does not use external font or image requests.

The clinician, coordinator and receiving-provider workspaces provide a persisted episode queue, result intake, reviewed patient explanations, referrals, actual encounter recording, evidence and clinician-approved closure. Population filters and exports use authorized persisted records. The local inbox shows simulated communication outcomes. The administrator demonstration lab invokes the actual scenario API. The record-grounded assistant is read-only and presents citations and draft administrative suggestions.

Patients see only their own authorized records, with English or Arabic navigation and RTL layout, acknowledgement, help requests and optional-contact preferences. Clinician-authored result explanations retain their original approved wording; this prototype does not automatically translate clinical content. Dates and times use the browser's local timezone.

Evidence import accepts bounded plain `.txt` content only, which is persisted privately inside the episode and requires clinical verification. Closure indicators use the same browser-safe `closureGaps` domain helper as the backend. They are explanatory controls; the API independently verifies all prerequisites and permissions.

Verification:

- `pnpm --filter @careloop/web typecheck`
- `pnpm lint`
- `pnpm exec playwright test tests/e2e/careloop.spec.ts`
- `pnpm exec playwright test tests/e2e/accessibility.spec.ts`

The accessibility suite checks WCAG 2.1 A/AA rules with Axe on login, clinician overview, result intake and English/Arabic patient views and preferences. It also checks modal Escape behavior and focus restoration. Automated checks do not replace manual keyboard, screen-reader and clinical usability assessment. Reports are written to `docs/evaluation/accessibility`; demonstration screenshots are saved to `docs/demo/screenshots`.
