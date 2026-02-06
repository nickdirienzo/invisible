import type { Service } from "../ir/index.js";

export interface DockerfileOptions {
  /** When true, the build uses .ii/build.mjs instead of plain tsc */
  hasResources?: boolean;
}

export function compileToDockerfile(
  svc: Service,
  startCmd: string,
  options?: DockerfileOptions
): string {
  const hasResources = !!options?.hasResources;

  if (svc.typescript) {
    const jsEntry = svc.entrypoint.replace(/\.ts$/, ".js").replace(/\.mts$/, ".mjs");
    const buildCmd = hasResources
      ? `COPY .ii/build.mjs ./.ii/build.mjs
COPY .ii/resources.json ./.ii/resources.json
RUN node .ii/build.mjs`
      : "RUN npx tsc --outDir dist";

    const runtimeLines = hasResources
      ? `COPY .ii/runtime ./.ii/runtime
RUN npm install @valkey/valkey-glide
`
      : "";

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
CMD ["node", "dist/${jsEntry}"]
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
