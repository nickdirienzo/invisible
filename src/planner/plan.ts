import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { App } from "../ir/index.js";

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export function plan(projectDir: string): App {
  const pkg = readPackageJson(projectDir);
  const appName = pkg.name ?? basename(projectDir);
  const sources = readSourceFiles(projectDir);

  const port = detectHttpServer(sources);
  const hasIngress = port !== null;
  const entrypoint = detectEntrypoint(sources);
  const typescript = entrypoint.endsWith(".ts") || entrypoint.endsWith(".mts");

  return {
    name: appName,
    services: [
      {
        name: "web",
        build: "./",
        port: port ?? 3000,
        entrypoint,
        typescript,
        ...(hasIngress ? { ingress: [{ host: "", path: "/" }] } : {}),
      },
    ],
  };
}

function readPackageJson(dir: string): PackageJson {
  const raw = readFileSync(join(dir, "package.json"), "utf-8");
  return JSON.parse(raw) as PackageJson;
}

function readSourceFiles(dir: string): Map<string, string> {
  const sources = new Map<string, string>();
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!/\.(ts|js|mjs|mts)$/.test(entry.name)) continue;

    const content = readFileSync(join(dir, entry.name), "utf-8");
    sources.set(entry.name, content);
  }

  return sources;
}

/**
 * Detects an HTTP server by looking for the stdlib contract:
 *
 *   - server.listen(port)     — the universal signal, used by node:http,
 *                                Express, Fastify, Koa, etc.
 *   - createServer(...)       — explicit node:http usage
 *
 * Returns the port number if found, null otherwise.
 */
function detectEntrypoint(sources: Map<string, string>): string {
  // The file containing .listen() is the entrypoint
  for (const [filename, content] of sources) {
    if (content.match(/\.listen\(/)) return filename;
  }

  // Fallback: prefer index.ts > index.js
  if (sources.has("index.ts")) return "index.ts";
  if (sources.has("index.js")) return "index.js";

  // First source file found
  const first = sources.keys().next().value;
  return first ?? "index.js";
}

function detectHttpServer(sources: Map<string, string>): number | null {
  for (const [, content] of sources) {
    // Look for .listen(arg) — this is the stdlib primitive.
    // Every HTTP framework in Node calls this under the hood.
    const listenMatch = content.match(/\.listen\(\s*(\w+)/);
    if (!listenMatch) continue;

    const arg = listenMatch[1];

    // Direct numeric literal: .listen(3000)
    const numeric = parseInt(arg, 10);
    if (!isNaN(numeric)) return numeric;

    // Variable reference: const port = process.env.PORT || 3000
    const varPattern = new RegExp(
      `(?:const|let|var)\\s+${arg}\\s*=\\s*(?:.*\\|\\|\\s*)?(\\d+)`
    );
    const varMatch = content.match(varPattern);
    if (varMatch) return parseInt(varMatch[1], 10);
  }

  return null;
}
