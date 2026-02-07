import type { Service } from "../ir/index.js";

export interface DockerfileOptions {
  /** When true, the build uses .ii/build.mjs instead of plain tsc */
  hasResources?: boolean;
  /** When true, copies secrets shim and uses --import to load it before app */
  hasSecrets?: boolean;
  /** When true, copies cron shim and uses --import to load it before app */
  hasCronJobs?: boolean;
  /** When true, copies events runtime for DistributedEventEmitter */
  hasEvents?: boolean;
}

export function compileToDockerfile(
  svc: Service,
  startCmd: string,
  options?: DockerfileOptions
): string {
  const hasResources = !!options?.hasResources;
  const hasSecrets = !!options?.hasSecrets;
  const hasCronJobs = !!options?.hasCronJobs;
  const hasEvents = !!options?.hasEvents;
  const hasDapr = hasCronJobs || hasEvents;

  // Framework apps (Remix, Next, etc.) — use the framework's own build & start
  if (svc.startCmd && svc.buildCmd) {
    return `FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev
EXPOSE ${svc.port}
CMD ["npm", "run", "start"]
`;
  }

  if (svc.typescript) {
    const jsEntry = svc.entrypoint.replace(/\.ts$/, ".js").replace(/\.mts$/, ".mjs");
    const needsCustomBuild = hasResources || hasCronJobs || hasEvents;
    const buildCopyParts: string[] = [];
    if (needsCustomBuild) {
      buildCopyParts.push("COPY .ii/build.mjs ./.ii/build.mjs");
      if (hasResources) buildCopyParts.push("COPY .ii/resources.json ./.ii/resources.json");
      if (hasCronJobs) buildCopyParts.push("COPY .ii/cron-jobs.json ./.ii/cron-jobs.json");
      if (hasEvents) buildCopyParts.push("COPY .ii/events.json ./.ii/events.json");
      buildCopyParts.push("RUN node .ii/build.mjs");
    }
    const buildCmd = needsCustomBuild
      ? buildCopyParts.join("\n")
      : "RUN npx tsc --outDir dist";

    const runtimeParts: string[] = [];
    if (hasResources || hasSecrets || hasDapr) {
      runtimeParts.push("COPY .ii/runtime ./.ii/runtime");
    }
    if (hasResources) {
      runtimeParts.push("RUN npm install @valkey/valkey-glide");
    }
    const runtimeLines = runtimeParts.length > 0
      ? runtimeParts.join("\n") + "\n"
      : "";

    const importFlags: string[] = [];
    if (hasDapr) importFlags.push("--import", "./.ii/runtime/ii-server.mjs");
    if (hasSecrets) importFlags.push("--import", "./.ii/runtime/secrets-shim.mjs");

    const cmd = importFlags.length > 0
      ? `CMD ["node", ${importFlags.map((f) => `"${f}"`).join(", ")}, "dist/${jsEntry}"]`
      : `CMD ["node", "dist/${jsEntry}"]`;

    return `FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npm ls typescript >/dev/null 2>&1 || npm install --no-save typescript
COPY . .
${buildCmd}

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
${runtimeLines}EXPOSE ${svc.port}
${cmd}
`;
  }

  // Plain JS — no tsc step, no transformer
  // For JS projects with resources, we'd need a different approach
  // (runtime loader), but for now this only supports TypeScript
  return `FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE ${svc.port}
CMD ${JSON.stringify(startCmd.split(" "))}
`;
}
