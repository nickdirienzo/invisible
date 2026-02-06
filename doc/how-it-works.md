# How Invisible Infrastructure Works

Invisible Infrastructure (II) reads your source code, infers what infrastructure you need, and generates deployment artifacts. You write normal code using stdlib primitives. II figures out the rest.

## The Core Idea

Developers already express infrastructure intent through the code they write. A module-scope `Map` is state that outlives a single request. A call to `.listen(3000)` is an HTTP server. A `writeFile` to a known path is durable storage. These patterns are universal across languages — II just reads them and provisions the right backing infrastructure.

This is not fundamentally different from what Vercel does when you deploy a Next.js app. Vercel detects static pages, API routes, ISR, and server components from your code, then silently wires up Lambdas, edge functions, CDN caching, and KV stores. You never configure any of it.

The difference is that Vercel is a closed platform for one framework. II does the same static analysis → infrastructure inference for open infrastructure (Docker, Kubernetes, Valkey) and is language-agnostic by design.

## The Pipeline

```
Source Code → Planner → IR → Compilers → Deployment Artifacts
```

### 1. Planner (Static Analysis)

The planner creates an AST of your source files and walks it looking for recognizable patterns:

- **HTTP servers**: `.listen(port)` on types that trace back to `node:http`, Express, Fastify, etc. The type checker resolves the port value through variable references and fallback expressions.
- **Durable state**: `new Map()` at module scope (top-level declarations). Function-scoped Maps are ephemeral and ignored.
- **Future**: `EventEmitter` at module scope → pub/sub, `fs.writeFile` to durable paths → blob storage, `process.env` → secret management.

The planner outputs an IR (intermediate representation) — a JSON document describing your app's services, ports, ingress rules, and resources.

### 2. Compilers (Code Generation)

Compilers take the IR and emit deployment artifacts for a target platform:

- **Docker Compose** (`--local`): Dockerfile, docker-compose.yml, supporting infrastructure (Valkey, etc.)
- **Kubernetes** (`--k8s`): Dockerfile, Deployment/Service/HTTPRoute manifests, infrastructure manifests

When resources like durable Maps are detected, compilers:
- Add infrastructure services (Valkey container, k8s Deployment)
- Inject environment variables (`VALKEY_URL`)
- Wire up service dependencies

### 3. TypeScript Transformer (Build-Time Swap)

This is where the magic happens. Since TypeScript is compiled to JavaScript anyway, II adds a custom transformer to that existing compilation step.

The transformer reads a manifest of detected durable Maps and, during `tsc` emit:
- Finds `const counters = new Map()` in the AST
- Replaces it with `const counters = new DurableMap("app:file:counters")`
- Injects `import { DurableMap } from "..."` at the top of the file

The compiled JavaScript has the swap already baked in. No runtime loader, no regex rewriting, no `--import` hooks. It's just part of the normal TS→JS build.

### 4. Runtime (DurableMap)

The DurableMap class implements the same interface as `Map` but backs every operation with Valkey HASH commands:

| Map method | DurableMap | Valkey command |
|------------|-----------|----------------|
| `get(key)` | `await get(key)` | `HGET hash key` |
| `set(key, val)` | `await set(key, val)` | `HSET hash key json` |
| `has(key)` | `await has(key)` | `HEXISTS hash key` |
| `delete(key)` | `await delete(key)` | `HDEL hash key` |
| `keys()` | `await keys()` | `HKEYS hash` |
| `clear()` | `await clear()` | `DEL hash` |

Values are JSON-serialized. Each DurableMap instance is namespaced by a hash key derived from the app name, source file, and variable name (e.g., `my-app:index.ts:counters`).

## The `await` Concession

Native `Map.get()` is synchronous. Valkey is async. The one concession developers make is writing `await` on Map operations:

```typescript
const current = (await counters.get(key)) ?? 0;
await counters.set(key, current + 1);
```

In local development with a native Map, `await` on a non-Promise is a no-op — the code works identically. In deployed mode, DurableMap returns Promises that resolve via Valkey. Same source, both environments.

## Why This Generalizes

The approach works for any language that has:

1. **Static analysis** — you can read the source and understand what it's doing. Types help but aren't strictly required; any language has an AST.
2. **A build step** — somewhere to inject the swap before runtime. Compilation, bundling, transpilation — any of these work.
3. **Recognizable scope** — module/package scope is distinguishable from function/block scope.

| Language | State detection | Server detection | Build hook |
|----------|----------------|------------------|------------|
| TypeScript | `new Map()` at module scope | `.listen()` via type checker | tsc custom transformer |
| Go | `var m = make(map[string]int)` at package scope | `http.ListenAndServe()` | `go/ast` rewriter |
| Rust | `lazy_static!` / `static` declarations | `Server::bind()` | proc macro or build.rs |
| Java | `static` fields in classes | `ServerSocket`, Spring `@RestController` | annotation processor |
| Python | Module-level variables | `app.run()` (Flask/Django) | import hook or AST transformer |

The core insight is language-agnostic: **scope already encodes developer intent about data lifetime**. A module-level Map in any language means "this outlives a single request." The planner just reads what the developer already wrote.

## What's Not Covered (Yet)

- **Valkey persistence** — currently ephemeral (no volume mounts). Needs `appendonly yes` + persistent volumes.
- **Connection resilience** — no reconnect/retry logic on Valkey failures.
- **Valkey auth** — wide open, fine in Docker networking, not for production.
- **HA** — single Valkey instance, no replication or sentinel.
- **Health checks** — no readiness probes for Valkey connectivity.
- **Forgotten `await`** — works locally (sync no-op), breaks in production (unresolved Promise). A lint rule or tsc plugin could catch this.
- **EventEmitter → pub/sub** — planned, not implemented.
- **fs → blob storage** — planned, not implemented.
- **process.env → secrets (OpenBao)** — planned, not implemented.
