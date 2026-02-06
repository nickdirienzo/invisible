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

export function compileToCompose(app: App): string {
  const compose: ComposeFile = { services: {} };
  const hasResources = (app.resources?.length ?? 0) > 0;

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
    if (hasResources) {
      env.VALKEY_URL = "valkey://valkey:6379";
    }
    if (Object.keys(env).length > 0) {
      composeSvc.environment = env;
    }

    if (hasResources) {
      composeSvc.depends_on = ["valkey"];
    }

    compose.services[svc.name] = composeSvc;
  }

  if (hasResources) {
    compose.services.valkey = {
      image: "valkey/valkey:8-alpine",
      ports: ["6379:6379"],
    };
  }

  return stringify(compose);
}
