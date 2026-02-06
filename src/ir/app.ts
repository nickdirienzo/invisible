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

export type Resource = DurableMapResource | SecretResource;
