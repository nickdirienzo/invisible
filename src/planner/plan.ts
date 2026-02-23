import { readdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import ts from "typescript";
import type { App, Resource, CapabilityImportResource } from "../ir/index.js";

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

interface ServicePlan {
  service: import("../ir/index.js").Service;
  resources: Resource[];
}

function planService(
  serviceDir: string,
  serviceName: string,
  buildPath: string
): ServicePlan {
  const pkg = readPackageJson(serviceDir);
  const sourceFiles = findSourceFiles(serviceDir);
  const { program, checker } = createProgram(serviceDir, sourceFiles);

  const listenResult = detectListenCall(program, checker, serviceDir, sourceFiles);
  const buildMode = !listenResult ? detectBuildMode(pkg) : null;
  const frameworkResult = buildMode?.kind === "framework" ? buildMode.result : null;
  const staticResult = buildMode?.kind === "static" ? buildMode.result : null;
  const hasIngress = listenResult !== null || frameworkResult !== null || staticResult !== null;
  const entrypoint = listenResult?.file ?? detectEntrypoint(sourceFiles);
  const typescript = entrypoint.endsWith(".ts") || entrypoint.endsWith(".tsx") || entrypoint.endsWith(".mts");

  const durableMaps = detectDurableMaps(program, serviceDir, sourceFiles);
  const secrets = detectSecrets(program, serviceDir, sourceFiles);
  const envVars = detectEnvVars(program, serviceDir, sourceFiles);
  const cronJobs = detectCronJobs(program, serviceDir, sourceFiles);
  const eventEmitters = detectEventEmitters(program, serviceDir, sourceFiles);
  const capabilityImports = detectCapabilityImports(program, serviceDir, sourceFiles);
  const resources: Resource[] = [
    ...durableMaps.map((m) => ({
      kind: "durable-map" as const,
      name: m.name,
      sourceFile: m.file,
    })),
    ...secrets.map((s) => ({
      kind: "secret" as const,
      name: s.name,
      sourceFile: s.file,
    })),
    ...envVars.map((v) => ({
      kind: "env-var" as const,
      name: v.name,
      sourceFile: v.file,
    })),
    ...cronJobs.map((c) => ({
      kind: "cron-job" as const,
      name: c.name,
      endpoint: c.endpoint,
      method: c.method,
      intervalMs: c.intervalMs,
      sourceFile: c.file,
    })),
    ...eventEmitters.map((e) => ({
      kind: "event-emitter" as const,
      name: e.name,
      sourceFile: e.file,
      events: e.events,
    })),
    ...capabilityImports.map((c) => ({
      kind: "capability-import" as const,
      module: c.module,
      capability: c.capability,
      engine: c.engine,
      provisioning: c.provisioning,
      sourceFile: c.file,
      name: c.engine ?? c.module,
      ...(c.deferred ? { deferred: c.deferred } : {}),
    })),
  ];

  return {
    service: {
      name: serviceName,
      build: buildPath,
      port: listenResult?.port ?? frameworkResult?.port ?? (staticResult ? 80 : 3000),
      entrypoint,
      typescript,
      ...(hasIngress ? { ingress: [{ host: "", path: "/" }] } : {}),
      ...(frameworkResult?.startCmd ? { startCmd: frameworkResult.startCmd } : {}),
      ...(frameworkResult?.buildCmd ? { buildCmd: frameworkResult.buildCmd } : {}),
      ...(staticResult ? { buildCmd: staticResult.buildCmd, static: true } : {}),
    },
    resources,
  };
}

function discoverServiceDirs(projectDir: string): Array<{ name: string; dir: string }> {
  const entries = readdirSync(projectDir, { withFileTypes: true });
  const serviceDirs: Array<{ name: string; dir: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    const subDir = join(projectDir, entry.name);
    const pkgPath = join(subDir, "package.json");
    try {
      readFileSync(pkgPath, "utf-8");
      serviceDirs.push({ name: entry.name, dir: subDir });
    } catch {
      // No package.json — not a service
    }
  }

  return serviceDirs;
}

export function plan(projectDir: string): App {
  const pkg = readPackageJson(projectDir);
  const appName = pkg.name ?? basename(projectDir);

  // Check for monorepo structure (subdirectories with package.json)
  const serviceDirs = discoverServiceDirs(projectDir);

  if (serviceDirs.length > 0) {
    const services: import("../ir/index.js").Service[] = [];
    const allResources: Resource[] = [];

    for (const svcDir of serviceDirs) {
      const result = planService(svcDir.dir, svcDir.name, `./${svcDir.name}`);
      services.push(result.service);
      // Prefix sourceFile with service dir for disambiguation
      for (const r of result.resources) {
        allResources.push({ ...r, sourceFile: `${svcDir.name}/${r.sourceFile}` });
      }
    }

    return {
      name: appName,
      services,
      ...(allResources.length > 0 ? { resources: allResources } : {}),
    };
  }

  // Single-service project (current behavior)
  const result = planService(projectDir, "web", "./");
  return {
    name: appName,
    services: [result.service],
    ...(result.resources.length > 0 ? { resources: result.resources } : {}),
  };
}

function readPackageJson(dir: string): PackageJson {
  const raw = readFileSync(join(dir, "package.json"), "utf-8");
  return JSON.parse(raw) as PackageJson;
}

function findSourceFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(currentDir: string, prefix: string) {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || entry.name === ".ii") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(currentDir, entry.name), rel);
      } else if (/\.(ts|js|mjs|mts|tsx|jsx)$/.test(entry.name)) {
        results.push(rel);
      }
    }
  }

  walk(dir, "");
  return results;
}

function createProgram(projectDir: string, files: string[]) {
  const filePaths = files.map((f) => join(projectDir, f));
  const program = ts.createProgram(filePaths, {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    baseUrl: projectDir,
  });
  const checker = program.getTypeChecker();
  return { program, checker };
}

function detectEntrypoint(files: string[]): string {
  if (files.includes("index.ts")) return "index.ts";
  if (files.includes("index.js")) return "index.js";
  return files[0] ?? "index.js";
}

// ---------------------------------------------------------------------------
// Framework detection — check package.json scripts.start + scripts.build
// ---------------------------------------------------------------------------

interface FrameworkResult {
  port: number;
  startCmd: string;
  buildCmd: string;
}

interface StaticSiteResult {
  buildCmd: string;
}

type BuildDetectionResult =
  | { kind: "framework"; result: FrameworkResult }
  | { kind: "static"; result: StaticSiteResult }
  | null;

/**
 * Detects how a service is built+served from package.json scripts.
 * Only checked when no explicit .listen() call is found in source code.
 *
 * Detection cascade:
 *   1. scripts.build + scripts.start → server framework (Remix, Next, etc.)
 *   2. scripts.build + no scripts.start → static site (Vite, CRA, etc.)
 *   3. Neither → null (no detection)
 *
 * The key insight: if the code had a server, we'd have found a .listen() call.
 * A build script without a start script means the output is static files —
 * no server process needed, just nginx.
 */
function detectBuildMode(pkg: PackageJson): BuildDetectionResult {
  const startScript = pkg.scripts?.start;
  const buildScript = pkg.scripts?.build;
  if (!buildScript) return null;

  if (startScript) {
    // Extract port from --port flag if present, otherwise default to 3000
    const portMatch = startScript.match(/--port\s+(\d+)/);
    const port = portMatch ? parseInt(portMatch[1], 10) : 3000;
    return {
      kind: "framework",
      result: { port, startCmd: startScript, buildCmd: buildScript },
    };
  }

  // scripts.build without scripts.start → static site
  return { kind: "static", result: { buildCmd: buildScript } };
}

// ---------------------------------------------------------------------------
// Listen detection
// ---------------------------------------------------------------------------

interface ListenResult {
  file: string;
  port: number;
}

/**
 * Uses the TypeScript type checker to find .listen() calls on objects
 * whose type traces back to node:http, node:net, or known HTTP frameworks.
 */
function detectListenCall(
  program: ts.Program,
  checker: ts.TypeChecker,
  projectDir: string,
  files: string[]
): ListenResult | null {
  for (const file of files) {
    const sourceFile = program.getSourceFile(join(projectDir, file));
    if (!sourceFile) continue;

    const result = walkForListen(sourceFile, checker);
    if (result !== null) {
      return { file, port: result };
    }
  }

  return null;
}

/**
 * Known type names that indicate an HTTP server.
 * These are the types that have a meaningful .listen() method
 * for binding to a network port.
 */
const HTTP_SERVER_TYPES = new Set([
  "Server",       // node:http, node:https, node:net
  "Application",  // Express
  "Express",      // Express (alternate type name)
  "FastifyInstance",
  "Koa",
]);

function isHttpServerType(type: ts.Type, checker: ts.TypeChecker): boolean {
  const typeName = checker.typeToString(type);

  // If types aren't resolvable (e.g. missing node_modules), the checker
  // returns "any" or "error". Accept those — better a false positive from
  // an unresolved type than silently missing a real server.
  if (type.flags & ts.TypeFlags.Any) return true;

  // Check the type name directly. Strip generic parameters
  // (e.g. "Server<typeof IncomingMessage, typeof ServerResponse>" → "Server")
  const baseName = typeName.split("<")[0];
  if (HTTP_SERVER_TYPES.has(baseName)) return true;

  // Check if any base type / constituent type matches
  // This handles Express which returns http.Server from .listen()
  if (type.isUnionOrIntersection()) {
    return type.types.some((t) => isHttpServerType(t, checker));
  }

  // Check the return type of .listen — if the object has a .listen
  // that returns Server, it's likely an HTTP server
  const listenProp = type.getProperty("listen");
  if (listenProp) {
    const listenType = checker.getTypeOfSymbol(listenProp);
    const signatures = listenType.getCallSignatures();
    for (const sig of signatures) {
      const returnType = checker.getReturnTypeOfSignature(sig);
      const returnName = checker.typeToString(returnType);
      if (returnName === "Server" || returnName === "this") return true;
    }
  }

  return false;
}

function walkForListen(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker
): number | null {
  let result: number | null = null;

  function visit(node: ts.Node) {
    if (result !== null) return;

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "listen" &&
      node.arguments.length > 0
    ) {
      // Get the type of the object .listen() is called on
      const objType = checker.getTypeAtLocation(node.expression.expression);

      if (isHttpServerType(objType, checker)) {
        const port = resolvePort(node.arguments[0], sourceFile);
        if (port !== null) {
          result = port;
          return;
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

/**
 * Resolve the port value from a .listen() argument.
 * Handles:
 *   - Numeric literals: .listen(3000)
 *   - Variable references: .listen(port) → follows to declaration
 *   - Object literals: .listen({ port: 3000 })
 */
function resolvePort(
  arg: ts.Expression,
  sourceFile: ts.SourceFile
): number | null {
  if (ts.isNumericLiteral(arg)) {
    return parseInt(arg.text, 10);
  }

  if (ts.isObjectLiteralExpression(arg)) {
    for (const prop of arg.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "port"
      ) {
        return resolvePort(prop.initializer, sourceFile);
      }
    }
    return null;
  }

  if (ts.isIdentifier(arg)) {
    return resolveVariable(arg.text, sourceFile);
  }

  return null;
}

function resolveVariable(
  name: string,
  sourceFile: ts.SourceFile
): number | null {
  let result: number | null = null;

  function visit(node: ts.Node) {
    if (result !== null) return;

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      result = resolveExpression(node.initializer);
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

function resolveExpression(expr: ts.Expression): number | null {
  if (ts.isNumericLiteral(expr)) {
    return parseInt(expr.text, 10);
  }

  if (ts.isBinaryExpression(expr)) {
    if (
      expr.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return resolveExpression(expr.right);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Durable Map detection (ADR-0003: module-scope = durable)
// ---------------------------------------------------------------------------

interface DurableMapDetection {
  name: string;
  file: string;
}

/**
 * Walk top-level statements looking for `new Map()` declarations.
 * Only module-scope (top-level) Maps are considered durable.
 * Function-scoped Maps are ephemeral and ignored.
 */
function detectDurableMaps(
  program: ts.Program,
  projectDir: string,
  files: string[]
): DurableMapDetection[] {
  const results: DurableMapDetection[] = [];

  for (const file of files) {
    const sourceFile = program.getSourceFile(join(projectDir, file));
    if (!sourceFile) continue;

    // Only iterate top-level statements — this is module scope
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;

      for (const decl of statement.declarationList.declarations) {
        if (
          decl.initializer &&
          ts.isNewExpression(decl.initializer) &&
          ts.isIdentifier(decl.initializer.expression) &&
          decl.initializer.expression.text === "Map" &&
          ts.isIdentifier(decl.name)
        ) {
          results.push({ name: decl.name.text, file });
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Secret detection (ADR-0008: process.env → OpenBao)
// ---------------------------------------------------------------------------

interface SecretDetection {
  name: string;
  file: string;
}

/** Env vars that are infrastructure-managed or non-secret */
const EXCLUDED_ENV_VARS = new Set([
  "PORT",
  "NODE_ENV",
  "VALKEY_URL",
  "OPENBAO_ADDR",
  "OPENBAO_TOKEN",
  "HOST",
  "HOSTNAME",
  "HOME",
  "PATH",
  "PWD",
  "USER",
  "SHELL",
  "TERM",
  "TZ",
  "LANG",
  "LC_ALL",
  "II_EVENTS_MANIFEST",
  "II_CRON_JOBS",
  "II_APP_PORT",
  "II_SERVER_PORT",
  "DAPR_HTTP_PORT",
]);

/**
 * Walk the full AST looking for `process.env` access patterns.
 * Unlike durable maps, env vars can be accessed anywhere (not just module scope).
 * Handles:
 *   - process.env.VARIABLE_NAME (PropertyAccessExpression)
 *   - process.env["VARIABLE_NAME"] (ElementAccessExpression with string literal)
 * Dynamic access like process.env[someVar] is silently skipped (ADR-0008 limitation).
 */
function detectSecrets(
  program: ts.Program,
  projectDir: string,
  files: string[]
): SecretDetection[] {
  const results: SecretDetection[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const sourceFile = program.getSourceFile(join(projectDir, file));
    if (!sourceFile) continue;

    walkForProcessEnv(sourceFile, (envVarName) => {
      const key = `${file}:${envVarName}`;
      if (!seen.has(key) && !EXCLUDED_ENV_VARS.has(envVarName)) {
        seen.add(key);
        results.push({ name: envVarName, file });
      }
    });
  }

  return results;
}

function walkForProcessEnv(
  sourceFile: ts.SourceFile,
  onFound: (envVarName: string) => void
): void {
  function visit(node: ts.Node) {
    // Pattern 1: process.env.VARIABLE_NAME
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "process" &&
      node.expression.name.text === "env"
    ) {
      onFound(node.name.text);
      return;
    }

    // Pattern 2: process.env["VARIABLE_NAME"]
    if (
      ts.isElementAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "process" &&
      node.expression.name.text === "env" &&
      ts.isStringLiteral(node.argumentExpression)
    ) {
      onFound(node.argumentExpression.text);
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

// ---------------------------------------------------------------------------
// Build-time env var detection (import.meta.env → Docker build ARG)
// ---------------------------------------------------------------------------

interface EnvVarDetection {
  name: string;
  file: string;
}

/**
 * Walk the full AST looking for `import.meta.env.VARIABLE_NAME` access patterns.
 * These are build-time environment variables (used by Vite, etc.) that get inlined
 * at build time — distinct from process.env secrets which are fetched at runtime.
 */
function detectEnvVars(
  program: ts.Program,
  projectDir: string,
  files: string[]
): EnvVarDetection[] {
  const results: EnvVarDetection[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const sourceFile = program.getSourceFile(join(projectDir, file));
    if (!sourceFile) continue;

    walkForImportMetaEnv(sourceFile, (envVarName) => {
      const key = `${file}:${envVarName}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ name: envVarName, file });
      }
    });
  }

  return results;
}

function walkForImportMetaEnv(
  sourceFile: ts.SourceFile,
  onFound: (envVarName: string) => void
): void {
  function visit(node: ts.Node) {
    // Pattern: import.meta.env.VARIABLE_NAME
    // AST: PropertyAccess(.VARIABLE_NAME, PropertyAccess(.env, MetaProperty(import.meta)))
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "env" &&
      ts.isMetaProperty(node.expression.expression) &&
      node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      node.expression.expression.name.text === "meta"
    ) {
      onFound(node.name.text);
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

// ---------------------------------------------------------------------------
// Cron job detection — module-scope setInterval(() => fetch('/...'), ms)
// ---------------------------------------------------------------------------

interface CronJobDetection {
  name: string;
  endpoint: string;
  method: string;
  intervalMs: number;
  file: string;
}

/**
 * Walk top-level statements looking for `setInterval(() => fetch('/job/...'), ms)`.
 * Only module-scope calls are eligible for durable scheduling.
 * The callback must be a single fetch() call to a /job/* route — Dapr triggers
 * jobs by POSTing to /job/<name>, so the developer's handler and the Dapr
 * callback share the same path. No shim or proxy needed.
 */
function detectCronJobs(
  program: ts.Program,
  projectDir: string,
  files: string[]
): CronJobDetection[] {
  const results: CronJobDetection[] = [];

  for (const file of files) {
    const sourceFile = program.getSourceFile(join(projectDir, file));
    if (!sourceFile) continue;

    for (const statement of sourceFile.statements) {
      if (!ts.isExpressionStatement(statement)) continue;

      const expr = statement.expression;
      if (!ts.isCallExpression(expr)) continue;
      if (!ts.isIdentifier(expr.expression)) continue;
      if (expr.expression.text !== "setInterval") continue;
      if (expr.arguments.length < 2) continue;

      const callback = expr.arguments[0];
      const intervalArg = expr.arguments[1];

      // Interval must be a statically resolvable numeric value
      const intervalMs = resolveConstantNumeric(intervalArg);
      if (intervalMs === null) {
        console.warn(
          `⚠ Warning: setInterval at ${file}:${sourceFile.getLineAndCharacterOfPosition(expr.getStart()).line + 1} ` +
          `has a dynamic interval and cannot be made durable. Use a numeric literal.`
        );
        continue;
      }

      // Callback must be an arrow function or function expression
      if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) continue;

      const fetchCall = extractSingleFetchCall(callback.body);
      if (!fetchCall) {
        // Check if the callback has any content (not empty) to decide whether to warn
        if (hasStatements(callback.body)) {
          console.warn(
            `⚠ Warning: setInterval at ${file}:${sourceFile.getLineAndCharacterOfPosition(expr.getStart()).line + 1} ` +
            `contains inline logic and will not survive restarts. ` +
            `If this should be durable, move logic to an endpoint and use fetch().`
          );
        }
        continue;
      }

      const { endpoint, method } = fetchCall;

      // Must be a local path — reject external URLs
      if (!endpoint.startsWith("/")) continue;
      if (endpoint.startsWith("//")) continue;

      // Derive job name from the path (strip leading /, replace / with -)
      const name = endpoint.slice(1).replace(/\//g, "-");

      results.push({ name, endpoint, method, intervalMs, file });
    }
  }

  return results;
}

/**
 * Check if a node has statements (is not an empty body).
 */
function hasStatements(body: ts.ConciseBody): boolean {
  if (ts.isBlock(body)) {
    return body.statements.length > 0;
  }
  // Expression body always has content
  return true;
}

/**
 * Extract a single fetch() call from a callback body.
 * Returns null if the body contains anything other than a single fetch call.
 *
 * Handles:
 *   - Arrow expression body: () => fetch('/path')
 *   - Block body with single statement: () => { fetch('/path') }
 *   - Block body with single statement + semicolon: () => { fetch('/path'); }
 */
function extractSingleFetchCall(
  body: ts.ConciseBody
): { endpoint: string; method: string } | null {
  let callExpr: ts.CallExpression | null = null;

  if (ts.isBlock(body)) {
    // Block body — must have exactly one expression statement
    if (body.statements.length !== 1) return null;
    const stmt = body.statements[0];
    if (!ts.isExpressionStatement(stmt)) return null;
    if (!ts.isCallExpression(stmt.expression)) return null;
    callExpr = stmt.expression;
  } else {
    // Expression body — must be a call expression
    if (!ts.isCallExpression(body)) return null;
    callExpr = body;
  }

  // Must be a call to `fetch`
  if (!ts.isIdentifier(callExpr.expression)) return null;
  if (callExpr.expression.text !== "fetch") return null;
  if (callExpr.arguments.length < 1) return null;

  // First arg must be a string literal
  const urlArg = callExpr.arguments[0];
  if (!ts.isStringLiteral(urlArg)) return null;
  const endpoint = urlArg.text;

  // Extract method from second arg (options object) if present
  let method = "GET";
  if (callExpr.arguments.length >= 2) {
    const options = callExpr.arguments[1];
    if (ts.isObjectLiteralExpression(options)) {
      for (const prop of options.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          prop.name.text === "method" &&
          ts.isStringLiteral(prop.initializer)
        ) {
          method = prop.initializer.text;
        }
      }
    }
  }

  return { endpoint, method };
}

/**
 * Resolve a constant numeric expression at compile time.
 * Handles:
 *   - Numeric literals: 86400000
 *   - Multiplication chains: 24 * 60 * 60 * 1000
 *   - Parenthesized expressions: (24 * 60) * 60 * 1000
 */
function resolveConstantNumeric(expr: ts.Expression): number | null {
  if (ts.isNumericLiteral(expr)) {
    return parseFloat(expr.text);
  }

  if (ts.isParenthesizedExpression(expr)) {
    return resolveConstantNumeric(expr.expression);
  }

  if (ts.isBinaryExpression(expr)) {
    const left = resolveConstantNumeric(expr.left);
    const right = resolveConstantNumeric(expr.right);
    if (left === null || right === null) return null;

    switch (expr.operatorToken.kind) {
      case ts.SyntaxKind.AsteriskToken: return left * right;
      case ts.SyntaxKind.PlusToken: return left + right;
      case ts.SyntaxKind.MinusToken: return left - right;
      default: return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// EventEmitter detection — module-scope new EventEmitter() from node:events
// ---------------------------------------------------------------------------

interface EventEmitterDetection {
  name: string;
  file: string;
  events: string[];
}

/**
 * Walk top-level statements looking for `new EventEmitter()` declarations
 * where EventEmitter is imported from `node:events` or `events`.
 * Only module-scope (top-level) EventEmitters are considered distributed.
 * Function-scoped EventEmitters are ephemeral and ignored.
 *
 * For each detected emitter, we also walk the full AST for `.on()` and
 * `.once()` calls with string literal event names to build the subscription list.
 */
function detectEventEmitters(
  program: ts.Program,
  projectDir: string,
  files: string[]
): EventEmitterDetection[] {
  const results: EventEmitterDetection[] = [];

  for (const file of files) {
    const sourceFile = program.getSourceFile(join(projectDir, file));
    if (!sourceFile) continue;

    // Check if file imports EventEmitter from node:events or events
    if (!importsEventEmitter(sourceFile)) continue;

    // Phase 1: find top-level new EventEmitter() declarations
    const emitterVars: string[] = [];
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;

      for (const decl of statement.declarationList.declarations) {
        if (
          decl.initializer &&
          ts.isNewExpression(decl.initializer) &&
          ts.isIdentifier(decl.initializer.expression) &&
          decl.initializer.expression.text === "EventEmitter" &&
          ts.isIdentifier(decl.name)
        ) {
          emitterVars.push(decl.name.text);
        }
      }
    }

    // Phase 2: for each emitter var, extract event names from .on()/.once() calls
    for (const varName of emitterVars) {
      const events = extractEventNames(sourceFile, varName);
      results.push({ name: varName, file, events });
    }
  }

  return results;
}

/**
 * Check if a source file imports EventEmitter from `node:events` or `events`.
 */
function importsEventEmitter(sourceFile: ts.SourceFile): boolean {
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const mod = statement.moduleSpecifier.text;
      if (mod === "node:events" || mod === "events") {
        const clause = statement.importClause;
        if (!clause) continue;

        // Named import: import { EventEmitter } from 'node:events'
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const spec of clause.namedBindings.elements) {
            if (spec.name.text === "EventEmitter") return true;
          }
        }

        // Default import: import EventEmitter from 'node:events'
        if (clause.name?.text === "EventEmitter") return true;
      }
    }
  }
  return false;
}

/**
 * Walk the full AST for `.on(stringLiteral, ...)` and `.once(stringLiteral, ...)`
 * calls on the given variable name. Returns deduplicated event names.
 */
function extractEventNames(sourceFile: ts.SourceFile, varName: string): string[] {
  const events = new Set<string>();

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === varName &&
      (node.expression.name.text === "on" || node.expression.name.text === "once") &&
      node.arguments.length >= 2 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      events.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...events];
}

// ---------------------------------------------------------------------------
// Capability import detection — database driver imports (Signal 4)
// ---------------------------------------------------------------------------

interface DriverMapping {
  capability: CapabilityImportResource["capability"];
  engine: NonNullable<CapabilityImportResource["engine"]>;
  provisioning: "replace" | "preserve";
}

/**
 * Known database driver packages → infrastructure requirements.
 * The import existing at all is the signal — we don't infer, we read.
 */
const DRIVER_MAP: Record<string, DriverMapping> = {
  "better-sqlite3":            { capability: "relational-embedded",   engine: "sqlite",      provisioning: "preserve" },
  "node:sqlite":               { capability: "relational-embedded",   engine: "sqlite",      provisioning: "preserve" },
  "sqlite":                    { capability: "relational-embedded",   engine: "sqlite",      provisioning: "preserve" },
  "pg":                        { capability: "relational",            engine: "postgres",    provisioning: "replace" },
  "postgres":                  { capability: "relational",            engine: "postgres",    provisioning: "replace" },
  "@neondatabase/serverless":  { capability: "relational",            engine: "postgres",    provisioning: "replace" },
  "mysql2":                    { capability: "relational",            engine: "mysql",       provisioning: "replace" },
  "mysql":                     { capability: "relational",            engine: "mysql",       provisioning: "replace" },
  "mongodb":                   { capability: "document",              engine: "mongodb",     provisioning: "replace" },
  "mongoose":                  { capability: "document",              engine: "mongodb",     provisioning: "replace" },
  "@planetscale/database":     { capability: "relational-compatible", engine: "planetscale", provisioning: "replace" },
  "@libsql/client":            { capability: "relational-compatible", engine: "libsql",      provisioning: "replace" },
  "@turso/client":             { capability: "relational-compatible", engine: "libsql",      provisioning: "replace" },
  "redis":                     { capability: "kv",                    engine: "valkey",      provisioning: "replace" },
  "ioredis":                   { capability: "kv",                    engine: "valkey",      provisioning: "replace" },
};

/** ORM packages that require deferred resolution to determine the actual engine. */
const DEFERRED_DRIVERS: Record<string, "prisma.schema" | "co-import"> = {
  "@prisma/client": "prisma.schema",
  "drizzle-orm":    "co-import",
};

/** All module names we scan for (direct + deferred). */
const ALL_DRIVER_MODULES = new Set([
  ...Object.keys(DRIVER_MAP),
  ...Object.keys(DEFERRED_DRIVERS),
]);

interface CapabilityImportDetection {
  module: string;
  capability: CapabilityImportResource["capability"];
  engine: CapabilityImportResource["engine"];
  provisioning: "replace" | "preserve";
  file: string;
  deferred?: {
    source: "prisma.schema" | "co-import";
    resolved: boolean;
  };
}

/**
 * Scan all source files for import declarations matching known database driver
 * packages. The import itself is the infrastructure declaration.
 *
 * For ORMs:
 *   - @prisma/client → read prisma/schema.prisma datasource provider
 *   - drizzle-orm → detect co-imported direct driver in the same project
 */
function detectCapabilityImports(
  program: ts.Program,
  projectDir: string,
  files: string[]
): CapabilityImportDetection[] {
  // Phase 1: collect all matching imports across all source files
  const rawImports = findImportedModules(program, projectDir, files, ALL_DRIVER_MODULES);

  // Phase 2: dedup by module (first source file wins)
  const seen = new Set<string>();
  const dedupedImports: Array<{ module: string; file: string }> = [];
  for (const imp of rawImports) {
    if (!seen.has(imp.module)) {
      seen.add(imp.module);
      dedupedImports.push(imp);
    }
  }

  // Phase 3: resolve direct drivers
  const results: CapabilityImportDetection[] = [];
  const directDrivers: CapabilityImportDetection[] = [];

  for (const imp of dedupedImports) {
    const mapping = DRIVER_MAP[imp.module];
    if (mapping) {
      const detection: CapabilityImportDetection = {
        module: imp.module,
        capability: mapping.capability,
        engine: mapping.engine,
        provisioning: mapping.provisioning,
        file: imp.file,
      };
      results.push(detection);
      directDrivers.push(detection);
      continue;
    }

    const deferredSource = DEFERRED_DRIVERS[imp.module];
    if (deferredSource === "prisma.schema") {
      results.push(resolvePrisma(imp, projectDir));
    } else if (deferredSource === "co-import") {
      // Drizzle resolved after all imports are collected
    }
  }

  // Phase 4: resolve Drizzle co-import (needs the full directDrivers list)
  for (const imp of dedupedImports) {
    if (DEFERRED_DRIVERS[imp.module] === "co-import") {
      results.push(resolveDrizzle(imp, directDrivers));
    }
  }

  return results;
}

/**
 * Scan source files for import declarations matching any module in the given set.
 * We only care about the module specifier — not what's imported from it.
 */
function findImportedModules(
  program: ts.Program,
  projectDir: string,
  files: string[],
  moduleNames: Set<string>
): Array<{ module: string; file: string }> {
  const results: Array<{ module: string; file: string }> = [];

  for (const file of files) {
    const sourceFile = program.getSourceFile(join(projectDir, file));
    if (!sourceFile) continue;

    for (const statement of sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const mod = statement.moduleSpecifier.text;
        if (moduleNames.has(mod)) {
          results.push({ module: mod, file });
        }
      }
    }
  }

  return results;
}

/** Prisma provider name → engine mapping */
const PRISMA_PROVIDER_MAP: Record<string, DriverMapping> = {
  "postgresql": { capability: "relational",          engine: "postgres", provisioning: "replace" },
  "postgres":   { capability: "relational",          engine: "postgres", provisioning: "replace" },
  "mysql":      { capability: "relational",          engine: "mysql",    provisioning: "replace" },
  "sqlite":     { capability: "relational-embedded", engine: "sqlite",   provisioning: "preserve" },
  "mongodb":    { capability: "document",            engine: "mongodb",  provisioning: "replace" },
};

/**
 * Resolve @prisma/client by reading prisma/schema.prisma and extracting
 * the datasource provider field.
 */
function resolvePrisma(
  imp: { module: string; file: string },
  projectDir: string
): CapabilityImportDetection {
  try {
    const schemaPath = join(projectDir, "prisma", "schema.prisma");
    const schema = readFileSync(schemaPath, "utf-8");
    const match = schema.match(/datasource\s+\w+\s*\{[^}]*provider\s*=\s*"(\w+)"/s);
    if (match) {
      const provider = match[1];
      const mapping = PRISMA_PROVIDER_MAP[provider];
      if (mapping) {
        return {
          module: imp.module,
          capability: mapping.capability,
          engine: mapping.engine,
          provisioning: mapping.provisioning,
          file: imp.file,
          deferred: { source: "prisma.schema", resolved: true },
        };
      }
    }
  } catch {
    // Schema file not found or unreadable — emit unresolved
  }

  return {
    module: imp.module,
    capability: "relational",
    engine: null,
    provisioning: "replace",
    file: imp.file,
    deferred: { source: "prisma.schema", resolved: false },
  };
}

/**
 * Resolve drizzle-orm by checking if a direct database driver was co-imported
 * in the same project. Drizzle always imports alongside a driver.
 */
function resolveDrizzle(
  imp: { module: string; file: string },
  directDrivers: CapabilityImportDetection[]
): CapabilityImportDetection {
  // Use the first direct driver found as the resolution
  if (directDrivers.length > 0) {
    const driver = directDrivers[0];
    return {
      module: imp.module,
      capability: driver.capability,
      engine: driver.engine,
      provisioning: driver.provisioning,
      file: imp.file,
      deferred: { source: "co-import", resolved: true },
    };
  }

  return {
    module: imp.module,
    capability: "relational",
    engine: null,
    provisioning: "replace",
    file: imp.file,
    deferred: { source: "co-import", resolved: false },
  };
}
