import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { plan } from "../plan.js";

function makeProject(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "ii-test-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  if (!files["package.json"]) {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "test-app" })
    );
  }
  return dir;
}

describe("detectDurableMaps", () => {
  it("detects module-scope new Map()", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const counters = new Map<string, number>();
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    expect(result.resources).toHaveLength(1);
    expect(result.resources![0]).toEqual({
      kind: "durable-map",
      name: "counters",
      sourceFile: "index.ts",
    });
  });

  it("ignores function-scope new Map()", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        app.get("/", (req, res) => {
          const temp = new Map();
          res.json({});
        });
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    expect(result.resources).toBeUndefined();
  });

  it("detects multiple Maps in the same file", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const sessions = new Map<string, object>();
        const cache = new Map<string, string>();
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    expect(result.resources).toHaveLength(2);
    expect(result.resources!.map((r) => r.name)).toEqual(["sessions", "cache"]);
  });

  it("detects Maps across multiple files", () => {
    const dir = makeProject({
      "state.ts": `
        export const sessions = new Map<string, object>();
      `,
      "index.ts": `
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    expect(result.resources).toHaveLength(1);
    expect(result.resources![0].name).toBe("sessions");
    expect(result.resources![0].sourceFile).toBe("state.ts");
  });

  it("produces no resources when no Maps exist", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    expect(result.resources).toBeUndefined();
  });

  it("ignores Maps inside class methods", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        class Handler {
          handle() {
            const m = new Map();
          }
        }
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    expect(result.resources).toBeUndefined();
  });
});
