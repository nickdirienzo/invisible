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

devenv and II are converging from opposite ends of the same pipeline. devenv
closes the gap from *config to running infrastructure* (making Nix invisible).
II closes the gap from *source code to config* (making the config itself
invisible). Together: source code → running infrastructure, zero manual
configuration.

### devenv 2.0 (March 2026)

[devenv 2.0](https://devenv.sh/blog/2026/03/05/devenv-20-a-fresh-interface-to-nix/)
landed with several features that directly reduce II's surface area:

- **Automatic port allocation** — devenv assigns ports to services automatically.
  This simplifies `detectListenCall`: II only needs to confirm a server exists,
  not resolve which port it binds to.
- **SecretSpec integration** — declarative secret definitions with typed
  generation (`password`, `hex`, `uuid`, etc.). II's secrets detection can
  target `secretspec.toml` instead of a dumb `.env.example`.
- **Built-in process manager** — replaces process-compose with a native Rust
  implementation, giving `ii up` a better runtime for free.
- **C FFI Nix backend** — calls the Nix evaluator directly instead of shelling
  out, making repeated commands run in milliseconds. Note: devenv evaluated
  switching to [Tvix](https://tvix.dev/) in 2024 but stayed on standard Nix,
  which keeps generated `.nix` files portable across the broader ecosystem.
- **Cloud conditionals** — `config.cloud.enable` allows a single `devenv.nix`
  to behave differently in local vs. cloud environments.

## Decision

Pivot II from generating deployment artifacts to generating `devenv.nix` files
for local development and retaining a compiler architecture for production
deployment targets.

The planner (static analysis) is the core open-source value — it is
target-agnostic. devenv is the *local dev* backend. Production compilers (AWS,
K8s, Fly, etc.) can target other platforms from the same planner IR.

The CLI abstraction boundary is `ii`, not devenv. Users run `ii up`, not
`devenv up`. This means devenv is an implementation detail that can be swapped
without breaking the user-facing contract.

### What stays

- **Capability import detection** — `import pg` → `services.postgres.enable = true`.
  This is the core value and the thing no other tool does.
- **HTTP listen detection** — confirms a server exists. Port resolution is
  simplified since devenv 2.0 handles automatic port allocation.
- **Secrets detection** — classifies `process.env.*` into three buckets:
  1. *Auto-wired from services* — e.g. `env.DATABASE_URL` derived from detected engines
  2. *Config* (PORT, NODE_ENV) — goes in `devenv.nix` as `env.*`
  3. *Secrets* — goes in `secretspec.toml` with typed declarations. Internal
     secrets (names matching `PASSWORD`, `SECRET`, etc.) get `generate = true`.
     External API keys (Stripe, Twilio, etc.) are declared without generation
     so the developer provides real values.
- **Framework detection** — determines start/build commands for the `processes` block.
- **Compiler architecture** — the planner produces target-agnostic IR.
  Compilers translate IR to specific backends.

### What goes

- Docker Compose, Kubernetes, and Dockerfile compilers (replaced by devenv
  compiler for local; production compilers are a separate concern)
- TypeScript AST transformer and durable map runtime
- Dapr-dependent detections (cron jobs, event emitters)
- Durable map detection (if you need Redis, import `redis`)
- `yaml` and `@valkey/valkey-glide` dependencies

### New output

`ii init [project-dir]` scans source code and writes:

- `devenv.nix` — languages, services, env vars (config + auto-wired), processes
- `secretspec.toml` — typed secret declarations with auto-generation where possible

The developer then runs `ii up` and everything works.

### Engine mapping

| Detected engine | devenv service | Auto-wired env var |
|----------------|---------------|-------------------|
| postgres | `services.postgres` | `DATABASE_URL=postgres://localhost:5432/app` |
| mysql | `services.mysql` | `DATABASE_URL=mysql://root@localhost:3306/app` |
| mongodb | `services.mongodb` | `MONGODB_URL=mongodb://localhost:27017/app` |
| valkey | `services.redis` | `REDIS_URL=redis://localhost:6379` |
| sqlite | (none, embedded) | `DATABASE_PATH=./app.db` |

## Risks

### Dependency on an external project

devenv is maintained by [Cachix](https://www.cachix.org/) and licensed
Apache 2.0. Cachix is building infrastructure for the Nix ecosystem — devenv,
the binary cache, and a cloud platform. II benefits from that investment.

If devenv's direction ever diverges from II's needs:

- **Output is plain Nix** — generated `.nix` files work with standard Nix
  tooling, not just devenv.
- **devenv is an implementation detail** — users interact with `ii`, not
  devenv. The backend can be swapped without user-facing changes.
- **The planner is target-agnostic** — II's open source parser can compile
  to any deployment target. devenv handles local dev; production compilers
  can target AWS, K8s, Fly, or whatever people actually use.

## Consequences

- The tool becomes dramatically simpler (~1,500 lines vs ~5,000).
- II stops competing with Docker/K8s tooling and instead complements the Nix ecosystem.
- The value proposition sharpens: "we read your code so you never write
  infrastructure config again."
- Developers never touch Nix or devenv directly — II is the interface.
- The durable map "magic" (rewriting `new Map()` to Valkey-backed storage) goes away.
  This is an acceptable trade — it was clever but required too much inference about intent.
- The compiler architecture survives the pivot, enabling future production
  deployment targets without rewriting the planner.
