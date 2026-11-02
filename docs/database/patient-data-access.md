# Patient data access

All clinical records and private documents are served through authenticated Fastify handlers. `WorkflowService.canAccessPatient` rechecks active account, completed onboarding, current role/organization, clinician approval and active care relationship. Owning patients can read their own records. Unrelated patients, unapproved clinicians and administrators without an explicit relationship receive no patient access. Receiving-provider episode grants do not grant a patient's entire longitudinal history.

Only approved treating clinicians can create consultations, clinical notes, investigations, summaries, treatment plans and follow-ups or review reports/analyses. Patients and approved treating clinicians can upload permitted medical files. UI controls supplement these server checks; route-ID substitution never grants access.

## API surface

| Endpoint | Operation |
| --- | --- |
| `GET /api/patients?limit=20&offset=0` | Authorized directory, including patients without episodes |
| `GET /api/patients/:id/clinical-records?limit=20&offset=0` | Bounded clinical collections, role-specific release filtering |
| `POST /api/patients/:id/clinical-records/:resource` | Validated clinical create command with `Idempotency-Key` |
| `POST /api/patients/:id/clinical-records/:resource/:recordId/review` | Explicit report or analysis review with `Idempotency-Key` |
| `POST /api/patients/:id/clinical-context` | Authorized bounded clinical context with optional collection flags |
| `GET/POST /api/patients/:id/documents` | Private document metadata/list and bounded upload |
| `POST /api/patients/:id/documents/:documentId/download` | Reauthorize and issue an expiring download URL |
| `GET /api/health/database` | Authenticated, sanitized connectivity status |

Create resources are `consultations`, `notes`, `lab-orders`, `lab-reports`, `lab-results`, `analyses`, `treatment-plans` and `followups`. Strict Zod schemas reject unknown input fields. Clinical SQL binds values; interpolated table/column identifiers are closed code constants.

## Release and provenance

Patients receive signed notes, reviewed reports/results, reviewed analyses with accepted findings, approved/completed plans and follow-ups. Unreviewed staff narratives are not released by displaying a hidden button. Corrected results preserve the original row, reset report review and supersede dependent analyses. Read projections omit private storage keys; downloads require the same patient authorization and document release policy.

The service bounds collections and context size. No generic pooled-connection RLS policy or database-owner bypass is presented as application authorization. RLS is deferred pending a deliberate runtime-role/session design. The selected target now uses the restricted `careloop_runtime` PostgreSQL role; its grant policy and verified denials are documented in [Neon setup](neon-setup.md). New deployments need equivalent reviewed provisioning.

## Example service call

```ts
// actor comes from the existing verified API authentication boundary.
const records = await clinical.records(actor, patientId, { limit: 20, offset: 0 });
const context = await clinical.getPatientClinicalContext(actor, patientId, {
  includeConsultations: true,
  includeLabResults: true,
  includeTreatments: true,
  includeAIHistory: false,
});
```

Do not call raw database exports from React. Do not transmit this context to an external model without an explicitly approved provider, purpose and data scope.
