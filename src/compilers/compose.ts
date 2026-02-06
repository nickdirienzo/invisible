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
}

interface ComposeFile {
  services: Record<string, ComposeService>;
}

function hasDurableMaps(app: App): boolean {
  return app.resources?.some((r) => r.kind === "durable-map") ?? false;
}

function hasSecrets(app: App): boolean {
  return app.resources?.some((r) => r.kind === "secret") ?? false;
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

  for (const svc of app.services) {
    const composeSvc: ComposeService = {
      build: {
        context: "..",
        dockerfile: ".ii/Dockerfile",
      },
    };

    if (svc.ingress?.length) {
      composeSvc.ports = [`${svc.port}:${svc.port}`];
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

  return stringify(compose);
}
