# 16. II Internal Server for Management Port

Date: 2025-02-06

## Status

Accepted

## Context

Three infrastructure patterns require Dapr to deliver HTTP callbacks to the application:

1. **Cron jobs** — Dapr's scheduler POSTs to the app when a job fires.
2. **Pub/sub events** — Dapr delivers published messages to subscriber endpoints.
3. **Subscriptions** — Dapr queries `GET /dapr/subscribe` to discover which topics to route.

Dapr's sidecar has a single `app-port` configuration that determines where it sends all callbacks. The developer's HTTP server already occupies one port (e.g. 3000 for Express). We need a way to receive Dapr callbacks without interfering with the developer's server.

We considered four approaches:

1. **Monkey-patch `http.createServer`** — Intercept the developer's server creation and inject middleware for II routes. Fragile, framework-dependent, and invisible in a way that causes debugging nightmares.
2. **Generated Express middleware** — Emit middleware that the developer's app mounts. Assumes Express, breaks for Fastify/Koa/raw `node:http`.
3. **Generated wrapper entry point** — Emit a new `entry.js` that starts both servers. Complicates the build and makes the developer's entry point no longer the real entry point.
4. **Standalone `node:http` server on a dedicated management port** — A separate server owned by II, started via Node.js `--import` hook, completely independent of the developer's code.

## Decision

We use a dedicated **II internal HTTP server** on port 3501, started via `--import ./.ii/runtime/ii-server.mjs`. Dapr's `app-port` points to 3501. The developer's app runs on its own port (e.g. 3000) undisturbed.

The II server handles:
- `GET /dapr/subscribe` — returns programmatic subscription list built from `II_EVENTS_MANIFEST`
- `POST /ii/events/{namespace}/{event}` — delivers pub/sub messages to in-process `DistributedEventEmitter` instances
- `POST /ii/jobs/{name}` — receives Dapr scheduler callbacks, proxies `fetch('http://localhost:{appPort}{endpoint}')` to the developer's app

This also removes the previous requirement that cron job endpoints must be prefixed with `/job/`. Since the II server proxies the call, developers can use any route path: `setInterval(() => fetch('/api/daily-report'), ms)` works because the II server reads the endpoint from the job payload and forwards it.

### Cross-language portability

The management-port-on-a-separate-port pattern is portable across every runtime II might support:

**Go** — `go func() { http.ListenAndServe(":3501", mux) }()` in an `init()` function. Goroutines are lightweight; a second HTTP listener is trivial.

**Java / Kotlin** — A separate thread running Javalin, Vert.x, or raw `com.sun.net.httpserver.HttpServer`. Spring Boot's management port (`management.server.port`) uses this exact pattern in production.

**Python** — `threading.Thread(target=uvicorn.run, args=(mgmt_app,), kwargs={"port": 3501})`. ASGI/WSGI servers routinely bind multiple ports. Flask's debug server, Django's management commands, and Celery's inspect protocol all use secondary listeners.

**Rust** — `tokio::spawn(async { axum::serve(listener, mgmt_router).await })`. Tokio's task model makes a second listener zero-cost.

**Ruby** — `Thread.new { WEBrick::HTTPServer.new(Port: 3501).start }`. Puma and Unicorn both support binding to multiple ports natively.

**C# / .NET** — `WebApplication.CreateBuilder().Build()` on a second port. ASP.NET Core's `UseUrls` accepts multiple bindings, and Kestrel natively supports multi-port listening. The health-check-on-a-management-port pattern is idiomatic in .NET microservices.

The key insight: every mainstream runtime has lightweight, well-tested mechanisms for running a second HTTP listener. This is a solved problem in all ecosystems. The management port doesn't need to be fast — it handles a handful of infrastructure callbacks per minute at most.

### Benefits of port separation

1. **No framework coupling** — Works with Express, Fastify, Koa, raw `node:http`, or any future framework. No middleware injection, no monkey-patching.
2. **Clean process model** — The developer's server owns its port completely. II's server owns its port completely. No routing conflicts, no path collisions.
3. **Debuggability** — `curl localhost:3501/dapr/subscribe` works independently of the app. The management port is inspectable without understanding the app's routing.
4. **Security boundary** — The management port is never exposed externally. Only the Dapr sidecar (same pod/network namespace) talks to it.
5. **Extensibility** — Future II features (health checks, metrics, blob storage callbacks) get endpoints on the management port without touching the developer's app.

### The harder cross-language question

Port separation is the easy part. The harder question is the **sync/async gap**: the `DistributedEventEmitter` replacement class needs to exist in each language's idiom. Node.js has `EventEmitter`; Go has channels; Java has `java.util.concurrent`; Rust has `tokio::sync::broadcast`. Each requires a language-specific runtime shim that bridges local event semantics to Dapr pub/sub HTTP calls.

The management server itself is trivially portable. The event delivery mechanism inside the process is where language-specific work lives. This ADR covers the management port; per-language event bridging will be addressed in future ADRs as II adds support for additional runtimes.

## Consequences

**Positive:**
- Framework-agnostic: works with any HTTP framework or none at all.
- The `--import` hook means zero changes to the developer's source code or entry point.
- Cron jobs no longer require `/job/`-prefixed routes — any local path works.
- Single Dapr sidecar serves both cron and events via one `app-port`.
- The pattern is proven in production systems (Spring Boot management port, Kubernetes liveness/readiness probes on secondary ports, Envoy admin interface).

**Negative:**
- A second HTTP server consumes a small amount of additional memory (~2-5MB for a `node:http` server).
- Port 3501 is reserved by II — if a developer happens to use that port, there's a conflict. This is mitigable via configuration.
- The `--import` hook runs before the app loads, adding a few milliseconds to startup.
- Proxying cron callbacks through the II server adds one extra `localhost` hop compared to direct Dapr-to-app delivery. This is negligible for scheduled jobs that run at minute/hour/day intervals.
