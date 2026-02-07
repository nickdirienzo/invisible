import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GenericContainer, Network, Wait } from "testcontainers";
import type { StartedTestContainer, StartedNetwork } from "testcontainers";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AddressInfo } from "node:net";

const EVENTS_MANIFEST = [
  { namespace: "orders", events: ["created", "shipped"] },
];

let network: StartedNetwork;
let valkeyContainer: StartedTestContainer;
let daprContainer: StartedTestContainer;
let iiServer: http.Server;
let mockAppServer: http.Server;
let iiServerPort: number;
let mockAppPort: number;
let daprHttpPort: number;
let cronRequests: Array<{ method: string; url: string }>;

/**
 * Get a free port by briefly listening on port 0.
 */
function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

describe("II Server Integration", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    // 1. Get free ports for in-process servers
    iiServerPort = await getFreePort();
    mockAppPort = await getFreePort();

    // 2. Set environment variables before importing runtime modules
    process.env.II_SERVER_PORT = String(iiServerPort);
    process.env.II_APP_PORT = String(mockAppPort);
    process.env.II_EVENTS_MANIFEST = JSON.stringify(EVENTS_MANIFEST);

    // 3. Create Docker network
    network = await new Network().start();

    // 4. Start Valkey container
    valkeyContainer = await new GenericContainer("valkey/valkey:8-alpine")
      .withNetwork(network)
      .withNetworkAliases("valkey")
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
      .start();

    // 5. Import II server (starts listening on iiServerPort)
    await import("../ii-server.mjs");

    // 6. Start mock app server (for cron job proxying)
    cronRequests = [];
    mockAppServer = http.createServer((req, res) => {
      cronRequests.push({ method: req.method!, url: req.url! });
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => {
      mockAppServer.listen(mockAppPort, () => resolve());
    });

    // 7. Write pubsub component YAML to temp dir
    const componentDir = mkdtempSync(join(tmpdir(), "ii-dapr-"));
    mkdirSync(componentDir, { recursive: true });
    writeFileSync(
      join(componentDir, "pubsub.yaml"),
      `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: ii-pubsub
spec:
  type: pubsub.redis
  version: v1
  metadata:
  - name: redisHost
    value: valkey:6379
`
    );

    // 8. Start Dapr sidecar
    daprContainer = await new GenericContainer("daprio/daprd:latest")
      .withNetwork(network)
      .withExtraHosts([{ host: "host.testcontainers.internal", ipAddress: "host-gateway" }])
      .withExposedPorts(3500)
      .withBindMounts([{ source: componentDir, target: "/components", mode: "ro" }])
      .withCommand([
        "./daprd",
        "-app-id", "test-app",
        "-app-port", String(iiServerPort),
        "-app-protocol", "http",
        "-app-channel-address", "host.testcontainers.internal",
        "-dapr-http-port", "3500",
        "-resources-path", "/components",
      ])
      .withWaitStrategy(Wait.forHttp("/v1.0/healthz", 3500))
      .withStartupTimeout(60_000)
      .start();

    daprHttpPort = daprContainer.getMappedPort(3500);

    // 9. Set DAPR_HTTP_PORT for DistributedEventEmitter to publish to
    process.env.DAPR_HTTP_PORT = String(daprHttpPort);

    // 10. Import DistributedEventEmitter
    await import("../distributed-events.mjs");

    // Give Dapr a moment to discover subscriptions
    await new Promise((r) => setTimeout(r, 2000));
  });

  afterAll(async () => {
    if (daprContainer) await daprContainer.stop();
    if (mockAppServer) await new Promise<void>((resolve) => mockAppServer.close(() => resolve()));
    const server = (globalThis as any).__ii_server as http.Server | undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (valkeyContainer) await valkeyContainer.stop();
    if (network) await network.stop();
  });

  beforeEach(() => {
    // Clear emitter registry between tests to avoid cross-test pollution
    (globalThis as any).__ii_event_emitters = [];
    cronRequests = [];
  });

  it("GET /dapr/subscribe returns subscription list", async () => {
    const res = await fetch(`http://localhost:${iiServerPort}/dapr/subscribe`);
    const subs = await res.json();
    expect(subs).toHaveLength(2);
    expect(subs[0]).toMatchObject({
      pubsubname: "ii-pubsub",
      topic: "orders.created",
      route: "/ii/events/orders/created",
    });
    expect(subs[1]).toMatchObject({
      pubsubname: "ii-pubsub",
      topic: "orders.shipped",
      route: "/ii/events/orders/shipped",
    });
  });

  it("POST /ii/events delivers to handler directly", async () => {
    const { DistributedEventEmitter } = await import("../distributed-events.mjs");
    const emitter = new DistributedEventEmitter("orders");

    const received = new Promise<any>((resolve) => {
      emitter.on("created", (data: any) => resolve(data));
    });

    await fetch(`http://localhost:${iiServerPort}/ii/events/orders/created`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { args: [{ orderId: 1 }] } }),
    });

    const data = await received;
    expect(data).toEqual({ orderId: 1 });
  });

  it("returns DROP for malformed payload", async () => {
    const res = await fetch(
      `http://localhost:${iiServerPort}/ii/events/orders/created`,
      {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not-json{{{",
      }
    );
    const body = await res.json();
    expect(body.status).toBe("DROP");
  });

  it("full pub/sub round-trip through Dapr", async () => {
    const { DistributedEventEmitter } = await import("../distributed-events.mjs");
    const emitter = new DistributedEventEmitter("orders");

    const received = new Promise<any>((resolve) => {
      emitter.on("shipped", (data: any) => resolve(data));
    });

    await emitter.emit("shipped", { orderId: 42 });

    const data = await Promise.race([
      received,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for event delivery")), 15_000)
      ),
    ]);
    expect(data).toEqual({ orderId: 42 });
  });

  it("once() handler fires exactly once", async () => {
    const { DistributedEventEmitter } = await import("../distributed-events.mjs");
    const emitter = new DistributedEventEmitter("orders");

    let callCount = 0;
    emitter.once("created", () => {
      callCount++;
    });

    // Deliver twice directly
    for (let i = 0; i < 2; i++) {
      await fetch(`http://localhost:${iiServerPort}/ii/events/orders/created`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { args: [] } }),
      });
    }

    await new Promise((r) => setTimeout(r, 500));
    expect(callCount).toBe(1);
  });

  it("cron job proxies to mock app server", async () => {
    const res = await fetch(
      `http://localhost:${iiServerPort}/ii/jobs/daily-report`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: "/job/daily-report", method: "POST" }),
      }
    );
    const body = await res.json();
    expect(body.status).toBe("SUCCESS");

    // Give the proxy request a moment to arrive
    await new Promise((r) => setTimeout(r, 500));
    expect(cronRequests).toContainEqual({
      method: "POST",
      url: "/job/daily-report",
    });
  });
});
