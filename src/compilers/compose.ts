import { stringify } from "yaml";
import type { App, EventEmitterResource } from "../ir/index.js";

interface ComposeBuild {
  context: string;
  dockerfile: string;
}

interface ComposeService {
  build?: ComposeBuild;
  image?: string;
  ports?: string[];
  environment?: Record<string, string>;
  depends_on?: string[];
  command?: string[];
  network_mode?: string;
  volumes?: string[];
}

interface ComposeFile {
  services: Record<string, ComposeService>;
  volumes?: Record<string, Record<string, never>>;
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

export function compileToCompose(app: App): string {
  const compose: ComposeFile = { services: {} };
  const hasMaps = hasDurableMaps(app);
  const hasSecretResources = hasSecrets(app);
  const hasCron = hasCronJobs(app);
  const hasEvents = hasEventEmitters(app);
  const hasDapr = hasCron || hasEvents;

  for (const svc of app.services) {
    const composeSvc: ComposeService = {
      build: {
        context: "..",
        dockerfile: ".ii/Dockerfile",
      },
    };

    const ports: string[] = [];
    if (svc.ingress?.length) {
      ports.push(`${svc.port}:${svc.port}`);
    }
    // Expose Dapr HTTP port so the CLI can reconcile jobs at deploy time.
    // The sidecar uses network_mode: service:<app>, so its ports are on the app's network.
    if (hasDapr) {
      ports.push("3500:3500");
    }
    if (ports.length > 0) {
      composeSvc.ports = ports;
    }

    const env: Record<string, string> = { ...(svc.env ?? {}) };
    if (hasMaps || hasEvents) {
      env.VALKEY_URL = "valkey://valkey:6379";
    }
    if (hasSecretResources) {
      env.OPENBAO_ADDR = "http://openbao:8200";
      env.OPENBAO_TOKEN = "dev-root-token";
      env.OPENBAO_SECRETS = JSON.stringify(getSecretNames(app));
    }
    if (hasDapr) {
      env.II_APP_PORT = String(svc.port);
    }
    if (hasEvents) {
      env.II_EVENTS_MANIFEST = JSON.stringify(getEventsManifest(app));
    }
    if (hasCron) {
      env.II_CRON_JOBS = JSON.stringify(getCronJobsManifest(app));
    }
    if (Object.keys(env).length > 0) {
      composeSvc.environment = env;
    }

    const deps: string[] = [];
    if (hasMaps || hasEvents) deps.push("valkey");
    if (hasSecretResources) deps.push("openbao");
    if (deps.length > 0) {
      composeSvc.depends_on = deps;
    }

    compose.services[svc.name] = composeSvc;

    if (hasDapr) {
      const sidecarDeps = [svc.name];
      if (hasCron) sidecarDeps.push("dapr-scheduler");

      const sidecarVolumes = ["./components:/components"];
      if (hasCron) sidecarVolumes.push("dapr-state:/state");

      compose.services[`${svc.name}-dapr`] = {
        image: "daprio/daprd:latest",
        command: [
          "./daprd",
          "-app-id", svc.name,
          "-app-port", "3501",
          "-dapr-http-port", "3500",
          ...(hasCron ? ["-scheduler-host-address", "dapr-scheduler:50006"] : []),
          "-resources-path", "/components",
        ],
        network_mode: `service:${svc.name}`,
        depends_on: sidecarDeps,
        volumes: sidecarVolumes,
      };
    }
  }

  if (hasMaps || hasEvents) {
    compose.services.valkey = {
      image: "valkey/valkey:8-alpine",
      ports: ["6379:6379"],
    };
  }

  if (hasSecretResources) {
    compose.services.openbao = {
      image: "quay.io/openbao/openbao:latest",
      ports: ["8200:8200"],
      environment: {
        BAO_DEV_ROOT_TOKEN_ID: "dev-root-token",
        BAO_DEV_LISTEN_ADDRESS: "0.0.0.0:8200",
      },
    };
  }

  if (hasCron) {
    compose.services["dapr-scheduler"] = {
      image: "daprio/dapr:latest",
      command: ["./scheduler", "--port", "50006", "--etcd-data-dir", "/var/lock/dapr/scheduler"],
    };
    compose.services["dapr-placement"] = {
      image: "daprio/dapr:latest",
      command: ["./placement", "--port", "50005"],
    };
  }

  if (hasCron) {
    compose.volumes = { "dapr-state": {} };
  }

  return stringify(compose);
}
