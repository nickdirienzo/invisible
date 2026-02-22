import { stringify } from "yaml";
import type { App, Service, EventEmitterResource, CapabilityImportResource } from "../ir/index.js";

// ---------------------------------------------------------------------------
// Engine provisioning config for capability-import resources
// ---------------------------------------------------------------------------

interface EngineK8sConfig {
  name: string;
  image: string;
  port: number;
  connectionUrl: string;
  secretName: string;
  env?: Array<{ name: string; value: string }>;
}

const ENGINE_K8S: Record<string, EngineK8sConfig> = {
  postgres: {
    name: "postgres",
    image: "postgres:17-alpine",
    port: 5432,
    connectionUrl: "postgres://postgres:postgres@postgres:5432/app",
    secretName: "DATABASE_URL",
    env: [
      { name: "POSTGRES_USER", value: "postgres" },
      { name: "POSTGRES_PASSWORD", value: "postgres" },
      { name: "POSTGRES_DB", value: "app" },
    ],
  },
  mysql: {
    name: "mysql",
    image: "mysql:8",
    port: 3306,
    connectionUrl: "mysql://root:root@mysql:3306/app",
    secretName: "DATABASE_URL",
    env: [
      { name: "MYSQL_ROOT_PASSWORD", value: "root" },
      { name: "MYSQL_DATABASE", value: "app" },
    ],
  },
  mongodb: {
    name: "mongodb",
    image: "mongo:7",
    port: 27017,
    connectionUrl: "mongodb://mongodb:27017/app",
    secretName: "MONGODB_URL",
  },
  valkey: {
    name: "valkey",
    image: "valkey/valkey:8-alpine",
    port: 6379,
    connectionUrl: "redis://valkey:6379",
    secretName: "REDIS_URL",
  },
};

interface K8sManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; labels?: Record<string, string> };
  spec: Record<string, unknown>;
}

function hasDurableMaps(app: App): boolean {
  return app.resources?.some((r) => r.kind === "durable-map") ?? false;
}

function hasSecrets(app: App): boolean {
  return app.resources?.some((r) => r.kind === "secret") ?? false;
}

function hasCronJobs(app: App): boolean {
  return app.resources?.some((r) => r.kind === "cron-job") ?? false;
}

function hasEventEmitters(app: App): boolean {
  return app.resources?.some((r) => r.kind === "event-emitter") ?? false;
}

function getSecretNames(app: App): string[] {
  return [...new Set(
    (app.resources ?? [])
      .filter((r) => r.kind === "secret")
      .map((r) => r.name)
  )];
}

function getEventsManifest(app: App): Array<{ namespace: string; events: string[] }> {
  return (app.resources ?? [])
    .filter((r): r is EventEmitterResource => r.kind === "event-emitter")
    .map((r) => ({ namespace: r.name, events: r.events }));
}

function getCronJobsManifest(app: App): Array<{ name: string; endpoint: string; method: string }> {
  return (app.resources ?? [])
    .filter((r) => r.kind === "cron-job")
    .map((r) => r.kind === "cron-job" ? { name: r.name, endpoint: r.endpoint, method: r.method } : { name: "", endpoint: "", method: "" });
}

function makeDeployment(app: App, svc: Service, hasMaps: boolean, hasSecretResources: boolean, hasDapr: boolean, hasCron: boolean, hasEvents: boolean): K8sManifest {
  const labels = { app: svc.name };
  const replicas = svc.scale?.min ?? 1;

  const envEntries = svc.env
    ? Object.entries(svc.env).map(([name, value]) => ({ name, value }))
    : [];

  if (hasMaps || hasEvents) {
    envEntries.push({ name: "VALKEY_URL", value: "valkey://valkey:6379" });
  }
  if (hasSecretResources) {
    envEntries.push({ name: "OPENBAO_ADDR", value: "http://openbao:8200" });
    envEntries.push({ name: "OPENBAO_TOKEN", value: "dev-root-token" });
    envEntries.push({ name: "OPENBAO_SECRETS", value: JSON.stringify(getSecretNames(app)) });
  }
  if (hasDapr) {
    envEntries.push({ name: "II_APP_PORT", value: String(svc.port) });
  }
  if (hasEvents) {
    envEntries.push({ name: "II_EVENTS_MANIFEST", value: JSON.stringify(getEventsManifest(app)) });
  }
  if (hasCron) {
    envEntries.push({ name: "II_CRON_JOBS", value: JSON.stringify(getCronJobsManifest(app)) });
  }

  const env = envEntries.length > 0 ? envEntries : undefined;

  const templateMetadata: Record<string, unknown> = { labels };
  if (hasDapr) {
    templateMetadata.annotations = {
      "dapr.io/enabled": "true",
      "dapr.io/app-id": svc.name,
      "dapr.io/app-port": "3501",
    };
  }

  const initContainers: Record<string, unknown>[] = [];
  if (hasSecretResources) {
    const seeds = getSecretSeeds(app);
    const initEnv = [
      { name: "OPENBAO_ADDR", value: "http://openbao:8200" },
      { name: "OPENBAO_TOKEN", value: "dev-root-token" },
      { name: "OPENBAO_SECRETS", value: JSON.stringify(getSecretNames(app)) },
    ];
    if (Object.keys(seeds).length > 0) {
      initEnv.push({ name: "II_SECRET_SEEDS", value: JSON.stringify(seeds) });
    }
    initContainers.push({
      name: "vault-init",
      image: "node:22-slim",
      command: ["node", "/app/vault-seed.mjs"],
      env: initEnv,
    });
  }

  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: svc.name, labels },
    spec: {
      replicas,
      selector: { matchLabels: labels },
      template: {
        metadata: templateMetadata,
        spec: {
          ...(initContainers.length > 0 ? { initContainers } : {}),
          containers: [
            {
              name: svc.name,
              image: `${app.name}/${svc.name}`,
              ports: [{ containerPort: svc.port }],
              ...(env ? { env } : {}),
            },
          ],
        },
      },
    },
  };
}

function makeService(svc: Service): K8sManifest {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: svc.name },
    spec: {
      selector: { app: svc.name },
      ports: [{ port: 80, targetPort: svc.port }],
    },
  };
}

function makeHTTPRoute(svc: Service): K8sManifest {
  const rules = (svc.ingress ?? []).map((rule) => ({
    matches: [
      {
        path: {
          type: "PathPrefix",
          value: rule.path ?? "/",
        },
      },
    ],
    backendRefs: [{ name: svc.name, port: 80 }],
  }));

  const hostnames = (svc.ingress ?? [])
    .map((r) => r.host)
    .filter(Boolean);

  return {
    apiVersion: "gateway.networking.k8s.io/v1",
    kind: "HTTPRoute",
    metadata: { name: `${svc.name}-route` },
    spec: {
      ...(hostnames.length > 0 ? { hostnames } : {}),
      rules,
    },
  };
}

function makeValkeyDeployment(): K8sManifest {
  const labels = { app: "valkey" };
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "valkey", labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          containers: [
            {
              name: "valkey",
              image: "valkey/valkey:8-alpine",
              ports: [{ containerPort: 6379 }],
            },
          ],
        },
      },
    },
  };
}

function makeValkeyService(): K8sManifest {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: "valkey" },
    spec: {
      selector: { app: "valkey" },
      ports: [{ port: 6379, targetPort: 6379 }],
    },
  };
}

function makeOpenBaoDeployment(): K8sManifest {
  const labels = { app: "openbao" };
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "openbao", labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          containers: [
            {
              name: "openbao",
              image: "quay.io/openbao/openbao:latest",
              ports: [{ containerPort: 8200 }],
              env: [
                { name: "BAO_DEV_ROOT_TOKEN_ID", value: "dev-root-token" },
                { name: "BAO_DEV_LISTEN_ADDRESS", value: "0.0.0.0:8200" },
              ],
              args: ["server", "-dev"],
            },
          ],
        },
      },
    },
  };
}

function makeOpenBaoService(): K8sManifest {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: "openbao" },
    spec: {
      selector: { app: "openbao" },
      ports: [{ port: 8200, targetPort: 8200 }],
    },
  };
}

function makeDaprStateStoreComponent(): K8sManifest {
  return {
    apiVersion: "dapr.io/v1alpha1",
    kind: "Component",
    metadata: { name: "ii-state" },
    spec: {
      type: "state.redis",
      version: "v1",
      metadata: [
        { name: "redisHost", value: "valkey:6379" },
      ],
    },
  };
}

/** Collect unique provisioned engines from capability-import resources. */
function getProvisionedEngines(app: App): EngineK8sConfig[] {
  const seen = new Set<string>();
  const engines: EngineK8sConfig[] = [];
  for (const r of (app.resources ?? [])) {
    if (r.kind !== "capability-import") continue;
    const cap = r as CapabilityImportResource;
    if (cap.provisioning !== "replace" || !cap.engine) continue;
    const cfg = ENGINE_K8S[cap.engine];
    if (cfg && !seen.has(cap.engine)) {
      seen.add(cap.engine);
      engines.push(cfg);
    }
  }
  return engines;
}

/** Build II_SECRET_SEEDS: maps secret names to connection strings for provisioned engines. */
function getSecretSeeds(app: App): Record<string, string> {
  const seeds: Record<string, string> = {};
  for (const eng of getProvisionedEngines(app)) {
    seeds[eng.secretName] = eng.connectionUrl;
  }
  return seeds;
}

function makeEngineDeployment(cfg: EngineK8sConfig): K8sManifest {
  const labels = { app: cfg.name };
  const container: Record<string, unknown> = {
    name: cfg.name,
    image: cfg.image,
    ports: [{ containerPort: cfg.port }],
  };
  if (cfg.env) container.env = cfg.env;
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: cfg.name, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          containers: [container],
        },
      },
    },
  };
}

function makeEngineService(cfg: EngineK8sConfig): K8sManifest {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: cfg.name },
    spec: {
      selector: { app: cfg.name },
      ports: [{ port: cfg.port, targetPort: cfg.port }],
    },
  };
}

function makeDaprPubsubComponent(): K8sManifest {
  return {
    apiVersion: "dapr.io/v1alpha1",
    kind: "Component",
    metadata: { name: "ii-pubsub" },
    spec: {
      type: "pubsub.redis",
      version: "v1",
      metadata: [
        { name: "redisHost", value: "valkey:6379" },
      ],
    },
  };
}

export function compileToK8s(app: App): string {
  const manifests: K8sManifest[] = [];
  const hasMaps = hasDurableMaps(app);
  const hasSecretResources = hasSecrets(app);
  const hasCron = hasCronJobs(app);
  const hasEvents = hasEventEmitters(app);
  const hasDapr = hasCron || hasEvents;
  const engines = getProvisionedEngines(app);
  const needsValkey = hasMaps || hasEvents || hasCron || engines.some((e) => e.name === "valkey");

  for (const svc of app.services) {
    manifests.push(makeDeployment(app, svc, hasMaps, hasSecretResources, hasDapr, hasCron, hasEvents));
    manifests.push(makeService(svc));

    if (svc.ingress?.length) {
      manifests.push(makeHTTPRoute(svc));
    }
  }

  if (needsValkey) {
    manifests.push(makeValkeyDeployment());
    manifests.push(makeValkeyService());
  }

  // Database engines provisioned from capability-import resources.
  for (const eng of engines) {
    if (eng.name === "valkey") continue; // handled above
    manifests.push(makeEngineDeployment(eng));
    manifests.push(makeEngineService(eng));
  }

  if (hasSecretResources) {
    manifests.push(makeOpenBaoDeployment());
    manifests.push(makeOpenBaoService());
  }

  if (hasCron) {
    manifests.push(makeDaprStateStoreComponent());
  }

  if (hasEvents) {
    manifests.push(makeDaprPubsubComponent());
  }

  return manifests.map((m) => stringify(m)).join("---\n");
}
