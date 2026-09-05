# Semantic contract

Invisible uses the Node standard library as its source vocabulary. Each API is
admitted only after the compiler can preserve its relevant semantics on celld;
other uses fail closed until that support exists.

Pure computation APIs can generally pass through or be bundled. Host-facing
APIs require an explicit target mapping: HTTP becomes Worker ingress, durable
filesystem operations may become SQLite or object storage, timers may become
alarms or cron triggers, and environment access becomes bindings. APIs whose
process semantics have no honest cell equivalent remain unsupported.

## Durable Map surface

Supported module-scope Maps have:

- string keys;
- finite number, string, or boolean values;
- no constructor entries; and
- ordinary `get`, `set`, `has`, `delete`, `clear`, `size`, iteration, and
  `forEach` usage.

Insertion order is stored explicitly. Updating an existing key retains its
position; deleting and reinserting it assigns a new position.

The following native Map behavior is outside the contract:

- object, symbol, or function keys;
- object identity and mutation through retrieved references;
- `undefined`, `NaN`, and infinite values;
- borrowed `Map.prototype` methods and Map subclasses; and
- initial entries evaluated at module load.

Function-scoped Maps remain native and ephemeral.

## Concurrency

A synchronous sequence such as `get -> calculate -> set` runs without an
interleaving point inside one application cell. This is the counter invariant.

An external `await` opens an interleaving boundary. A read-modify-write path
that crosses one is unsafe unless the application supplies another concurrency
mechanism. Invisible emits a
[Waldo](https://github.com/mirage-security/waldo) fact for the currently
recognized form.

## HTTP surface

The generated adapter currently supplies:

- request `method`, `url`, and plain-object `headers`;
- response `statusCode`, `setHeader`, `getHeader`, `writeHead`, `write`, and
  `end`; and
- synchronous or asynchronous request handlers that eventually call `end`.

Request streams, trailers, sockets, upgrades, backpressure, and the complete
Node.js `IncomingMessage` and `ServerResponse` contracts are not implemented.

## Operational boundary

celld owns ports, routing, cell placement, storage replication, and recovery.
The current compiler strips `.listen(...)` arguments rather than pretending
the source port controls deployment.

celld's per-cell admission limit and any 503 response remain visible. Invisible
does not retry an ambiguous operation automatically.
