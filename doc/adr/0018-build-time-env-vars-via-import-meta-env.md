# 18. Build-Time Environment Variables via import.meta.env

Date: 2025-02-07

## Status

Accepted

## Context

In a monorepo with a static frontend and a backend API, the frontend needs to know where to send API requests. During local development with Vite, `server.proxy` can transparently forward `/api` requests to the backend. But in production — whether Docker Compose, S3+CloudFront, or Kubernetes — there is no dev server, no proxy, and the frontend's `fetch("/api/boards")` hits the static file server and returns a 404.

We considered several approaches:

1. **Nginx reverse proxy in the static site container.** Generate an `nginx.conf` that proxies `/api` to the backend service. This works for Docker Compose but breaks for S3+CloudFront, Netlify, Vercel, and any deployment where the static files aren't served by nginx.

2. **Auto-detect cross-service fetch calls and inject a build-time variable.** The planner would see `fetch("/api/boards")` in the frontend and `app.get("/api/boards")` in the backend, infer the relationship, and rewrite the frontend to use a variable. Too much magic — it couples planner logic to URL path conventions and makes the system harder to reason about.

3. **Developer uses `import.meta.env.VITE_API_URL` explicitly.** The developer writes `fetch(\`${import.meta.env.VITE_API_URL}/api/boards\`)` and provides the value via `.env.local` for local dev, CI environment for builds, or platform-specific config for production. II detects `import.meta.env` access as a new resource kind for reporting and validation.

## Decision

We use `import.meta.env` detection as a new resource kind (`env-var`) in the planner. This is distinct from `process.env` secrets (which are runtime values fetched from OpenBao).

**Detection:** The planner walks the AST for `import.meta.env.VARIABLE_NAME` property access expressions — the same pattern Vite uses to inline environment variables at build time.

**No infrastructure wiring.** Unlike secrets (`process.env` → OpenBao) or durable state (`new Map()` → Valkey), detected `env-var` resources do not generate infrastructure. Vite already handles inlining these values at build time from the developer's environment. II detects them for visibility — showing what config a service depends on — but does not try to provide the values.

**Developer provides values** via standard Vite conventions:
- `.env.local` for local development (e.g., `VITE_API_URL=http://localhost:4000`)
- CI/CD environment variables for production builds
- Platform-specific config (CloudFront behaviors, API Gateway, etc.) for routing

This keeps the boundary clean: II handles infrastructure (state, secrets, scheduling), the developer handles application config (where my API lives).

## Consequences

**Positive:**
- No magic. The developer explicitly declares their config dependency in code, using standard Vite conventions. II sees it and reports it.
- Works everywhere. Whether deployed to Docker Compose, S3+CloudFront, Kubernetes, or Vercel — the pattern is the same. The value changes per environment, but the code doesn't.
- Clean separation between infrastructure resources (which II manages) and application config (which the developer manages).
- `.env.local` is already gitignored by Vite's conventions and familiar to frontend developers.

**Negative:**
- Developers must change `fetch("/api/boards")` to `fetch(\`${import.meta.env.VITE_API_URL}/api/boards\`)`. This is a small amount of ceremony, but it's the honest representation of a real deployment concern — the API URL genuinely varies by environment.
- II cannot validate that the env var is set at build time. If `.env.local` is missing and the CI doesn't set `VITE_API_URL`, the build succeeds but the app makes requests to `/api/boards` (empty string prefix), which fails silently. A future enhancement could warn during `ii plan` if detected env vars have no values.
- Only detects `import.meta.env` (Vite convention). Other bundlers use different patterns (`process.env.REACT_APP_*` for CRA, `env()` for SvelteKit). These can be added as needed.
