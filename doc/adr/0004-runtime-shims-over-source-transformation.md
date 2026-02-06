# 4. Use Runtime Shims Instead of Source Code Transformation

Date: 2025-02-06

## Status

Accepted

## Context

Once the planner has determined that a `new EventEmitter()` should become a distributed pub/sub system, or that `writeFile('/uploads/...')` should target blob storage, the system must bridge the gap between the stdlib API the developer wrote and the distributed backend that actually handles it.

Two approaches were considered:

1. **Source code transformation (compile-time)** — Rewrite the developer's code at build time. Replace `new EventEmitter()` with `new DaprPubSubClient()` and `writeFile` with `daprBindings.write()`. The deployed code is different from what the developer wrote.

2. **Runtime shims (deploy-time)** — Keep the developer's code as-is. At runtime, swap the stdlib implementations with infrastructure-backed versions. `new EventEmitter()` returns an `IIDistributedEventEmitter` that speaks the same API but routes through Dapr.

Source transformation is fragile: it breaks source maps, complicates debugging, and means the deployed code doesn't match what's in git. Runtime shims preserve the developer's code exactly — the magic is in the runtime, not the build.

## Decision

We will use runtime shims that implement stdlib-compatible interfaces backed by infrastructure services. The developer's source code is never modified.

Shim examples:

- `EventEmitter` → `IIDistributedEventEmitter` (routes `.on()`/`.emit()` through Dapr Pub/Sub)
- `node:fs` operations on durable paths → Dapr Bindings (S3, R2, GCS, Azure Blob)
- `process.env` → OpenBao dynamic secret fetching with per-service policies
- `Map` / `Array` (module scope) → Valkey-backed implementations with same API

The shims are injected by the II runtime loader. In local development, the native Node.js implementations are used directly — no shims, no infrastructure. This gives developers the same code path locally and in production, differing only in the backing implementation.

## Consequences

**Positive:**
- Developer's source code is unchanged — what's in git is what runs.
- Debugging is straightforward: source maps work, stack traces are clean.
- Local development uses native Node.js with zero infrastructure dependencies.
- Ejection is trivial — remove the runtime, code still runs (with ephemeral state).

**Negative:**
- Runtime shims add a layer of indirection that could mask errors or introduce subtle behavioral differences.
- Some stdlib APIs have edge cases that are difficult to replicate in a distributed context (e.g., synchronous `fs.readFileSync` over a network).
- The shim layer must maintain API compatibility as Node.js evolves.
- Performance characteristics differ between native and shim implementations — developers may be surprised by latency.
