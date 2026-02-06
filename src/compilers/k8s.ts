import { stringify } from "yaml";
import type { App, Service } from "../ir/index.js";

interface K8sManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; labels?: Record<string, string> };
  spec: Record<string, unknown>;
}

function makeDeployment(app: App, svc: Service, hasResources: boolean): K8sManifest {
  const labels = { app: svc.name };
  const replicas = svc.scale?.min ?? 1;

  const envEntries = svc.env
    ? Object.entries(svc.env).map(([name, value]) => ({ name, value }))
    : [];

  if (hasResources) {
    envEntries.push({ name: "VALKEY_URL", value: "valkey://valkey:6379" });
  }

  const env = envEntries.length > 0 ? envEntries : undefined;

  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: svc.name, labels },
    spec: {
      replicas,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
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

export function compileToK8s(app: App): string {
  const manifests: K8sManifest[] = [];
  const hasResources = (app.resources?.length ?? 0) > 0;

  for (const svc of app.services) {
    manifests.push(makeDeployment(app, svc, hasResources));
    manifests.push(makeService(svc));

    if (svc.ingress?.length) {
      manifests.push(makeHTTPRoute(svc));
    }
  }

  if (hasResources) {
    manifests.push(makeValkeyDeployment());
    manifests.push(makeValkeyService());
  }

  return manifests.map((m) => stringify(m)).join("---\n");
}
