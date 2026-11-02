# Observability boundaries

The API emits OpenTelemetry-compatible command spans, safe request IDs and redacted error/denial records; worker emits aggregate processing/failure events. Health checks query PostgreSQL. The demo does not configure an external trace exporter. Ordinary logs contain neither patient narratives nor credentials. See [system](../../docs/architecture/system.md) and [threat model](../../docs/security/threat-model.md).
