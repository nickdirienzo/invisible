# 7. Use Libsql (SQLite Protocol) for the Database Layer

Date: 2025-02-06

## Status

Accepted

## Context

When the planner detects `import { DatabaseSync } from 'node:sqlite'`, it must provision a database. The choice of database backend is one of the most consequential infrastructure decisions since it affects data modeling, query patterns, scaling characteristics, and operational complexity.

We evaluated:

1. **PostgreSQL** — Industry standard, rich feature set, strong ecosystem. But: heavy operational overhead, connection pooling complexity, expensive managed instances, and significant differences between cloud providers (RDS vs Cloud SQL vs Azure Database).
2. **MySQL** — Similar profile to PostgreSQL with different tradeoffs. Same operational concerns.
3. **Cloud-native databases** — DynamoDB, Firestore, Spanner. Proprietary, non-portable, different data models per cloud.
4. **Libsql / SQLite** — SQLite wire protocol with cloud-native replication. Turso (managed), Cloudflare D1, or self-hosted Litestream. The world's most deployed database engine, now available as a cloud service.

SQLite is the only database engine that Node.js ships stdlib support for (`node:sqlite`). This makes it the natural fit for our stdlib-inference model. Libsql extends SQLite with network access, replication, and multi-tenancy without changing the SQL dialect or API.

## Decision

We will use Libsql (SQLite wire protocol) as the database layer. When the planner detects a `node:sqlite` import, it provisions a Libsql instance.

Deployment options:
- **Managed:** Turso (global edge replicas, serverless pricing)
- **Cloudflare:** D1 (for Cloudflare deployments)
- **Self-hosted:** Libsql server with Litestream for S3-based replication

The developer writes standard SQLite SQL. The runtime connects to Libsql instead of a local SQLite file, transparently.

## Consequences

**Positive:**
- SQLite is the most tested, most deployed database engine in the world.
- `node:sqlite` is in the Node.js stdlib — no additional dependencies.
- Libsql is open source (MIT) with active development and commercial backing (Turso).
- Edge replication: Turso replicates read replicas globally with single-digit ms reads.
- Simple operational model compared to PostgreSQL/MySQL (no connection pooling, no vacuuming, no WAL management).

**Negative:**
- SQLite has limitations: no built-in full-text search at the Libsql level, limited concurrent write throughput (single writer).
- Some applications genuinely need PostgreSQL features (JSONB operators, CTEs with mutations, advanced indexing).
- Libsql is younger than PostgreSQL/MySQL — smaller ecosystem of tools and extensions.
- Migration path from SQLite to PostgreSQL is non-trivial if applications outgrow SQLite's capabilities.
- `node:sqlite` API is relatively new and still evolving in Node.js.
