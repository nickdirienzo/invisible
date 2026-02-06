import { stringify } from "yaml";
import type { App } from "../ir/index.js";

interface ComposeService {
  build: string;
  ports?: string[];
  environment?: Record<string, string>;
}

interface ComposeFile {
  services: Record<string, ComposeService>;
}

export function compileToCompose(app: App): string {
  const compose: ComposeFile = { services: {} };

  for (const svc of app.services) {
    const composeSvc: ComposeService = {
      build: svc.build,
    };

    if (svc.ingress?.length) {
      composeSvc.ports = [`${svc.port}:${svc.port}`];
    }

    if (svc.env && Object.keys(svc.env).length > 0) {
      composeSvc.environment = svc.env;
    }

    compose.services[svc.name] = composeSvc;
  }

  return stringify(compose);
}
