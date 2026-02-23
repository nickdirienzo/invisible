import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import type { App } from "../../ir/index.js";
import { compileToCompose } from "../compose.js";
import { compileToDockerfile } from "../dockerfile.js";
import { compileToK8s } from "../k8s.js";

const helloWorld: App = {
  name: "hello-world",
  services: [
    {
      name: "web",
      build: "./",
      port: 3000,
      entrypoint: "index.ts",
      typescript: true,
      ingress: [{ host: "hello.example.com", path: "/" }],
      scale: { min: 1, max: 3 },
      env: { NODE_ENV: "production" },
    },
  ],
};

describe("compileToCompose", () => {
  it("produces a valid compose file with service, ports, and env", () => {
    const output = compileToCompose(helloWorld);
    const doc = parse(output);

    expect(doc.services.web).toBeDefined();
    expect(doc.services.web.build).toEqual({ context: "..", dockerfile: ".ii/Dockerfile" });
    expect(doc.services.web.ports).toEqual(["3000:3000"]);
    expect(doc.services.web.environment).toEqual({ NODE_ENV: "production" });
  });

  it("omits ports when no ingress rules", () => {
    const app: App = {
      name: "worker",
      services: [{ name: "bg", build: "./worker", port: 8080, entrypoint: "worker.js", typescript: false }],
    };
    const doc = parse(compileToCompose(app));

    expect(doc.services.bg.ports).toBeUndefined();
  });
});

describe("compileToK8s", () => {
  it("produces Deployment, Service, and HTTPRoute", () => {
    const output = compileToK8s(helloWorld);
    const docs = output.split("---\n").map((d) => parse(d));

    expect(docs).toHaveLength(3);

    const [deployment, service, route] = docs;

    expect(deployment.kind).toBe("Deployment");
    expect(deployment.spec.replicas).toBe(1);
    expect(deployment.spec.template.spec.containers[0].image).toBe(
      "hello-world/web"
    );
    expect(deployment.spec.template.spec.containers[0].env).toEqual([
      { name: "NODE_ENV", value: "production" },
    ]);

    expect(service.kind).toBe("Service");
    expect(service.spec.ports[0].targetPort).toBe(3000);

    expect(route.kind).toBe("HTTPRoute");
    expect(route.spec.hostnames).toEqual(["hello.example.com"]);
  });

  it("omits HTTPRoute when no ingress", () => {
    const app: App = {
      name: "worker",
      services: [{ name: "bg", build: "./worker", port: 8080, entrypoint: "worker.js", typescript: false }],
    };
    const docs = compileToK8s(app)
      .split("---\n")
      .map((d) => parse(d));

    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.kind)).toEqual(["Deployment", "Service"]);
  });
});

const counterApp: App = {
  name: "counter-app",
  services: [
    {
      name: "web",
      build: "./",
      port: 3000,
      entrypoint: "index.ts",
      typescript: true,
      ingress: [{ host: "", path: "/" }],
    },
  ],
  resources: [
    { kind: "durable-map", name: "counters", sourceFile: "index.ts" },
  ],
};

describe("compileToCompose with resources", () => {
  it("adds valkey service when durable maps present", () => {
    const doc = parse(compileToCompose(counterApp));
    expect(doc.services.valkey).toBeDefined();
    expect(doc.services.valkey.image).toBe("valkey/valkey:8-alpine");
  });

  it("injects VALKEY_URL into app service", () => {
    const doc = parse(compileToCompose(counterApp));
    expect(doc.services.web.environment.VALKEY_URL).toBe("valkey://valkey:6379");
  });

  it("adds depends_on for valkey", () => {
    const doc = parse(compileToCompose(counterApp));
    expect(doc.services.web.depends_on).toContain("valkey");
  });
});

describe("compileToK8s with resources", () => {
  it("adds Valkey Deployment and Service", () => {
    const docs = compileToK8s(counterApp)
      .split("---\n")
      .map((d) => parse(d));

    const valkeyDeploy = docs.find(
      (d) => d.kind === "Deployment" && d.metadata.name === "valkey"
    );
    expect(valkeyDeploy).toBeDefined();
    expect(
      valkeyDeploy.spec.template.spec.containers[0].image
    ).toBe("valkey/valkey:8-alpine");

    const valkeySvc = docs.find(
      (d) => d.kind === "Service" && d.metadata.name === "valkey"
    );
    expect(valkeySvc).toBeDefined();
    expect(valkeySvc.spec.ports[0].port).toBe(6379);
  });

  it("injects VALKEY_URL env var into app containers", () => {
    const docs = compileToK8s(counterApp)
      .split("---\n")
      .map((d) => parse(d));

    const webDeploy = docs.find(
      (d) => d.kind === "Deployment" && d.metadata.name === "web"
    );
    const env = webDeploy.spec.template.spec.containers[0].env;
    expect(env).toContainEqual({ name: "VALKEY_URL", value: "valkey://valkey:6379" });
  });
});

// ---------------------------------------------------------------------------
// Secret resources (OpenBao)
// ---------------------------------------------------------------------------

const secretApp: App = {
  name: "secret-app",
  services: [
    {
      name: "web",
      build: "./",
      port: 3000,
      entrypoint: "index.ts",
      typescript: true,
      ingress: [{ host: "", path: "/" }],
    },
  ],
  resources: [
    { kind: "secret", name: "STRIPE_API_KEY", sourceFile: "index.ts" },
    { kind: "secret", name: "DATABASE_URL", sourceFile: "index.ts" },
  ],
};

const mixedApp: App = {
  name: "mixed-app",
  services: [
    {
      name: "web",
      build: "./",
      port: 3000,
      entrypoint: "index.ts",
      typescript: true,
      ingress: [{ host: "", path: "/" }],
    },
  ],
  resources: [
    { kind: "durable-map", name: "counters", sourceFile: "index.ts" },
    { kind: "secret", name: "API_KEY", sourceFile: "index.ts" },
  ],
};

describe("compileToCompose with secrets", () => {
  it("adds openbao service when secrets present", () => {
    const doc = parse(compileToCompose(secretApp));
    expect(doc.services.openbao).toBeDefined();
    expect(doc.services.openbao.image).toBe("quay.io/openbao/openbao:latest");
  });

  it("injects OPENBAO_ADDR, OPENBAO_TOKEN, and OPENBAO_SECRETS into app service", () => {
    const doc = parse(compileToCompose(secretApp));
    expect(doc.services.web.environment.OPENBAO_ADDR).toBe("http://openbao:8200");
    expect(doc.services.web.environment.OPENBAO_TOKEN).toBe("dev-root-token");
    const secrets = JSON.parse(doc.services.web.environment.OPENBAO_SECRETS);
    expect(secrets).toEqual(["STRIPE_API_KEY", "DATABASE_URL"]);
  });

  it("adds depends_on for vault-init", () => {
    const doc = parse(compileToCompose(secretApp));
    expect(doc.services.web.depends_on).toContain("vault-init");
  });

  it("adds vault-init service that depends on openbao", () => {
    const doc = parse(compileToCompose(secretApp));
    expect(doc.services["vault-init"]).toBeDefined();
    expect(doc.services["vault-init"].depends_on).toContain("openbao");
    expect(doc.services["vault-init"].environment.OPENBAO_ADDR).toBe("http://openbao:8200");
  });

  it("does not inject II_SECRET_SEEDS into app service", () => {
    const doc = parse(compileToCompose(secretApp));
    expect(doc.services.web.environment.II_SECRET_SEEDS).toBeUndefined();
  });

  it("does not add valkey when only secrets present", () => {
    const doc = parse(compileToCompose(secretApp));
    expect(doc.services.valkey).toBeUndefined();
  });
});

describe("compileToCompose with envSeeds", () => {
  it("seeds user-provided secret values via II_SECRET_SEEDS", () => {
    const envSeeds = { STRIPE_API_KEY: "sk_test_123", DATABASE_URL: "postgres://localhost/mydb" };
    const doc = parse(compileToCompose(secretApp, envSeeds));
    const seeds = JSON.parse(doc.services["vault-init"].environment.II_SECRET_SEEDS);
    expect(seeds.STRIPE_API_KEY).toBe("sk_test_123");
    expect(seeds.DATABASE_URL).toBe("postgres://localhost/mydb");
  });

  it("engine seeds are overridden by envSeeds", () => {
    const envSeeds = { DATABASE_URL: "postgres://custom:5432/mydb" };
    const doc = parse(compileToCompose(capabilityApp, envSeeds));
    const seeds = JSON.parse(doc.services["vault-init"].environment.II_SECRET_SEEDS);
    expect(seeds.DATABASE_URL).toBe("postgres://custom:5432/mydb");
  });

  it("produces II_SECRET_SEEDS even without engine seeds", () => {
    const envSeeds = { STRIPE_API_KEY: "sk_live_abc" };
    const doc = parse(compileToCompose(secretApp, envSeeds));
    const seeds = JSON.parse(doc.services["vault-init"].environment.II_SECRET_SEEDS);
    expect(seeds.STRIPE_API_KEY).toBe("sk_live_abc");
  });
});

describe("compileToCompose with mixed resources", () => {
  it("adds both valkey and openbao services", () => {
    const doc = parse(compileToCompose(mixedApp));
    expect(doc.services.valkey).toBeDefined();
    expect(doc.services.openbao).toBeDefined();
  });

  it("injects both VALKEY_URL and OPENBAO_ADDR", () => {
    const doc = parse(compileToCompose(mixedApp));
    expect(doc.services.web.environment.VALKEY_URL).toBe("valkey://valkey:6379");
    expect(doc.services.web.environment.OPENBAO_ADDR).toBe("http://openbao:8200");
  });

  it("depends on both valkey and vault-init", () => {
    const doc = parse(compileToCompose(mixedApp));
    expect(doc.services.web.depends_on).toContain("valkey");
    expect(doc.services.web.depends_on).toContain("vault-init");
  });
});

// ---------------------------------------------------------------------------
// Framework Dockerfile compilation
// ---------------------------------------------------------------------------

const remixApp: App = {
  name: "remix-app",
  services: [
    {
      name: "web",
      build: "./",
      port: 3000,
      entrypoint: "app/root.tsx",
      typescript: true,
      ingress: [{ host: "", path: "/" }],
      startCmd: "remix-serve ./build/server/index.js",
      buildCmd: "remix vite:build",
    },
  ],
};

describe("compileToDockerfile with framework app", () => {
  it("uses npm run build and framework start command", () => {
    const dockerfile = compileToDockerfile(remixApp.services[0], "");
    expect(dockerfile).toContain("RUN npm run build");
    expect(dockerfile).toContain('CMD ["npm", "run", "start"]');
    expect(dockerfile).toContain("EXPOSE 3000");
  });

  it("does not prune dev deps (start script may need them)", () => {
    const dockerfile = compileToDockerfile(remixApp.services[0], "");
    expect(dockerfile).not.toContain("npm prune");
  });

  it("does not use tsc or multi-stage build", () => {
    const dockerfile = compileToDockerfile(remixApp.services[0], "");
    expect(dockerfile).not.toContain("tsc");
    expect(dockerfile).not.toContain("AS build");
  });
});

describe("compileToK8s with secrets", () => {
  it("adds OpenBao Deployment and Service", () => {
    const docs = compileToK8s(secretApp)
      .split("---\n")
      .map((d) => parse(d));

    const baoDeploy = docs.find(
      (d) => d.kind === "Deployment" && d.metadata.name === "openbao"
    );
    expect(baoDeploy).toBeDefined();
    expect(baoDeploy.spec.template.spec.containers[0].image).toBe(
      "quay.io/openbao/openbao:latest"
    );

    const baoSvc = docs.find(
      (d) => d.kind === "Service" && d.metadata.name === "openbao"
    );
    expect(baoSvc).toBeDefined();
    expect(baoSvc.spec.ports[0].port).toBe(8200);
  });

  it("injects OPENBAO_ADDR, OPENBAO_TOKEN, and OPENBAO_SECRETS into app containers", () => {
    const docs = compileToK8s(secretApp)
      .split("---\n")
      .map((d) => parse(d));

    const webDeploy = docs.find(
      (d) => d.kind === "Deployment" && d.metadata.name === "web"
    );
    const env = webDeploy.spec.template.spec.containers[0].env;
    expect(env).toContainEqual({ name: "OPENBAO_ADDR", value: "http://openbao:8200" });
    expect(env).toContainEqual({ name: "OPENBAO_TOKEN", value: "dev-root-token" });
    const secretsEntry = env.find((e: { name: string }) => e.name === "OPENBAO_SECRETS");
    expect(secretsEntry).toBeDefined();
    expect(JSON.parse(secretsEntry.value)).toEqual(["STRIPE_API_KEY", "DATABASE_URL"]);
  });

  it("does not add Valkey when only secrets present", () => {
    const docs = compileToK8s(secretApp)
      .split("---\n")
      .map((d) => parse(d));

    const valkeyDeploy = docs.find(
      (d) => d.kind === "Deployment" && d.metadata.name === "valkey"
    );
    expect(valkeyDeploy).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Static site Dockerfile compilation (nginx)
// ---------------------------------------------------------------------------

const staticApp: App = {
  name: "static-app",
  services: [
    {
      name: "web",
      build: "./",
      port: 80,
      entrypoint: "index.ts",
      typescript: true,
      ingress: [{ host: "", path: "/" }],
      buildCmd: "vite build",
      static: true,
    },
  ],
};

describe("compileToDockerfile with static site", () => {
  it("produces multi-stage build with nginx", () => {
    const dockerfile = compileToDockerfile(staticApp.services[0], "");
    expect(dockerfile).toContain("FROM node:22-slim AS build");
    expect(dockerfile).toContain("RUN npm run build");
    expect(dockerfile).toContain("FROM nginx:alpine");
    expect(dockerfile).toContain("COPY --from=build /app/dist /usr/share/nginx/html");
    expect(dockerfile).toContain("EXPOSE 80");
  });

  it("does not include node CMD or tsc", () => {
    const dockerfile = compileToDockerfile(staticApp.services[0], "");
    expect(dockerfile).not.toContain("CMD [\"node\"");
    expect(dockerfile).not.toContain("CMD [\"npm\"");
    expect(dockerfile).not.toContain("tsc");
  });

  it("uses monorepo copy paths when build is a subdirectory", () => {
    const monoStaticSvc = { ...staticApp.services[0], build: "./web" };
    const dockerfile = compileToDockerfile(monoStaticSvc, "");
    expect(dockerfile).toContain("COPY web/package.json package-lock.json ./");
    expect(dockerfile).toContain("COPY web/ .");
  });
});

describe("compileToCompose with static site", () => {
  it("exposes port 80", () => {
    const doc = parse(compileToCompose(staticApp));
    expect(doc.services.web.ports).toEqual(["80:80"]);
  });
});

// ---------------------------------------------------------------------------
// Cron job resources (Dapr)
// ---------------------------------------------------------------------------

const cronApp: App = {
  name: "cron-app",
  services: [
    {
      name: "web",
      build: "./",
      port: 3000,
      entrypoint: "index.ts",
      typescript: true,
      ingress: [{ host: "", path: "/" }],
    },
  ],
  resources: [
    {
      kind: "cron-job",
      name: "daily-report",
      endpoint: "/job/daily-report",
      method: "POST",
      intervalMs: 86400000,
      sourceFile: "index.ts",
    },
  ],
};

describe("compileToCompose with cron jobs", () => {
  it("adds Dapr sidecar service", () => {
    const doc = parse(compileToCompose(cronApp));
    expect(doc.services["web-dapr"]).toBeDefined();
    expect(doc.services["web-dapr"].image).toBe("daprio/daprd:latest");
    expect(doc.services["web-dapr"].network_mode).toBe("service:web");
  });

  it("adds Dapr scheduler and placement services", () => {
    const doc = parse(compileToCompose(cronApp));
    expect(doc.services["dapr-scheduler"]).toBeDefined();
    expect(doc.services["dapr-scheduler"].image).toBe("daprio/dapr:latest");
    expect(doc.services["dapr-placement"]).toBeDefined();
    expect(doc.services["dapr-placement"].image).toBe("daprio/dapr:latest");
  });

  it("injects II_APP_PORT and II_CRON_JOBS env vars", () => {
    const doc = parse(compileToCompose(cronApp));
    expect(doc.services.web.environment.II_APP_PORT).toBe("3000");
    const cronData = JSON.parse(doc.services.web.environment.II_CRON_JOBS);
    expect(cronData).toEqual([{ name: "daily-report", endpoint: "/job/daily-report", method: "POST" }]);
    expect(doc.services.web.environment?.DAPR_CRON_JOBS).toBeUndefined();
  });

  it("exposes Dapr HTTP port for CLI reconciliation", () => {
    const doc = parse(compileToCompose(cronApp));
    expect(doc.services.web.ports).toContain("3500:3500");
  });

  it("Dapr sidecar uses app-port 3501 (II server)", () => {
    const doc = parse(compileToCompose(cronApp));
    const cmd = doc.services["web-dapr"].command;
    expect(cmd).toContain("-app-port");
    const portIdx = cmd.indexOf("-app-port");
    expect(cmd[portIdx + 1]).toBe("3501");
  });

  it("Dapr sidecar depends on app and scheduler", () => {
    const doc = parse(compileToCompose(cronApp));
    expect(doc.services["web-dapr"].depends_on).toContain("web");
    expect(doc.services["web-dapr"].depends_on).toContain("dapr-scheduler");
  });

  it("Dapr sidecar mounts components dir", () => {
    const doc = parse(compileToCompose(cronApp));
    expect(doc.services["web-dapr"].volumes).toContain("./components:/components");
  });

  it("Dapr sidecar has -resources-path flag", () => {
    const doc = parse(compileToCompose(cronApp));
    const cmd = doc.services["web-dapr"].command;
    expect(cmd).toContain("-resources-path");
    expect(cmd).toContain("/components");
  });
});

describe("compileToK8s with cron jobs", () => {
  it("adds Dapr annotations to Deployment pod template", () => {
    const docs = compileToK8s(cronApp)
      .split("---\n")
      .map((d) => parse(d));

    const webDeploy = docs.find(
      (d) => d.kind === "Deployment" && d.metadata.name === "web"
    );
    const annotations = webDeploy.spec.template.metadata.annotations;
    expect(annotations["dapr.io/enabled"]).toBe("true");
    expect(annotations["dapr.io/app-id"]).toBe("web");
    expect(annotations["dapr.io/app-port"]).toBe("3501");
  });

  it("injects II_APP_PORT and II_CRON_JOBS env vars", () => {
    const docs = compileToK8s(cronApp)
      .split("---\n")
      .map((d) => parse(d));

    const webDeploy = docs.find(
      (d) => d.kind === "Deployment" && d.metadata.name === "web"
    );
    const env = webDeploy.spec.template.spec.containers[0].env;
    expect(env).toContainEqual({ name: "II_APP_PORT", value: "3000" });
    const cronEntry = env.find((e: { name: string }) => e.name === "II_CRON_JOBS");
    expect(cronEntry).toBeDefined();
    const cronData = JSON.parse(cronEntry.value);
    expect(cronData).toEqual([{ name: "daily-report", endpoint: "/job/daily-report", method: "POST" }]);
  });

  it("does not add separate Dapr Deployment", () => {
    const docs = compileToK8s(cronApp)
      .split("---\n")
      .map((d) => parse(d));

    const daprDeploy = docs.find(
      (d) => d.kind === "Deployment" && d.metadata.name === "dapr-scheduler"
    );
    expect(daprDeploy).toBeUndefined();
  });

  it("includes Dapr state store Component for job reconciliation", () => {
    const docs = compileToK8s(cronApp)
      .split("---\n")
      .map((d) => parse(d));

    const stateStore = docs.find(
      (d) => d.kind === "Component" && d.metadata.name === "ii-state"
    );
    expect(stateStore).toBeDefined();
    expect(stateStore.spec.type).toBe("state.redis");
  });
});

describe("compileToDockerfile with rootDir", () => {
  it("strips rootDir prefix from entrypoint in CMD", () => {
    const svc = {
      name: "web",
      build: "./",
      port: 3000,
      entrypoint: "src/server.ts",
      typescript: true,
      rootDir: "src",
    };
    const dockerfile = compileToDockerfile(svc, "node dist/server.js");
    expect(dockerfile).toContain('CMD ["node", "dist/server.js"]');
    expect(dockerfile).not.toContain("dist/src/server.js");
  });

  it("leaves entrypoint alone when no rootDir", () => {
    const svc = {
      name: "web",
      build: "./",
      port: 3000,
      entrypoint: "src/server.ts",
      typescript: true,
    };
    const dockerfile = compileToDockerfile(svc, "node dist/src/server.js");
    expect(dockerfile).toContain('CMD ["node", "dist/src/server.js"]');
  });
});

describe("compileToDockerfile with cron jobs", () => {
  it("includes --import for II server", () => {
    const dockerfile = compileToDockerfile(cronApp.services[0], "node index.js", {
      hasCronJobs: true,
    });
    expect(dockerfile).toContain("ii-server.mjs");
    expect(dockerfile).not.toContain("cron-shim.mjs");
  });

  it("copies resources.json and build.mjs in build stage for transformer", () => {
    const dockerfile = compileToDockerfile(cronApp.services[0], "node index.js", {
      hasCronJobs: true,
    });
    expect(dockerfile).toContain("resources.json");
    expect(dockerfile).toContain("build.mjs");
    expect(dockerfile).toContain("II_SERVICE=web");
  });

  it("copies runtime dir for II server", () => {
    const dockerfile = compileToDockerfile(cronApp.services[0], "node index.js", {
      hasCronJobs: true,
    });
    expect(dockerfile).toContain("COPY .ii/runtime ./.ii/runtime");
  });

  it("includes both II server and secrets shim imports", () => {
    const dockerfile = compileToDockerfile(cronApp.services[0], "node index.js", {
      hasSecrets: true,
      hasCronJobs: true,
    });
    expect(dockerfile).toContain("ii-server.mjs");
    expect(dockerfile).toContain("secrets-shim.mjs");
  });
});

// ---------------------------------------------------------------------------
// Event emitter resources (Dapr pub/sub)
// ---------------------------------------------------------------------------

const eventsApp: App = {
  name: "events-app",
  services: [
    {
      name: "web",
      build: "./",
      port: 3000,
      entrypoint: "index.ts",
      typescript: true,
      ingress: [{ host: "", path: "/" }],
    },
  ],
  resources: [
    {
      kind: "event-emitter",
      name: "orders",
      sourceFile: "index.ts",
      events: ["order:created", "order:shipped"],
    },
  ],
};

describe("compileToCompose with events", () => {
  it("adds Valkey for pub/sub", () => {
    const doc = parse(compileToCompose(eventsApp));
    expect(doc.services.valkey).toBeDefined();
    expect(doc.services.valkey.image).toBe("valkey/valkey:8-alpine");
  });

  it("adds Dapr sidecar with app-port 3501", () => {
    const doc = parse(compileToCompose(eventsApp));
    expect(doc.services["web-dapr"]).toBeDefined();
    const cmd = doc.services["web-dapr"].command;
    expect(cmd).toContain("-app-port");
    const portIdx = cmd.indexOf("-app-port");
    expect(cmd[portIdx + 1]).toBe("3501");
  });

  it("does not add scheduler or placement (events only)", () => {
    const doc = parse(compileToCompose(eventsApp));
    expect(doc.services["dapr-scheduler"]).toBeUndefined();
    expect(doc.services["dapr-placement"]).toBeUndefined();
  });

  it("injects VALKEY_URL, II_APP_PORT, and II_EVENTS_MANIFEST", () => {
    const doc = parse(compileToCompose(eventsApp));
    expect(doc.services.web.environment.VALKEY_URL).toBe("valkey://valkey:6379");
    expect(doc.services.web.environment.II_APP_PORT).toBe("3000");
    const manifest = JSON.parse(doc.services.web.environment.II_EVENTS_MANIFEST);
    expect(manifest).toEqual([{ namespace: "orders", events: ["order:created", "order:shipped"] }]);
  });

  it("depends on valkey", () => {
    const doc = parse(compileToCompose(eventsApp));
    expect(doc.services.web.depends_on).toContain("valkey");
  });
});

describe("compileToK8s with events", () => {
  it("adds Dapr annotations with app-port 3501", () => {
    const docs = compileToK8s(eventsApp)
      .split("---\n")
      .map((d) => parse(d));

    const webDeploy = docs.find(
      (d) => d.kind === "Deployment" && d.metadata.name === "web"
    );
    const annotations = webDeploy.spec.template.metadata.annotations;
    expect(annotations["dapr.io/enabled"]).toBe("true");
    expect(annotations["dapr.io/app-port"]).toBe("3501");
  });

  it("adds Valkey and pub/sub Component", () => {
    const docs = compileToK8s(eventsApp)
      .split("---\n")
      .map((d) => parse(d));

    const valkeyDeploy = docs.find(
      (d) => d.kind === "Deployment" && d.metadata.name === "valkey"
    );
    expect(valkeyDeploy).toBeDefined();

    const pubsub = docs.find(
      (d) => d.kind === "Component" && d.metadata.name === "ii-pubsub"
    );
    expect(pubsub).toBeDefined();
    expect(pubsub.spec.type).toBe("pubsub.redis");
  });

  it("does not add state store Component (events only)", () => {
    const docs = compileToK8s(eventsApp)
      .split("---\n")
      .map((d) => parse(d));

    const stateStore = docs.find(
      (d) => d.kind === "Component" && d.metadata.name === "ii-state"
    );
    expect(stateStore).toBeUndefined();
  });

  it("injects events env vars", () => {
    const docs = compileToK8s(eventsApp)
      .split("---\n")
      .map((d) => parse(d));

    const webDeploy = docs.find(
      (d) => d.kind === "Deployment" && d.metadata.name === "web"
    );
    const env = webDeploy.spec.template.spec.containers[0].env;
    expect(env).toContainEqual({ name: "VALKEY_URL", value: "valkey://valkey:6379" });
    expect(env).toContainEqual({ name: "II_APP_PORT", value: "3000" });
    const eventsEntry = env.find((e: { name: string }) => e.name === "II_EVENTS_MANIFEST");
    expect(eventsEntry).toBeDefined();
  });
});

describe("compileToDockerfile with events", () => {
  it("includes --import for II server", () => {
    const dockerfile = compileToDockerfile(eventsApp.services[0], "node index.js", {
      hasEvents: true,
    });
    expect(dockerfile).toContain("ii-server.mjs");
  });

  it("copies resources.json and build.mjs in build stage", () => {
    const dockerfile = compileToDockerfile(eventsApp.services[0], "node index.js", {
      hasEvents: true,
    });
    expect(dockerfile).toContain("resources.json");
    expect(dockerfile).toContain("build.mjs");
    expect(dockerfile).toContain("II_SERVICE=web");
  });

  it("copies runtime dir", () => {
    const dockerfile = compileToDockerfile(eventsApp.services[0], "node index.js", {
      hasEvents: true,
    });
    expect(dockerfile).toContain("COPY .ii/runtime ./.ii/runtime");
  });
});

// ---------------------------------------------------------------------------
// Mixed cron + events
// ---------------------------------------------------------------------------

const mixedDaprApp: App = {
  name: "mixed-dapr",
  services: [
    {
      name: "web",
      build: "./",
      port: 3000,
      entrypoint: "index.ts",
      typescript: true,
      ingress: [{ host: "", path: "/" }],
    },
  ],
  resources: [
    {
      kind: "cron-job",
      name: "cleanup",
      endpoint: "/cleanup",
      method: "POST",
      intervalMs: 3600000,
      sourceFile: "index.ts",
    },
    {
      kind: "event-emitter",
      name: "bus",
      sourceFile: "index.ts",
      events: ["notify"],
    },
  ],
};

describe("compileToCompose with cron + events", () => {
  it("has single Valkey, single Dapr sidecar", () => {
    const doc = parse(compileToCompose(mixedDaprApp));
    expect(doc.services.valkey).toBeDefined();
    expect(doc.services["web-dapr"]).toBeDefined();
  });

  it("has scheduler for cron", () => {
    const doc = parse(compileToCompose(mixedDaprApp));
    expect(doc.services["dapr-scheduler"]).toBeDefined();
  });

  it("injects all Dapr env vars", () => {
    const doc = parse(compileToCompose(mixedDaprApp));
    expect(doc.services.web.environment.II_APP_PORT).toBe("3000");
    expect(doc.services.web.environment.II_CRON_JOBS).toBeDefined();
    expect(doc.services.web.environment.II_EVENTS_MANIFEST).toBeDefined();
    expect(doc.services.web.environment.VALKEY_URL).toBe("valkey://valkey:6379");
  });
});

// ---------------------------------------------------------------------------
// Capability-import resources (database provisioning)
// ---------------------------------------------------------------------------

const capabilityApp: App = {
  name: "capability-app",
  services: [
    {
      name: "web",
      build: "./",
      port: 3000,
      entrypoint: "index.ts",
      typescript: true,
      ingress: [{ host: "", path: "/" }],
    },
  ],
  resources: [
    {
      kind: "capability-import",
      module: "pg",
      capability: "relational",
      engine: "postgres",
      provisioning: "replace",
      sourceFile: "index.ts",
      name: "postgres",
    },
    {
      kind: "capability-import",
      module: "redis",
      capability: "kv",
      engine: "valkey",
      provisioning: "replace",
      sourceFile: "index.ts",
      name: "valkey",
    },
    { kind: "secret", name: "DATABASE_URL", sourceFile: "index.ts" },
    { kind: "secret", name: "REDIS_URL", sourceFile: "index.ts" },
  ],
};

describe("compileToCompose with capability imports", () => {
  it("adds postgres service", () => {
    const doc = parse(compileToCompose(capabilityApp));
    expect(doc.services.postgres).toBeDefined();
    expect(doc.services.postgres.image).toBe("postgres:17-alpine");
    expect(doc.services.postgres.ports).toEqual(["5432:5432"]);
    expect(doc.services.postgres.environment).toEqual({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "app",
    });
  });

  it("adds valkey service for kv capability", () => {
    const doc = parse(compileToCompose(capabilityApp));
    expect(doc.services.valkey).toBeDefined();
    expect(doc.services.valkey.image).toBe("valkey/valkey:8-alpine");
  });

  it("injects OPENBAO_SECRETS with DATABASE_URL and REDIS_URL", () => {
    const doc = parse(compileToCompose(capabilityApp));
    const secrets = JSON.parse(doc.services.web.environment.OPENBAO_SECRETS);
    expect(secrets).toEqual(["DATABASE_URL", "REDIS_URL"]);
  });

  it("puts II_SECRET_SEEDS on vault-init, not app service", () => {
    const doc = parse(compileToCompose(capabilityApp));
    expect(doc.services.web.environment.II_SECRET_SEEDS).toBeUndefined();
    const seeds = JSON.parse(doc.services["vault-init"].environment.II_SECRET_SEEDS);
    expect(seeds).toEqual({
      DATABASE_URL: "postgres://postgres:postgres@postgres:5432/app",
      REDIS_URL: "redis://valkey:6379",
    });
  });

  it("depends on postgres, valkey, and vault-init", () => {
    const doc = parse(compileToCompose(capabilityApp));
    expect(doc.services.web.depends_on).toContain("postgres");
    expect(doc.services.web.depends_on).toContain("valkey");
    expect(doc.services.web.depends_on).toContain("vault-init");
  });

  it("creates volumes for postgres and valkey", () => {
    const doc = parse(compileToCompose(capabilityApp));
    expect(doc.volumes["postgres-data"]).toBeDefined();
    expect(doc.volumes["valkey-data"]).toBeDefined();
  });
});

const capabilityWithOtherSecretsApp: App = {
  name: "mixed-cap-app",
  services: [
    {
      name: "web",
      build: "./",
      port: 3000,
      entrypoint: "index.ts",
      typescript: true,
      ingress: [{ host: "", path: "/" }],
    },
  ],
  resources: [
    {
      kind: "capability-import",
      module: "pg",
      capability: "relational",
      engine: "postgres",
      provisioning: "replace",
      sourceFile: "index.ts",
      name: "postgres",
    },
    { kind: "secret", name: "DATABASE_URL", sourceFile: "index.ts" },
    { kind: "secret", name: "STRIPE_API_KEY", sourceFile: "index.ts" },
  ],
};

describe("compileToCompose with capability imports + other secrets", () => {
  it("OPENBAO_SECRETS includes all secrets", () => {
    const doc = parse(compileToCompose(capabilityWithOtherSecretsApp));
    const secrets = JSON.parse(doc.services.web.environment.OPENBAO_SECRETS);
    expect(secrets).toEqual(["DATABASE_URL", "STRIPE_API_KEY"]);
  });

  it("II_SECRET_SEEDS only on vault-init, only includes engine-managed secrets", () => {
    const doc = parse(compileToCompose(capabilityWithOtherSecretsApp));
    expect(doc.services.web.environment.II_SECRET_SEEDS).toBeUndefined();
    const seeds = JSON.parse(doc.services["vault-init"].environment.II_SECRET_SEEDS);
    expect(seeds).toEqual({
      DATABASE_URL: "postgres://postgres:postgres@postgres:5432/app",
    });
  });
});

describe("compileToK8s with capability imports", () => {
  it("adds postgres Deployment and Service", () => {
    const docs = compileToK8s(capabilityApp)
      .split("---\n")
      .map((d) => parse(d));

    const pgDeploy = docs.find(
      (d) => d.kind === "Deployment" && d.metadata.name === "postgres"
    );
    expect(pgDeploy).toBeDefined();
    expect(pgDeploy.spec.template.spec.containers[0].image).toBe("postgres:17-alpine");

    const pgSvc = docs.find(
      (d) => d.kind === "Service" && d.metadata.name === "postgres"
    );
    expect(pgSvc).toBeDefined();
    expect(pgSvc.spec.ports[0].port).toBe(5432);
  });

  it("adds Valkey Deployment and Service for kv capability", () => {
    const docs = compileToK8s(capabilityApp)
      .split("---\n")
      .map((d) => parse(d));

    const valkeyDeploy = docs.find(
      (d) => d.kind === "Deployment" && d.metadata.name === "valkey"
    );
    expect(valkeyDeploy).toBeDefined();
  });

  it("puts II_SECRET_SEEDS on init container, not app container", () => {
    const docs = compileToK8s(capabilityApp)
      .split("---\n")
      .map((d) => parse(d));

    const webDeploy = docs.find(
      (d) => d.kind === "Deployment" && d.metadata.name === "web"
    );
    const appEnv = webDeploy.spec.template.spec.containers[0].env;
    const appSeedsEntry = appEnv.find((e: { name: string }) => e.name === "II_SECRET_SEEDS");
    expect(appSeedsEntry).toBeUndefined();

    const initContainers = webDeploy.spec.template.spec.initContainers;
    expect(initContainers).toBeDefined();
    expect(initContainers).toHaveLength(1);
    expect(initContainers[0].name).toBe("vault-init");
    const initEnv = initContainers[0].env;
    const seedsEntry = initEnv.find((e: { name: string }) => e.name === "II_SECRET_SEEDS");
    expect(seedsEntry).toBeDefined();
    const seeds = JSON.parse(seedsEntry.value);
    expect(seeds).toEqual({
      DATABASE_URL: "postgres://postgres:postgres@postgres:5432/app",
      REDIS_URL: "redis://valkey:6379",
    });
  });
});

describe("compileToK8s with envSeeds", () => {
  it("merges envSeeds into II_SECRET_SEEDS on init container", () => {
    const envSeeds = { STRIPE_API_KEY: "sk_test_123" };
    const docs = compileToK8s(secretApp, envSeeds)
      .split("---\n")
      .map((d) => parse(d));

    const webDeploy = docs.find(
      (d) => d.kind === "Deployment" && d.metadata.name === "web"
    );
    const initContainers = webDeploy.spec.template.spec.initContainers;
    const initEnv = initContainers[0].env;
    const seedsEntry = initEnv.find((e: { name: string }) => e.name === "II_SECRET_SEEDS");
    expect(seedsEntry).toBeDefined();
    const seeds = JSON.parse(seedsEntry.value);
    expect(seeds.STRIPE_API_KEY).toBe("sk_test_123");
  });

  it("envSeeds override engine-derived seeds", () => {
    const envSeeds = { DATABASE_URL: "postgres://custom/db" };
    const docs = compileToK8s(capabilityApp, envSeeds)
      .split("---\n")
      .map((d) => parse(d));

    const webDeploy = docs.find(
      (d) => d.kind === "Deployment" && d.metadata.name === "web"
    );
    const initContainers = webDeploy.spec.template.spec.initContainers;
    const initEnv = initContainers[0].env;
    const seedsEntry = initEnv.find((e: { name: string }) => e.name === "II_SECRET_SEEDS");
    const seeds = JSON.parse(seedsEntry.value);
    expect(seeds.DATABASE_URL).toBe("postgres://custom/db");
  });
});

const sqliteApp: App = {
  name: "sqlite-app",
  services: [
    {
      name: "web",
      build: "./",
      port: 3000,
      entrypoint: "index.ts",
      typescript: true,
      ingress: [{ host: "", path: "/" }],
    },
  ],
  resources: [
    {
      kind: "capability-import",
      module: "node:sqlite",
      capability: "relational-embedded",
      engine: "sqlite",
      provisioning: "preserve",
      sourceFile: "index.ts",
      name: "sqlite",
    },
    { kind: "secret", name: "DATABASE_PATH", sourceFile: "index.ts" },
  ],
};

describe("compileToCompose with preserve engines (sqlite)", () => {
  it("mounts a named volume on the app service", () => {
    const doc = parse(compileToCompose(sqliteApp));
    expect(doc.services.web.volumes).toContain("sqlite-data:/data");
  });

  it("sets DATABASE_PATH env var on the app service", () => {
    const doc = parse(compileToCompose(sqliteApp));
    expect(doc.services.web.environment.DATABASE_PATH).toBe("/data/app.db");
  });

  it("declares sqlite-data in top-level volumes", () => {
    const doc = parse(compileToCompose(sqliteApp));
    expect(doc.volumes["sqlite-data"]).toBeDefined();
  });

  it("seeds DATABASE_PATH into II_SECRET_SEEDS", () => {
    const doc = parse(compileToCompose(sqliteApp));
    const seeds = JSON.parse(doc.services["vault-init"].environment.II_SECRET_SEEDS);
    expect(seeds.DATABASE_PATH).toBe("/data/app.db");
  });

  it("does not add a separate sqlite service", () => {
    const doc = parse(compileToCompose(sqliteApp));
    expect(doc.services.sqlite).toBeUndefined();
  });
});

describe("compileToK8s with preserve engines (sqlite)", () => {
  it("adds PersistentVolumeClaim for sqlite-data", () => {
    const docs = compileToK8s(sqliteApp)
      .split("---\n")
      .map((d) => parse(d));
    const pvc = docs.find((d) => d.kind === "PersistentVolumeClaim" && d.metadata.name === "sqlite-data");
    expect(pvc).toBeDefined();
    expect(pvc.spec.accessModes).toContain("ReadWriteOnce");
  });

  it("mounts volume on app container", () => {
    const docs = compileToK8s(sqliteApp)
      .split("---\n")
      .map((d) => parse(d));
    const deploy = docs.find((d) => d.kind === "Deployment" && d.metadata.name === "web");
    const container = deploy.spec.template.spec.containers[0];
    expect(container.volumeMounts).toEqual([{ name: "sqlite-data", mountPath: "/data" }]);
  });

  it("adds DATABASE_PATH env var to app container", () => {
    const docs = compileToK8s(sqliteApp)
      .split("---\n")
      .map((d) => parse(d));
    const deploy = docs.find((d) => d.kind === "Deployment" && d.metadata.name === "web");
    const env = deploy.spec.template.spec.containers[0].env;
    const dbPath = env.find((e: { name: string }) => e.name === "DATABASE_PATH");
    expect(dbPath.value).toBe("/data/app.db");
  });

  it("seeds DATABASE_PATH into II_SECRET_SEEDS on init container", () => {
    const docs = compileToK8s(sqliteApp)
      .split("---\n")
      .map((d) => parse(d));
    const deploy = docs.find((d) => d.kind === "Deployment" && d.metadata.name === "web");
    const initEnv = deploy.spec.template.spec.initContainers[0].env;
    const seedsEntry = initEnv.find((e: { name: string }) => e.name === "II_SECRET_SEEDS");
    const seeds = JSON.parse(seedsEntry.value);
    expect(seeds.DATABASE_PATH).toBe("/data/app.db");
  });
});
