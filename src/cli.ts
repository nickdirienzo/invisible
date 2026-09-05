#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { analyzeSource, serializeFacts } from "./analyzer.js";
import { CompileError, compile } from "./compiler.js";

function usage(): never {
  console.error(`Invisible v2

Usage:
  ii compile <entrypoint> [--out DIRECTORY] [--name NAME]
  ii facts <entrypoint> [--out FILE]

The current compiler accepts the Node-to-celld contract documented in
docs/semantic-contract.md.`);
  process.exit(2);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) usage();
  return value;
}

function positional(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith("--")) {
      index += 1;
      continue;
    }
    values.push(args[index]);
  }
  return values;
}

function writeFacts(entrypoint: string, outputPath: string): void {
  const absoluteEntrypoint = path.resolve(entrypoint);
  const root = process.cwd();
  const facts = analyzeSource(absoluteEntrypoint, root);
  const absoluteOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
  fs.writeFileSync(absoluteOutput, serializeFacts(facts));
  console.log(
    JSON.stringify({
      entrypoint: absoluteEntrypoint,
      output: absoluteOutput,
      facts: facts.length,
    }),
  );
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  const [entrypoint] = positional(args);
  if (!command || !entrypoint) usage();

  if (command === "compile") {
    const result = compile({
      entrypoint,
      outputDirectory: option(args, "--out") ?? ".invisible",
      projectRoot: process.cwd(),
      name: option(args, "--name"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "facts") {
    writeFacts(entrypoint, option(args, "--out") ?? ".invisible/waldo-facts.jsonl");
    return;
  }

  usage();
}

try {
  main();
} catch (error) {
  if (error instanceof CompileError) {
    console.error(`Invisible cannot preserve this program: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
