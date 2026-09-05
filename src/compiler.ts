import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import {
  renderRuntimePrefix,
  renderRuntimeSuffix,
  renderWranglerConfig,
} from "./runtime-template.js";

export interface CompileOptions {
  entrypoint: string;
  outputDirectory: string;
  projectRoot?: string;
  name?: string;
}

export interface DurableMapDescription {
  variable: string;
  id: string;
  keyType: "string";
  valueType: "number" | "string" | "boolean";
}

export interface CompileResult {
  entrypoint: string;
  outputDirectory: string;
  workerPath: string;
  wranglerPath: string;
  cell: "AppCell:global";
  maps: DurableMapDescription[];
}

export class CompileError extends Error {
  override name = "CompileError";
}

interface SourceContract {
  maps: DurableMapDescription[];
}

function isNodeHttpImport(statement: ts.Statement): boolean {
  return (
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    ["node:http", "http"].includes(statement.moduleSpecifier.text)
  );
}

function isTopLevelVariable(declaration: ts.VariableDeclaration): boolean {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    ts.isVariableStatement(declaration.parent.parent) &&
    ts.isSourceFile(declaration.parent.parent.parent)
  );
}

function mapValueType(node: ts.TypeNode | undefined): DurableMapDescription["valueType"] | undefined {
  if (!node) return undefined;
  if (node.kind === ts.SyntaxKind.NumberKeyword) return "number";
  if (node.kind === ts.SyntaxKind.StringKeyword) return "string";
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return "boolean";
  return undefined;
}

function isProcessEnvAccess(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "process" &&
    node.expression.name.text === "env"
  );
}

function isSupportedListenCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "listen" &&
    ts.isCallExpression(node.expression.expression) &&
    ts.isIdentifier(node.expression.expression.expression) &&
    node.expression.expression.expression.text === "createServer"
  );
}

function insideListenArguments(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "listen"
    ) {
      return current.arguments.some(
        (argument) =>
          node.getStart() >= argument.getStart() && node.getEnd() <= argument.getEnd(),
      );
    }
    current = current.parent;
  }
  return false;
}

function inspectSource(
  sourceFile: ts.SourceFile,
  projectRoot: string,
): SourceContract {
  let importsCreateServer = false;
  const maps: DurableMapDescription[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!isNodeHttpImport(statement)) {
        throw new CompileError(
          `Unsupported import ${statement.moduleSpecifier.getText(sourceFile)}; ` +
            "the v2 spike accepts only node:http",
        );
      }
      const bindings = statement.importClause?.namedBindings;
      const elements = bindings && ts.isNamedImports(bindings) ? bindings.elements : [];
      if (
        elements.length !== 1 ||
        (elements[0].propertyName?.text ?? elements[0].name.text) !== "createServer" ||
        elements[0].name.text !== "createServer"
      ) {
        throw new CompileError(
          "The v2 spike requires exactly import { createServer } from node:http",
        );
      }
      importsCreateServer = true;
    }

    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !declaration.initializer ||
        !ts.isNewExpression(declaration.initializer) ||
        !ts.isIdentifier(declaration.initializer.expression) ||
        declaration.initializer.expression.text !== "Map"
      ) {
        continue;
      }
      if (!ts.isIdentifier(declaration.name) || !isTopLevelVariable(declaration)) {
        throw new CompileError("Durable Maps require a module-scope identifier");
      }
      const [keyNode, valueNode] = declaration.initializer.typeArguments ?? [];
      const keyType = keyNode?.kind === ts.SyntaxKind.StringKeyword ? "string" : undefined;
      const valueType = mapValueType(valueNode);
      if (!keyType || !valueType) {
        throw new CompileError(
          `Unsupported Map ${declaration.name.text}; expected ` +
            "Map<string, number | string | boolean>",
        );
      }
      if ((declaration.initializer.arguments?.length ?? 0) !== 0) {
        throw new CompileError(
          `Unsupported Map ${declaration.name.text}; initial entries are not implemented`,
        );
      }
      const relativeSource = path
        .relative(projectRoot, sourceFile.fileName)
        .split(path.sep)
        .join("/");
      maps.push({
        variable: declaration.name.text,
        id: `${relativeSource}:${declaration.name.text}`,
        keyType,
        valueType,
      });
    }
  }

  if (!importsCreateServer) {
    throw new CompileError(
      "The v2 spike requires import { createServer } from node:http",
    );
  }
  if (maps.length === 0) {
    throw new CompileError("The v2 spike requires at least one module-scope Map");
  }

  const listenCalls: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (isSupportedListenCall(node)) {
      listenCalls.push(node);
    }
    if (isProcessEnvAccess(node) && !insideListenArguments(node)) {
      throw new CompileError(
        `Unsupported ${node.getText(sourceFile)}; only a listen port may read process.env`,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  if (listenCalls.length !== 1) {
    throw new CompileError(
      "The v2 spike requires exactly one createServer(...).listen(...) expression",
    );
  }

  return { maps };
}

function createTransformer(
  contract: SourceContract,
): ts.TransformerFactory<ts.SourceFile> {
  const maps = new Map(contract.maps.map((map) => [map.variable, map.id]));

  return (context) => (sourceFile) => {
    const visitor: ts.Visitor = (node) => {
      if (isSupportedListenCall(node)) {
        return context.factory.updateCallExpression(
          node,
          ts.visitNode(node.expression, visitor) as ts.Expression,
          node.typeArguments,
          [],
        );
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Map" &&
        ts.isVariableDeclaration(node.parent) &&
        ts.isIdentifier(node.parent.name) &&
        isTopLevelVariable(node.parent) &&
        maps.has(node.parent.name.text)
      ) {
        return context.factory.createNewExpression(
          context.factory.createIdentifier("__InvisibleDurableMap"),
          undefined,
          [context.factory.createStringLiteral(maps.get(node.parent.name.text)!)],
        );
      }
      return ts.visitEachChild(node, visitor, context);
    };

    const statements: ts.Statement[] = [];
    for (const statement of sourceFile.statements) {
      if (isNodeHttpImport(statement)) continue;
      const transformed = ts.visitNode(statement, visitor);
      if (transformed && ts.isStatement(transformed)) statements.push(transformed);
    }
    return context.factory.updateSourceFile(sourceFile, statements);
  };
}

function deploymentName(entrypoint: string, requestedName?: string): string {
  const raw = requestedName ?? path.basename(entrypoint, path.extname(entrypoint));
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "invisible-app";
}

export function compile(options: CompileOptions): CompileResult {
  const entrypoint = path.resolve(options.entrypoint);
  const outputDirectory = path.resolve(options.outputDirectory);
  const projectRoot = path.resolve(options.projectRoot ?? path.dirname(entrypoint));
  const sourceText = fs.readFileSync(entrypoint, "utf8");
  const sourceFile = ts.createSourceFile(
    entrypoint,
    sourceText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const contract = inspectSource(sourceFile, projectRoot);
  const transpiled = ts.transpileModule(sourceText, {
    fileName: entrypoint,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      strict: true,
    },
    transformers: { before: [createTransformer(contract)] },
  });

  const workerPath = path.join(outputDirectory, "index.js");
  const wranglerPath = path.join(outputDirectory, "wrangler.jsonc");
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(
    workerPath,
    `${renderRuntimePrefix()}\n${transpiled.outputText}\n${renderRuntimeSuffix()}`,
  );
  fs.writeFileSync(
    wranglerPath,
    renderWranglerConfig(deploymentName(entrypoint, options.name)),
  );

  return {
    entrypoint,
    outputDirectory,
    workerPath,
    wranglerPath,
    cell: "AppCell:global",
    maps: contract.maps,
  };
}
