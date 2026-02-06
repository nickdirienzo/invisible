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

describe("detectSecrets", () => {
  it("detects process.env.VARIABLE_NAME access", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const apiKey = process.env.STRIPE_API_KEY;
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const secrets = result.resources?.filter((r) => r.kind === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets![0]).toEqual({
      kind: "secret",
      name: "STRIPE_API_KEY",
      sourceFile: "index.ts",
    });
  });

  it("detects process.env['VARIABLE_NAME'] access", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const dbUrl = process.env["DATABASE_URL"];
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const secrets = result.resources?.filter((r) => r.kind === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets![0].name).toBe("DATABASE_URL");
  });

  it("excludes infrastructure-managed env vars", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const port = process.env.PORT || 3000;
        const env = process.env.NODE_ENV;
        const valkey = process.env.VALKEY_URL;
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const secrets = (result.resources ?? []).filter((r) => r.kind === "secret");
    expect(secrets).toHaveLength(0);
  });

  it("detects process.env inside route handlers", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        app.get("/", (req, res) => {
          const key = process.env.API_KEY;
          res.json({ key });
        });
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const secrets = result.resources?.filter((r) => r.kind === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets![0].name).toBe("API_KEY");
  });

  it("detects multiple env vars in one file", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const stripe = process.env.STRIPE_KEY;
        const db = process.env.DATABASE_URL;
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const secrets = result.resources?.filter((r) => r.kind === "secret");
    expect(secrets).toHaveLength(2);
    expect(secrets!.map((s) => s.name)).toEqual(["STRIPE_KEY", "DATABASE_URL"]);
  });

  it("detects env vars across files", () => {
    const dir = makeProject({
      "config.ts": `export const dbUrl = process.env.DATABASE_URL;`,
      "index.ts": `
        import express from "express";
        const key = process.env.API_KEY;
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const secrets = result.resources?.filter((r) => r.kind === "secret");
    expect(secrets).toHaveLength(2);
  });

  it("deduplicates same env var accessed multiple times in one file", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const a = process.env.API_KEY;
        const b = process.env.API_KEY;
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const secrets = result.resources?.filter((r) => r.kind === "secret");
    expect(secrets).toHaveLength(1);
  });

  it("produces no secret resources when no process.env access", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const secrets = (result.resources ?? []).filter((r) => r.kind === "secret");
    expect(secrets).toHaveLength(0);
  });

  it("detects both durable maps and secrets", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const cache = new Map<string, string>();
        const apiKey = process.env.STRIPE_KEY;
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    expect(result.resources).toHaveLength(2);
    expect(result.resources!.find((r) => r.kind === "durable-map")).toBeDefined();
    expect(result.resources!.find((r) => r.kind === "secret")).toBeDefined();
  });
});
