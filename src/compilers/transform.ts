import ts from "typescript";

interface MapEntry {
  varName: string;
  hashKey: string;
}

interface ManifestEntry {
  file: string;
  maps: MapEntry[];
}

/**
 * Creates a TypeScript custom transformer that rewrites module-scope
 * `new Map()` declarations to `new DurableMap("hashKey")`.
 *
 * This runs during tsc emit — the source files on disk are never modified.
 * The transformer also injects an import for the DurableMap class at the
 * top of any file it modifies.
 */
export function createDurableMapTransformer(
  manifest: ManifestEntry[],
  durableMapImportPath: string
): ts.TransformerFactory<ts.SourceFile> {
  return (context) => {
    return (sourceFile) => {
      // Match this source file against the manifest
      const entry = manifest.find((e) => {
        const jsName = e.file.replace(/\.ts$/, ".js").replace(/\.mts$/, ".mjs");
        return (
          sourceFile.fileName.endsWith(e.file) ||
          sourceFile.fileName.endsWith(jsName)
        );
      });

      if (!entry || entry.maps.length === 0) return sourceFile;

      const varNames = new Map(entry.maps.map((m) => [m.varName, m.hashKey]));
      let needsImport = false;

      const visitor: ts.Visitor = (node) => {
        // Only transform top-level variable statements
        if (
          ts.isVariableStatement(node) &&
          node.parent === sourceFile
        ) {
          const newDeclarations = node.declarationList.declarations.map(
            (decl) => {
              if (
                decl.initializer &&
                ts.isNewExpression(decl.initializer) &&
                ts.isIdentifier(decl.initializer.expression) &&
                decl.initializer.expression.text === "Map" &&
                ts.isIdentifier(decl.name) &&
                varNames.has(decl.name.text)
              ) {
                needsImport = true;
                const hashKey = varNames.get(decl.name.text)!;

                // new DurableMap("hashKey")
                const newExpr = context.factory.createNewExpression(
                  context.factory.createIdentifier("DurableMap"),
                  undefined,
                  [context.factory.createStringLiteral(hashKey)]
                );

                return context.factory.updateVariableDeclaration(
                  decl,
                  decl.name,
                  decl.exclamationToken,
                  undefined, // drop type annotation — JS output won't have it anyway
                  newExpr
                );
              }
              return decl;
            }
          );

          const newDeclList = context.factory.updateVariableDeclarationList(
            node.declarationList,
            newDeclarations
          );
          return context.factory.updateVariableStatement(
            node,
            node.modifiers,
            newDeclList
          );
        }

        return ts.visitEachChild(node, visitor, context);
      };

      const transformed = ts.visitEachChild(sourceFile, visitor, context);

      if (!needsImport) return transformed;

      // import { DurableMap } from "<durableMapImportPath>";
      const importDecl = context.factory.createImportDeclaration(
        undefined,
        context.factory.createImportClause(
          false,
          undefined,
          context.factory.createNamedImports([
            context.factory.createImportSpecifier(
              false,
              undefined,
              context.factory.createIdentifier("DurableMap")
            ),
          ])
        ),
        context.factory.createStringLiteral(durableMapImportPath)
      );

      return context.factory.updateSourceFile(transformed, [
        importDecl,
        ...transformed.statements,
      ]);
    };
  };
}

// ---------------------------------------------------------------------------
// Cron job transformer — removes durable setInterval calls from compiled output
// ---------------------------------------------------------------------------

interface CronJobEntry {
  endpoint: string;
  name: string;
}

interface CronManifestEntry {
  file: string;
  jobs: CronJobEntry[];
}

/**
 * Creates a TypeScript custom transformer that removes module-scope
 * `setInterval(() => fetch('/...'), ms)` calls that have been registered
 * as durable cron jobs with Dapr.
 *
 * The removed calls are replaced with empty statements so line numbers
 * in the output remain stable for debugging.
 */
export function createCronJobTransformer(
  manifest: CronManifestEntry[],
): ts.TransformerFactory<ts.SourceFile> {
  return (context) => {
    return (sourceFile) => {
      const entry = manifest.find((e) => {
        const jsName = e.file.replace(/\.ts$/, ".js").replace(/\.mts$/, ".mjs");
        return (
          sourceFile.fileName.endsWith(e.file) ||
          sourceFile.fileName.endsWith(jsName)
        );
      });

      if (!entry || entry.jobs.length === 0) return sourceFile;

      const endpoints = new Set(entry.jobs.map((j) => j.endpoint));

      // Filter top-level statements directly instead of using a recursive
      // visitor with `node.parent === sourceFile`.  The parent check breaks
      // when a prior transformer (e.g. durable-map) creates a new SourceFile
      // node — existing children still point at the *old* SourceFile.
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
  };
}

function extractFetchEndpoint(body: ts.ConciseBody): string | null {
  let callExpr: ts.CallExpression | null = null;

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

// ---------------------------------------------------------------------------
// EventEmitter transformer — rewrites new EventEmitter() to DistributedEventEmitter
// ---------------------------------------------------------------------------

interface EventEmitterEntry {
  varName: string;
  namespace: string;
}

interface EventManifestEntry {
  file: string;
  emitters: EventEmitterEntry[];
}

/**
 * Creates a TypeScript custom transformer that rewrites module-scope
 * `new EventEmitter()` declarations to `new DistributedEventEmitter("namespace")`.
 *
 * This runs during tsc emit — the source files on disk are never modified.
 * The transformer also injects an import for the DistributedEventEmitter class
 * at the top of any file it modifies.
 */
export function createEventEmitterTransformer(
  manifest: EventManifestEntry[],
  distributedEventsImportPath: string
): ts.TransformerFactory<ts.SourceFile> {
  return (context) => {
    return (sourceFile) => {
      const entry = manifest.find((e) => {
        const jsName = e.file.replace(/\.ts$/, ".js").replace(/\.mts$/, ".mjs");
        return (
          sourceFile.fileName.endsWith(e.file) ||
          sourceFile.fileName.endsWith(jsName)
        );
      });

      if (!entry || entry.emitters.length === 0) return sourceFile;

      const varNames = new Map(entry.emitters.map((e) => [e.varName, e.namespace]));
      let needsImport = false;

      const visitor: ts.Visitor = (node) => {
        // Only transform top-level variable statements
        if (
          ts.isVariableStatement(node) &&
          node.parent === sourceFile
        ) {
          const newDeclarations = node.declarationList.declarations.map(
            (decl) => {
              if (
                decl.initializer &&
                ts.isNewExpression(decl.initializer) &&
                ts.isIdentifier(decl.initializer.expression) &&
                decl.initializer.expression.text === "EventEmitter" &&
                ts.isIdentifier(decl.name) &&
                varNames.has(decl.name.text)
              ) {
                needsImport = true;
                const namespace = varNames.get(decl.name.text)!;

                // new DistributedEventEmitter("namespace")
                const newExpr = context.factory.createNewExpression(
                  context.factory.createIdentifier("DistributedEventEmitter"),
                  undefined,
                  [context.factory.createStringLiteral(namespace)]
                );

                return context.factory.updateVariableDeclaration(
                  decl,
                  decl.name,
                  decl.exclamationToken,
                  undefined, // drop type annotation
                  newExpr
                );
              }
              return decl;
            }
          );

          const newDeclList = context.factory.updateVariableDeclarationList(
            node.declarationList,
            newDeclarations
          );
          return context.factory.updateVariableStatement(
            node,
            node.modifiers,
            newDeclList
          );
        }

        return ts.visitEachChild(node, visitor, context);
      };

      const transformed = ts.visitEachChild(sourceFile, visitor, context);

      if (!needsImport) return transformed;

      // import { DistributedEventEmitter } from "<path>";
      const importDecl = context.factory.createImportDeclaration(
        undefined,
        context.factory.createImportClause(
          false,
          undefined,
          context.factory.createNamedImports([
            context.factory.createImportSpecifier(
              false,
              undefined,
              context.factory.createIdentifier("DistributedEventEmitter")
            ),
          ])
        ),
        context.factory.createStringLiteral(distributedEventsImportPath)
      );

      return context.factory.updateSourceFile(transformed, [
        importDecl,
        ...transformed.statements,
      ]);
    };
  };
}

/**
 * Compiles TypeScript files with the DurableMap transformer applied.
 * This is the build function called from the generated build script
 * that replaces `npx tsc --outDir dist`.
 */
export function compileWithTransform(
  projectDir: string,
  outDir: string,
  manifest: ManifestEntry[],
  durableMapImportPath: string
): { success: boolean; diagnostics: string[] } {
  const configPath = ts.findConfigFile(projectDir, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    return { success: false, diagnostics: ["Could not find tsconfig.json"] };
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    projectDir
  );

  // Override outDir
  parsedConfig.options.outDir = outDir;

  const program = ts.createProgram(
    parsedConfig.fileNames,
    parsedConfig.options
  );

  const transformer = createDurableMapTransformer(manifest, durableMapImportPath);

  const emitResult = program.emit(undefined, undefined, undefined, false, {
    before: [transformer],
  });

  const allDiagnostics = ts
    .getPreEmitDiagnostics(program)
    .concat(emitResult.diagnostics);

  const diagnosticMessages = allDiagnostics.map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, "\n")
  );

  return {
    success: !emitResult.emitSkipped,
    diagnostics: diagnosticMessages,
  };
}
