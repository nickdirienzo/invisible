import { createServer } from "node:http";

const counters = new Map<string, number>();

createServer(async (request, response) => {
  const key = request.url ?? "default";
  const current = counters.get(key) ?? 0;

  // Another cell event can run while this external operation is pending.
  await fetch("https://example.invalid/audit");

  counters.set(key, current + 1);
  response.end(String(current + 1));
}).listen(3000);
