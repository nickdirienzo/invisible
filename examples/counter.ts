import { createServer } from "node:http";

const counters = new Map<string, number>();

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://invisible");
  const key = url.pathname.slice(1) || "default";
  const current = counters.get(key) ?? 0;
  const next = current + 1;

  counters.set(key, next);
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ key, value: next }));
}).listen(process.env.PORT ? Number(process.env.PORT) : 3000);
