import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CompileError, compile } from "./compiler.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("compiles the Node counter into one SQLite-backed application cell", () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "invisible-compile-"));
  try {
    const result = compile({
      entrypoint: path.join(repositoryRoot, "examples/counter.ts"),
      outputDirectory,
      projectRoot: repositoryRoot,
    });
    const worker = fs.readFileSync(result.workerPath, "utf8");
    const wrangler = JSON.parse(fs.readFileSync(result.wranglerPath, "utf8"));

    assert.equal(result.cell, "AppCell:global");
    assert.deepEqual(result.maps, [
      {
        variable: "counters",
        id: "examples/counter.ts:counters",
        keyType: "string",
        valueType: "number",
      },
    ]);
    assert.match(worker, /new __InvisibleDurableMap\("examples\/counter\.ts:counters"\)/);
    assert.match(worker, /env\.APP\.getByName\("global"\)/);
    assert.match(worker, /state\.storage\.sql/);
    assert.doesNotMatch(worker, /from "node:http"/);
    assert.doesNotMatch(worker, /process\.env/);
    assert.match(worker, /\.listen\(\)/);
    assert.deepEqual(wrangler.durable_objects.bindings, [
      { name: "APP", class_name: "AppCell" },
    ]);
    assert.deepEqual(wrangler.migrations, [
      { tag: "v1", new_sqlite_classes: ["AppCell"] },
    ]);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("rejects Map representations that cannot preserve native semantics", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "invisible-reject-"));
  const entrypoint = path.join(directory, "index.ts");
  try {
    fs.writeFileSync(
      entrypoint,
      `import { createServer } from "node:http";
const state = new Map<object, number>();
createServer((_request, response) => response.end(String(state.size))).listen(3000);
`,
    );
    assert.throws(
      () =>
        compile({
          entrypoint,
          outputDirectory: path.join(directory, "output"),
          projectRoot: directory,
        }),
      (error: unknown) =>
        error instanceof CompileError &&
        error.message.includes("Map<string, number | string | boolean>"),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects environment access that cannot be supplied at module load", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "invisible-env-"));
  const entrypoint = path.join(directory, "index.ts");
  try {
    fs.writeFileSync(
      entrypoint,
      `import { createServer } from "node:http";
const state = new Map<string, string>();
const secret = process.env.SECRET;
createServer((_request, response) => response.end(secret ?? state.get("x"))).listen(3000);
`,
    );
    assert.throws(
      () =>
        compile({
          entrypoint,
          outputDirectory: path.join(directory, "output"),
          projectRoot: directory,
        }),
      (error: unknown) =>
        error instanceof CompileError && error.message.includes("process.env.SECRET"),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
