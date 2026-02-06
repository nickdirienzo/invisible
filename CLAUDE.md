# CLAUDE.md — Invisible Infrastructure (II)

## What is this project?

Invisible Infrastructure is a static analysis and code generation tool that infers infrastructure requirements from TypeScript/JavaScript source code and generates deployment artifacts (Docker, Docker Compose, Kubernetes). Developers write standard code using Node.js stdlib primitives (`Map`, `.listen()`, `process.env`) and II detects what backing services are needed (Valkey, OpenBao, etc.).

**Core pipeline:** `Source Code → Planner → IR → Compilers → Deployment Artifacts`

## Commands

```bash
npm test            # Run Vitest test suite (uses --experimental-vm-modules)
npm run build       # Compile TypeScript → dist/
npm run ii          # Run CLI via tsx (dev mode)
```

CLI usage:
```bash
npx ii plan <project-dir>                    # Analyze source, write .ii/plan.json
npx ii deploy --local <project-dir>          # Deploy locally via Docker Compose
npx ii deploy --k8s <project-dir>            # Generate Kubernetes manifests
npx ii deploy --local --plan FILE <dir>      # Deploy using existing plan
```

## Project structure

```
src/
├── cli.ts              # CLI entry point (plan, deploy commands)
├── index.ts            # Library exports
├── ir/                 # Intermediate representation types (App, Service, Resource)
├── planner/            # Static analysis — detects .listen(), new Map(), process.env
│   ├── plan.ts         # Main planner: file discovery, TypeScript type checking, detection
│   └── __tests__/      # Tests for each detection strategy
├── compilers/          # Code generators for deployment targets
│   ├── compose.ts      # Docker Compose YAML
│   ├── dockerfile.ts   # Multi-stage Dockerfile
│   ├── k8s.ts          # Kubernetes manifests
│   ├── transform.ts    # TypeScript AST transformer (Map → DurableMap rewrite)
│   └── __tests__/
└── runtime/            # Runtime implementations shipped into containers
    └── durable-map.ts  # Valkey-backed async Map class
```

Generated artifacts go into `.ii/` in the target project directory.

## Architecture

**Three detection strategies in the planner:**

1. **HTTP servers** (`detectListenCall`): Walks AST for `.listen()` calls, uses TypeScript type checker to confirm the receiver is an HTTP server type (Express, Fastify, Koa, http.Server). Resolves port from literals, variables, or fallback expressions (`process.env.PORT || 3000`).

2. **Durable state** (`detectDurableMaps`): Finds `new Map()` at module scope (top-level variable declarations only). Function-scoped Maps are intentionally ignored — module scope implies durability.

3. **Secrets** (`detectSecrets`): Extracts `process.env.VARIABLE_NAME` patterns, excluding infrastructure-managed vars (PORT, NODE_ENV, VALKEY_URL, etc.).

4. **Framework detection** (`detectFrameworkStart`): Fallback when no `.listen()` found — checks `package.json` for `scripts.start` + `scripts.build` to detect meta-frameworks (Remix, Next, Nuxt, etc.).

**TypeScript transformer** (`transform.ts`): At build time, rewrites `new Map()` → `new DurableMap("hashKey")` using a manifest that maps variables to Valkey hash keys. This is a TypeScript compiler transformer factory, not a runtime shim.

## Key conventions

- **ESM only** — `"type": "module"` in package.json, Node16 module resolution
- **TypeScript strict mode** — strict null checks enabled
- **Target ES2022** — output to `dist/`
- **Vitest** for testing — tests live in `__tests__/` directories next to source
- **Functional style** — pure functions for analysis, AST walking via `ts.visitEachChild`
- **TypeScript compiler API** — used directly for AST parsing, type checking, and code transformation
- **Resource naming** — durable maps keyed as `{appName}:{sourceFile}:{varName}`

## Documentation

- `doc/how-it-works.md` — technical overview of the full pipeline
- `doc/adr/` — 15 Architecture Decision Records covering design choices
- `doc/TODO.md` — planned work (secrets CLI, environments)
- `examples/` — four example projects (hello-world, durable-counter, secret-api, remix-app)
