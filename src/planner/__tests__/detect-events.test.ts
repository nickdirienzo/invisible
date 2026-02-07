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

describe("detectEventEmitters", () => {
  it("detects module-scope new EventEmitter() with node:events import", () => {
    const dir = makeProject({
      "index.ts": `
        import { EventEmitter } from "node:events";
        import express from "express";
        const bus = new EventEmitter();
        bus.on("order", (data) => console.log(data));
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const emitters = result.resources?.filter((r) => r.kind === "event-emitter") ?? [];
    expect(emitters).toHaveLength(1);
    expect(emitters[0]).toEqual({
      kind: "event-emitter",
      name: "bus",
      sourceFile: "index.ts",
      events: ["order"],
    });
  });

  it("detects multiple event names from .on() and .once()", () => {
    const dir = makeProject({
      "index.ts": `
        import { EventEmitter } from "node:events";
        import express from "express";
        const bus = new EventEmitter();
        bus.on("order:created", (data) => console.log(data));
        bus.on("order:shipped", (data) => console.log(data));
        bus.once("order:cancelled", (data) => console.log(data));
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const emitters = result.resources?.filter((r) => r.kind === "event-emitter") ?? [];
    expect(emitters).toHaveLength(1);
    if (emitters[0].kind === "event-emitter") {
      expect(emitters[0].events).toEqual(["order:created", "order:shipped", "order:cancelled"]);
    }
  });

  it("ignores function-scoped EventEmitter", () => {
    const dir = makeProject({
      "index.ts": `
        import { EventEmitter } from "node:events";
        import express from "express";
        function setup() {
          const bus = new EventEmitter();
          bus.on("test", () => {});
        }
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const emitters = result.resources?.filter((r) => r.kind === "event-emitter") ?? [];
    expect(emitters).toHaveLength(0);
  });

  it("ignores EventEmitter without node:events import", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        class EventEmitter { on() {} emit() {} }
        const bus = new EventEmitter();
        bus.on("test", () => {});
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const emitters = result.resources?.filter((r) => r.kind === "event-emitter") ?? [];
    expect(emitters).toHaveLength(0);
  });

  it("detects EventEmitter imported from 'events' (no node: prefix)", () => {
    const dir = makeProject({
      "index.ts": `
        import { EventEmitter } from "events";
        import express from "express";
        const notifications = new EventEmitter();
        notifications.on("email", (data) => console.log(data));
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const emitters = result.resources?.filter((r) => r.kind === "event-emitter") ?? [];
    expect(emitters).toHaveLength(1);
    if (emitters[0].kind === "event-emitter") {
      expect(emitters[0].name).toBe("notifications");
    }
  });

  it("detects multiple emitters in the same file", () => {
    const dir = makeProject({
      "index.ts": `
        import { EventEmitter } from "node:events";
        import express from "express";
        const orders = new EventEmitter();
        const payments = new EventEmitter();
        orders.on("created", (data) => console.log(data));
        payments.on("charged", (data) => console.log(data));
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const emitters = result.resources?.filter((r) => r.kind === "event-emitter") ?? [];
    expect(emitters).toHaveLength(2);
    expect(emitters.map((r) => r.name)).toEqual(["orders", "payments"]);
  });

  it("detects emitters across multiple files", () => {
    const dir = makeProject({
      "events.ts": `
        import { EventEmitter } from "node:events";
        export const bus = new EventEmitter();
        bus.on("ping", () => {});
      `,
      "index.ts": `
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const emitters = result.resources?.filter((r) => r.kind === "event-emitter") ?? [];
    expect(emitters).toHaveLength(1);
    expect(emitters[0]).toMatchObject({
      name: "bus",
      sourceFile: "events.ts",
    });
  });

  it("ignores dynamic event names", () => {
    const dir = makeProject({
      "index.ts": `
        import { EventEmitter } from "node:events";
        import express from "express";
        const bus = new EventEmitter();
        const eventName = "dynamic";
        bus.on(eventName, () => {});
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const emitters = result.resources?.filter((r) => r.kind === "event-emitter") ?? [];
    expect(emitters).toHaveLength(1);
    if (emitters[0].kind === "event-emitter") {
      expect(emitters[0].events).toEqual([]);
    }
  });

  it("deduplicates event names", () => {
    const dir = makeProject({
      "index.ts": `
        import { EventEmitter } from "node:events";
        import express from "express";
        const bus = new EventEmitter();
        bus.on("order", (data) => console.log(data));
        bus.on("order", (data) => console.log("second handler", data));
        bus.once("order", (data) => console.log("once handler", data));
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const emitters = result.resources?.filter((r) => r.kind === "event-emitter") ?? [];
    expect(emitters).toHaveLength(1);
    if (emitters[0].kind === "event-emitter") {
      expect(emitters[0].events).toEqual(["order"]);
    }
  });

  it("produces no resources when no EventEmitters exist", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const result = plan(dir);
    const emitters = result.resources?.filter((r) => r.kind === "event-emitter") ?? [];
    expect(emitters).toHaveLength(0);
  });
});
