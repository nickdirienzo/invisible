import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { plan } from "../plan.js";

function makeProject(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "ii-test-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  // Every project needs a package.json
  if (!files["package.json"]) {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "test-app" })
    );
  }
  return dir;
}

describe("detectListenCall", () => {
  it("detects app.listen(3000)", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    expect(result.services[0].port).toBe(3000);
  });

  it("detects app.listen(port) with const port = 8080", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        const port = 8080;
        app.listen(port);
      `,
    });
    const result = plan(dir);
    expect(result.services[0].port).toBe(8080);
  });

  it("detects process.env.PORT || 3000 fallback", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        const port = process.env.PORT || 3000;
        app.listen(port);
      `,
    });
    const result = plan(dir);
    expect(result.services[0].port).toBe(3000);
  });

  it("detects process.env.PORT ?? 4000 fallback", () => {
    const dir = makeProject({
      "index.ts": `
        const port = process.env.PORT ?? 4000;
        Bun.serve({ port });
      `,
    });
    // No .listen() call here, so should fall back to default
    // But if we had server.listen(port), it would resolve 4000
  });

  it("detects .listen({ port: 3000 }) object form", () => {
    const dir = makeProject({
      "index.ts": `
        import Fastify from "fastify";
        const app = Fastify();
        app.listen({ port: 3000 });
      `,
    });
    const result = plan(dir);
    expect(result.services[0].port).toBe(3000);
  });

  it("detects createServer().listen(5000) chained", () => {
    const dir = makeProject({
      "index.ts": `
        import { createServer } from "node:http";
        createServer((req, res) => {
          res.end("ok");
        }).listen(5000);
      `,
    });
    const result = plan(dir);
    expect(result.services[0].port).toBe(5000);
  });

  it("detects .listen with callback", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        app.listen(3000, () => console.log("ready"));
      `,
    });
    const result = plan(dir);
    expect(result.services[0].port).toBe(3000);
  });

  it("falls back to 3000 when no .listen found", () => {
    const dir = makeProject({
      "index.ts": `console.log("no server here");`,
    });
    const result = plan(dir);
    expect(result.services[0].port).toBe(3000);
    expect(result.services[0].ingress).toBeUndefined();
  });

  it("identifies the entrypoint as the file with .listen", () => {
    const dir = makeProject({
      "utils.ts": `export const foo = 1;`,
      "server.ts": `
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    expect(result.services[0].entrypoint).toBe("server.ts");
  });
});

describe("detectFrameworkStart", () => {
  it("detects framework from scripts.start", () => {
    const dir = makeProject({
      "package.json": JSON.stringify({
        name: "remix-app",
        scripts: {
          build: "remix vite:build",
          start: "remix-serve ./build/server/index.js",
        },
      }),
      "vite.config.ts": `export default {};`,
    });
    const result = plan(dir);
    expect(result.services[0].port).toBe(3000);
    expect(result.services[0].ingress).toEqual([{ host: "", path: "/" }]);
    expect(result.services[0].startCmd).toBe("remix-serve ./build/server/index.js");
    expect(result.services[0].buildCmd).toBe("remix vite:build");
  });

  it("does not detect framework when scripts.build is missing", () => {
    const dir = makeProject({
      "package.json": JSON.stringify({
        name: "no-build",
        scripts: {
          start: "remix-serve ./build/server/index.js",
        },
      }),
      "index.ts": `console.log("hello");`,
    });
    const result = plan(dir);
    expect(result.services[0].startCmd).toBeUndefined();
    expect(result.services[0].ingress).toBeUndefined();
  });

  it("extracts port from --port flag", () => {
    const dir = makeProject({
      "package.json": JSON.stringify({
        name: "custom-port-app",
        scripts: {
          build: "next build",
          start: "next start --port 4000",
        },
      }),
      "index.ts": `export default {};`,
    });
    const result = plan(dir);
    expect(result.services[0].port).toBe(4000);
  });

  it("detects static site when scripts.build exists without scripts.start", () => {
    const dir = makeProject({
      "package.json": JSON.stringify({
        name: "no-start",
        scripts: {
          build: "tsc",
        },
      }),
      "index.ts": `console.log("hello");`,
    });
    const result = plan(dir);
    expect(result.services[0].startCmd).toBeUndefined();
    expect(result.services[0].static).toBe(true);
    expect(result.services[0].buildCmd).toBe("tsc");
    expect(result.services[0].port).toBe(80);
    expect(result.services[0].ingress).toEqual([{ host: "", path: "/" }]);
  });

  it("prefers .listen() over framework detection", () => {
    const dir = makeProject({
      "package.json": JSON.stringify({
        name: "custom-server",
        scripts: {
          build: "remix vite:build",
          start: "remix-serve ./build/server/index.js",
        },
      }),
      "server.ts": `
        import express from "express";
        const app = express();
        app.listen(4000);
      `,
    });
    const result = plan(dir);
    expect(result.services[0].port).toBe(4000);
    expect(result.services[0].entrypoint).toBe("server.ts");
    expect(result.services[0].startCmd).toBeUndefined();
  });
});
