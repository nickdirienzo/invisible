import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execSync, spawn } from "node:child_process";
import { resolve, join } from "node:path";
import type { App } from "./ir/index.js";
import { plan } from "./planner/index.js";
import { compileToCompose } from "./compilers/compose.js";
import { compileToDockerfile } from "./compilers/dockerfile.js";
import { compileToK8s } from "./compilers/k8s.js";

const II_DIR = ".ii";
const PLAN_FILE = "plan.json";
const RESOURCES_FILE = "resources.json";

const USAGE = `Usage:
  ii plan             [project-dir]   Analyze source, write .ii/${PLAN_FILE}
  ii local up         [project-dir] [--no-cache]  Build and start locally via Docker Compose
  ii local down       [project-dir]   Stop and remove local containers
  ii local logs       [project-dir]   Stream app service logs
  ii deploy --k8s     [project-dir]   Compile to Kubernetes manifests
  ii deploy --k8s --plan FILE [dir]   Compile to k8s using an existing plan file`;

interface DeployOpts {
  target: string;
  planFile: string | null;
  projectDir: string;
  noCache?: boolean;
}

function parseDeployArgs(args: string[]): DeployOpts {
  let target = "";
  let planFile: string | null = null;
  let projectDir = ".";

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--local" || args[i] === "--k8s") {
      target = args[i];
    } else if (args[i] === "--plan") {
      planFile = args[++i];
    } else {
      positional.push(args[i]);
    }
  }

  if (positional.length > 0) projectDir = positional[0];

  return { target, planFile, projectDir: resolve(projectDir) };
}

function iiDir(projectDir: string): string {
  const dir = join(projectDir, II_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "plan") {
    const projectDir = resolve(args[1] ?? ".");
    doPlan(projectDir);
  } else if (command === "local") {
    const subcommand = args[1];
    const localArgs = args.slice(2);
    const noCache = localArgs.includes("--no-cache");
    const projectDir = resolve(localArgs.find((a) => !a.startsWith("--")) ?? ".");
    if (subcommand === "up") {
      await doDeployLocal({ target: "--local", planFile: null, projectDir, noCache });
    } else if (subcommand === "down") {
      doLocalDown(projectDir);
    } else if (subcommand === "logs") {
      await doLocalLogs(projectDir);
    } else {
      console.error(`local requires 'up', 'down', or 'logs'\n`);
      console.error(USAGE);
      process.exit(1);
    }
  } else if (command === "deploy") {
    const opts = parseDeployArgs(args.slice(1));

    if (opts.target === "--local") {
      await doDeployLocal(opts);
    } else if (opts.target === "--k8s") {
      doDeployK8s(opts);
    } else {
      console.error(`Deploy requires --k8s\n`);
      console.error(USAGE);
      process.exit(1);
    }
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}

function doPlan(projectDir: string) {
  const app = plan(projectDir);
  const out = iiDir(projectDir);

  writeFileSync(join(out, PLAN_FILE), JSON.stringify(app, null, 2) + "\n");

  console.log(`${app.name}: ${app.services.length} service(s)\n`);
  for (const svc of app.services) {
    console.log(`  ${svc.name}`);
    console.log(`    port:    ${svc.port}`);
    console.log(`    ingress: ${svc.ingress ? "yes" : "no"}`);
  }

  if (app.resources?.length) {
    const durableMaps = app.resources.filter((r) => r.kind === "durable-map");
    const secrets = app.resources.filter((r) => r.kind === "secret");

    if (durableMaps.length > 0) {
      console.log(`\n  durable maps:`);
      for (const r of durableMaps) {
        console.log(`    ${r.name} (${r.sourceFile})`);
      }
    }

    if (secrets.length > 0) {
      console.log(`\n  secrets:`);
      for (const r of secrets) {
        console.log(`    ${r.name} (${r.sourceFile})`);
      }
    }

    const cronJobs = app.resources.filter((r) => r.kind === "cron-job");
    if (cronJobs.length > 0) {
      console.log(`\n  cron jobs:`);
      for (const r of cronJobs) {
        if (r.kind === "cron-job") {
          const seconds = Math.round(r.intervalMs / 1000);
          console.log(`    ${r.method} ${r.endpoint} every ${seconds}s (${r.sourceFile})`);
        }
      }
    }

    const eventEmitters = app.resources.filter((r) => r.kind === "event-emitter");
    if (eventEmitters.length > 0) {
      console.log(`\n  event emitters:`);
      for (const r of eventEmitters) {
        if (r.kind === "event-emitter") {
          console.log(`    ${r.name} → ${r.events.join(", ")} (${r.sourceFile})`);
        }
      }
    }

    const capImports = app.resources.filter((r) => r.kind === "capability-import");
    if (capImports.length > 0) {
      console.log(`\n  databases:`);
      for (const r of capImports) {
        if (r.kind === "capability-import") {
          const engine = r.engine ?? "unresolved";
          const prov = r.provisioning === "preserve" ? " [preserve]" : "";
          const def = r.deferred
            ? ` (deferred → ${r.deferred.source}, ${r.deferred.resolved ? "resolved" : "unresolved"})`
            : "";
          console.log(`    ${r.module} → ${engine} (${r.capability})${prov}${def} (${r.sourceFile})`);
        }
      }
    }
  }

  // Show inferred infrastructure
  const hasMaps = app.resources?.some((r) => r.kind === "durable-map") ?? false;
  const hasSecretResources = app.resources?.some((r) => r.kind === "secret") ?? false;
  const hasCron = app.resources?.some((r) => r.kind === "cron-job") ?? false;
  const hasEvents = app.resources?.some((r) => r.kind === "event-emitter") ?? false;
  const hasDapr = hasCron || hasEvents;

  const infra: string[] = [];
  if (hasMaps || hasEvents) infra.push("valkey");
  if (hasSecretResources) infra.push("openbao");
  if (hasDapr) infra.push("dapr");

  const replaceEngines = [...new Set(
    (app.resources ?? [])
      .filter((r) => r.kind === "capability-import" && r.engine && r.provisioning === "replace")
      .map((r) => r.kind === "capability-import" ? r.engine : null)
      .filter(Boolean) as string[]
  )];
  for (const engine of replaceEngines) infra.push(engine);

  const hasPreservedDb = (app.resources ?? []).some(
    (r) => r.kind === "capability-import" && r.provisioning === "preserve"
  );

  if (infra.length > 0 || hasPreservedDb) {
    console.log(`\n  infrastructure:`);
    if (hasMaps) console.log(`    valkey — durable map backend`);
    if (hasEvents && !hasMaps) console.log(`    valkey — pub/sub backend`);
    if (hasEvents && hasMaps) console.log(`           + pub/sub backend`);
    if (hasSecretResources) console.log(`    openbao — secrets management`);
    if (hasCron && hasEvents) console.log(`    dapr — job scheduling + pub/sub`);
    else if (hasCron) console.log(`    dapr — job scheduling`);
    else if (hasEvents) console.log(`    dapr — pub/sub`);
    for (const engine of replaceEngines) console.log(`    ${engine} — database`);
    if (hasPreservedDb) console.log(`    volume — persistent storage (embedded database)`);
  }

  console.log(`\nPlan written to ${II_DIR}/${PLAN_FILE}`);
}

function loadOrPlan(projectDir: string, planFile: string | null): App {
  if (planFile) {
    return JSON.parse(readFileSync(resolve(planFile), "utf-8")) as App;
  }

  const app = plan(projectDir);
  const out = iiDir(projectDir);
  writeFileSync(join(out, PLAN_FILE), JSON.stringify(app, null, 2) + "\n");
  return app;
}

/**
 * Write .ii/resources.json — a single manifest keyed by service name.
 * Each service entry contains maps, cronJobs, and events arrays with
 * file paths relative to the service's build context. The build script
 * reads II_SERVICE (a Docker build ARG) to select the right section.
 *
 * Shape:
 * {
 *   "api": {
 *     "maps": [{ "file": "index.ts", "varName": "tasks", "hashKey": "..." }],
 *     "cronJobs": [{ "file": "index.ts", "endpoint": "/api/cleanup", "name": "..." }],
 *     "events": [{ "file": "index.ts", "varName": "taskEvents", "namespace": "..." }]
 *   }
 * }
 */
function writeResourceManifest(out: string, app: App) {
  if (!app.resources?.length) return;

  const isMultiService = app.services.length > 1;
  const manifest: Record<string, {
    maps: Array<{ file: string; varName: string; hashKey: string }>;
    cronJobs: Array<{ file: string; endpoint: string; name: string }>;
    events: Array<{ file: string; varName: string; namespace: string }>;
  }> = {};

  for (const svc of app.services) {
    const svcResources = (app.resources ?? []).filter((r) =>
      resourceBelongsToService(r, svc, isMultiService)
    );
    if (svcResources.length === 0) continue;

    const prefix = svc.build.replace(/^\.\//, "");
    const stripPrefix = (file: string) =>
      prefix && file.startsWith(prefix + "/") ? file.slice(prefix.length + 1) : file;

    const entry = { maps: [] as typeof manifest[string]["maps"], cronJobs: [] as typeof manifest[string]["cronJobs"], events: [] as typeof manifest[string]["events"] };

    for (const r of svcResources) {
      if (r.kind === "durable-map") {
        entry.maps.push({
          file: stripPrefix(r.sourceFile),
          varName: r.name,
          hashKey: `${app.name}:${r.sourceFile}:${r.name}`,
        });
      } else if (r.kind === "cron-job") {
        entry.cronJobs.push({
          file: stripPrefix(r.sourceFile),
          endpoint: r.endpoint,
          name: r.name,
        });
      } else if (r.kind === "event-emitter") {
        entry.events.push({
          file: stripPrefix(r.sourceFile),
          varName: r.name,
          namespace: r.name,
        });
      }
    }

    manifest[svc.name] = entry;
  }

  writeFileSync(join(out, RESOURCES_FILE), JSON.stringify(manifest, null, 2) + "\n");
}

function resourceBelongsToService(r: import("./ir/index.js").Resource, svc: import("./ir/index.js").Service, isMultiService: boolean): boolean {
  if (!isMultiService) return true;
  const prefix = svc.build.replace(/^\.\//, "");
  return r.sourceFile.startsWith(prefix + "/");
}

async function doDeployLocal({ projectDir, planFile, noCache }: DeployOpts) {
  const app = loadOrPlan(projectDir, planFile);
  const out = iiDir(projectDir);
  const isMultiService = app.services.length > 1;

  // App-level resource flags for shared infrastructure
  const hasMaps = app.resources?.some((r) => r.kind === "durable-map") ?? false;
  const hasSecretResources = app.resources?.some((r) => r.kind === "secret") ?? false;
  const hasCron = app.resources?.some((r) => r.kind === "cron-job") ?? false;
  const hasEvents = app.resources?.some((r) => r.kind === "event-emitter") ?? false;
  const hasDapr = hasCron || hasEvents;

  // Generate a Dockerfile per service
  for (const svc of app.services) {
    const svcDir = isMultiService
      ? join(projectDir, svc.build.replace(/^\.\//, ""))
      : projectDir;
    const startCmd = getStartCmd(svcDir);
    const svcResources = (app.resources ?? []).filter((r) => resourceBelongsToService(r, svc, isMultiService));
    const svcHasMaps = svcResources.some((r) => r.kind === "durable-map");
    const svcHasSecrets = svcResources.some((r) => r.kind === "secret");
    const svcHasCron = svcResources.some((r) => r.kind === "cron-job");
    const svcHasEvents = svcResources.some((r) => r.kind === "event-emitter");

    const dockerfileName = isMultiService ? `Dockerfile.${svc.name}` : "Dockerfile";
    writeFileSync(
      join(out, dockerfileName),
      compileToDockerfile(svc, startCmd, {
        hasResources: svcHasMaps,
        hasSecrets: svcHasSecrets,
        hasCronJobs: svcHasCron,
        hasEvents: svcHasEvents,
      })
    );
  }

  writeFileSync(join(out, "Dockerfile.dockerignore"), "node_modules\n");
  writeFileSync(join(out, "docker-compose.yml"), compileToCompose(app));

  if (hasMaps || hasCron || hasEvents) {
    writeResourceManifest(out, app);
    writeBuildScript(out, app);
    if (hasMaps) writeDurableMapRuntime(out);
  }

  if (hasDapr) writeIIServerRuntime(out);

  if (hasEvents) {
    writeDistributedEventsRuntime(out);
    writePubsubComponent(out);
  }

  if (hasSecretResources) {
    writeSecretsShim(out);
  }

  if (hasCron) {
    writeDaprComponents(out);
  }

  console.log(`${app.name}: deploying ${app.services.length} service(s) locally...\n`);

  // Start everything in detached mode (project name scoped to app)
  if (noCache) {
    execSync(`docker compose -p ${app.name} -f ${II_DIR}/docker-compose.yml build --no-cache`, {
      cwd: projectDir,
      stdio: "inherit",
    });
  }
  execSync(`docker compose -p ${app.name} -f ${II_DIR}/docker-compose.yml up -d --build`, {
    cwd: projectDir,
    stdio: "inherit",
  });

  // Reconcile cron jobs at deploy time (not per-replica at startup)
  if (hasCron) {
    const cronJobs = (app.resources ?? []).filter(
      (r): r is import("./ir/index.js").CronJobResource => r.kind === "cron-job"
    );
    await reconcileCronJobs(cronJobs);
  }

  // Print service URLs
  for (const svc of app.services) {
    if (svc.ingress?.length) {
      console.log(`  ${svc.name}: http://localhost:${svc.port}`);
    }
  }
  console.log(`\nRun 'ii local logs' to stream logs, 'ii local down' to stop.`);
}

function doLocalDown(projectDir: string) {
  const planPath = join(projectDir, II_DIR, PLAN_FILE);
  let app: App;
  try {
    app = JSON.parse(readFileSync(planPath, "utf-8")) as App;
  } catch {
    console.error(`No plan found at ${II_DIR}/${PLAN_FILE} — run 'ii local up' first.`);
    process.exit(1);
  }

  execSync(`docker compose -p ${app.name} -f ${II_DIR}/docker-compose.yml down`, {
    cwd: projectDir,
    stdio: "inherit",
  });
}

async function doLocalLogs(projectDir: string) {
  const planPath = join(projectDir, II_DIR, PLAN_FILE);
  let app: App;
  try {
    app = JSON.parse(readFileSync(planPath, "utf-8")) as App;
  } catch {
    console.error(`No plan found at ${II_DIR}/${PLAN_FILE} — run 'ii local up' first.`);
    process.exit(1);
  }

  // Stream only app service logs, not infrastructure (valkey, openbao, dapr)
  const serviceNames = app.services.map((s) => s.name);
  const logs = spawn(
    "docker", ["compose", "-p", app.name, "-f", `${II_DIR}/docker-compose.yml`, "logs", "-f", ...serviceNames],
    { cwd: projectDir, stdio: "inherit" }
  );

  process.on("SIGINT", () => logs.kill("SIGINT"));
  await new Promise<void>((res) => logs.on("close", () => res()));
}

/**
 * Reconcile cron jobs with the Dapr Jobs API from the CLI.
 * Runs once at deploy time — not per-replica at app startup.
 *
 * 1. Wait for Dapr sidecar healthz (exposed on host port 3500)
 * 2. Read previously registered job names from Dapr state store
 * 3. Delete stale jobs (in prev but not in current)
 * 4. Register current jobs
 * 5. Save current job names to state store
 */
async function reconcileCronJobs(
  cronJobs: import("./ir/index.js").CronJobResource[]
): Promise<void> {
  const DAPR_BASE = "http://localhost:3500";
  const STATE_STORE = "ii-state";
  const STATE_KEY = "registered-cron-jobs";

  // Wait for Dapr sidecar AND scheduler to be ready.
  // healthz alone isn't enough — the scheduler connection may still be initialising
  // after the sidecar HTTP server is up.  Poll the Jobs API endpoint instead.
  console.log("  Waiting for Dapr sidecar...");
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${DAPR_BASE}/v1.0/healthz`);
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Give the scheduler connection a moment to establish after healthz passes
  console.log("  Waiting for Dapr scheduler...");
  for (let i = 0; i < 15; i++) {
    try {
      // A GET on a non-existent job returns 500 when the scheduler isn't connected,
      // but returns 404/200 (or similar non-error) when it is.
      const res = await fetch(`${DAPR_BASE}/v1.0-alpha1/jobs/__ii_probe`);
      if (res.status !== 500) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Read previously registered job names from Dapr state store
  let prevNames: string[] = [];
  try {
    const res = await fetch(`${DAPR_BASE}/v1.0/state/${STATE_STORE}/${STATE_KEY}`);
    if (res.ok) {
      prevNames = await res.json() as string[];
    }
  } catch {}

  // Delete stale jobs — names in prev but not in current
  const currentNames = new Set(cronJobs.map((j) => j.name));
  for (const name of prevNames) {
    if (!currentNames.has(name)) {
      try {
        await fetch(`${DAPR_BASE}/v1.0-alpha1/jobs/${name}`, { method: "DELETE" });
        console.log(`  Deleted stale cron job: ${name}`);
      } catch {}
    }
  }

  // Register each current job (with retries — scheduler may still be warming up)
  for (const job of cronJobs) {
    let registered = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(`${DAPR_BASE}/v1.0-alpha1/jobs/${job.name}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            schedule: `@every ${job.intervalMs}ms`,
            data: JSON.stringify({ endpoint: job.endpoint, method: job.method }),
          }),
        });
        if (res.ok) {
          console.log(`  Registered cron job: ${job.name} (every ${job.intervalMs}ms)`);
          registered = true;
          break;
        }
        // Non-OK response — scheduler may not be ready, retry
      } catch {
        // Connection failed — retry
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!registered) {
      console.error(`  Failed to register cron job ${job.name} after retries`);
    }
  }

  // Save current job names to state store for next reconciliation
  try {
    await fetch(`${DAPR_BASE}/v1.0/state/${STATE_STORE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ key: STATE_KEY, value: [...currentNames] }]),
    });
  } catch {}
}

function doDeployK8s({ projectDir, planFile }: DeployOpts) {
  const app = loadOrPlan(projectDir, planFile);
  const out = iiDir(projectDir);
  const isMultiService = app.services.length > 1;

  const hasMaps = app.resources?.some((r) => r.kind === "durable-map") ?? false;
  const hasSecretResources = app.resources?.some((r) => r.kind === "secret") ?? false;
  const hasCron = app.resources?.some((r) => r.kind === "cron-job") ?? false;
  const hasEvents = app.resources?.some((r) => r.kind === "event-emitter") ?? false;
  const hasDapr = hasCron || hasEvents;

  // Generate a Dockerfile per service
  const dockerfileNames: string[] = [];
  for (const svc of app.services) {
    const svcDir = isMultiService
      ? join(projectDir, svc.build.replace(/^\.\//, ""))
      : projectDir;
    const startCmd = getStartCmd(svcDir);
    const svcResources = (app.resources ?? []).filter((r) => resourceBelongsToService(r, svc, isMultiService));
    const svcHasMaps = svcResources.some((r) => r.kind === "durable-map");
    const svcHasSecrets = svcResources.some((r) => r.kind === "secret");
    const svcHasCron = svcResources.some((r) => r.kind === "cron-job");
    const svcHasEvents = svcResources.some((r) => r.kind === "event-emitter");

    const dockerfileName = isMultiService ? `Dockerfile.${svc.name}` : "Dockerfile";
    dockerfileNames.push(dockerfileName);
    writeFileSync(
      join(out, dockerfileName),
      compileToDockerfile(svc, startCmd, {
        hasResources: svcHasMaps,
        hasSecrets: svcHasSecrets,
        hasCronJobs: svcHasCron,
        hasEvents: svcHasEvents,
      })
    );
  }

  writeFileSync(join(out, "Dockerfile.dockerignore"), "node_modules\n");
  writeFileSync(join(out, "k8s.yml"), compileToK8s(app));

  if (hasMaps || hasCron || hasEvents) {
    writeResourceManifest(out, app);
    writeBuildScript(out, app);
    if (hasMaps) writeDurableMapRuntime(out);
  }

  if (hasDapr) writeIIServerRuntime(out);

  if (hasEvents) {
    writeDistributedEventsRuntime(out);
    writePubsubComponent(out);
  }

  if (hasSecretResources) {
    writeSecretsShim(out);
  }

  if (hasCron) {
    writeDaprComponents(out);
  }

  console.log(`${app.name}: compiled ${app.services.length} service(s)\n`);
  for (const name of dockerfileNames) {
    console.log(`  ${II_DIR}/${name}`);
  }
  console.log(`  ${II_DIR}/k8s.yml`);
}

/**
 * Write .ii/build.mjs — a self-contained build script that runs tsc
 * with our custom transformer to swap new Map() → new DurableMap().
 * Called from the Dockerfile instead of `npx tsc --outDir dist`.
 */
function writeBuildScript(out: string, app: App) {
  const hasMaps = app.resources?.some((r) => r.kind === "durable-map") ?? false;
  const hasCron = app.resources?.some((r) => r.kind === "cron-job") ?? false;

  writeFileSync(join(out, "build.mjs"), `\
import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Read the service-keyed manifest and extract arrays for this service
const serviceName = process.env.II_SERVICE;
const allResources = existsSync(join(process.cwd(), ".ii", "resources.json"))
  ? JSON.parse(readFileSync(join(process.cwd(), ".ii", "resources.json"), "utf-8"))
  : {};
const svcResources = serviceName ? (allResources[serviceName] ?? {}) : {};

// Group flat resource arrays by file into the shape each transformer expects
function groupByFile(items, key) {
  const byFile = new Map();
  for (const { file, ...rest } of items) {
    const arr = byFile.get(file) ?? [];
    arr.push(rest);
    byFile.set(file, arr);
  }
  return Array.from(byFile.entries()).map(([file, values]) => ({ file, [key]: values }));
}

const manifest = groupByFile(svcResources.maps ?? [], "maps");
const cronManifest = groupByFile(svcResources.cronJobs ?? [], "jobs");
const eventsManifest = groupByFile(svcResources.events ?? [], "emitters");

const DURABLE_MAP_IMPORT = "../.ii/runtime/durable-map.mjs";
const DISTRIBUTED_EVENTS_IMPORT = "../.ii/runtime/distributed-events.mjs";

function createDurableMapTransformer(manifest, importPath) {
  return (context) => (sourceFile) => {
    const entry = manifest.find((e) => {
      const jsName = e.file.replace(/\\.ts$/, ".js").replace(/\\.mts$/, ".mjs");
      return sourceFile.fileName.endsWith(e.file) || sourceFile.fileName.endsWith(jsName);
    });

    if (!entry || entry.maps.length === 0) return sourceFile;

    const varNames = new Map(entry.maps.map((m) => [m.varName, m.hashKey]));
    let needsImport = false;

    const visitor = (node) => {
      if (ts.isVariableStatement(node) && node.parent === sourceFile) {
        const newDeclarations = node.declarationList.declarations.map((decl) => {
          if (
            decl.initializer &&
            ts.isNewExpression(decl.initializer) &&
            ts.isIdentifier(decl.initializer.expression) &&
            decl.initializer.expression.text === "Map" &&
            ts.isIdentifier(decl.name) &&
            varNames.has(decl.name.text)
          ) {
            needsImport = true;
            const hashKey = varNames.get(decl.name.text);
            const newExpr = context.factory.createNewExpression(
              context.factory.createIdentifier("DurableMap"),
              undefined,
              [context.factory.createStringLiteral(hashKey)]
            );
            return context.factory.updateVariableDeclaration(
              decl, decl.name, decl.exclamationToken, undefined, newExpr
            );
          }
          return decl;
        });

        const newDeclList = context.factory.updateVariableDeclarationList(
          node.declarationList, newDeclarations
        );
        return context.factory.updateVariableStatement(node, node.modifiers, newDeclList);
      }
      return ts.visitEachChild(node, visitor, context);
    };

    const transformed = ts.visitEachChild(sourceFile, visitor, context);
    if (!needsImport) return transformed;

    const importDecl = context.factory.createImportDeclaration(
      undefined,
      context.factory.createImportClause(
        false,
        undefined,
        context.factory.createNamedImports([
          context.factory.createImportSpecifier(
            false, undefined,
            context.factory.createIdentifier("DurableMap")
          ),
        ])
      ),
      context.factory.createStringLiteral(importPath)
    );

    return context.factory.updateSourceFile(transformed, [
      importDecl,
      ...transformed.statements,
    ]);
  };
}

function createCronJobTransformer(cronManifest) {
  return (context) => (sourceFile) => {
    const entry = cronManifest.find((e) => {
      const jsName = e.file.replace(/\\.ts$/, ".js").replace(/\\.mts$/, ".mjs");
      return sourceFile.fileName.endsWith(e.file) || sourceFile.fileName.endsWith(jsName);
    });

    if (!entry || entry.jobs.length === 0) return sourceFile;

    const endpoints = new Set(entry.jobs.map((j) => j.endpoint));

    const newStatements = sourceFile.statements.map((node) => {
      if (
        ts.isExpressionStatement(node) &&
        ts.isCallExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "setInterval" &&
        node.expression.arguments.length >= 2
      ) {
        const callback = node.expression.arguments[0];
        if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
          const fetchEndpoint = extractFetchEndpoint(callback.body);
          if (fetchEndpoint && endpoints.has(fetchEndpoint)) {
            return context.factory.createEmptyStatement();
          }
        }
      }
      return node;
    });

    return context.factory.updateSourceFile(sourceFile, newStatements);
  };
}

function extractFetchEndpoint(body) {
  let callExpr = null;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1) return null;
    const stmt = body.statements[0];
    if (!ts.isExpressionStatement(stmt)) return null;
    if (!ts.isCallExpression(stmt.expression)) return null;
    callExpr = stmt.expression;
  } else {
    if (!ts.isCallExpression(body)) return null;
    callExpr = body;
  }
  if (!ts.isIdentifier(callExpr.expression)) return null;
  if (callExpr.expression.text !== "fetch") return null;
  if (callExpr.arguments.length < 1) return null;
  const urlArg = callExpr.arguments[0];
  if (!ts.isStringLiteral(urlArg)) return null;
  return urlArg.text;
}

function createEventEmitterTransformer(eventsManifest, importPath) {
  return (context) => (sourceFile) => {
    const entry = eventsManifest.find((e) => {
      const jsName = e.file.replace(/\\.ts$/, ".js").replace(/\\.mts$/, ".mjs");
      return sourceFile.fileName.endsWith(e.file) || sourceFile.fileName.endsWith(jsName);
    });

    if (!entry || entry.emitters.length === 0) return sourceFile;

    const varNames = new Map(entry.emitters.map((em) => [em.varName, em.namespace]));
    let needsImport = false;

    const visitor = (node) => {
      if (ts.isVariableStatement(node) && node.parent === sourceFile) {
        const newDeclarations = node.declarationList.declarations.map((decl) => {
          if (
            decl.initializer &&
            ts.isNewExpression(decl.initializer) &&
            ts.isIdentifier(decl.initializer.expression) &&
            decl.initializer.expression.text === "EventEmitter" &&
            ts.isIdentifier(decl.name) &&
            varNames.has(decl.name.text)
          ) {
            needsImport = true;
            const namespace = varNames.get(decl.name.text);
            const newExpr = context.factory.createNewExpression(
              context.factory.createIdentifier("DistributedEventEmitter"),
              undefined,
              [context.factory.createStringLiteral(namespace)]
            );
            return context.factory.updateVariableDeclaration(
              decl, decl.name, decl.exclamationToken, undefined, newExpr
            );
          }
          return decl;
        });

        const newDeclList = context.factory.updateVariableDeclarationList(
          node.declarationList, newDeclarations
        );
        return context.factory.updateVariableStatement(node, node.modifiers, newDeclList);
      }
      return ts.visitEachChild(node, visitor, context);
    };

    const transformed = ts.visitEachChild(sourceFile, visitor, context);
    if (!needsImport) return transformed;

    const importDecl = context.factory.createImportDeclaration(
      undefined,
      context.factory.createImportClause(
        false,
        undefined,
        context.factory.createNamedImports([
          context.factory.createImportSpecifier(
            false, undefined,
            context.factory.createIdentifier("DistributedEventEmitter")
          ),
        ])
      ),
      context.factory.createStringLiteral(importPath)
    );

    return context.factory.updateSourceFile(transformed, [
      importDecl,
      ...transformed.statements,
    ]);
  };
}

// Read tsconfig.json
const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, "tsconfig.json");
if (!configPath) {
  console.error("Could not find tsconfig.json");
  process.exit(1);
}

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, process.cwd());
parsedConfig.options.outDir = "dist";

const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);

const transformers = [];
if (manifest.length > 0) {
  transformers.push(createDurableMapTransformer(manifest, DURABLE_MAP_IMPORT));
}
if (cronManifest.length > 0) {
  transformers.push(createCronJobTransformer(cronManifest));
}
if (eventsManifest.length > 0) {
  transformers.push(createEventEmitterTransformer(eventsManifest, DISTRIBUTED_EVENTS_IMPORT));
}

const emitResult = program.emit(undefined, undefined, undefined, false, {
  before: transformers,
});

const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
for (const d of diagnostics) {
  console.error(ts.flattenDiagnosticMessageText(d.messageText, "\\n"));
}

if (emitResult.emitSkipped) {
  console.error("Build failed");
  process.exit(1);
}

console.log("Build complete");
`);
}

/**
 * Write .ii/runtime/durable-map.mjs — the Valkey-backed Map implementation.
 * This is the only runtime file needed. It gets COPY'd into the final
 * Docker image and imported by the transformer-generated code.
 */
function writeDurableMapRuntime(out: string) {
  const runtimeDir = join(out, "runtime");
  mkdirSync(runtimeDir, { recursive: true });

  writeFileSync(join(runtimeDir, "durable-map.mjs"), `\
import { GlideClient } from "@valkey/valkey-glide";

let client = null;

function parseValkeyUrl(url) {
  const stripped = url.replace(/^valkey:\\/\\//, "");
  const [host, portStr] = stripped.split(":");
  return { host, port: portStr ? parseInt(portStr, 10) : 6379 };
}

async function getClient() {
  if (!client) {
    const url = process.env.VALKEY_URL;
    if (!url) throw new Error("VALKEY_URL not set. DurableMap requires a Valkey connection.");
    const { host, port } = parseValkeyUrl(url);
    client = await GlideClient.createClient({ addresses: [{ host, port }] });
  }
  return client;
}

export class DurableMap {
  #hashKey;
  constructor(hashKey) { this.#hashKey = hashKey; }

  async get(key) {
    const c = await getClient();
    const raw = await c.hget(this.#hashKey, key);
    return raw === null ? undefined : JSON.parse(raw);
  }

  async set(key, value) {
    const c = await getClient();
    await c.hset(this.#hashKey, { [key]: JSON.stringify(value) });
    return this;
  }

  async has(key) {
    const c = await getClient();
    return c.hexists(this.#hashKey, key);
  }

  async delete(key) {
    const c = await getClient();
    const removed = await c.hdel(this.#hashKey, [key]);
    return removed > 0;
  }

  async size() {
    const c = await getClient();
    return c.hlen(this.#hashKey);
  }

  async clear() {
    const c = await getClient();
    await c.del([this.#hashKey]);
  }

  async keys() {
    const c = await getClient();
    return c.hkeys(this.#hashKey);
  }

  async values() {
    const c = await getClient();
    const all = await c.hgetall(this.#hashKey);
    // valkey-glide returns GlideRecord: array of { field, value } objects
    return all.map((entry) => JSON.parse(entry.value));
  }

  async entries() {
    const c = await getClient();
    const all = await c.hgetall(this.#hashKey);
    // valkey-glide returns GlideRecord: array of { field, value } objects
    return all.map((entry) => [entry.field, JSON.parse(entry.value)]);
  }
}
`);
}

/**
 * Write .ii/runtime/secrets-shim.mjs — a Node --import hook that fetches
 * secrets from OpenBao and populates process.env before the app starts.
 * Uses Node 22's built-in fetch(), no npm dependencies needed.
 */
function writeSecretsShim(out: string) {
  const runtimeDir = join(out, "runtime");
  mkdirSync(runtimeDir, { recursive: true });

  writeFileSync(join(runtimeDir, "secrets-shim.mjs"), `\
// Secrets shim — runs via node --import before the app starts.
// Reads secret names from OPENBAO_SECRETS, seeds dev values,
// then fetches from OpenBao and populates process.env.

const addr = process.env.OPENBAO_ADDR;
const token = process.env.OPENBAO_TOKEN;
const secretNames = JSON.parse(process.env.OPENBAO_SECRETS || "[]");

if (addr && token && secretNames.length > 0) {
  // Seed each secret (idempotent — overwrites on each start).
  // II_SECRET_SEEDS provides real connection strings for provisioned engines;
  // other secrets get a dev placeholder.
  const seeds = JSON.parse(process.env.II_SECRET_SEEDS || "{}");
  for (const name of secretNames) {
    const seedValue = seeds[name] ?? \`\${name}-dev-value\`;
    await fetch(\`\${addr}/v1/secret/data/\${name}\`, {
      method: "PUT",
      headers: { "X-Vault-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ data: { value: seedValue } }),
    }).catch(() => {});
  }

  // Fetch each secret and populate process.env
  for (const name of secretNames) {
    try {
      const res = await fetch(\`\${addr}/v1/secret/data/\${name}\`, {
        headers: { "X-Vault-Token": token },
      });
      if (res.ok) {
        const json = await res.json();
        process.env[name] = json.data?.data?.value ?? "";
      }
    } catch {
      // OpenBao not ready yet — leave env var unset
    }
  }
}
`);
}

function writeIIServerRuntime(out: string) {
  const runtimeDir = join(out, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const src = fileURLToPath(new URL("./runtime/ii-server.mjs", import.meta.url));
  copyFileSync(src, join(runtimeDir, "ii-server.mjs"));
}

function writeDistributedEventsRuntime(out: string) {
  const runtimeDir = join(out, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const src = fileURLToPath(new URL("./runtime/distributed-events.mjs", import.meta.url));
  copyFileSync(src, join(runtimeDir, "distributed-events.mjs"));
}

function writePubsubComponent(out: string) {
  const componentsDir = join(out, "components");
  mkdirSync(componentsDir, { recursive: true });

  writeFileSync(join(componentsDir, "pubsub.yaml"), `\
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: ii-pubsub
spec:
  type: pubsub.redis
  version: v1
  metadata:
  - name: redisHost
    value: valkey:6379
`);
}

/**
 * Write .ii/components/statestore.yaml — Dapr state store component backed
 * by Valkey (Redis-compatible). Used by the CLI to persist registered job
 * names across restarts so it can reconcile stale jobs on the next deploy.
 *
 * We reuse the same Valkey instance that backs durable maps / pub-sub.
 * The previous SQLite backend crashed the sidecar because the daprd
 * distroless image runs as UID 65532 and can't write to Docker volumes.
 */
function writeDaprComponents(out: string) {
  const componentsDir = join(out, "components");
  mkdirSync(componentsDir, { recursive: true });

  writeFileSync(join(componentsDir, "statestore.yaml"), `\
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: ii-state
spec:
  type: state.redis
  version: v1
  metadata:
  - name: redisHost
    value: valkey:6379
`);
}

function getStartCmd(projectDir: string): string {
  const pkg = JSON.parse(
    readFileSync(join(projectDir, "package.json"), "utf-8")
  ) as { scripts?: Record<string, string> };
  return pkg.scripts?.start ?? "node index.js";
}

main();
