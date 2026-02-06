import { readdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import ts from "typescript";
import type { App } from "../ir/index.js";

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export function plan(projectDir: string): App {
  const pkg = readPackageJson(projectDir);
  const appName = pkg.name ?? basename(projectDir);
  const sourceFiles = findSourceFiles(projectDir);

  const listenResult = detectListenCall(projectDir, sourceFiles);
  const hasIngress = listenResult !== null;
  const entrypoint = listenResult?.file ?? detectEntrypoint(sourceFiles);
  const typescript = entrypoint.endsWith(".ts") || entrypoint.endsWith(".mts");

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

function detectEntrypoint(files: string[]): string {
  if (files.includes("index.ts")) return "index.ts";
  if (files.includes("index.js")) return "index.js";
  return files[0] ?? "index.js";
}

interface ListenResult {
  file: string;
  port: number;
}

/**
 * Uses the TypeScript type checker to find .listen() calls on objects
 * whose type traces back to node:http, node:net, or known HTTP frameworks.
 *
 * This avoids false positives from unrelated .listen() methods — only
 * matches when the type system confirms it's a server.
 */
function detectListenCall(
  projectDir: string,
  files: string[]
): ListenResult | null {
  const filePaths = files.map((f) => join(projectDir, f));

  const program = ts.createProgram(filePaths, {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    // Resolve types from node_modules
    baseUrl: projectDir,
  });

  const checker = program.getTypeChecker();

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
