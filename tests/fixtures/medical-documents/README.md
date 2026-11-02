# Synthetic medical document fixtures

These nine documents contain no real patient data. Their values are software test data, not clinical guidance. The eight PDFs have real text and can be regenerated with `node --import tsx scripts/fixtures/generate-medical-documents.ts`. `synthetic-scanned.png` is a rasterization of `synthetic-hba1c.pdf` and requires an OCR provider to extract its text.

| Fixture | Expected source-grounded result |
| --- | --- |
| CBC | Hemoglobin 13.4 g/dL; white blood cells 6.2 10^9/L; platelets 235 10^9/L |
| HbA1c | Original precision `5.2000`, `%`, reference `4.0 - 5.6`; source collection date 2026-10-01; HPLC method |
| HbA1c follow-up | Original precision `5.5000`, `%`; source collection date 2026-11-01; HPLC method |
| Lipids | Total cholesterol 210 mg/dL; triglycerides 125 mg/dL; observation dates absent |
| Metabolic | Sodium 140 mmol/L; potassium 4.1 mmol/L; creatinine 0.80 mg/dL; observation dates absent |
| Consultation | Exact quoted impression; no inferred laboratory results or treatment guidance |
| Prescription | Exact quoted synthetic placeholder; no invented medicine, dosing, or clinical advice |
| Ambiguous | `1O5` and `<5` remain textual values; no numeric correction or invented unit/range |
| Scanned PNG | `OCR_UNAVAILABLE` without configured Google Document AI; original still requires successful security checks |

The fixture scanner requires all three flags: `DOCUMENT_SYNTHETIC_FIXTURES=true`, `DEMO_MODE=true`, and `DATABASE_ENVIRONMENT=development` or `test`. It accepts only the committed bytes' SHA-256 values. Changes to a filename, a synthetic label, or a document metadata flag cannot bypass security scanning. Arbitrary files require a real ClamD scanner.

Every extracted observation is unverified until an authorized treating clinician verifies or corrects it and approves its document. A report date is never substituted for a missing collection/observation date. Trend comparisons require explicit matching units, method, and specimen context.

OCR uses the canonical `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_CLOUD_LOCATION`, and `GOOGLE_DOCUMENT_AI_PROCESSOR_ID` variables plus Application Default Credentials. Existing `GOOGLE_CLOUD_PROJECT` and `GOOGLE_DOCUMENT_AI_LOCATION` aliases are accepted only when they agree with any canonical values. `DOCUMENT_EXTERNAL_PROCESSING_ALLOWED=true` is required before sending document bytes or text to OCR or MedGemma. Unconfigured providers are reported as unavailable; summaries remain source quotes and counts rather than fabricated AI output.

When an authorized MedGemma response includes valid `summaryQuotes`, the adapter produces a `model_source_quotes` summary with a `model_provisional` label. It selects entire exact clinical source lines and preserves negations, values, and qualifiers; it cannot introduce free-form diagnoses or treatment instructions. Unsupported, altered, cross-page, or instruction-only quotations are rejected. Responses without summary quotations retain the native source summary and add `AI_SUMMARY_UNAVAILABLE`. Model confidence is not fabricated.
