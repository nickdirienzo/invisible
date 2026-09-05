# Runtime experiment notes

Date: 2026-09-04 (America/Los_Angeles)

Pinned inputs:

- celld `v0.4.0`; downloaded GitHub release attestation verified successfully.
- [Waldo](https://github.com/mirage-security/waldo) commit
  `0f3dc293b2188bf71926ce6f0be85a1a4ae15c1a`.
- Node.js `v23.11.0` for the request driver.

## Runtime observation

The compiler transformed `examples/counter.ts` into a stateless Worker,
singleton SQLite-backed `AppCell`, Node HTTP adapter, and synchronous durable
Map.

With celld's local persistent object store:

```json
{"requests":500,"concurrency":32,"unique":500,"min":1,"max":500,"contiguous":true}
```

An unbounded burst above celld's default per-cell in-flight limit produced a
503. Repeating the experiment with bounded concurrency made the admission boundary
explicit and produced no lost increments.

## Owner failure observation

The generated application acknowledged 100 contiguous increments for a fresh
key. Its celld node process was then terminated with `SIGKILL`. After starting
celld against the same state directory, the next increment returned:

```json
{"key":"failure","value":101}
```

This is evidence for the narrow local-development recovery path exercised by
the spike. It does not validate a multi-node fleet or substitute for celld's
object-store, fencing, and fault-injection tests.

## Waldo observation

Invisible's analyzer inspected `test/fixtures/unsafe-counter.ts` and emitted
one `state-rmw-across-yield` fact. Waldo joined it with the celld deployment
model and returned exit status 1:

```json
{
  "policyId": "state-rmw-across-interleaving-yield",
  "severity": "error",
  "disposition": "unresolved",
  "deploymentUnit": "app-cell"
}
```

The safe counter fixture emits no such fact because its read-modify-write
sequence contains no external await.
