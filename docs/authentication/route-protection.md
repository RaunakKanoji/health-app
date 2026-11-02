# Route and session protection

The Next.js proxy supplies page-level session checks; Fastify and the application services enforce data access. A hidden control, client redirect, or browser role value is never the authorization boundary.

## Web routes

`apps/web/src/proxy.ts` runs `clerkMiddleware` for application pages and API paths. Sign-in and sign-up catchalls are public. Unauthenticated application page requests redirect to `/sign-in` with a limited internal `next` path. API requests continue to Fastify so callers receive JSON authentication/authorization errors rather than a page redirect.

`next.config.ts` enables the documented `skipProxyUrlNormalize` option. With Next 16.4.3 and a local `127.0.0.1` listener, URL normalization otherwise changes Clerk’s same-URL rewrite to `localhost`; Next treats it as an external rewrite and recursively proxies the request. Preserving the original URL avoids that loop without weakening any session or API checks. This was verified against the running local sign-up page and API health rewrite.

| Route | Client gate after Clerk session check |
| --- | --- |
| `/` | Completed onboarding and a server identity destination of `/`; administrators are sent to `/admin`. |
| `/admin` | Server application role `admin`; other users return to their authorized destination. |
| `/onboarding`, `/onboarding/patient`, `/onboarding/clinician` | Incomplete onboarding; pending/rejected clinicians go to the pending page. |
| `/onboarding/clinician/pending` | A pending/rejected clinician application; completed users leave onboarding. |
| `/account/[[...account]]` | An active, resolved application identity, including users still completing onboarding. |
| `/auth/continue` | Resolve identity, then replace the route with an authorized destination. |

Catchall sign-in/sign-up/account components and the continuation page use Suspense. No medical records are embedded in these page responses or Clerk metadata.

## Return URL rules

`safeReturnPath` accepts only exact application-owned paths: `/`, `/account`, `/admin`, `/onboarding`, `/onboarding/patient`, `/onboarding/clinician`, and `/onboarding/clinician/pending`. Absolute URLs, protocol-relative URLs, backslashes, queries, fragments, and unknown paths are rejected.

`authorizedReturnPath` additionally checks the resolved identity. Account management is available to a resolved user; incomplete/pending onboarding takes precedence over workspace targets. `/admin` is honored only for administrators. Administrators requesting `/` still return to `/admin`. Other onboarding targets collapse to the server's current canonical destination. The auth components force redirects through `/auth/continue`, overriding arbitrary Clerk redirect query parameters.

## API boundaries

The shared request helper obtains the current Clerk session token via `useAuth().getToken()` and sends `Authorization: Bearer ...` to the same-origin `/api` rewrite. It uses `cache: 'no-store'`. Fastify accepts a verified Clerk session token in the authorization header or the same-origin `__session` cookie. Legacy CareLoop session cookies/passwords are not authentication fallbacks.

The production verifier validates the selected issuer, authorized frontend origin, token, and active Clerk user/session. Application services then read the current database identity, status, role, clinician approval, and record relationships. Browser metadata does not set roles or patient IDs.

| API | Protection / behavior |
| --- | --- |
| `GET /api/health` | Public operational health check. |
| `POST /api/webhooks/clerk` | Requires a verified Clerk/Svix signature over the raw body; not a browser session. |
| `POST /api/auth/login`, `POST /api/auth/logout` | Retired custom-auth entrypoints; return 410 and direct callers to Clerk. |
| `GET /api/auth/me` | Verified active Clerk identity; retained compatibility endpoint. |
| `GET /api/identity` | Verified identity and server-derived onboarding/destination. |
| `POST /api/onboarding/patient`, `POST /api/onboarding/clinician` | Authenticated self-onboarding only; strict field validation and server transition checks. |
| `GET /api/admin/users`, `GET /api/admin/clinicians` | Administrator-only identity directory and clinician applications. |
| `POST /api/admin/clinicians/:userId/review` | Administrator-only review, with decision and reason. |
| `POST /api/admin/users/:id/status`, `POST /api/admin/users/:id/role` | Administrator-only permitted status/role transitions. |
| `GET/POST /api/admin/relationships` | Administrator-only directory/access grants with an authorization basis. |
| `POST /api/admin/relationships/:id/revoke` | Administrator-only relationship revocation. |
| `GET /api/admin/audit` | Administrator-only identity/access audit; does not retrieve medical record content. |
| `/api/workspace`, `/api/episodes`, `/api/episodes/:id` | Current server authorization and record-level visibility. |
| `/api/episodes/:id/actions`, `/api/episodes/:id/assistant` | Current record access plus action-specific permissions. |
| `/api/metrics`, `/api/inbox`, `/api/audit`, `/api/operations` | Role restrictions and server-scoped data; clinical audit is separate from the admin identity/access audit. |
| `/api/fhir/ingest` | Server-authorized clinical ingestion. |
| `/api/scenarios`, `/api/scenarios/run`, `/api/admin/tick` | Existing privileged synthetic demonstration operations; not a general grant to read clinical records. |

Administrative role membership does not implicitly grant patient access. The backend determines any explicitly authorized record access and continues to enforce the existing coordinator and receiving-provider workflow rules.

## Failure, caching, and stale data

- Unauthenticated/expired sessions produce 401. A resolved account lacking a permission produces 403, or a non-disclosing 404 for unavailable records. Configuration/authentication service failures produce 503.
- Identity failures clear the resolved identity and render manual retry/sign-out controls. The UI does not repeatedly redirect on 401/403/503.
- Workspace 401/403 responses clear cached workspace/selection and re-resolve identity. Other workspace errors remain visible with retry and, where appropriate, the existing offline view.
- Session changes increment a request epoch. Requests started under a previous epoch are rejected even if their HTTP response succeeds later. Identity and workspace loaders also reject superseded responses.
- Application sign-out clears identity and workspace state before calling Clerk. Clerk UserButton sign-out and account/session changes invalidate the current identity through the Clerk hooks. Browser back/forward-cache restoration re-resolves identity.
- The app does not persist access tokens, clinical data, or role claims in local storage. It stores only the interface-language preference there.

The frontend checks improve navigation and prevent stale UI exposure. Every protected API request remains independently authorized, including manually constructed URLs and direct API calls.
