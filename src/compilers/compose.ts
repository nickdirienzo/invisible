import { stringify } from "yaml";
import type { App } from "../ir/index.js";

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

function getSecretNames(app: App): string[] {
  return [...new Set(
    (app.resources ?? [])
      .filter((r) => r.kind === "secret")
      .map((r) => r.name)
  )];
}

export function compileToCompose(app: App): string {
  const compose: ComposeFile = { services: {} };
  const hasMaps = hasDurableMaps(app);
  const hasSecretResources = hasSecrets(app);
  const hasCron = hasCronJobs(app);

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
    if (hasCron) {
      ports.push("3500:3500");
    }
    if (ports.length > 0) {
      composeSvc.ports = ports;
    }

    const env: Record<string, string> = { ...(svc.env ?? {}) };
    if (hasMaps) {
      env.VALKEY_URL = "valkey://valkey:6379";
    }
    if (hasSecretResources) {
      env.OPENBAO_ADDR = "http://openbao:8200";
      env.OPENBAO_TOKEN = "dev-root-token";
      env.OPENBAO_SECRETS = JSON.stringify(getSecretNames(app));
    }
    // Note: cron job registration is handled by the CLI at deploy time,
    // not by the app at startup. No DAPR_CRON_JOBS env var needed.
    if (Object.keys(env).length > 0) {
      composeSvc.environment = env;
    }

    const deps: string[] = [];
    if (hasMaps) deps.push("valkey");
    if (hasSecretResources) deps.push("openbao");
    if (deps.length > 0) {
      composeSvc.depends_on = deps;
    }

    compose.services[svc.name] = composeSvc;

    if (hasCron) {
      compose.services[`${svc.name}-dapr`] = {
        image: "daprio/daprd:latest",
        command: [
          "./daprd",
          "-app-id", svc.name,
          "-app-port", String(svc.port),
          "-dapr-http-port", "3500",
          "-scheduler-host-address", "dapr-scheduler:50006",
          "-resources-path", "/components",
        ],
        network_mode: `service:${svc.name}`,
        depends_on: [svc.name, "dapr-scheduler"],
        volumes: [
          "./.ii/components:/components",
          "dapr-state:/state",
        ],
      };
    }
  }

  if (hasMaps) {
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
