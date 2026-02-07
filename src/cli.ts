import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  ii plan                        <project-dir>   Analyze source, write .ii/${PLAN_FILE}
  ii deploy --local              <project-dir>   Deploy locally via Docker
  ii deploy --k8s                <project-dir>   Compile to k8s manifests
  ii deploy --local --plan FILE  <project-dir>   Deploy using an existing plan file
  ii deploy --k8s   --plan FILE  <project-dir>   Compile to k8s using an existing plan file`;

interface DeployOpts {
  target: string;
  planFile: string | null;
  projectDir: string;
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
  } else if (command === "deploy") {
    const opts = parseDeployArgs(args.slice(1));

    if (opts.target === "--local") {
      await doDeployLocal(opts);
    } else if (opts.target === "--k8s") {
      doDeployK8s(opts);
    } else {
      console.error(`Deploy requires --local or --k8s\n`);
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

  if (infra.length > 0) {
    console.log(`\n  infrastructure:`);
    if (hasMaps) console.log(`    valkey — durable map backend`);
    if (hasEvents && !hasMaps) console.log(`    valkey — pub/sub backend`);
    if (hasEvents && hasMaps) console.log(`           + pub/sub backend`);
    if (hasSecretResources) console.log(`    openbao — secrets management`);
    if (hasCron && hasEvents) console.log(`    dapr — job scheduling + pub/sub`);
    else if (hasCron) console.log(`    dapr — job scheduling`);
    else if (hasEvents) console.log(`    dapr — pub/sub`);
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

function writeResourceManifest(out: string, app: App) {
  if (!app.resources?.length) return;

  const byFile = new Map<string, Array<{ varName: string; hashKey: string }>>();
  for (const r of app.resources) {
    if (r.kind === "durable-map") {
      const maps = byFile.get(r.sourceFile) ?? [];
      maps.push({
        varName: r.name,
        hashKey: `${app.name}:${r.sourceFile}:${r.name}`,
      });
      byFile.set(r.sourceFile, maps);
    }
  }

  const manifest = Array.from(byFile.entries()).map(([file, maps]) => ({
    file,
    maps,
  }));

  writeFileSync(join(out, RESOURCES_FILE), JSON.stringify(manifest, null, 2) + "\n");

  // Write cron jobs manifest for the transformer
  const cronByFile = new Map<string, Array<{ endpoint: string; name: string }>>();
  for (const r of app.resources) {
    if (r.kind === "cron-job") {
      const jobs = cronByFile.get(r.sourceFile) ?? [];
      jobs.push({ endpoint: r.endpoint, name: r.name });
      cronByFile.set(r.sourceFile, jobs);
    }
  }

  if (cronByFile.size > 0) {
    const cronManifest = Array.from(cronByFile.entries()).map(([file, jobs]) => ({
      file,
      jobs,
    }));
    writeFileSync(join(out, "cron-jobs.json"), JSON.stringify(cronManifest, null, 2) + "\n");
  }

  // Write events manifest for the transformer
  const eventsByFile = new Map<string, Array<{ varName: string; namespace: string }>>();
  for (const r of app.resources) {
    if (r.kind === "event-emitter") {
      const emitters = eventsByFile.get(r.sourceFile) ?? [];
      emitters.push({
        varName: r.name,
        namespace: r.name,
      });
      eventsByFile.set(r.sourceFile, emitters);
    }
  }

  if (eventsByFile.size > 0) {
    const eventsManifest = Array.from(eventsByFile.entries()).map(([file, emitters]) => ({
      file,
      emitters,
    }));
    writeFileSync(join(out, "events.json"), JSON.stringify(eventsManifest, null, 2) + "\n");
  }
}

async function doDeployLocal({ projectDir, planFile }: DeployOpts) {
  const app = loadOrPlan(projectDir, planFile);
  const startCmd = getStartCmd(projectDir);
  const svc = app.services[0];
  const out = iiDir(projectDir);
  const hasMaps = app.resources?.some((r) => r.kind === "durable-map") ?? false;
  const hasSecretResources = app.resources?.some((r) => r.kind === "secret") ?? false;
  const hasCron = app.resources?.some((r) => r.kind === "cron-job") ?? false;
  const hasEvents = app.resources?.some((r) => r.kind === "event-emitter") ?? false;
  const hasDapr = hasCron || hasEvents;

  writeFileSync(
    join(out, "Dockerfile"),
    compileToDockerfile(svc, startCmd, {
      hasResources: hasMaps,
      hasSecrets: hasSecretResources,
      hasCronJobs: hasCron,
      hasEvents,
    })
  );
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

  // Start everything in detached mode
  execSync(`docker compose -f ${II_DIR}/docker-compose.yml up -d --build`, {
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

  // Stream logs in foreground — Ctrl+C stops tailing but containers keep running
  const logs = spawn(
    "docker", ["compose", "-f", `${II_DIR}/docker-compose.yml`, "logs", "-f"],
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

  // Wait for Dapr sidecar to be ready
  console.log("  Waiting for Dapr sidecar...");
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${DAPR_BASE}/v1.0/healthz`);
      if (res.ok) break;
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

  // Register each current job
  for (const job of cronJobs) {
    try {
      await fetch(`${DAPR_BASE}/v1.0-alpha1/jobs/${job.name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schedule: `@every ${job.intervalMs}ms`,
          data: { endpoint: job.endpoint, method: job.method },
        }),
      });
      console.log(`  Registered cron job: ${job.name} (every ${job.intervalMs}ms)`);
    } catch (err) {
      console.error(`  Failed to register cron job ${job.name}:`, (err as Error).message);
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
  const startCmd = getStartCmd(projectDir);
  const svc = app.services[0];
  const out = iiDir(projectDir);
  const hasMaps = app.resources?.some((r) => r.kind === "durable-map") ?? false;
  const hasSecretResources = app.resources?.some((r) => r.kind === "secret") ?? false;
  const hasCron = app.resources?.some((r) => r.kind === "cron-job") ?? false;
  const hasEvents = app.resources?.some((r) => r.kind === "event-emitter") ?? false;
  const hasDapr = hasCron || hasEvents;

  writeFileSync(
    join(out, "Dockerfile"),
    compileToDockerfile(svc, startCmd, {
      hasResources: hasMaps,
      hasSecrets: hasSecretResources,
      hasCronJobs: hasCron,
      hasEvents,
    })
  );
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
  console.log(`  ${II_DIR}/Dockerfile`);
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

const manifest = existsSync(join(process.cwd(), ".ii", "resources.json"))
  ? JSON.parse(readFileSync(join(process.cwd(), ".ii", "resources.json"), "utf-8"))
  : [];

const cronManifest = existsSync(join(process.cwd(), ".ii", "cron-jobs.json"))
  ? JSON.parse(readFileSync(join(process.cwd(), ".ii", "cron-jobs.json"), "utf-8"))
  : [];

const eventsManifest = existsSync(join(process.cwd(), ".ii", "events.json"))
  ? JSON.parse(readFileSync(join(process.cwd(), ".ii", "events.json"), "utf-8"))
  : [];

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

    const visitor = (node) => {
      if (
        ts.isExpressionStatement(node) &&
        node.parent === sourceFile &&
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
      return ts.visitEachChild(node, visitor, context);
    };

    return ts.visitEachChild(sourceFile, visitor, context);
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
    return Object.values(all).map((v) => JSON.parse(v));
  }

  async entries() {
    const c = await getClient();
    const all = await c.hgetall(this.#hashKey);
    return Object.entries(all).map(([k, v]) => [k, JSON.parse(v)]);
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
  // Seed each secret with a dev placeholder (idempotent — overwrites on each start)
  for (const name of secretNames) {
    await fetch(\`\${addr}/v1/secret/data/\${name}\`, {
      method: "PUT",
      headers: { "X-Vault-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ data: { value: \`\${name}-dev-value\` } }),
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

  writeFileSync(join(runtimeDir, "ii-server.mjs"), `\
// II internal server — runs via node --import before the app starts.
// Provides HTTP endpoints for Dapr to deliver pub/sub messages and cron callbacks.
// No monkey-patching — this is a standalone server on its own port.

import http from "node:http";

const II_PORT = parseInt(process.env.II_SERVER_PORT || "3501", 10);
const APP_PORT = parseInt(process.env.II_APP_PORT || "3000", 10);
const eventsManifest = JSON.parse(process.env.II_EVENTS_MANIFEST || "[]");

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  // GET /dapr/subscribe — programmatic subscription list
  if (req.method === "GET" && req.url === "/dapr/subscribe") {
    const subs = [];
    for (const entry of eventsManifest) {
      for (const event of entry.events) {
        subs.push({
          pubsubname: "ii-pubsub",
          topic: \`\${entry.namespace}.\${event}\`,
          route: \`/ii/events/\${entry.namespace}/\${event}\`,
        });
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(subs));
    return;
  }

  // POST /ii/events/{namespace}/{event} — pub/sub delivery
  const eventsMatch = req.url?.match(/^\\/ii\\/events\\/([^/]+)\\/(.+)$/);
  if (req.method === "POST" && eventsMatch) {
    const [, namespace, event] = eventsMatch;
    const body = await readBody(req);
    try {
      const envelope = JSON.parse(body);
      // Dapr wraps pub/sub payloads in a CloudEvents envelope — unwrap .data
      const payload = envelope.data ?? envelope;
      for (const emitter of (globalThis.__ii_event_emitters || [])) {
        if (emitter._namespace === namespace) {
          emitter._deliver(event, payload);
        }
      }
    } catch (err) {
      console.error("[ii] Failed to deliver event:", err.message);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"ok"}');
    return;
  }

  // POST /ii/jobs/{name} — cron job callback, proxy to app
  const jobsMatch = req.url?.match(/^\\/ii\\/jobs\\/(.+)$/);
  if (req.method === "POST" && jobsMatch) {
    const body = await readBody(req);
    try {
      const data = JSON.parse(body);
      const { endpoint, method } = data;
      await fetch(\`http://localhost:\${APP_PORT}\${endpoint}\`, { method: method || "GET" });
    } catch (err) {
      console.error("[ii] Failed to proxy cron job:", err.message);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"ok"}');
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(II_PORT, () => {
  console.log(\`[ii] Internal server listening on :\${II_PORT}\`);
});
`);
}

function writeDistributedEventsRuntime(out: string) {
  const runtimeDir = join(out, "runtime");
  mkdirSync(runtimeDir, { recursive: true });

  writeFileSync(join(runtimeDir, "distributed-events.mjs"), `\
// Distributed EventEmitter — replaces node:events EventEmitter with Dapr pub/sub.
// emit() publishes to Dapr, handlers are invoked when Dapr delivers messages
// through the II internal server.

const DAPR_PORT = process.env.DAPR_HTTP_PORT || "3500";
const PUBSUB_NAME = "ii-pubsub";

export class DistributedEventEmitter {
  #namespace;
  #handlers = new Map();

  constructor(namespace) {
    this.#namespace = namespace;
    globalThis.__ii_event_emitters = globalThis.__ii_event_emitters || [];
    globalThis.__ii_event_emitters.push(this);
  }

  on(event, handler) {
    if (!this.#handlers.has(event)) {
      this.#handlers.set(event, new Set());
    }
    this.#handlers.get(event).add(handler);
    return this;
  }

  once(event, handler) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      handler(...args);
    };
    wrapper._original = handler;
    return this.on(event, wrapper);
  }

  off(event, handler) {
    const set = this.#handlers.get(event);
    if (set) {
      set.delete(handler);
      for (const h of set) {
        if (h._original === handler) {
          set.delete(h);
          break;
        }
      }
    }
    return this;
  }

  removeListener(event, handler) {
    return this.off(event, handler);
  }

  async emit(event, ...args) {
    const topic = \`\${this.#namespace}.\${event}\`;
    try {
      await fetch(\`http://localhost:\${DAPR_PORT}/v1.0/publish/\${PUBSUB_NAME}/\${topic}\`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args }),
      });
    } catch (err) {
      console.error(\`[ii] Failed to publish to \${topic}:\`, err.message);
    }
    return true;
  }

  _deliver(event, data) {
    const set = this.#handlers.get(event);
    if (!set) return;
    const args = data?.args ?? [];
    for (const handler of set) {
      try {
        handler(...args);
      } catch (err) {
        console.error(\`[ii] Handler error for \${this.#namespace}.\${event}:\`, err);
      }
    }
  }

  get _namespace() { return this.#namespace; }
}
`);
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
 * by SQLite. Used by the cron shim to persist registered job names across
 * restarts so it can reconcile stale jobs on the next deploy.
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
  type: state.sqlite
  version: v1
  metadata:
  - name: connectionString
    value: /state/ii-state.db
`);
}

function getStartCmd(projectDir: string): string {
  const pkg = JSON.parse(
    readFileSync(join(projectDir, "package.json"), "utf-8")
  ) as { scripts?: Record<string, string> };
  return pkg.scripts?.start ?? "node index.js";
}

main();
