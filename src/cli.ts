import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
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

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "plan") {
    const projectDir = resolve(args[1] ?? ".");
    doPlan(projectDir);
  } else if (command === "deploy") {
    const opts = parseDeployArgs(args.slice(1));

    if (opts.target === "--local") {
      doDeployLocal(opts);
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
}

function doDeployLocal({ projectDir, planFile }: DeployOpts) {
  const app = loadOrPlan(projectDir, planFile);
  const startCmd = getStartCmd(projectDir);
  const svc = app.services[0];
  const out = iiDir(projectDir);
  const hasMaps = app.resources?.some((r) => r.kind === "durable-map") ?? false;
  const hasSecretResources = app.resources?.some((r) => r.kind === "secret") ?? false;

  writeFileSync(
    join(out, "Dockerfile"),
    compileToDockerfile(svc, startCmd, {
      hasResources: hasMaps,
      hasSecrets: hasSecretResources,
    })
  );
  writeFileSync(join(out, "docker-compose.yml"), compileToCompose(app));

  if (hasMaps) {
    writeResourceManifest(out, app);
    writeBuildScript(out);
    writeDurableMapRuntime(out);
  }

  if (hasSecretResources) {
    writeSecretsShim(out);
  }

  console.log(`${app.name}: deploying ${app.services.length} service(s) locally...\n`);

  execSync(`docker compose -f ${II_DIR}/docker-compose.yml up --build`, {
    cwd: projectDir,
    stdio: "inherit",
  });
}

function doDeployK8s({ projectDir, planFile }: DeployOpts) {
  const app = loadOrPlan(projectDir, planFile);
  const startCmd = getStartCmd(projectDir);
  const svc = app.services[0];
  const out = iiDir(projectDir);
  const hasMaps = app.resources?.some((r) => r.kind === "durable-map") ?? false;
  const hasSecretResources = app.resources?.some((r) => r.kind === "secret") ?? false;

  writeFileSync(
    join(out, "Dockerfile"),
    compileToDockerfile(svc, startCmd, {
      hasResources: hasMaps,
      hasSecrets: hasSecretResources,
    })
  );
  writeFileSync(join(out, "k8s.yml"), compileToK8s(app));

  if (hasMaps) {
    writeResourceManifest(out, app);
    writeBuildScript(out);
    writeDurableMapRuntime(out);
  }

  if (hasSecretResources) {
    writeSecretsShim(out);
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
function writeBuildScript(out: string) {
  writeFileSync(join(out, "build.mjs"), `\
import ts from "typescript";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const manifest = JSON.parse(
  readFileSync(join(process.cwd(), ".ii", "resources.json"), "utf-8")
);

const DURABLE_MAP_IMPORT = "../.ii/runtime/durable-map.mjs";

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
const transformer = createDurableMapTransformer(manifest, DURABLE_MAP_IMPORT);

const emitResult = program.emit(undefined, undefined, undefined, false, {
  before: [transformer],
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

function getStartCmd(projectDir: string): string {
  const pkg = JSON.parse(
    readFileSync(join(projectDir, "package.json"), "utf-8")
  ) as { scripts?: Record<string, string> };
  return pkg.scripts?.start ?? "node index.js";
}

main();
