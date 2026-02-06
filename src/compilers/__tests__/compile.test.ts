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

  it("adds depends_on for openbao", () => {
    const doc = parse(compileToCompose(secretApp));
    expect(doc.services.web.depends_on).toContain("openbao");
  });

  it("does not add valkey when only secrets present", () => {
    const doc = parse(compileToCompose(secretApp));
    expect(doc.services.valkey).toBeUndefined();
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

  it("depends on both valkey and openbao", () => {
    const doc = parse(compileToCompose(mixedApp));
    expect(doc.services.web.depends_on).toContain("valkey");
    expect(doc.services.web.depends_on).toContain("openbao");
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

  it("prunes dev deps after build", () => {
    const dockerfile = compileToDockerfile(remixApp.services[0], "");
    expect(dockerfile).toContain("RUN npm prune --omit=dev");
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

  it("does not inject DAPR_CRON_JOBS env var (reconciliation at deploy time)", () => {
    const doc = parse(compileToCompose(cronApp));
    expect(doc.services.web.environment?.DAPR_CRON_JOBS).toBeUndefined();
  });

  it("exposes Dapr HTTP port for CLI reconciliation", () => {
    const doc = parse(compileToCompose(cronApp));
    expect(doc.services.web.ports).toContain("3500:3500");
  });

  it("Dapr sidecar depends on app and scheduler", () => {
    const doc = parse(compileToCompose(cronApp));
    expect(doc.services["web-dapr"].depends_on).toContain("web");
    expect(doc.services["web-dapr"].depends_on).toContain("dapr-scheduler");
  });

  it("Dapr sidecar mounts components dir and state volume", () => {
    const doc = parse(compileToCompose(cronApp));
    expect(doc.services["web-dapr"].volumes).toContain("./.ii/components:/components");
    expect(doc.services["web-dapr"].volumes).toContain("dapr-state:/state");
  });

  it("Dapr sidecar has -resources-path flag", () => {
    const doc = parse(compileToCompose(cronApp));
    const cmd = doc.services["web-dapr"].command;
    expect(cmd).toContain("-resources-path");
    expect(cmd).toContain("/components");
  });

  it("declares dapr-state named volume", () => {
    const doc = parse(compileToCompose(cronApp));
    expect(doc.volumes).toBeDefined();
    expect(doc.volumes["dapr-state"]).toBeDefined();
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
    expect(annotations["dapr.io/app-port"]).toBe("3000");
  });

  it("does not inject DAPR_CRON_JOBS env var (reconciliation at deploy time)", () => {
    const docs = compileToK8s(cronApp)
      .split("---\n")
      .map((d) => parse(d));

    const webDeploy = docs.find(
      (d) => d.kind === "Deployment" && d.metadata.name === "web"
    );
    const env = webDeploy.spec.template.spec.containers[0].env;
    expect(env).toBeUndefined();
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
    expect(stateStore.spec.type).toBe("state.sqlite");
  });
});

describe("compileToDockerfile with cron jobs", () => {
  it("does not include --import for cron shim (reconciliation at deploy time)", () => {
    const dockerfile = compileToDockerfile(cronApp.services[0], "node index.js", {
      hasCronJobs: true,
    });
    expect(dockerfile).not.toContain("cron-shim.mjs");
  });

  it("copies cron-jobs.json in build stage for transformer", () => {
    const dockerfile = compileToDockerfile(cronApp.services[0], "node index.js", {
      hasCronJobs: true,
    });
    expect(dockerfile).toContain("cron-jobs.json");
    expect(dockerfile).toContain("build.mjs");
  });

  it("includes secrets shim import but not cron shim", () => {
    const dockerfile = compileToDockerfile(cronApp.services[0], "node index.js", {
      hasSecrets: true,
      hasCronJobs: true,
    });
    expect(dockerfile).toContain("secrets-shim.mjs");
    expect(dockerfile).not.toContain("cron-shim.mjs");
  });
});
