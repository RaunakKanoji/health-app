# FHIR R4 ingestion

`src/index.ts` validates a bounded structural subset for14 R4 resource types, preserves coding/source data and recognizes explicitly source-flagged supported findings. It is not a complete profile/terminology validator. Patient/results normalize into operational records; other types retain provenance without implicitly authorizing clinical actions. Run `pnpm import:synthea` for the official retained Bundle. See [backend boundaries](../../docs/architecture/backend-handoff.md).
