# 8. Use OpenBao for Least-Privilege Secrets Management

Date: 2025-02-06

## Status

Accepted

## Context

Applications access secrets through `process.env` — API keys, database URLs, and credentials. The standard approach is to inject all secrets as environment variables at deploy time, giving every service access to every secret. This violates least-privilege and creates a blast radius problem: one compromised service exposes all secrets.

We need a secrets management solution that:
1. Integrates with `process.env` (no new API for developers).
2. Automatically scopes secrets per-service based on static analysis.
3. Supports rotation without redeployment.
4. Provides an audit trail of every secret access.
5. Runs on any cloud or self-hosted.

We evaluated:

1. **HashiCorp Vault** — Industry standard, but changed to BSL license in August 2023. No longer open source.
2. **OpenBao** — Linux Foundation fork of Vault, BSD-licensed, API-compatible. Community-driven governance.
3. **AWS Secrets Manager / GCP Secret Manager** — Cloud-native, but proprietary and non-portable.
4. **Doppler / Infisical** — SaaS secrets managers. Add external dependencies and are not self-hostable (Doppler) or have limited maturity.

OpenBao won on the same criteria we apply to all infrastructure choices: open source, open governance, portable, and API-compatible with the industry standard (Vault).

## Decision

We will use OpenBao for secrets management with automatic least-privilege policy generation.

The planner performs static analysis on each service to determine which `process.env` variables it accesses. It then generates OpenBao policies that grant each service access only to the secrets it actually uses:

```
api-service policy:
  path "secret/data/STRIPE_API_KEY" { capabilities = ["read"] }
  path "secret/data/DATABASE_URL"   { capabilities = ["read"] }
  # SENDGRID_API_KEY: explicitly denied

worker-service policy:
  path "secret/data/DATABASE_URL"     { capabilities = ["read"] }
  path "secret/data/SENDGRID_API_KEY" { capabilities = ["read"] }
  # STRIPE_API_KEY: explicitly denied
```

At runtime, `process.env.STRIPE_API_KEY` is intercepted by the runtime shim and fetched from OpenBao using the service's scoped token. The developer never knows OpenBao exists.

The planner also detects and warns about: hardcoded credentials in source code, unused secrets (declared but never accessed), and overly broad secret names that suggest misconfiguration.

## Consequences

**Positive:**
- Automatic least-privilege: no manual policy writing required.
- Secret rotation without redeployment — OpenBao serves fresh values on each access.
- Full audit trail of every secret access, tied to service identity.
- Developers use `process.env` as usual — zero API changes.
- BSD-licensed, Linux Foundation governed, self-hostable on any cloud.

**Negative:**
- Adds a critical infrastructure dependency — OpenBao must be highly available.
- Dynamic secret fetching adds latency compared to static environment variables (mitigated by caching with short TTLs).
- Static analysis of `process.env` access may miss dynamic key construction (e.g., `process.env[`${prefix}_KEY`]`).
- OpenBao is newer than Vault with a smaller (but growing) community.
- Operational complexity of managing OpenBao's own secrets (unseal keys, root tokens) must be addressed.
