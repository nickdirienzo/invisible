# 19. Service-Keyed Resource Manifest and Project Scoping

Date: 2025-02-07

## Status

Accepted

## Context

Three related problems surfaced when running monorepo examples through `ii local up/down`:

1. **Compose project naming.** Docker Compose derives its project name from the compose file's parent directory. Since the compose file always lives at `.ii/docker-compose.yml`, every project got the project name `ii`. This meant all projects shared volumes (`ii_valkey-data`), container names (`ii-valkey-1`), and networks. Running one project could stomp on another's state.

2. **Resource manifest file paths.** The planner stores resource paths relative to the project root (e.g., `api/index.ts`). But in a monorepo, each service's Dockerfile builds from its own subdirectory — `COPY api/ .` puts files at `/app/index.ts`, not `/app/api/index.ts`. The build-time transformer matches files using `sourceFile.fileName.endsWith(entry.file)`, so `api/index.ts` never matched `/app/index.ts`. The transform silently did nothing, leaving `new Map()` in the output instead of `new DurableMap()`. Everything stayed in-memory.

3. **Valkey persistence.** Valkey defaults to in-memory only. Even with a volume mounted at `/data`, Valkey won't write persistence files unless explicitly configured with `--appendonly yes` or a `save` directive.

## Decision

**Compose project scoping.** All `docker compose` invocations now pass `-p <app-name>`, derived from the plan. Volumes become `07-task-board_valkey-data` instead of `ii_valkey-data`. Each project is fully isolated.

**Service-keyed manifest.** The three separate manifest files (`resources.json`, `cron-jobs.json`, `events.json`) are collapsed into a single `resources.json` keyed by service name:

```json
{
  "api": {
    "maps": [{ "file": "index.ts", "varName": "tasks", "hashKey": "07-task-board:api/index.ts:tasks" }],
    "cronJobs": [{ "file": "index.ts", "endpoint": "/api/cleanup", "name": "api-cleanup" }],
    "events": [{ "file": "index.ts", "varName": "taskEvents", "namespace": "taskEvents" }]
  }
}
```

File paths are relative to the service's build context (prefix stripped). The Dockerfile passes `II_SERVICE=<name>` when invoking `build.mjs`, which selects the right section. The `hashKey` still uses the full project-root-relative path for global uniqueness across services.

This works uniformly for both monorepos and single-service projects — single-service projects have one key in the manifest with unmodified paths.

**Valkey persistence.** The Valkey service in the compose output now includes `command: ["valkey-server", "--appendonly", "yes"]`, ensuring all writes are captured in the append-only file at `/data`.

## Consequences

- Projects no longer interfere with each other's Docker resources when running locally.
- The DurableMap transformer now correctly fires in monorepo builds, so data actually flows through Valkey.
- Data survives `ii local down` + `ii local up` cycles.
- The `hashKey` format (`appName:fullPath:varName`) remains stable — only the manifest lookup path changed, not the Valkey key space.
- Older `.ii/` directories with the previous three-file manifest format will need to be regenerated via `ii local up` (which always regenerates artifacts).
