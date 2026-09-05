# Architecture

Invisible v2 is target-specific by design. The Node standard library is its
source-level deployment interface and celld's Worker and Durable Object runtime
is its target ABI. The current implementation covers the first checked slice of
that interface.

```text
                       celld fleet
request -> any node -> generated Worker
                            |
                            v
                    AppCell:global
                    +----------------+
                    | Node adapter   |
                    | application    |
                    | sync SQLite    |
                    +----------------+
```

celld guarantees one owner for a named cell. Other fleet nodes route to that
owner and can take ownership after failure. Multiple nodes therefore provide
durability and failover for the singleton app; they do not execute that app's
JavaScript in parallel.

## Compiler

The compiler:

1. Parses one TypeScript entrypoint with the TypeScript compiler API.
2. Rejects syntax outside the current semantic envelope.
3. Removes the `node:http` import and supplies a narrow runtime adapter.
4. Rewrites supported module-scope Maps to namespaced SQLite-backed Maps.
5. Removes the source port expression because celld owns the listener.
6. Emits a Worker router, `AppCell`, and `wrangler.jsonc`.

The generated Worker always calls `env.APP.getByName("global")`. This fixed
identity is part of the correctness contract: creating multiple application
cells would split module-scope state.

## Static analysis and Waldo

Invisible emits provider-neutral [Waldo](https://github.com/mirage-security/waldo)
facts for state read-modify-write paths
that cross an external await. Waldo joins those facts with the celld deployment
fact `concurrency.interleavesOnExternalAwait: true`.

The singleton cell is an exclusive authority, but exclusivity is not a lock
held across arbitrary asynchronous I/O. Synchronous SQLite operations cannot
interleave; an awaited network operation can.
