import { describe, it, expect } from "vitest";
import ts from "typescript";
import { createDurableMapTransformer, createEventEmitterTransformer } from "../transform.js";

function transformSource(
  source: string,
  fileName: string,
  manifest: Array<{ file: string; maps: Array<{ varName: string; hashKey: string }> }>,
  importPath = "./.ii/runtime/durable-map.mjs"
): string {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const transformer = createDurableMapTransformer(manifest, importPath);
  const result = ts.transform(sourceFile, [transformer]);
  const printer = ts.createPrinter();
  const output = printer.printFile(result.transformed[0]);
  result.dispose();
  return output;
}

describe("createDurableMapTransformer", () => {
  it("replaces module-scope new Map() with new DurableMap()", () => {
    const source = `const counters = new Map<string, number>();`;
    const manifest = [
      {
        file: "index.ts",
        maps: [{ varName: "counters", hashKey: "app:index.ts:counters" }],
      },
    ];

    const output = transformSource(source, "index.ts", manifest);
    expect(output).toContain('new DurableMap("app:index.ts:counters")');
    expect(output).not.toContain("new Map");
  });

  it("adds import for DurableMap", () => {
    const source = `const counters = new Map<string, number>();`;
    const manifest = [
      {
        file: "index.ts",
        maps: [{ varName: "counters", hashKey: "app:index.ts:counters" }],
      },
    ];

    const output = transformSource(source, "index.ts", manifest);
    expect(output).toContain("import { DurableMap }");
    expect(output).toContain("./.ii/runtime/durable-map.mjs");
  });

  it("uses the provided import path", () => {
    const source = `const m = new Map();`;
    const manifest = [
      { file: "index.ts", maps: [{ varName: "m", hashKey: "k" }] },
    ];

    const output = transformSource(source, "index.ts", manifest, "@invisible/runtime");
    expect(output).toContain('from "@invisible/runtime"');
  });

  it("does not transform files not in the manifest", () => {
    const source = `const counters = new Map<string, number>();`;
    const manifest = [
      {
        file: "other.ts",
        maps: [{ varName: "counters", hashKey: "app:other.ts:counters" }],
      },
    ];

    const output = transformSource(source, "index.ts", manifest);
    expect(output).toContain("new Map");
    expect(output).not.toContain("DurableMap");
  });

  it("does not transform variables not in the manifest", () => {
    const source = `const counters = new Map();
const cache = new Map();`;
    const manifest = [
      {
        file: "index.ts",
        maps: [{ varName: "counters", hashKey: "app:index.ts:counters" }],
      },
    ];

    const output = transformSource(source, "index.ts", manifest);
    expect(output).toContain('new DurableMap("app:index.ts:counters")');
    // cache should remain untouched
    expect(output).toMatch(/cache\s*=\s*new Map/);
  });

  it("transforms multiple maps in the same file", () => {
    const source = `const counters = new Map();
const sessions = new Map();`;
    const manifest = [
      {
        file: "index.ts",
        maps: [
          { varName: "counters", hashKey: "app:index.ts:counters" },
          { varName: "sessions", hashKey: "app:index.ts:sessions" },
        ],
      },
    ];

    const output = transformSource(source, "index.ts", manifest);
    expect(output).toContain('new DurableMap("app:index.ts:counters")');
    expect(output).toContain('new DurableMap("app:index.ts:sessions")');
    expect(output).not.toContain("new Map");
  });

  it("only adds import once even with multiple maps", () => {
    const source = `const a = new Map();
const b = new Map();`;
    const manifest = [
      {
        file: "index.ts",
        maps: [
          { varName: "a", hashKey: "k1" },
          { varName: "b", hashKey: "k2" },
        ],
      },
    ];

    const output = transformSource(source, "index.ts", manifest);
    const importCount = (output.match(/import { DurableMap }/g) ?? []).length;
    expect(importCount).toBe(1);
  });

  it("preserves other code in the file", () => {
    const source = `import express from "express";

const counters = new Map<string, number>();

const app = express();
app.listen(3000);`;
    const manifest = [
      {
        file: "index.ts",
        maps: [{ varName: "counters", hashKey: "app:index.ts:counters" }],
      },
    ];

    const output = transformSource(source, "index.ts", manifest);
    expect(output).toContain("import express");
    expect(output).toContain("express()");
    expect(output).toContain("listen(3000)");
    expect(output).toContain('new DurableMap("app:index.ts:counters")');
  });

  it("handles empty manifest gracefully", () => {
    const source = `const counters = new Map();`;
    const output = transformSource(source, "index.ts", []);
    expect(output).toContain("new Map");
    expect(output).not.toContain("DurableMap");
  });
});

// ---------------------------------------------------------------------------
// EventEmitter transformer
// ---------------------------------------------------------------------------

function transformEvents(
  source: string,
  fileName: string,
  manifest: Array<{ file: string; emitters: Array<{ varName: string; namespace: string }> }>,
  importPath = "./.ii/runtime/distributed-events.mjs"
): string {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const transformer = createEventEmitterTransformer(manifest, importPath);
  const result = ts.transform(sourceFile, [transformer]);
  const printer = ts.createPrinter();
  const output = printer.printFile(result.transformed[0]);
  result.dispose();
  return output;
}

describe("createEventEmitterTransformer", () => {
  it("replaces new EventEmitter() with new DistributedEventEmitter()", () => {
    const source = `const bus = new EventEmitter();`;
    const manifest = [
      {
        file: "index.ts",
        emitters: [{ varName: "bus", namespace: "bus" }],
      },
    ];

    const output = transformEvents(source, "index.ts", manifest);
    expect(output).toContain('new DistributedEventEmitter("bus")');
    expect(output).not.toContain("new EventEmitter");
  });

  it("adds import for DistributedEventEmitter", () => {
    const source = `const bus = new EventEmitter();`;
    const manifest = [
      {
        file: "index.ts",
        emitters: [{ varName: "bus", namespace: "bus" }],
      },
    ];

    const output = transformEvents(source, "index.ts", manifest);
    expect(output).toContain("import { DistributedEventEmitter }");
    expect(output).toContain("./.ii/runtime/distributed-events.mjs");
  });

  it("does not transform files not in the manifest", () => {
    const source = `const bus = new EventEmitter();`;
    const manifest = [
      {
        file: "other.ts",
        emitters: [{ varName: "bus", namespace: "bus" }],
      },
    ];

    const output = transformEvents(source, "index.ts", manifest);
    expect(output).toContain("new EventEmitter");
    expect(output).not.toContain("DistributedEventEmitter");
  });

  it("does not transform variables not in the manifest", () => {
    const source = `const bus = new EventEmitter();
const local = new EventEmitter();`;
    const manifest = [
      {
        file: "index.ts",
        emitters: [{ varName: "bus", namespace: "bus" }],
      },
    ];

    const output = transformEvents(source, "index.ts", manifest);
    expect(output).toContain('new DistributedEventEmitter("bus")');
    expect(output).toMatch(/local\s*=\s*new EventEmitter/);
  });

  it("transforms multiple emitters in the same file", () => {
    const source = `const orders = new EventEmitter();
const payments = new EventEmitter();`;
    const manifest = [
      {
        file: "index.ts",
        emitters: [
          { varName: "orders", namespace: "orders" },
          { varName: "payments", namespace: "payments" },
        ],
      },
    ];

    const output = transformEvents(source, "index.ts", manifest);
    expect(output).toContain('new DistributedEventEmitter("orders")');
    expect(output).toContain('new DistributedEventEmitter("payments")');
    expect(output).not.toContain("new EventEmitter");
  });

  it("only adds import once even with multiple emitters", () => {
    const source = `const a = new EventEmitter();
const b = new EventEmitter();`;
    const manifest = [
      {
        file: "index.ts",
        emitters: [
          { varName: "a", namespace: "a" },
          { varName: "b", namespace: "b" },
        ],
      },
    ];

    const output = transformEvents(source, "index.ts", manifest);
    const importCount = (output.match(/import { DistributedEventEmitter }/g) ?? []).length;
    expect(importCount).toBe(1);
  });

  it("handles empty manifest gracefully", () => {
    const source = `const bus = new EventEmitter();`;
    const output = transformEvents(source, "index.ts", []);
    expect(output).toContain("new EventEmitter");
    expect(output).not.toContain("DistributedEventEmitter");
  });
});
