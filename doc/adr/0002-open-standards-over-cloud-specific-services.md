# 2. Target Open Standards Instead of Cloud-Specific Services

Date: 2025-02-06

## Status

Accepted

## Context

When the planner infers that code needs a key-value store, a queue, a database, or a pub/sub system, it must decide what to provision. There are two fundamental approaches:

1. **Direct cloud mapping** — Map each inferred primitive to the cloud provider's native service: `Map` → DynamoDB (AWS) / Firestore (GCP) / CosmosDB (Azure). This maximizes native performance but creates N different backends the planner must understand, each with unique semantics (DynamoDB partition keys, SQS visibility timeouts, etc.).

2. **Open standard mapping** — Map each primitive to an open standard that runs identically on any cloud: `Map` → Valkey, database → Libsql, jobs → Dapr, pub/sub → Dapr, secrets → OpenBao. One intermediate representation (IR) for all targets.

The direct mapping approach is how most multi-cloud tools work, and it's why most multi-cloud tools fail. Each cloud service has different consistency models, different limitations, and different failure modes. A planner that targets DynamoDB, Firestore, and CosmosDB simultaneously is really three planners wearing a trenchcoat.

## Decision

We will target open standards (Valkey, Libsql, Dapr, OpenBao) as our intermediate representation rather than mapping directly to cloud-native services. Every cloud gets the same backend — the only thing that changes is where and how that backend is hosted.

The specific standard for each infrastructure primitive:

- **Key-value / queues / pub-sub state** → Valkey (open-source Redis fork)
- **Relational database** → Libsql (SQLite wire protocol)
- **Job scheduling** → Dapr Jobs API
- **Distributed pub/sub** → Dapr Pub/Sub
- **Blob storage** → Dapr Bindings
- **Secrets** → OpenBao (Linux Foundation Vault fork)

## Consequences

**Positive:**
- One IR for all clouds — the planner is dramatically simpler.
- True portability: same behavior in dev (local Docker) and prod (any cloud).
- No vendor lock-in at the infrastructure level. Users can self-host everything.
- All chosen standards are CNCF-graduated or Linux Foundation backed — strong governance and community.

**Negative:**
- May sacrifice some cloud-native performance optimizations (e.g., DynamoDB's auto-scaling, Spanner's global consistency).
- Adds an abstraction layer that must be managed and kept updated.
- Some teams may want to use cloud-native services they already have expertise in.
- Open-source projects can fork or change direction (mitigated by choosing well-governed projects).
