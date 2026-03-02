import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { plan } from "../plan.js";

function makeMonorepo(structure: Record<string, Record<string, string>>) {
  const dir = mkdtempSync(join(tmpdir(), "ii-test-"));

  for (const [subdir, files] of Object.entries(structure)) {
    if (subdir === ".") {
      // Root-level files
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, name), content);
      }
    } else {
      mkdirSync(join(dir, subdir), { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, subdir, name), content);
      }
    }
  }

  // Ensure root package.json exists
  if (!structure["."]?.["package.json"]) {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "test-monorepo" })
    );
  }

  return dir;
}

describe("monorepo detection", () => {
  it("detects monorepo with two service directories", () => {
    const dir = makeMonorepo({
      ".": {
        "package.json": JSON.stringify({ name: "my-monorepo" }),
      },
      api: {
        "package.json": JSON.stringify({ name: "api" }),
        "index.ts": `
          import express from "express";
          const app = express();
          app.listen(4000);
        `,
      },
      web: {
        "package.json": JSON.stringify({
          name: "web",
          scripts: { build: "vite build" },
        }),
        "index.ts": "export {};",
      },
    });

    const result = plan(dir);
    expect(result.name).toBe("my-monorepo");
    expect(result.services).toHaveLength(2);
    expect(result.services.map((s) => s.name).sort()).toEqual(["api", "web"]);

    const api = result.services.find((s) => s.name === "api")!;
    expect(api.port).toBe(4000);
    expect(api.build).toBe("./api");

    const web = result.services.find((s) => s.name === "web")!;
    expect(web.port).toBe(80);
    expect(web.build).toBe("./web");
    expect(web.static).toBe(true);
    expect(web.buildCmd).toBe("vite build");
    expect(web.startCmd).toBeUndefined();
  });

  it("falls back to single service when no subdirectory has package.json", () => {
    const dir = makeMonorepo({
      ".": {
        "package.json": JSON.stringify({ name: "single-app" }),
        "index.ts": `
          import express from "express";
          const app = express();
          app.listen(3000);
        `,
      },
    });

    const result = plan(dir);
    expect(result.services).toHaveLength(1);
    expect(result.services[0].name).toBe("web");
    expect(result.services[0].build).toBe("./");
  });

  it("ignores .ii and node_modules directories", () => {
    const dir = makeMonorepo({
      ".": {
        "package.json": JSON.stringify({ name: "test-app" }),
        "index.ts": `
          import express from "express";
          const app = express();
          app.listen(3000);
        `,
      },
      ".ii": {
        "package.json": JSON.stringify({ name: "should-be-ignored" }),
      },
      node_modules: {
        "package.json": JSON.stringify({ name: "also-ignored" }),
      },
    });

    const result = plan(dir);
    // Should fall back to single-service since .ii and node_modules are skipped
    expect(result.services).toHaveLength(1);
    expect(result.services[0].name).toBe("web");
  });

  it("prefixes sourceFile with service name for disambiguation", () => {
    const dir = makeMonorepo({
      ".": {
        "package.json": JSON.stringify({ name: "test-monorepo" }),
      },
      api: {
        "package.json": JSON.stringify({ name: "api" }),
        "index.ts": `
          import express from "express";
          const app = express();
          const tasks = new Map<string, string>();
          app.listen(4000);
        `,
      },
      web: {
        "package.json": JSON.stringify({
          name: "web",
          scripts: { build: "vite build" },
        }),
        "index.ts": "export {};",
      },
    });

    const result = plan(dir);
    const maps = result.resources?.filter((r) => r.kind === "durable-map") ?? [];
    expect(maps).toHaveLength(1);
    expect(maps[0].sourceFile).toBe("api/index.ts");
  });

  it("merges resources from all services at app level", () => {
    const dir = makeMonorepo({
      ".": {
        "package.json": JSON.stringify({ name: "test-monorepo" }),
      },
      api: {
        "package.json": JSON.stringify({ name: "api" }),
        "index.ts": `
          import express from "express";
          const app = express();
          const tasks = new Map<string, string>();
          const key = process.env.API_KEY;
          app.listen(4000);
        `,
      },
      worker: {
        "package.json": JSON.stringify({ name: "worker" }),
        "index.ts": `
          import express from "express";
          const app = express();
          const cache = new Map<string, string>();
          app.listen(5000);
        `,
      },
    });

    const result = plan(dir);
    expect(result.services).toHaveLength(2);

    const maps = result.resources?.filter((r) => r.kind === "durable-map") ?? [];
    expect(maps).toHaveLength(2);
    expect(maps.map((m) => m.sourceFile).sort()).toEqual([
      "api/index.ts",
      "worker/index.ts",
    ]);

    const secrets = result.resources?.filter((r) => r.kind === "secret") ?? [];
    expect(secrets).toHaveLength(1);
    expect(secrets[0].sourceFile).toBe("api/index.ts");
  });

  it("detects static site when scripts.build exists without scripts.start", () => {
    const dir = makeMonorepo({
      ".": {
        "package.json": JSON.stringify({ name: "static-mono" }),
      },
      web: {
        "package.json": JSON.stringify({
          name: "web",
          scripts: { build: "vite build" },
        }),
        "index.ts": "export {};",
      },
    });

    const result = plan(dir);
    const web = result.services.find((s) => s.name === "web")!;
    expect(web.static).toBe(true);
    expect(web.buildCmd).toBe("vite build");
    expect(web.startCmd).toBeUndefined();
    expect(web.port).toBe(80);
    expect(web.ingress).toBeDefined();
  });

  it("detects framework when scripts.build and scripts.start both exist", () => {
    const dir = makeMonorepo({
      ".": {
        "package.json": JSON.stringify({ name: "framework-mono" }),
      },
      web: {
        "package.json": JSON.stringify({
          name: "web",
          scripts: { build: "remix vite:build", start: "remix-serve ./build/server/index.js" },
        }),
        "index.ts": "export {};",
      },
    });

    const result = plan(dir);
    const web = result.services.find((s) => s.name === "web")!;
    expect(web.static).toBeUndefined();
    expect(web.startCmd).toBe("remix-serve ./build/server/index.js");
    expect(web.buildCmd).toBe("remix vite:build");
    expect(web.port).toBe(3000);
  });

  it("each service gets its own build path", () => {
    const dir = makeMonorepo({
      ".": {
        "package.json": JSON.stringify({ name: "test-monorepo" }),
      },
      backend: {
        "package.json": JSON.stringify({ name: "backend" }),
        "index.ts": `
          import express from "express";
          const app = express();
          app.listen(4000);
        `,
      },
      frontend: {
        "package.json": JSON.stringify({
          name: "frontend",
          scripts: { build: "vite build" },
        }),
        "index.ts": "export {};",
      },
    });

    const result = plan(dir);
    const backend = result.services.find((s) => s.name === "backend")!;
    const frontend = result.services.find((s) => s.name === "frontend")!;

    expect(backend.build).toBe("./backend");
    expect(frontend.build).toBe("./frontend");
  });

  it("includes root as service when it has a server alongside subdirectory services", () => {
    const dir = makeMonorepo({
      ".": {
        "package.json": JSON.stringify({ name: "my-app" }),
      },
      src: {
        "server.ts": `
          import express from "express";
          const app = express();
          app.listen(3000);
        `,
      },
      frontend: {
        "package.json": JSON.stringify({
          name: "frontend",
          scripts: { build: "vite build" },
        }),
        "index.ts": "export {};",
      },
    });

    const result = plan(dir);
    expect(result.name).toBe("my-app");
    expect(result.services).toHaveLength(2);
    expect(result.services.map((s) => s.name).sort()).toEqual(["frontend", "web"]);

    const web = result.services.find((s) => s.name === "web")!;
    expect(web.port).toBe(3000);
    expect(web.build).toBe("./");

    const frontend = result.services.find((s) => s.name === "frontend")!;
    expect(frontend.port).toBe(80);
    expect(frontend.static).toBe(true);
    expect(frontend.build).toBe("./frontend");
  });
});
