import { stringify } from "yaml";
import type { App, Service } from "../ir/index.js";

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

function getSecretNames(app: App): string[] {
  return [...new Set(
    (app.resources ?? [])
      .filter((r) => r.kind === "secret")
      .map((r) => r.name)
  )];
}

function makeDeployment(app: App, svc: Service, hasMaps: boolean, hasSecretResources: boolean, hasCron: boolean): K8sManifest {
  const labels = { app: svc.name };
  const replicas = svc.scale?.min ?? 1;

  const envEntries = svc.env
    ? Object.entries(svc.env).map(([name, value]) => ({ name, value }))
    : [];

  if (hasMaps) {
    envEntries.push({ name: "VALKEY_URL", value: "valkey://valkey:6379" });
  }
  if (hasSecretResources) {
    envEntries.push({ name: "OPENBAO_ADDR", value: "http://openbao:8200" });
    envEntries.push({ name: "OPENBAO_TOKEN", value: "dev-root-token" });
    envEntries.push({ name: "OPENBAO_SECRETS", value: JSON.stringify(getSecretNames(app)) });
  }
  // Note: cron job registration is handled by the CLI at deploy time,
  // not by the app at startup. No DAPR_CRON_JOBS env var needed.

  const env = envEntries.length > 0 ? envEntries : undefined;

  const templateMetadata: Record<string, unknown> = { labels };
  if (hasCron) {
    templateMetadata.annotations = {
      "dapr.io/enabled": "true",
      "dapr.io/app-id": svc.name,
      "dapr.io/app-port": String(svc.port),
    };
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
      type: "state.sqlite",
      version: "v1",
      metadata: [
        { name: "connectionString", value: "/state/ii-state.db" },
      ],
    },
  };
}

export function compileToK8s(app: App): string {
  const manifests: K8sManifest[] = [];
  const hasMaps = hasDurableMaps(app);
  const hasSecretResources = hasSecrets(app);
  const hasCron = hasCronJobs(app);

  for (const svc of app.services) {
    manifests.push(makeDeployment(app, svc, hasMaps, hasSecretResources, hasCron));
    manifests.push(makeService(svc));

    if (svc.ingress?.length) {
      manifests.push(makeHTTPRoute(svc));
    }
  }

  if (hasMaps) {
    manifests.push(makeValkeyDeployment());
    manifests.push(makeValkeyService());
  }

  if (hasSecretResources) {
    manifests.push(makeOpenBaoDeployment());
    manifests.push(makeOpenBaoService());
  }

  if (hasCron) {
    manifests.push(makeDaprStateStoreComponent());
  }

  return manifests.map((m) => stringify(m)).join("---\n");
}
