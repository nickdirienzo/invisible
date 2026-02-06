# 1. Use Node.js Stdlib Primitives as the Infrastructure Abstraction Layer

Date: 2025-02-06

## Status

Accepted

## Context

II needs a way for developers (and AI agents like Claude) to express infrastructure requirements without learning new APIs, DSLs, or platform-specific SDKs. Traditional approaches require explicit infrastructure declarations — Terraform files, cloud SDK calls, or framework-specific abstractions like Vercel's `@vercel/kv`.

The core insight is that developers already express infrastructure intent through familiar Node.js stdlib patterns: `Map` for key-value storage, `Array` with push/shift for queues, `EventEmitter` for pub/sub, `node:fs` for file storage, `node:sqlite` for databases, and `process.env` for secrets.

We considered three approaches:

1. **Custom DSL / SDK** — A new `@iil/kv`, `@iil/queue` API. Familiar to platform engineers but creates lock-in, requires documentation, and LLMs need training on new APIs.
2. **Decorator / annotation-based** — TypeScript decorators like `@Durable() const cache = new Map()`. Explicit but adds syntax noise, requires build tooling, and is unfamiliar to most developers.
3. **Stdlib inference** — Analyze standard Node.js code patterns and infer infrastructure. Zero new APIs to learn, works with any LLM that writes Node.js, code remains portable.

## Decision

We will use Node.js stdlib primitives as the sole interface for expressing infrastructure requirements. A static analysis planner will infer what infrastructure each pattern requires at deploy time.

The central design principle is: **"The code means what it looks like it means."**

A module-level `Map` that looks like persistent state becomes persistent state. An `EventEmitter` that looks like a message bus becomes a distributed message bus. No annotations, no SDKs, no new APIs.

## Consequences

**Positive:**
- Zero learning curve for any developer or LLM that writes Node.js.
- Code is fully portable — runs locally with native Node.js, runs on any cloud with II shims.
- No vendor lock-in at the API level.
- AI agents generate correct infrastructure-aware code without specialized training.

**Negative:**
- Static analysis has limits — some patterns will be ambiguous and require an escape hatch (e.g., `Ephemeral<Map<K, V>>` type hint).
- The planner must handle edge cases gracefully with clear warnings rather than silent misclassification.
- Developers must understand the inference rules (scope-based durability, path-based storage) even though they don't need new APIs.
- Some advanced infrastructure patterns (FIFO guarantees, exactly-once delivery) may not map cleanly to stdlib primitives.
