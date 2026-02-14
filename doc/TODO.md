# TODO

## Secret Management & Environments

Right now secrets are detected via `process.env` static analysis and OpenBao is
provisioned automatically, but secret *values* are only dev placeholders seeded
by the runtime shim. We need:

- **`ii secrets set <name> <value>`** — write a secret value into OpenBao for
  the current environment.
- **`ii secrets list`** — show detected secrets and whether they have values set.
- **`ii secrets get <name>`** — read a secret value (masked by default).
- **Environment concept** — `ii env create staging`, `ii env use production`.
  Secrets, env vars, and deployment config are scoped per environment.
  The planner already detects what's needed; environments let you configure
  different values for dev / staging / production.
- **Env var configuration** — manage non-secret env vars (`PORT`, `NODE_ENV`,
  etc.) per environment through the CLI rather than hardcoding in compose/k8s.
- **Production OpenBao** — the current dev-mode OpenBao (in-memory, root token)
  is fine for local dev but production needs persistent storage, proper auth
  policies, and token rotation.

## Distributed `.once` Semantics

Should `.once()` on a `DistributedEventEmitter` have cluster-wide semantics?
Currently it only auto-removes the handler on the local instance after first
delivery. With Dapr consumer groups, each message already goes to one instance,
so `.once` means "this instance stops listening after its first delivery" — but
other instances remain subscribed. A true cluster-wide `.once` (fire globally
once, then unsubscribe everywhere) would need coordination (e.g. a Valkey key
to track consumption and dynamic Dapr topic unsubscription). Open question
whether that's worth the complexity or if local `.once` is sufficient.

## Global types
`new Map` as Durable
Use `{}` as a fallback to in-memory map
`new Array` as Durable
Use `[]` as in-memory array