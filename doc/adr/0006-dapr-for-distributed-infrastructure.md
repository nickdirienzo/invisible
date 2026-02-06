# 6. Use Dapr for Distributed Infrastructure Primitives

Date: 2025-02-06

## Status

Accepted

## Context

Three of our inferred infrastructure patterns — job scheduling, distributed pub/sub, and blob storage — need a portable abstraction layer that works across clouds without tying us to any single provider's API.

We evaluated:

1. **Direct cloud SDK integration** — Use AWS SDK for S3, GCP SDK for Cloud Storage, etc. Maximum control but requires N implementations per cloud, each with different error handling, authentication, and edge cases.
2. **Custom abstraction layer** — Build our own adapters for each cloud service. Full control but massive maintenance burden.
3. **Dapr (Distributed Application Runtime)** — CNCF-graduated project that provides building blocks (pub/sub, bindings, jobs) with pluggable backends. One API, many backends.

Dapr is specifically designed for the problem we have: applications that need distributed infrastructure without coupling to a specific provider. It runs as a sidecar, speaks HTTP/gRPC, and has production-grade components for every major cloud.

## Decision

We will use Dapr for three infrastructure primitives:

**Job Scheduling (Dapr Jobs API):**
- Pattern detected: `setInterval(() => fetch('/local-route'), ms)` — only when the callback is a `fetch` to a local endpoint.
- Dapr provides durable cron with exactly-once-per-trigger semantics.
- Non-fetch `setInterval` callbacks stay in-memory (with a warning) since their logic can't be serialized.

**Distributed Pub/Sub (Dapr Pub/Sub):**
- Pattern detected: Module-scope `EventEmitter` with `.on()` and `.emit()`.
- Dapr Pub/Sub supports pluggable backends: Redis, Kafka, RabbitMQ, AWS SNS/SQS, GCP Pub/Sub, Azure Service Bus.
- The runtime shim replaces `EventEmitter` methods with Dapr topic operations.

**Blob Storage (Dapr Bindings):**
- Pattern detected: `node:fs` operations (`writeFile`, `readFile`) on durable paths (`/uploads`, `/files`, `/data`).
- Dapr Bindings support S3, Azure Blob, GCS, R2, and local filesystem.
- Ephemeral paths (`/tmp`, `./cache`) stay on the local container filesystem.

## Consequences

**Positive:**
- One API for all three patterns, across all clouds.
- CNCF-graduated — strong governance, large contributor base, production-proven.
- Sidecar model means no SDK to embed — just HTTP calls.
- Rich component ecosystem: 100+ components for different backends.
- Native Kubernetes integration with Dapr operator.

**Negative:**
- Sidecar adds operational complexity and resource overhead.
- Dapr is another runtime dependency that must be deployed and managed.
- Some Dapr components are more mature than others — we must choose carefully.
- Debugging through a sidecar layer adds complexity to troubleshooting.
- Teams unfamiliar with Dapr face a learning curve for operations (though developers never interact with Dapr directly).
