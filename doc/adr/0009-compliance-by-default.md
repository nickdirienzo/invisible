# 9. Provision Compliance Controls by Default

Date: 2025-02-06

## Status

Accepted

## Context

Startups building on II will eventually need to pass security audits (SOC2 Type II, ISO 27001, HIPAA) to close enterprise deals. Today, compliance is a 6-12 month manual effort that diverts engineering time from product work. Most startups defer it until a deal requires it, then scramble.

The infrastructure II provisions (Valkey, Libsql, OpenBao, Dapr) already supports all the controls SOC2 requires. The question is whether to make compliance opt-in (users configure it when they need it) or opt-out (provisioned by default, users can disable controls they don't need).

We considered:

1. **Opt-in compliance** — Users enable controls when needed. Lower default resource cost but means most deployments are non-compliant and migration to compliant configuration requires re-provisioning.
2. **Compliance by default** — Every deployment gets SOC2-grade controls out of the box. Slightly higher baseline cost but eliminates the compliance scramble entirely.

## Decision

We will provision SOC2 Type II controls by default on all infrastructure. Every II deployment automatically includes:

**Encryption:**
- Encryption at rest: AES-256 on all state stores (Valkey, Libsql, blob storage)
- Encryption in transit: TLS required on all connections (no plaintext, no opt-out)

**Access Control:**
- Per-service IAM roles (no shared credentials)
- Least-privilege secrets policies (see ADR-0008)
- Network segmentation between services

**Audit Logging:**
- All secret access logged with service identity
- All deployment events logged
- All configuration changes logged
- Logs encrypted and immutable (append-only)
- 1-year log retention by default

**Backup & Recovery:**
- Automated daily snapshots of all state stores
- Point-in-time recovery capability
- 30-day snapshot retention by default
- Cross-region backup replication where available

## Consequences

**Positive:**
- Startups are SOC2-ready from day one without any extra work.
- Enterprise deals can proceed without a compliance scramble.
- Auditors can verify controls are in place automatically (infrastructure-as-code provides the evidence).
- Security posture is consistent across all deployments, reducing the attack surface.

**Negative:**
- Higher baseline infrastructure cost (encryption overhead, log storage, snapshot storage).
- Some controls may be unnecessary for non-regulated workloads (hobby projects, internal tools).
- Compliance controls add latency (TLS handshakes, audit log writes, encrypted storage I/O).
- Users who need to customize controls (different retention periods, specific compliance frameworks) need configuration options we must build.
- II takes on the responsibility of maintaining compliance — any control regression is a platform-level incident.
