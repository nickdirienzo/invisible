# ADR-0016: Pivot to devenv.nix generation

## Status

Proposed

## Context

II currently scans source code, detects infrastructure needs, and generates
Docker Compose YAML, Kubernetes manifests, and Dockerfiles. The compilers also
include a TypeScript AST transformer (Map → DurableMap) and runtime shims for
Valkey, OpenBao, and Dapr.

The [devenv](https://devenv.sh/) ecosystem already solves the "run
infrastructure" problem well — declarative service orchestration (Postgres,
Redis, MongoDB, etc.), container builds, and even Kubernetes manifest generation
via [kubenix](https://kubenix.org/). These are battle-tested Nix tools
maintained by a large community.

Meanwhile, the Nix ecosystem's developer experience gap is the *on-ramp*:
developers who import `pg` or `mongoose` don't want to learn Nix syntax to get
a working dev environment. Existing Nix inference tools (dream2nix, node2nix,
nixify) work at the package manager / lockfile level — none of them analyze
source code to determine what *services* need to run.

## Decision

Pivot II from generating deployment artifacts to generating `devenv.nix` files.
The planner (static analysis) stays; the compilers and runtime shims are
replaced by a single devenv compiler.

### What stays

- **Capability import detection** — `import pg` → `services.postgres.enable = true`.
  This is the core value and the thing no other tool does.
- **HTTP listen detection** — determines the port for `env.PORT`.
- **Secrets detection** — classifies `process.env.*` into three buckets:
  1. *Auto-wired from services* — e.g. `env.DATABASE_URL` derived from detected engines
  2. *Config* (PORT, NODE_ENV) — goes in `devenv.nix` as `env.*`
  3. *Secrets* (everything else) — goes in `.env.example`, loaded via `dotenv.enable = true`
- **Framework detection** — determines start/build commands for the `processes` block.

### What goes

- Docker Compose, Kubernetes, and Dockerfile compilers
- TypeScript AST transformer and durable map runtime
- Dapr-dependent detections (cron jobs, event emitters)
- Durable map detection (if you need Redis, import `redis`)
- `yaml` and `@valkey/valkey-glide` dependencies

### New output

`ii init [project-dir]` scans source code and writes:

- `devenv.nix` — languages, services, env vars (config + auto-wired), dotenv, processes
- `.env.example` — secret env vars with empty values

The developer then runs `devenv up` and everything works.

### Engine mapping

| Detected engine | devenv service | Auto-wired env var |
|----------------|---------------|-------------------|
| postgres | `services.postgres` | `DATABASE_URL=postgres://localhost:5432/app` |
| mysql | `services.mysql` | `DATABASE_URL=mysql://root@localhost:3306/app` |
| mongodb | `services.mongodb` | `MONGODB_URL=mongodb://localhost:27017/app` |
| valkey | `services.redis` | `REDIS_URL=redis://localhost:6379` |
| sqlite | (none, embedded) | `DATABASE_PATH=./app.db` |

## Consequences

- The tool becomes dramatically simpler (~1,500 lines vs ~5,000).
- II stops competing with Docker/K8s tooling and instead complements the Nix ecosystem.
- The value proposition sharpens: "we read your code and configure your dev environment."
- Developers never need to learn Nix — II is the steering wheel, devenv is the engine.
- The durable map "magic" (rewriting `new Map()` to Valkey-backed storage) goes away.
  This is an acceptable trade — it was clever but required too much inference about intent.
