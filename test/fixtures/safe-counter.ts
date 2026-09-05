import { createServer } from "node:http";

const counters = new Map<string, number>();

createServer((request, response) => {
  const key = request.url ?? "default";
  const current = counters.get(key) ?? 0;
  counters.set(key, current + 1);
  response.end(String(current + 1));
}).listen(3000);
