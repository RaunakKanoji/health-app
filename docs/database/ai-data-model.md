# AI data and provenance

The new laboratory analysis is a local deterministic synthetic summary. It counts and preserves recorded measurements with units/reference ranges, includes a review-required finding and explicitly stores `diagnosis: null` and `externalTransmission: false`. It is not medical-model inference, OCR, validated clinical decision support or a diagnostic classifier.

The existing episode assistant remains a separate bounded record-based fallback in `ai_recommendations`. Neither path approves diagnoses or prescriptions.

`ai_analyses` stores provider, model identifier/version, input-context version hash, structured output and lifecycle status. `ai_analysis_sources` records explicit same-patient source references/version. `ai_findings` stores draft findings separately from clinician-authored plans. Optional confidence is not manufactured when no calibrated interpretation exists.

Creation leaves an analysis `pending_review`. An approved treating clinician explicitly accepts or rejects it. Accepted analyses become `reviewed`; findings become `accepted`. Source corrections preserve immutable laboratory history, reset report review and supersede affected analyses. Review verifies the current input hash while serializing against report changes. Historical outputs are retained rather than overwritten.

`getPatientClinicalContext` returns selected profile, observations, consultations/notes, reports/results, plans, follow-ups and optional AI history. It is authorized, bounded and marks source limitations. Patients receive released clinical projections; unreviewed FHIR source observations are omitted for patients. No vector extension, embedding pipeline or default external export was introduced.

General conditions, allergies, prescriptions and structured diagnoses are deferred. AI-generated possibilities must never be inserted into a future confirmed-condition table without a distinct clinician-authorized workflow.
