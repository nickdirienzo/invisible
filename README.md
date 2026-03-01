# Invisible Infrastructure

Write normal Node.js code. Get deployable infrastructure for free.

Invisible Infrastructure (II) reads your source code, figures out what backing services you need, and generates Docker Compose and Kubernetes artifacts automatically. No config files, no infrastructure-as-code — just your app.

## How it works

II runs static analysis on your TypeScript/JS and detects patterns you're already writing:

| You write | II infers |
|---|---|
| `app.listen(3000)` | HTTP service with port and ingress |
| `new Map()` at module scope | Durable state backed by Valkey |
| `process.env.STRIPE_KEY` | Secret managed by OpenBao (Vault) |
| `new EventEmitter()` at module scope | Distributed pub/sub via Dapr |
| `setInterval(() => fetch(...))` | Cron job via Dapr scheduler |
| `import pg from "pg"` | Postgres database provisioned automatically |

At build time, a TypeScript compiler transformer swaps stdlib primitives for their durable equivalents (e.g. `new Map()` becomes `new DurableMap()` backed by Valkey). Your source stays clean.

## Quick example

This is a complete, deployable app — no Dockerfile, no docker-compose.yml, no Valkey config:

```typescript
// index.ts
import express from "express";

const counters = new Map<string, number>();

const app = express();

app.get("/:key", async (req, res) => {
  const key = req.params.key;
  const current = (await counters.get(key)) ?? 0;
  await counters.set(key, current + 1);
  res.json({ key, count: current + 1 });
});

app.listen(process.env.PORT || 3000);
```

```
$ ii plan .
durable-counter: 1 service(s)
  app
    port:    3000
    ingress: yes
  durable maps:
    counters (index.ts)
  infrastructure:
    valkey — durable map backend

$ ii local up .
# Builds Docker image, starts app + Valkey, wires everything together
```

The `counters` Map survives restarts, scales across replicas, and works identically in local dev (where `await` on a sync Map is a no-op).

## Usage

```bash
npm install
npm run build

# Analyze a project
npx ii plan <project-dir>

# Deploy locally (Docker Compose)
npx ii local up <project-dir>
npx ii local logs <project-dir>
npx ii local down <project-dir>

# Generate Kubernetes manifests
npx ii deploy --k8s <project-dir>
```

## Examples

The `examples/` directory has working apps that demonstrate each detection:

| Example | What it shows |
|---|---|
| `01-hello-world` | Basic Express server, HTTP detection |
| `02-durable-counter` | Module-scope `Map` → Valkey |
| `03-secret-api` | `process.env` → OpenBao secrets |
| `04-remix-app` | Framework detection (no `.listen()`) |
| `05-cron-jobs` | `setInterval` + `fetch` → Dapr jobs |
| `06-events` | `EventEmitter` → distributed pub/sub |
| `07-task-board` | Multi-service app (API + worker) |
| `08-capability-imports` | `import pg` → Postgres provisioning |

## The pipeline

```
Source Code → Planner (AST analysis) → IR (JSON) → Compilers → Artifacts
```

The planner uses the TypeScript compiler API to walk your AST and type-check what it finds (e.g. confirming `.listen()` is on an actual HTTP server, not some random object). The IR is a plain JSON description of services, ports, and resources. Compilers turn that into Dockerfiles, Compose files, or K8s manifests.

More detail in `doc/how-it-works.md` and the ADRs in `doc/adr/`.

## What works well

**The scope-as-intent idea is sound.** Module-scope `new Map()` meaning "this outlives a request" is genuinely how developers already think about state. The planner reads intent that's already expressed in the code rather than asking you to restate it in config. This generalizes across languages — a package-level `var m = make(map[string]int)` in Go, a `static` field in Java, a module-level dict in Python all mean the same thing.

**Single-key operations are a great fit.** `get`, `set`, `has`, `delete` on individual keys map cleanly to Valkey HASH commands. For use cases like counters, feature flags, session data, or caches — anything where each operation is independent — the DurableMap swap is transparent and works well.

**The `await` concession is minimal.** `await` on a non-Promise is a no-op in JavaScript, so `await counters.get(key)` works identically against both a native Map (local dev) and a DurableMap (deployed). One keyword is a small price for code that runs the same in both environments.

**The static analysis is type-aware.** The planner doesn't just pattern-match on `.listen()` — it uses the TypeScript type checker to confirm the receiver is actually an HTTP server. This avoids false positives and makes detection reliable.

**Ejection is trivial.** Remove II, and your code still runs — you just have ephemeral in-memory Maps instead of durable ones. There's no vendor lock-in or proprietary API to untangle.

**The analysis tooling is useful on its own.** Even if you never deploy with II, the planner is a useful static analysis tool — it can tell you what infrastructure your code needs, where your state lives, and where coordination concerns exist. That's valuable for code review and architecture discussions independent of the deployment story.

## What doesn't work well (yet)

**Read-then-write patterns have no coordination.** The classic `get → modify → set` pattern (like the counter example) is technically a race condition under concurrent requests. Two requests can read the same value, both increment, and one write overwrites the other. Valkey has WATCH/MULTI for optimistic locking and Lua scripts for atomic operations, but DurableMap doesn't expose either. For now this is fine for low-contention use cases, but it's a real gap for anything with concurrent writers.

**Forgotten `await` is a silent bug.** If you write `counters.get(key)` without `await`, it works locally (sync Map returns the value) but breaks in production (DurableMap returns a Promise object). There's no lint rule or compiler check to catch this yet.

**No persistence by default.** Valkey runs without `appendonly` or volume mounts, so a container restart loses all data. Fine for dev, not for production.

**Single-instance everything.** Valkey, OpenBao, and Dapr all run as single instances with no replication, no auth, and no health checks. The generated infrastructure is for development and demos, not production.
