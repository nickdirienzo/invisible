import type { Service } from "../ir/index.js";

export function compileToDockerfile(svc: Service, startCmd: string): string {
  if (svc.typescript) {
    const jsEntry = svc.entrypoint.replace(/\.ts$/, ".js").replace(/\.mts$/, ".mjs");
    return `FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npx tsc --outDir dist

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE ${svc.port}
CMD ["node", "dist/${jsEntry}"]
`;
  }

  return `FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY . .
EXPOSE ${svc.port}
CMD ${JSON.stringify(startCmd.split(" "))}
`;
}
