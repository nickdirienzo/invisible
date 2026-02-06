import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import type { App } from "../../ir/index.js";
import { compileToCompose } from "../compose.js";
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
