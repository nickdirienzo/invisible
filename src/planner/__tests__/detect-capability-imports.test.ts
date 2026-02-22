import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { plan } from "../plan.js";

function makeProject(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "ii-test-"));
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    // Support nested paths like "prisma/schema.prisma"
    const parentDir = filePath.substring(0, filePath.lastIndexOf("/"));
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(filePath, content);
  }
  if (!files["package.json"]) {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "test-app" })
    );
  }
  return dir;
}

function getCapImports(dir: string) {
  const result = plan(dir);
  return (result.resources ?? []).filter((r) => r.kind === "capability-import");
}

// ---------------------------------------------------------------------------
// Direct driver detection
// ---------------------------------------------------------------------------

describe("detectCapabilityImports — direct drivers", () => {
  it("detects pg as relational postgres (replace)", () => {
    const dir = makeProject({
      "index.ts": `
        import { Client } from "pg";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({
      kind: "capability-import",
      module: "pg",
      capability: "relational",
      engine: "postgres",
      provisioning: "replace",
      sourceFile: "index.ts",
    });
  });

  it("detects postgres as relational postgres (replace)", () => {
    const dir = makeProject({
      "index.ts": `
        import postgres from "postgres";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({ module: "postgres", engine: "postgres" });
  });

  it("detects @neondatabase/serverless as relational postgres (replace)", () => {
    const dir = makeProject({
      "index.ts": `
        import { neon } from "@neondatabase/serverless";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({ module: "@neondatabase/serverless", engine: "postgres" });
  });

  it("detects mysql2 as relational mysql (replace)", () => {
    const dir = makeProject({
      "index.ts": `
        import mysql from "mysql2";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({
      module: "mysql2",
      capability: "relational",
      engine: "mysql",
      provisioning: "replace",
    });
  });

  it("detects mysql as relational mysql (replace)", () => {
    const dir = makeProject({
      "index.ts": `
        import mysql from "mysql";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({ module: "mysql", engine: "mysql" });
  });

  it("detects mongodb as document mongodb (replace)", () => {
    const dir = makeProject({
      "index.ts": `
        import { MongoClient } from "mongodb";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({
      module: "mongodb",
      capability: "document",
      engine: "mongodb",
      provisioning: "replace",
    });
  });

  it("detects mongoose as document mongodb (replace)", () => {
    const dir = makeProject({
      "index.ts": `
        import mongoose from "mongoose";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({ module: "mongoose", engine: "mongodb" });
  });

  it("detects better-sqlite3 as relational-embedded sqlite (preserve)", () => {
    const dir = makeProject({
      "index.ts": `
        import Database from "better-sqlite3";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({
      module: "better-sqlite3",
      capability: "relational-embedded",
      engine: "sqlite",
      provisioning: "preserve",
    });
  });

  it("detects node:sqlite as relational-embedded sqlite (preserve)", () => {
    const dir = makeProject({
      "index.ts": `
        import { DatabaseSync } from "node:sqlite";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({
      module: "node:sqlite",
      capability: "relational-embedded",
      engine: "sqlite",
      provisioning: "preserve",
    });
  });

  it("detects redis as kv valkey (replace)", () => {
    const dir = makeProject({
      "index.ts": `
        import Redis from "redis";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({
      module: "redis",
      capability: "kv",
      engine: "valkey",
      provisioning: "replace",
    });
  });

  it("detects ioredis as kv valkey (replace)", () => {
    const dir = makeProject({
      "index.ts": `
        import Redis from "ioredis";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({ module: "ioredis", engine: "valkey" });
  });

  it("detects @libsql/client as relational-compatible libsql (replace)", () => {
    const dir = makeProject({
      "index.ts": `
        import { createClient } from "@libsql/client";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({
      module: "@libsql/client",
      capability: "relational-compatible",
      engine: "libsql",
      provisioning: "replace",
    });
  });

  it("detects @turso/client as relational-compatible libsql (replace)", () => {
    const dir = makeProject({
      "index.ts": `
        import { createClient } from "@turso/client";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({ module: "@turso/client", engine: "libsql" });
  });

  it("detects @planetscale/database as relational-compatible planetscale (replace)", () => {
    const dir = makeProject({
      "index.ts": `
        import { connect } from "@planetscale/database";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({
      module: "@planetscale/database",
      capability: "relational-compatible",
      engine: "planetscale",
      provisioning: "replace",
    });
  });
});

// ---------------------------------------------------------------------------
// Import form variations
// ---------------------------------------------------------------------------

describe("detectCapabilityImports — import forms", () => {
  it("detects default import", () => {
    const dir = makeProject({
      "index.ts": `
        import pg from "pg";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({ module: "pg" });
  });

  it("detects named import", () => {
    const dir = makeProject({
      "index.ts": `
        import { Pool } from "pg";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({ module: "pg" });
  });

  it("detects namespace import", () => {
    const dir = makeProject({
      "index.ts": `
        import * as pg from "pg";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({ module: "pg" });
  });

  it("detects side-effect import", () => {
    const dir = makeProject({
      "index.ts": `
        import "pg";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({ module: "pg" });
  });
});

// ---------------------------------------------------------------------------
// Dedup and edge cases
// ---------------------------------------------------------------------------

describe("detectCapabilityImports — dedup and edge cases", () => {
  it("deduplicates same driver imported in multiple files", () => {
    const dir = makeProject({
      "db.ts": `
        import { Pool } from "pg";
        export const pool = new Pool();
      `,
      "index.ts": `
        import { Client } from "pg";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    const pgCaps = caps.filter((r) => r.kind === "capability-import" && r.module === "pg");
    expect(pgCaps).toHaveLength(1);
  });

  it("detects multiple different drivers in same project", () => {
    const dir = makeProject({
      "index.ts": `
        import { Pool } from "pg";
        import Redis from "redis";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(2);
    expect(caps.map((r) => r.kind === "capability-import" ? r.module : "").sort()).toEqual(["pg", "redis"]);
  });

  it("produces no resources when no driver imports exist", () => {
    const dir = makeProject({
      "index.ts": `
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(0);
  });

  it("ignores unknown modules", () => {
    const dir = makeProject({
      "index.ts": `
        import something from "some-random-package";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Prisma deferred resolution
// ---------------------------------------------------------------------------

describe("detectCapabilityImports — Prisma deferred", () => {
  it("resolves @prisma/client with postgresql provider", () => {
    const dir = makeProject({
      "index.ts": `
        import { PrismaClient } from "@prisma/client";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
      "prisma/schema.prisma": `
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({
      kind: "capability-import",
      module: "@prisma/client",
      capability: "relational",
      engine: "postgres",
      provisioning: "replace",
      deferred: { source: "prisma.schema", resolved: true },
    });
  });

  it("resolves @prisma/client with mysql provider", () => {
    const dir = makeProject({
      "index.ts": `
        import { PrismaClient } from "@prisma/client";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
      "prisma/schema.prisma": `
        datasource db {
          provider = "mysql"
          url      = env("DATABASE_URL")
        }
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({
      engine: "mysql",
      capability: "relational",
      deferred: { source: "prisma.schema", resolved: true },
    });
  });

  it("resolves @prisma/client with sqlite provider as preserve", () => {
    const dir = makeProject({
      "index.ts": `
        import { PrismaClient } from "@prisma/client";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
      "prisma/schema.prisma": `
        datasource db {
          provider = "sqlite"
          url      = "file:./dev.db"
        }
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({
      engine: "sqlite",
      capability: "relational-embedded",
      provisioning: "preserve",
      deferred: { source: "prisma.schema", resolved: true },
    });
  });

  it("resolves @prisma/client with mongodb provider", () => {
    const dir = makeProject({
      "index.ts": `
        import { PrismaClient } from "@prisma/client";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
      "prisma/schema.prisma": `
        datasource db {
          provider = "mongodb"
          url      = env("DATABASE_URL")
        }
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({
      engine: "mongodb",
      capability: "document",
      deferred: { source: "prisma.schema", resolved: true },
    });
  });

  it("emits unresolved when prisma schema is missing", () => {
    const dir = makeProject({
      "index.ts": `
        import { PrismaClient } from "@prisma/client";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({
      module: "@prisma/client",
      engine: null,
      deferred: { source: "prisma.schema", resolved: false },
    });
  });
});

// ---------------------------------------------------------------------------
// Drizzle deferred resolution (co-import)
// ---------------------------------------------------------------------------

describe("detectCapabilityImports — Drizzle deferred", () => {
  it("resolves drizzle-orm with pg co-import", () => {
    const dir = makeProject({
      "index.ts": `
        import { drizzle } from "drizzle-orm";
        import { Pool } from "pg";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    const drizzleCap = caps.find((r) => r.kind === "capability-import" && r.module === "drizzle-orm");
    expect(drizzleCap).toBeDefined();
    expect(drizzleCap).toMatchObject({
      module: "drizzle-orm",
      capability: "relational",
      engine: "postgres",
      provisioning: "replace",
      deferred: { source: "co-import", resolved: true },
    });
  });

  it("resolves drizzle-orm with better-sqlite3 co-import as preserve", () => {
    const dir = makeProject({
      "index.ts": `
        import { drizzle } from "drizzle-orm";
        import Database from "better-sqlite3";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    const drizzleCap = caps.find((r) => r.kind === "capability-import" && r.module === "drizzle-orm");
    expect(drizzleCap).toMatchObject({
      engine: "sqlite",
      capability: "relational-embedded",
      provisioning: "preserve",
      deferred: { source: "co-import", resolved: true },
    });
  });

  it("resolves drizzle-orm with co-import in different file", () => {
    const dir = makeProject({
      "db.ts": `
        import { Pool } from "pg";
        export const pool = new Pool();
      `,
      "index.ts": `
        import { drizzle } from "drizzle-orm";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    const drizzleCap = caps.find((r) => r.kind === "capability-import" && r.module === "drizzle-orm");
    expect(drizzleCap).toMatchObject({
      engine: "postgres",
      deferred: { source: "co-import", resolved: true },
    });
  });

  it("emits unresolved when drizzle-orm has no co-import", () => {
    const dir = makeProject({
      "index.ts": `
        import { drizzle } from "drizzle-orm";
        import express from "express";
        const app = express();
        app.listen(3000);
      `,
    });
    const caps = getCapImports(dir);
    const drizzleCap = caps.find((r) => r.kind === "capability-import" && r.module === "drizzle-orm");
    expect(drizzleCap).toBeDefined();
    expect(drizzleCap).toMatchObject({
      module: "drizzle-orm",
      engine: null,
      deferred: { source: "co-import", resolved: false },
    });
  });
});
