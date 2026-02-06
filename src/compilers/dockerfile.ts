import type { Service } from "../ir/index.js";

export interface DockerfileOptions {
  /** When true, the build uses .ii/build.mjs instead of plain tsc */
  hasResources?: boolean;
  /** When true, copies secrets shim and uses --import to load it before app */
  hasSecrets?: boolean;
}

export function compileToDockerfile(
  svc: Service,
  startCmd: string,
  options?: DockerfileOptions
): string {
  const hasResources = !!options?.hasResources;
  const hasSecrets = !!options?.hasSecrets;

  // Framework apps (Remix, Next, etc.) — use the framework's own build & start
  if (svc.startCmd && svc.buildCmd) {
    return `FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
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
    const buildCmd = hasResources
      ? `COPY .ii/build.mjs ./.ii/build.mjs
COPY .ii/resources.json ./.ii/resources.json
RUN node .ii/build.mjs`
      : "RUN npx tsc --outDir dist";

    const runtimeParts: string[] = [];
    if (hasResources || hasSecrets) {
      runtimeParts.push("COPY .ii/runtime ./.ii/runtime");
    }
    if (hasResources) {
      runtimeParts.push("RUN npm install @valkey/valkey-glide");
    }
    const runtimeLines = runtimeParts.length > 0
      ? runtimeParts.join("\n") + "\n"
      : "";

    const cmd = hasSecrets
      ? `CMD ["node", "--import", "./.ii/runtime/secrets-shim.mjs", "dist/${jsEntry}"]`
      : `CMD ["node", "dist/${jsEntry}"]`;

    return `FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
${buildCmd}

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
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
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY . .
EXPOSE ${svc.port}
CMD ${JSON.stringify(startCmd.split(" "))}
`;
}
