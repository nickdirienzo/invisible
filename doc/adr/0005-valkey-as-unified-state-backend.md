# 5. Use Valkey as the Unified State Backend

Date: 2025-02-06

## Status

Accepted

## Context

The planner infers three categories of state from stdlib patterns: key-value stores (from `Map`), queues (from `Array` with push/shift), and pub/sub channels (from `EventEmitter`). Each could map to a separate service (DynamoDB + SQS + SNS on AWS, for example), but this multiplies operational complexity and makes the planner's job harder.

We evaluated several options:

1. **Redis** — The de facto standard for in-memory data structures. However, Redis changed its license to SSPL in March 2024, making it non-open-source and creating legal ambiguity for hosted deployments.
2. **Valkey** — Linux Foundation fork of Redis 7.x, launched in response to the license change. Fully open source (BSD-3), backed by AWS, Google, Oracle, and the Linux Foundation. API-compatible with Redis.
3. **Dragonfly** — High-performance Redis alternative. BSL license (not open source). Smaller community.
4. **KeyDB** — Multi-threaded Redis fork. Smaller community, less cloud provider support.

Valkey won on governance (Linux Foundation), licensing (BSD-3), cloud availability (ElastiCache, Memorystore, Upstash all support it), and API compatibility (every Redis client works).

## Decision

We will use Valkey as the single backend for all inferred state primitives:

| Stdlib Pattern | Valkey Primitive |
|---|---|
| `Map.set(k, v)` / `Map.get(k)` | `HSET` / `HGET` (Hash) |
| `Array.push(item)` / `Array.shift()` | `LPUSH` / `RPOP` (List) |
| `EventEmitter.emit(event, data)` | `PUBLISH` (Pub/Sub) |
| `EventEmitter.on(event, handler)` | `SUBSCRIBE` (Pub/Sub) |

A single Valkey instance (or cluster) handles KV, queues, and pub/sub. This dramatically simplifies operations — one service to monitor, scale, and back up rather than three.

## Consequences

**Positive:**
- One service handles three infrastructure primitives — simpler operations, lower cost.
- Available as a managed service on every major cloud (AWS ElastiCache, GCP Memorystore, Upstash, etc.).
- BSD-3 license — no legal risk for any deployment model.
- Identical API to Redis — massive ecosystem of clients, tools, and operational knowledge.
- Same behavior locally (`docker run valkey/valkey`) and in production.

**Negative:**
- Valkey is memory-bound — large datasets may be expensive compared to disk-based stores.
- Single Valkey becoming a single point of failure if not properly clustered.
- Pub/sub in Valkey is fire-and-forget (no delivery guarantees without additional work). This is acceptable for the EventEmitter use case but must be documented.
- Queue semantics in Valkey Lists lack features like visibility timeouts, dead-letter queues, and exactly-once delivery that dedicated queuing systems provide.
