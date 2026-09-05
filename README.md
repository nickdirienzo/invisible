# Invisible

Invisible explores compiling Node.js programs into one durable logical process,
using the Node standard library as the deployment interface.

This is a focused research prototype. It statically checks which Node.js
semantics it can currently preserve and targets a singleton
[celld](https://github.com/denoland/celld) Durable Object. Module-scope Maps
become synchronous SQLite-backed Maps inside that cell. The source API stays
synchronous, so a read-modify-write sequence does not acquire a remote `await`
boundary.

```text
Node.js source -> eligibility analysis -> compiler -> Worker + AppCell -> celld
```

## The experiment

```ts
import { createServer } from "node:http";

const counters = new Map<string, number>();

createServer((request, response) => {
  const key = request.url ?? "default";
  const current = counters.get(key) ?? 0;
  counters.set(key, current + 1);
  response.end(String(current + 1));
}).listen(3000);
```

Invisible emits:

- a stateless Worker that routes every request to `AppCell:global`;
- one SQLite-backed Durable Object named `AppCell`;
- a narrow `node:http` adapter; and
- synchronous storage implementations for supported module-scope Maps.

The initial runtime experiment sent 500 requests at concurrency 32 and observed the
contiguous sequence 1–500. After 100 acknowledged writes, the celld owner was
terminated with `SIGKILL`; after restart, the next increment returned 101.
See [the experiment notes](docs/validation.md).

## Try it

Requirements:

- Node.js 22 or newer
- celld 0.4.0
- esbuild on `PATH` (required by celld)

```sh
npm install
npm run check
npm run compile:example
celld dev .invisible
```

Then increment a counter:

```sh
curl http://127.0.0.1:9876/example
```

## First implemented slice

The first vertical slice accepts one TypeScript entrypoint containing:

- one direct `node:http` `createServer` import and one `.listen()` server;
- module-scope `Map<string, number | string | boolean>` declarations with no
  initial entries; and
- the supported request/response surface documented in
  [the semantic contract](docs/semantic-contract.md).

The intended source vocabulary is the Node standard library, expanded one
primitive at a time. Today, unsupported imports and Map representations fail
compilation instead of silently changing their behavior.

[Waldo](https://github.com/mirage-security/waldo) owns checks whose outcome
depends on both source behavior and runtime topology. The included unsafe
fixture demonstrates a read-modify-write path that crosses an external `await`,
where celld may interleave another request:

```sh
npm run build
npm run facts:unsafe
waldo check --root . --config waldo.yaml \
  --facts .invisible/waldo-facts.jsonl --json
```

The command intentionally exits 1 with
`state-rmw-across-interleaving-yield`.

## History

The original language- and deployment-target exploration is preserved on the
`v1-research-poc` branch and at the `v1-research-final` tag.
