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
    expect(doc.services.web.build).toBe("./");
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
