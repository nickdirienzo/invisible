# 17. Static Site Detection via Build Without Start

Date: 2025-02-07

## Status

Accepted

## Context

ADR-0013 established `scripts.start` + `scripts.build` in package.json as the contract for detecting framework-managed web services (Remix, Next.js, etc.). This works when a framework CLI starts a server process. But modern frontend toolchains (Vite, Create React App, Parcel) produce static files — HTML, CSS, and JS bundles — with no server process. There is nothing to `scripts.start`.

We encountered this with a Vite+React SPA in a monorepo. Attempts to work around it (Express static server, `vite preview`) were fragile and violated the "invisible" principle — developers shouldn't need to write serving infrastructure for static builds.

We considered:

1. **Whitelisting build tools** (Vite, CRA, etc.) by checking `devDependencies`. This requires maintaining a list of tools and breaks when new ones appear.

2. **Adding an `ii.config.ts`** where developers declare "this is a static site." This adds ceremony and goes against the project philosophy.

3. **Extending the detection cascade** using what the code already tells us: if there's no `.listen()` call and no `scripts.start`, but there is a `scripts.build`, the output must be static files. No server-specific knowledge needed.

## Decision

We extend the build detection cascade from ADR-0013 to three tiers:

1. **`.listen()` found in source** → HTTP server (unchanged)
2. **`scripts.build` + `scripts.start`** → server framework like Remix (unchanged, ADR-0013)
3. **`scripts.build` + no `scripts.start`** → static site (new)

The key insight: if the project had a server, we would have found a `.listen()` call in source code or a `scripts.start` to invoke a framework CLI. The absence of both, combined with a build script, means the build output is static files.

Static sites get:
- `static: true` on the Service IR
- `port: 80` (nginx default)
- Ingress enabled (static sites are always web-facing)
- A multi-stage Dockerfile: `node:22-slim` to `npm run build`, then `nginx:alpine` serving from `/usr/share/nginx/html`
- Build output assumed in `dist/` (Vite convention, also used by most modern bundlers)

This is entirely code-driven — no tool-specific knowledge, no whitelisting, no config files. It works for Vite, CRA, Parcel, esbuild, Webpack, or any future bundler that outputs static files.

## Consequences

**Positive:**
- Zero configuration. A Vite project with `scripts.build: "vite build"` and no start script is automatically detected and served.
- No framework-specific or tool-specific knowledge. Works with any static site generator.
- Consistent with ADR-0001 (stdlib as abstraction) and ADR-0013 (package.json as contract) — the detection is purely from what the code tells us.
- nginx is production-grade, handles compression, caching headers, and SPA routing out of the box.
- Extends naturally to monorepos: the API service has `.listen()`, the web service has `scripts.build` only.

**Negative:**
- Any project with `scripts.build` and no `scripts.start` is treated as a static site, even if it's a library or CLI tool. In practice this is fine — II only processes projects intended for deployment.
- Build output directory is hardcoded to `dist/`. Projects using `build/` or `public/` would need to configure their tool to output to `dist/`, or we'd need to add output directory detection later.
- SPA routing (serving `index.html` for all paths) requires nginx config beyond the default. A future enhancement could generate an `nginx.conf` with `try_files $uri $uri/ /index.html`.
