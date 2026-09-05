import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface WaldoFact {
  id: string;
  kind: "state-rmw-across-yield";
  source: {
    path: string;
    line: number;
    column: number;
  };
  symbol: string;
  attributes: {
    "atomicity.required": true;
    "state.scope": "cell";
    "yield.kind": "external";
  };
}

interface Operation {
  position: number;
  kind: "get" | "set" | "external-await";
  map?: string;
  node: ts.Node;
}

function moduleMapNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        ts.isNewExpression(declaration.initializer) &&
        ts.isIdentifier(declaration.initializer.expression) &&
        declaration.initializer.expression.text === "Map"
      ) {
        names.add(declaration.name.text);
      }
    }
  }
  return names;
}

function functionBody(node: ts.Node): ts.ConciseBody | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  ) {
    return node.body;
  }
  return undefined;
}

function collectOperations(
  body: ts.ConciseBody,
  sourceFile: ts.SourceFile,
  maps: Set<string>,
): Operation[] {
  const operations: Operation[] = [];

  function visit(node: ts.Node): void {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      maps.has(node.expression.expression.text) &&
      ["get", "set"].includes(node.expression.name.text)
    ) {
      operations.push({
        position: node.getStart(sourceFile),
        kind: node.expression.name.text as "get" | "set",
        map: node.expression.expression.text,
        node,
      });
    }
    if (ts.isAwaitExpression(node)) {
      const call = ts.isCallExpression(node.expression) ? node.expression : undefined;
      const isMapOperation =
        call &&
        ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        maps.has(call.expression.expression.text);
      if (!isMapOperation) {
        operations.push({
          position: node.getStart(sourceFile),
          kind: "external-await",
          node,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(body);
  return operations.sort((left, right) => left.position - right.position);
}

export function analyzeSource(
  entrypoint: string,
  projectRoot = path.dirname(path.resolve(entrypoint)),
): WaldoFact[] {
  const absoluteEntrypoint = path.resolve(entrypoint);
  const absoluteRoot = path.resolve(projectRoot);
  const sourceText = fs.readFileSync(absoluteEntrypoint, "utf8");
  const sourceFile = ts.createSourceFile(
    absoluteEntrypoint,
    sourceText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const maps = moduleMapNames(sourceFile);
  const facts: WaldoFact[] = [];

  function inspect(node: ts.Node): void {
    const body = functionBody(node);
    if (body) {
      const operations = collectOperations(body, sourceFile, maps);
      for (const map of maps) {
        for (let index = 0; index < operations.length; index += 1) {
          const read = operations[index];
          if (read.kind !== "get" || read.map !== map) continue;
          const externalAwait = operations
            .slice(index + 1)
            .find((operation) => operation.kind === "external-await");
          if (!externalAwait) continue;
          const write = operations.find(
            (operation) =>
              operation.position > externalAwait.position &&
              operation.kind === "set" &&
              operation.map === map,
          );
          if (!write) continue;

          const location = sourceFile.getLineAndCharacterOfPosition(
            read.node.getStart(sourceFile),
          );
          const relativePath = path
            .relative(absoluteRoot, absoluteEntrypoint)
            .split(path.sep)
            .join("/");
          facts.push({
            id: `state-rmw-across-yield:${relativePath}:${map}`,
            kind: "state-rmw-across-yield",
            source: {
              path: relativePath,
              line: location.line + 1,
              column: location.character + 1,
            },
            symbol: map,
            attributes: {
              "atomicity.required": true,
              "state.scope": "cell",
              "yield.kind": "external",
            },
          });
          break;
        }
      }
    }
    ts.forEachChild(node, inspect);
  }
  inspect(sourceFile);

  const unique = new Map(facts.map((fact) => [fact.id, fact]));
  return [...unique.values()];
}

export function serializeFacts(facts: WaldoFact[]): string {
  if (facts.length === 0) return "";
  return `${facts.map((fact) => JSON.stringify(fact)).join("\n")}\n`;
}
