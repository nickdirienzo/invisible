import { readdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import ts from "typescript";
import type { App, Resource } from "../ir/index.js";

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export function plan(projectDir: string): App {
  const pkg = readPackageJson(projectDir);
  const appName = pkg.name ?? basename(projectDir);
  const sourceFiles = findSourceFiles(projectDir);

  // Create one ts.Program shared across all detectors
  const { program, checker } = createProgram(projectDir, sourceFiles);

  const listenResult = detectListenCall(program, checker, projectDir, sourceFiles);
  const frameworkResult = !listenResult ? detectFrameworkStart(pkg) : null;
  const hasIngress = listenResult !== null || frameworkResult !== null;
  const entrypoint = listenResult?.file ?? detectEntrypoint(sourceFiles);
  const typescript = entrypoint.endsWith(".ts") || entrypoint.endsWith(".tsx") || entrypoint.endsWith(".mts");

  const durableMaps = detectDurableMaps(program, projectDir, sourceFiles);
  const secrets = detectSecrets(program, projectDir, sourceFiles);
  const cronJobs = detectCronJobs(program, projectDir, sourceFiles);
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
    ...cronJobs.map((c) => ({
      kind: "cron-job" as const,
      name: c.name,
      endpoint: c.endpoint,
      method: c.method,
      intervalMs: c.intervalMs,
      sourceFile: c.file,
    })),
  ];

  return {
    name: appName,
    services: [
      {
        name: "web",
        build: "./",
        port: listenResult?.port ?? frameworkResult?.port ?? 3000,
        entrypoint,
        typescript,
        ...(hasIngress ? { ingress: [{ host: "", path: "/" }] } : {}),
        ...(frameworkResult?.startCmd ? { startCmd: frameworkResult.startCmd } : {}),
        ...(frameworkResult?.buildCmd ? { buildCmd: frameworkResult.buildCmd } : {}),
      },
    ],
    ...(resources.length > 0 ? { resources } : {}),
  };
}

function readPackageJson(dir: string): PackageJson {
  const raw = readFileSync(join(dir, "package.json"), "utf-8");
  return JSON.parse(raw) as PackageJson;
}

function findSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.isDirectory() && /\.(ts|js|mjs|mts)$/.test(e.name))
    .map((e) => e.name);
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

/**
 * Detects framework-based apps from scripts.start + scripts.build in
 * package.json. Both are required — this is an opinionated contract.
 *
 * Only checked when no explicit .listen() call is found in source code.
 * Covers Remix, Next, Nuxt, SvelteKit, Astro, etc. without needing
 * framework-specific knowledge.
 */
function detectFrameworkStart(pkg: PackageJson): FrameworkResult | null {
  const startScript = pkg.scripts?.start;
  const buildScript = pkg.scripts?.build;
  if (!startScript || !buildScript) return null;

  // Extract port from --port flag if present, otherwise default to 3000
  const portMatch = startScript.match(/--port\s+(\d+)/);
  const port = portMatch ? parseInt(portMatch[1], 10) : 3000;

  return {
    port,
    startCmd: startScript,
    buildCmd: buildScript,
  };
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

      // Must be a /job/* route — Dapr calls POST /job/<name> directly
      if (!endpoint.startsWith("/job/")) continue;

      // Derive job name from the path after /job/
      const name = endpoint.slice("/job/".length).replace(/\//g, "-");

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
