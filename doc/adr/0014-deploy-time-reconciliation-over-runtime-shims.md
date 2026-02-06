# 14. Deploy-Time Reconciliation Over Runtime Shims

Date: 2025-02-06

## Status

Accepted

## Context

When we first implemented Dapr-backed cron job scheduling (ADR-0006), the initial design used a Node.js `--import` shim that ran at app startup. The shim read a `DAPR_CRON_JOBS` environment variable (a JSON array of job definitions), waited for the Dapr sidecar to become healthy, and registered each job via the Dapr Jobs API. This mirrored our existing pattern for secrets (the OpenBao shim).

The problem emerged when considering horizontal scaling. If an app runs 10 replicas, all 10 would race to register the same set of cron jobs on startup. While Dapr's Jobs API is idempotent for registration, the reconciliation logic (reading previous state, diffing, deleting stale jobs) would execute N times concurrently. This is wasteful at best and introduces race conditions at worst — two replicas could read the same stale state simultaneously and both attempt to delete the same jobs.

We considered three approaches:

1. **Leader election** — Only one replica performs reconciliation. Adds complexity (leader election requires its own distributed state) and couples the app to infrastructure concerns.
2. **Startup shim with locking** — Use a distributed lock to serialize reconciliation across replicas. Same complexity as leader election, plus lock timeout/starvation issues.
3. **CLI-driven deploy-time reconciliation** — Move reconciliation out of the app entirely. The CLI runs it once after `docker compose up` or `kubectl apply`, before any replicas handle traffic.

## Decision

Infrastructure state changes (job registration, deregistration, drift reconciliation) run from the CLI at deploy time, not from runtime shims at app startup. The deploy flow has two phases:

1. **Infra phase:** Start services in detached mode (`docker compose up -d --build`), wait for the Dapr sidecar to be healthy, then reconcile cron jobs from the CLI.
2. **App phase:** Stream logs in the foreground (`docker compose logs -f`).

The app container has no knowledge of cron jobs. No `DAPR_CRON_JOBS` environment variable, no `--import` shim, no startup registration logic. The Dockerfile is simpler and the app starts faster.

This applies specifically to infrastructure state that is global (not per-replica). Per-replica concerns like OpenBao secret injection still use runtime shims because each replica needs its own authenticated session.

## Consequences

**Positive:**
- Reconciliation runs exactly once per deploy, regardless of replica count.
- No race conditions, no distributed locking, no leader election.
- App containers are simpler — no cron shim, no `DAPR_CRON_JOBS` env var, faster startup.
- Clear separation: the CLI manages infrastructure state, the app handles requests.
- Works identically for local (`docker compose`) and hosted deploys.

**Negative:**
- The CLI must wait for the Dapr sidecar to be healthy before reconciling, adding a few seconds to deploy time.
- Deploy is no longer a single `docker compose up` — it's a phased operation. The CLI owns the orchestration.
- If a deploy is interrupted between phases, jobs may not be reconciled. The next successful deploy will catch up.
- Different pattern from secrets (which still use a runtime shim), creating a conceptual inconsistency. The distinction is justified: secrets are per-replica, jobs are global.
