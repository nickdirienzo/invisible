# 13. package.json scripts as Framework Contract

Date: 2025-02-06

## Status

Accepted

## Context

The planner uses TypeScript type checking to detect `.listen()` calls on HTTP server objects (ADR-0001). This works well for frameworks where developers write explicit server code (Express, Fastify, Koa), but fails for meta-frameworks like Remix, Next.js, Nuxt, SvelteKit, and Astro where the server is started by a framework CLI (e.g. `remix-serve`, `next start`). In these cases, `.listen()` is called inside `node_modules`, not in user code.

We considered several approaches:

1. **Framework-specific pattern table** mapping known CLIs (`remix-serve`, `next start`, etc.) to their metadata. This requires manually adding support for every new framework and maintaining version-specific knowledge.

2. **Analyze node_modules** to trace `.listen()` calls through framework internals. This is fragile across framework versions and extremely complex to implement correctly.

3. **Optional config file** (e.g. `ii.config.ts`) where developers declare their server setup. This works but adds ceremony and goes against the "invisible" philosophy.

4. **Detect `scripts.start` + `scripts.build` in package.json** as a universal signal that the project is a framework-managed web service.

## Decision

We require `scripts.start` and `scripts.build` in `package.json` as an opinionated contract for framework-based apps. When no explicit `.listen()` call is found in source code but both scripts exist, the planner infers:

- The app is a web server (ingress enabled)
- The port from a `--port` flag in the start script, or 3000 by default
- The Dockerfile uses `npm run build` then `npm run start`

This is checked only as a fallback — if a `.listen()` call is found in source code, it takes priority. This allows developers with custom servers to override the framework detection.

The Dockerfile for framework apps uses a single-stage build: install all deps, run `npm run build`, prune dev deps, then `CMD ["npm", "run", "start"]`. Using `npm run start` rather than invoking the framework CLI directly ensures `node_modules/.bin` is on the PATH.

## Consequences

**Positive:**
- Zero framework-specific knowledge needed. Remix, Next.js, Nuxt, SvelteKit, Astro, and any future framework work automatically.
- The contract is already the Node.js ecosystem convention — every framework's getting-started guide sets up these scripts.
- No config files, no special annotations, no ceremony.
- Developers with custom servers (explicit `.listen()`) are unaffected.

**Negative:**
- Requires both `scripts.start` and `scripts.build` in package.json. A framework app missing either will not be detected.
- Port detection is limited to `--port` flags in the start script. Frameworks that configure ports via config files or environment variables alone will default to 3000.
- The Dockerfile always uses `npm run build` and `npm run start`, which adds npm's process overhead vs. invoking the CLI directly. This is negligible in practice.
