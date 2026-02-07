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

describe("detectEnvVars", () => {
  it("detects import.meta.env.VARIABLE_NAME access", () => {
    const dir = makeProject({
      "index.ts": `
        const apiUrl = import.meta.env.VITE_API_URL;
        console.log(apiUrl);
      `,
    });
    const result = plan(dir);
    const envVars = result.resources?.filter((r) => r.kind === "env-var");
    expect(envVars).toHaveLength(1);
    expect(envVars![0]).toEqual({
      kind: "env-var",
      name: "VITE_API_URL",
      sourceFile: "index.ts",
    });
  });

  it("detects multiple import.meta.env vars", () => {
    const dir = makeProject({
      "index.ts": `
        const api = import.meta.env.VITE_API_URL;
        const title = import.meta.env.VITE_APP_TITLE;
      `,
    });
    const result = plan(dir);
    const envVars = result.resources?.filter((r) => r.kind === "env-var");
    expect(envVars).toHaveLength(2);
    expect(envVars!.map((v) => v.name)).toEqual(["VITE_API_URL", "VITE_APP_TITLE"]);
  });

  it("deduplicates same env var accessed multiple times", () => {
    const dir = makeProject({
      "index.ts": `
        const a = import.meta.env.VITE_API_URL;
        const b = import.meta.env.VITE_API_URL;
      `,
    });
    const result = plan(dir);
    const envVars = result.resources?.filter((r) => r.kind === "env-var");
    expect(envVars).toHaveLength(1);
  });

  it("detects import.meta.env inside functions", () => {
    const dir = makeProject({
      "index.ts": `
        function getApi() {
          return import.meta.env.VITE_API_URL;
        }
      `,
    });
    const result = plan(dir);
    const envVars = result.resources?.filter((r) => r.kind === "env-var");
    expect(envVars).toHaveLength(1);
    expect(envVars![0].name).toBe("VITE_API_URL");
  });

  it("does not confuse import.meta.env with process.env", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const apiUrl = import.meta.env.VITE_API_URL;
        const secret = process.env.API_KEY;
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const envVars = result.resources?.filter((r) => r.kind === "env-var");
    const secrets = result.resources?.filter((r) => r.kind === "secret");
    expect(envVars).toHaveLength(1);
    expect(envVars![0].name).toBe("VITE_API_URL");
    expect(secrets).toHaveLength(1);
    expect(secrets![0].name).toBe("API_KEY");
  });

  it("produces no env-var resources when no import.meta.env access", () => {
    const dir = makeProject({
      "index.ts": `
        const x = 42;
      `,
    });
    const result = plan(dir);
    const envVars = (result.resources ?? []).filter((r) => r.kind === "env-var");
    expect(envVars).toHaveLength(0);
  });
});
