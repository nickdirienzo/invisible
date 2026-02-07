import { stringify } from "yaml";
import type { App, Resource, EventEmitterResource, Service } from "../ir/index.js";

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

function resourceBelongsToService(r: Resource, svc: Service, isMultiService: boolean): boolean {
  if (!isMultiService) return true;
  const prefix = svc.build.replace(/^\.\//, "");
  return r.sourceFile.startsWith(prefix + "/");
}

function serviceResources(app: App, svc: Service, isMultiService: boolean): Resource[] {
  return (app.resources ?? []).filter((r) => resourceBelongsToService(r, svc, isMultiService));
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

function getSecretNames(resources: Resource[]): string[] {
  return [...new Set(
    resources
      .filter((r) => r.kind === "secret")
      .map((r) => r.name)
  )];
}

function getEventsManifest(resources: Resource[]): Array<{ namespace: string; events: string[] }> {
  return resources
    .filter((r): r is EventEmitterResource => r.kind === "event-emitter")
    .map((r) => ({ namespace: r.name, events: r.events }));
}

function getCronJobsManifest(resources: Resource[]): Array<{ name: string; endpoint: string; method: string }> {
  return resources
    .filter((r) => r.kind === "cron-job")
    .map((r) => r.kind === "cron-job" ? { name: r.name, endpoint: r.endpoint, method: r.method } : { name: "", endpoint: "", method: "" });
}

export function compileToCompose(app: App): string {
  const compose: ComposeFile = { services: {} };
  const isMultiService = app.services.length > 1;

  // App-level flags for shared infrastructure
  const appHasMaps = hasDurableMaps(app);
  const appHasSecrets = hasSecrets(app);
  const appHasCron = hasCronJobs(app);
  const appHasEvents = hasEventEmitters(app);
  const appHasDapr = appHasCron || appHasEvents;

  for (const svc of app.services) {
    // Per-service resource scoping
    const svcResources = serviceResources(app, svc, isMultiService);
    const svcHasMaps = svcResources.some((r) => r.kind === "durable-map");
    const svcHasSecrets = svcResources.some((r) => r.kind === "secret");
    const svcHasCron = svcResources.some((r) => r.kind === "cron-job");
    const svcHasEvents = svcResources.some((r) => r.kind === "event-emitter");
    const svcHasDapr = svcHasCron || svcHasEvents;

    const dockerfileName = isMultiService
      ? `.ii/Dockerfile.${svc.name}`
      : ".ii/Dockerfile";

    const composeSvc: ComposeService = {
      build: {
        context: "..",
        dockerfile: dockerfileName,
      },
    };

    const ports: string[] = [];
    if (svc.ingress?.length) {
      ports.push(`${svc.port}:${svc.port}`);
    }
    // Expose Dapr HTTP port so the CLI can reconcile jobs at deploy time.
    // The sidecar uses network_mode: service:<app>, so its ports are on the app's network.
    if (svcHasDapr) {
      ports.push("3500:3500");
    }
    if (ports.length > 0) {
      composeSvc.ports = ports;
    }

    const env: Record<string, string> = { ...(svc.env ?? {}) };
    if (svcHasMaps || svcHasEvents) {
      env.VALKEY_URL = "valkey://valkey:6379";
    }
    if (svcHasSecrets) {
      env.OPENBAO_ADDR = "http://openbao:8200";
      env.OPENBAO_TOKEN = "dev-root-token";
      env.OPENBAO_SECRETS = JSON.stringify(getSecretNames(svcResources));
    }
    if (svcHasDapr) {
      env.II_APP_PORT = String(svc.port);
    }
    if (svcHasEvents) {
      env.II_EVENTS_MANIFEST = JSON.stringify(getEventsManifest(svcResources));
    }
    if (svcHasCron) {
      env.II_CRON_JOBS = JSON.stringify(getCronJobsManifest(svcResources));
    }
    if (Object.keys(env).length > 0) {
      composeSvc.environment = env;
    }

    const deps: string[] = [];
    if (svcHasMaps || svcHasEvents) deps.push("valkey");
    if (svcHasSecrets) deps.push("openbao");
    if (deps.length > 0) {
      composeSvc.depends_on = deps;
    }

    compose.services[svc.name] = composeSvc;

    if (svcHasDapr) {
      const sidecarDeps = [svc.name];
      if (svcHasCron) sidecarDeps.push("dapr-scheduler");

      const sidecarVolumes = ["./components:/components"];
      if (svcHasCron) sidecarVolumes.push("dapr-state:/state");

      compose.services[`${svc.name}-dapr`] = {
        image: "daprio/daprd:latest",
        command: [
          "./daprd",
          "-app-id", svc.name,
          "-app-port", "3501",
          "-dapr-http-port", "3500",
          ...(svcHasCron ? ["-scheduler-host-address", "dapr-scheduler:50006"] : []),
          "-resources-path", "/components",
        ],
        network_mode: `service:${svc.name}`,
        depends_on: sidecarDeps,
        volumes: sidecarVolumes,
      };
    }
  }

  if (appHasMaps || appHasEvents) {
    compose.services.valkey = {
      image: "valkey/valkey:8-alpine",
      command: ["valkey-server", "--appendonly", "yes"],
      ports: ["6379:6379"],
      volumes: ["valkey-data:/data"],
    };
  }

  if (appHasSecrets) {
    compose.services.openbao = {
      image: "quay.io/openbao/openbao:latest",
      ports: ["8200:8200"],
      environment: {
        BAO_DEV_ROOT_TOKEN_ID: "dev-root-token",
        BAO_DEV_LISTEN_ADDRESS: "0.0.0.0:8200",
      },
    };
  }

  if (appHasCron) {
    compose.services["dapr-scheduler"] = {
      image: "daprio/dapr:latest",
      command: ["./scheduler", "--port", "50006", "--etcd-data-dir", "/var/lock/dapr/scheduler"],
    };
    compose.services["dapr-placement"] = {
      image: "daprio/dapr:latest",
      command: ["./placement", "--port", "50005"],
    };
  }

  const volumes: Record<string, Record<string, never>> = {};
  if (appHasMaps || appHasEvents) volumes["valkey-data"] = {};
  if (appHasCron) volumes["dapr-state"] = {};
  if (Object.keys(volumes).length > 0) {
    compose.volumes = volumes;
  }

  return stringify(compose);
}
