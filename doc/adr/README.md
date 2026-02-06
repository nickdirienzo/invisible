# Architecture Decision Records

This directory contains the Architecture Decision Records (ADRs) for the Invisible Infrastructure (II) project.

## Index

- [ADR-0000](0000-record-architecture-decisions.md) — Record Architecture Decisions
- [ADR-0001](0001-use-nodejs-stdlib-as-infrastructure-abstraction.md) — Use Node.js Stdlib Primitives as the Infrastructure Abstraction Layer
- [ADR-0002](0002-open-standards-over-cloud-specific-services.md) — Target Open Standards Instead of Cloud-Specific Services
- [ADR-0003](0003-scope-based-durability-inference.md) — Use Declaration Scope to Infer Durability
- [ADR-0004](0004-runtime-shims-over-source-transformation.md) — Use Runtime Shims Instead of Source Code Transformation
- [ADR-0005](0005-valkey-as-unified-state-backend.md) — Use Valkey as the Unified State Backend
- [ADR-0006](0006-dapr-for-distributed-infrastructure.md) — Use Dapr for Distributed Infrastructure Primitives
- [ADR-0007](0007-libsql-sqlite-for-database-layer.md) — Use Libsql (SQLite Protocol) for the Database Layer
- [ADR-0008](0008-openbao-for-secrets-management.md) — Use OpenBao for Least-Privilege Secrets Management
- [ADR-0009](0009-compliance-by-default.md) — Provision Compliance Controls by Default
- [ADR-0010](0010-open-source-planner-hosted-runtime-business-model.md) — Open Source Planner with Hosted Runtime Business Model
- [ADR-0011](0011-kubernetes-for-compute-and-ingress.md) — Target Kubernetes for Compute and HTTP Ingress

## Creating New ADRs

To add a new decision record:

1. Copy the template from ADR-0000
2. Number it sequentially (next: `0012`)
3. Use a descriptive filename: `NNNN-short-title-with-hyphens.md`
4. Fill in Context (why), Decision (what), and Consequences (tradeoffs)
5. Set status to `Proposed`, then update to `Accepted` after team review

## Statuses

- **Proposed** — Under discussion
- **Accepted** — Approved and in effect
- **Deprecated** — No longer applies (replaced by a newer ADR)
- **Superseded** — Replaced by another ADR (link to replacement)
