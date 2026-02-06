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
  const hasIngress = listenResult !== null;
  const entrypoint = listenResult?.file ?? detectEntrypoint(sourceFiles);
  const typescript = entrypoint.endsWith(".ts") || entrypoint.endsWith(".mts");

  const durableMaps = detectDurableMaps(program, projectDir, sourceFiles);
  const resources: Resource[] = durableMaps.map((m) => ({
    kind: "durable-map" as const,
    name: m.name,
    sourceFile: m.file,
  }));

  return {
    name: appName,
    services: [
      {
        name: "web",
        build: "./",
        port: listenResult?.port ?? 3000,
        entrypoint,
        typescript,
        ...(hasIngress ? { ingress: [{ host: "", path: "/" }] } : {}),
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
