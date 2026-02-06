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

describe("detectCronJobs", () => {
  it("detects setInterval with expression-body fetch to /job/*", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        setInterval(() => fetch('/job/report'), 86400000);
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const cronJobs = result.resources?.filter((r) => r.kind === "cron-job") ?? [];
    expect(cronJobs).toHaveLength(1);
    expect(cronJobs[0]).toEqual({
      kind: "cron-job",
      name: "report",
      endpoint: "/job/report",
      method: "GET",
      intervalMs: 86400000,
      sourceFile: "index.ts",
    });
  });

  it("detects setInterval with block-body fetch", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        setInterval(() => { fetch('/job/cleanup'); }, 3600000);
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const cronJobs = result.resources?.filter((r) => r.kind === "cron-job") ?? [];
    expect(cronJobs).toHaveLength(1);
    expect(cronJobs[0]).toMatchObject({
      kind: "cron-job",
      endpoint: "/job/cleanup",
      intervalMs: 3600000,
    });
  });

  it("detects POST method from fetch options", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        setInterval(() => fetch('/job/daily-report', { method: 'POST' }), 86400000);
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const cronJobs = result.resources?.filter((r) => r.kind === "cron-job") ?? [];
    expect(cronJobs).toHaveLength(1);
    expect(cronJobs[0]).toMatchObject({
      kind: "cron-job",
      method: "POST",
      endpoint: "/job/daily-report",
    });
  });

  it("ignores function-scoped setInterval", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        function setup() {
          setInterval(() => fetch('/job/report'), 86400000);
        }
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const cronJobs = result.resources?.filter((r) => r.kind === "cron-job") ?? [];
    expect(cronJobs).toHaveLength(0);
  });

  it("ignores setInterval with non-fetch callback", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        setInterval(() => { console.log('heartbeat'); }, 5000);
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const cronJobs = result.resources?.filter((r) => r.kind === "cron-job") ?? [];
    expect(cronJobs).toHaveLength(0);
  });

  it("ignores setInterval with mixed logic + fetch", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        setInterval(() => {
          const stats = gatherStats();
          fetch('/job/stats', { method: 'POST', body: JSON.stringify(stats) });
        }, 60000);
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const cronJobs = result.resources?.filter((r) => r.kind === "cron-job") ?? [];
    expect(cronJobs).toHaveLength(0);
  });

  it("ignores fetch to non /job/* routes", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        setInterval(() => fetch('/api/report'), 86400000);
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const cronJobs = result.resources?.filter((r) => r.kind === "cron-job") ?? [];
    expect(cronJobs).toHaveLength(0);
  });

  it("ignores external URLs", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        setInterval(() => fetch('https://external.com/job/ping'), 60000);
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const cronJobs = result.resources?.filter((r) => r.kind === "cron-job") ?? [];
    expect(cronJobs).toHaveLength(0);
  });

  it("detects multiple cron jobs in the same file", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        setInterval(() => fetch('/job/report'), 86400000);
        setInterval(() => fetch('/job/cleanup', { method: 'POST' }), 3600000);
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const cronJobs = result.resources?.filter((r) => r.kind === "cron-job") ?? [];
    expect(cronJobs).toHaveLength(2);
    expect(cronJobs.map((r) => r.kind === "cron-job" && r.endpoint)).toEqual([
      "/job/report",
      "/job/cleanup",
    ]);
  });

  it("detects cron jobs across multiple files", () => {
    const dir = makeProject({
      "cron.ts": `
        setInterval(() => fetch('/job/report'), 86400000);
      `,
      "index.ts": `
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const cronJobs = result.resources?.filter((r) => r.kind === "cron-job") ?? [];
    expect(cronJobs).toHaveLength(1);
    expect(cronJobs[0]).toMatchObject({
      sourceFile: "cron.ts",
    });
  });

  it("produces no cron resources when no setInterval exists", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const cronJobs = result.resources?.filter((r) => r.kind === "cron-job") ?? [];
    expect(cronJobs).toHaveLength(0);
  });

  it("derives job name from path after /job/", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        setInterval(() => fetch('/job/daily-report'), 86400000);
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const cronJobs = result.resources?.filter((r) => r.kind === "cron-job") ?? [];
    expect(cronJobs).toHaveLength(1);
    if (cronJobs[0].kind === "cron-job") {
      expect(cronJobs[0].name).toBe("daily-report");
    }
  });

  it("resolves constant expressions like 24 * 60 * 60 * 1000", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        setInterval(() => fetch('/job/daily-report', { method: 'POST' }), 24 * 60 * 60 * 1000);
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const cronJobs = result.resources?.filter((r) => r.kind === "cron-job") ?? [];
    expect(cronJobs).toHaveLength(1);
    if (cronJobs[0].kind === "cron-job") {
      expect(cronJobs[0].intervalMs).toBe(86400000);
    }
  });

  it("defaults method to GET when no options provided", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        setInterval(() => fetch('/job/check'), 5000);
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const cronJobs = result.resources?.filter((r) => r.kind === "cron-job") ?? [];
    expect(cronJobs).toHaveLength(1);
    if (cronJobs[0].kind === "cron-job") {
      expect(cronJobs[0].method).toBe("GET");
    }
  });
});
