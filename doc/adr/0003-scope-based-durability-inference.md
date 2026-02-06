# 3. Use Declaration Scope to Infer Durability

Date: 2025-02-06

## Status

Accepted

## Context

When the planner encounters a `new Map()` or `new Array()` in source code, it must determine whether the data structure should be ephemeral (dies with the process/request) or durable (persists across requests, restarts, and scaling events). Getting this wrong is catastrophic in either direction: making ephemeral state durable wastes resources and adds latency; making durable state ephemeral causes silent data loss.

We considered several signals for durability:

1. **Explicit annotations** — `@Durable const cache = new Map()` or `new DurableMap()`. Clear but adds API surface and defeats the stdlib-only goal.
2. **Usage-based heuristics** — If a Map is read and written across multiple request handlers, it's probably durable. Requires complex interprocedural analysis and is error-prone.
3. **Scope-based inference** — Module-level declarations are durable; function-scoped declarations are ephemeral. Simple, matches developer intuition, and covers 99% of cases.

The scope-based approach works because it matches how developers already think about state lifetime. A module-level `const sessions = new Map()` intuitively feels like it should persist across requests — and in traditional servers, it does. The serverless footgun is that this state silently vanishes between cold starts. II fixes this by making the intuition correct.

## Decision

We will use the lexical scope of a data structure's declaration as the primary signal for durability:

- **Module scope** (top-level of a file) → durable. The data structure is backed by a persistent store (Valkey) and survives process restarts, scaling events, and redeployments.
- **Function scope** (inside a function, handler, or block) → ephemeral. The data structure lives in memory for the duration of that function call only.

For the rare case where a developer wants a module-level data structure to remain ephemeral (e.g., a per-instance LRU cache), we provide an escape hatch: `Ephemeral<Map<K, V>>`.

Additional inference rules refine durability:

- **Type serializability** — If the Map's value type is not serializable (e.g., `Map<string, WebSocket>`), it stays ephemeral regardless of scope, with a warning.
- **Access patterns** — If an Array is only used with `push`/`shift`, it's inferred as a queue (FIFO). Random access patterns trigger a warning about potential performance on distributed backing.

## Consequences

**Positive:**
- No new APIs or annotations needed in 99% of cases.
- Matches developer intuition — "module state persists" becomes actually true.
- Fixes a real serverless footgun (silent state loss between cold starts).
- Simple for the planner to implement — scope analysis is a solved problem in static analysis.

**Negative:**
- Developers must understand the scope rule, even though it's intuitive.
- The escape hatch (`Ephemeral<T>`) is technically a new type — though it's opt-in and rare.
- Type serializability analysis has limits (generic types, dynamic values) and may produce false positives/negatives.
- Module-scope Maps with millions of entries could have surprising latency characteristics when backed by a remote store.
