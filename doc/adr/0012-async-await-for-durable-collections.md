# 12. Accept Async Await for Durable Collections

Date: 2025-02-06

## Status

Accepted

## Context

ADR-0004 established that runtime shims should replace stdlib implementations transparently, preserving the developer's source code. However, a fundamental tension arises with durable collections (Map, Array) backed by Valkey (ADR-0005): the native `Map.get()` and `Map.set()` APIs are synchronous, but Valkey operations are inherently asynchronous over the network.

We considered several approaches to bridge this gap:

1. **Synchronous Valkey client** via SharedArrayBuffer + Atomics + worker threads. This would preserve the exact `Map` API but blocks the event loop, harming server throughput. The implementation is complex, fragile, and poorly supported in Node.js module loaders.

2. **Global Map constructor patching** that returns a synchronous-looking proxy backed by a local cache with async sync. This hides the async nature but introduces subtle consistency bugs (stale reads, lost writes) that are worse than an explicit API change.

3. **Accept `await`** on collection operations. The DurableMap class returns Promises from `get`, `set`, `has`, `delete`. Developers write `await counters.get(key)` instead of `counters.get(key)`.

4. **New explicit API** like `DurableMap` imported from `@invisible/runtime`. This is transparent but violates the stdlib-only goal (ADR-0001).

## Decision

We accept `await` as the one visible concession to distributed backing. Developers use `await` on Map operations that may be durable.

This works because of a JavaScript language property: `await` on a non-Promise value is a no-op. This means the same source code runs correctly in both environments:

- **Local dev** (native Map): `await counters.get("foo")` resolves immediately because `Map.get()` returns a value, not a Promise. The `await` is harmless.
- **Deployed** (DurableMap shim): `await counters.get("foo")` resolves the Promise from the Valkey-backed implementation.

The developer writes one version of their code. The runtime environment determines whether the `await` does real async work or is a no-op.

## Consequences

**Positive:**
- Same source code works in both local and deployed environments without conditional logic.
- The `await` keyword serves as a natural hint that these operations may have latency, which is honest about the distributed nature.
- No complex synchronous workarounds that harm server performance or introduce consistency bugs.
- TypeScript can type-check both paths: `await T` resolves to `T` whether the input is `T` or `Promise<T>`.

**Negative:**
- Developers must remember to `await` Map operations on module-scope collections. Forgetting `await` in deployed mode silently returns a Promise object instead of the value.
- This is a deviation from the "fully invisible" ideal. The infrastructure is not entirely invisible; there is one syntactic marker.
- Request handlers must be `async` functions (already the norm in Express/Fastify, but worth noting).
- Iterators (`for...of` over `map.entries()`) don't work directly since the iteration methods return Promises. Developers must `await` first: `for (const [k, v] of await counters.entries())`.
