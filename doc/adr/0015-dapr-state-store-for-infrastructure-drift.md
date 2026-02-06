# 15. Dapr State Store for Infrastructure Drift Management

Date: 2025-02-06

## Status

Accepted

## Context

Dapr's Jobs API supports registering and deleting individual jobs, but provides no endpoint to list all registered jobs. When a developer removes a `setInterval` call from their code, the corresponding Dapr job persists in the scheduler's etcd store across restarts. The stale job continues firing, hitting endpoints that may no longer exist (returning 404/500 errors).

This is a classic infrastructure drift problem. The desired state (defined in source code) diverges from the actual state (registered in Dapr scheduler). We need a way to diff and reconcile.

We considered several approaches:

1. **Nuke volumes on every deploy** (`docker compose down -v`). Destroys all persistent state including databases and Valkey data. Unacceptable — a code change to cron schedules shouldn't wipe application data.
2. **Track state in a local file on a mounted volume.** Works for local dev but doesn't translate to hosted environments where the CLI may not share a filesystem with the runtime.
3. **External database** (SQLite file, Postgres). Adds a new infrastructure dependency just to track infrastructure.
4. **Use Dapr's own state store API.** Dapr already runs as a sidecar for job scheduling. Its state store API (`/v1.0/state/<store>`) is available with no additional services — just a component definition.

## Decision

We use Dapr's state store API backed by SQLite to track previously registered job names. The state store component is defined as:

```yaml
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: ii-state
spec:
  type: state.sqlite
  version: v1
  metadata:
  - name: connectionString
    value: /state/ii-state.db
```

The SQLite database lives on a named Docker volume (`dapr-state`) that survives `docker compose down` (without `-v`). This is the same volume mounted into the Dapr sidecar for its own scheduler state.

At deploy time, the CLI reconciles by:

1. Reading the previous job name list from state key `registered-cron-jobs`.
2. Computing the current job names from the plan.
3. Deleting jobs that are in the previous set but not the current set.
4. Registering all current jobs (idempotent — Dapr overwrites existing registrations).
5. Writing the current job name list back to state.

The state store is scoped to II's internal use (`ii-state`), not exposed to application code. If the app also needs Dapr state (future work), it would use a separate named store.

## Consequences

**Positive:**
- No new infrastructure dependencies. Dapr is already running for job scheduling; the state store is just a component config.
- SQLite requires no external service — it's a file on the existing named volume.
- Works in both local and hosted environments. The state store API is network-accessible, so the CLI can reach it from outside the container.
- Persistent across restarts. The named volume survives `docker compose down`, preserving reconciliation state alongside scheduler state and application data.
- Self-contained — Dapr manages its own drift tracking.

**Negative:**
- Adds a Dapr component even when the app doesn't use state stores. The component is internal to II and invisible to the developer, but it's another moving part.
- SQLite on a named volume is a local-dev solution. Hosted environments will need a different state store backend (Redis, Postgres, etc.), though Dapr's pluggable component model makes this a config change, not a code change.
- If the named volume is deleted, reconciliation state is lost. The next deploy will re-register all current jobs (safe) but won't know about stale jobs from before the volume loss (they'll persist until manually deleted or the scheduler state is also lost).
