// II internal server — runs via node --import before the app starts.
// Provides HTTP endpoints for Dapr to deliver pub/sub messages and cron callbacks.
// No monkey-patching — this is a standalone server on its own port.

import http from "node:http";

const II_PORT = parseInt(process.env.II_SERVER_PORT || "3501", 10);
const APP_PORT = parseInt(process.env.II_APP_PORT || "3000", 10);
const eventsManifest = JSON.parse(process.env.II_EVENTS_MANIFEST || "[]");

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  // GET /dapr/subscribe — programmatic subscription list
  if (req.method === "GET" && req.url === "/dapr/subscribe") {
    const subs = [];
    for (const entry of eventsManifest) {
      for (const event of entry.events) {
        subs.push({
          pubsubname: "ii-pubsub",
          topic: `${entry.namespace}.${event}`,
          route: `/ii/events/${entry.namespace}/${event}`,
        });
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(subs));
    return;
  }

  // POST /ii/events/{namespace}/{event} — pub/sub delivery
  const eventsMatch = req.url?.match(/^\/ii\/events\/([^/]+)\/(.+)$/);
  if (req.method === "POST" && eventsMatch) {
    const [, namespace, event] = eventsMatch;
    const body = await readBody(req);
    try {
      const envelope = JSON.parse(body);
      // Dapr wraps pub/sub payloads in a CloudEvents envelope — unwrap .data
      const payload = envelope.data ?? envelope;
      for (const emitter of (globalThis.__ii_event_emitters || [])) {
        if (emitter._namespace === namespace) {
          emitter._deliver(event, payload);
        }
      }
    } catch (err) {
      console.error("[ii] Failed to deliver event:", err.message);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"DROP"}');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"SUCCESS"}');
    return;
  }

  // POST /job/{name} — Dapr Jobs callback, proxy to app.
  // Dapr delivers triggered jobs to POST /job/<job-name> on the app port.
  // The payload is the `data` field we registered (a JSON string).
  const jobsMatch = req.url?.match(/^\/job\/(.+)$/);
  if (req.method === "POST" && jobsMatch) {
    const body = await readBody(req);
    try {
      // data was registered as JSON.stringify({endpoint, method}), Dapr
      // delivers it as bytes — parse the outer envelope then the inner payload.
      const envelope = JSON.parse(body);
      const payload = typeof envelope === "string" ? JSON.parse(envelope) : envelope;
      const { endpoint, method } = payload;
      await fetch(`http://localhost:${APP_PORT}${endpoint}`, { method: method || "GET" });
    } catch (err) {
      console.error("[ii] Failed to proxy cron job:", err.message);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"SUCCESS"}');
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(II_PORT, () => {
  console.log(`[ii] Internal server listening on :${II_PORT}`);
});

globalThis.__ii_server = server;
