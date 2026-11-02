# Security implementation

The original governance security module remains in `src/governance`. Runtime session authentication is in `../auth`, authorization/closure rules in `../domain`, transactional tenant enforcement in `../workflows` and SQL constraints in `../db`. See [threat model](../../docs/security/threat-model.md) and [privacy](../../docs/security/privacy-and-consent.md).
