export interface App {
  name: string;
  services: Service[];
  resources?: Resource[];
}

export interface Service {
  name: string;
  build: string;
  port: number;
  entrypoint: string;
  typescript: boolean;
  ingress?: IngressRule[];
  scale?: ScaleBounds;
  env?: Record<string, string>;
  /** When set, the service uses a framework CLI (e.g. remix-serve) instead of node dist/entry.js */
  startCmd?: string;
  /** When set, the build uses this command instead of tsc (e.g. "remix vite:build") */
  buildCmd?: string;
  /** When true, the service is a static site served by nginx (no server process) */
  static?: boolean;
}

export interface IngressRule {
  host: string;
  path?: string;
}

export interface ScaleBounds {
  min: number;
  max: number;
}

export interface DurableMapResource {
  kind: "durable-map";
  name: string;
  sourceFile: string;
}

export interface SecretResource {
  kind: "secret";
  name: string;
  sourceFile: string;
}

export interface CronJobResource {
  kind: "cron-job";
  name: string;
  endpoint: string;
  method: string;
  intervalMs: number;
  sourceFile: string;
}

export interface EventEmitterResource {
  kind: "event-emitter";
  name: string;
  sourceFile: string;
  events: string[];
}

export interface EnvVarResource {
  kind: "env-var";
  name: string;
  sourceFile: string;
}

export interface CapabilityImportResource {
  kind: "capability-import";
  /** Raw import module specifier, e.g. "pg", "better-sqlite3", "@prisma/client" */
  module: string;
  capability: "relational" | "relational-embedded" | "document" | "kv" | "relational-compatible";
  engine: "postgres" | "mysql" | "sqlite" | "mongodb" | "valkey" | "libsql" | "planetscale" | null;
  /** replace: grammar provisions the engine. preserve: grammar provisions compute + volume, keeps the engine. */
  provisioning: "replace" | "preserve";
  sourceFile: string;
  name: string;
  /** Present for ORM imports where the engine is resolved indirectly */
  deferred?: {
    source: "prisma.schema" | "co-import";
    resolved: boolean;
  };
}

export type Resource = DurableMapResource | SecretResource | CronJobResource | EventEmitterResource | EnvVarResource | CapabilityImportResource;
