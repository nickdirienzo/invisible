# 10. Open Source Planner with Hosted Runtime Business Model

Date: 2025-02-06

## Status

Accepted

## Context

II's business model must align with its technical philosophy: no vendor lock-in. A platform built on open standards and portability cannot sustain itself through captivity. But it must still generate revenue.

We studied the failure mode of developer tools funded by venture capital: tool gains adoption → raise money → investors demand returns → company adds lock-in to capture value → company becomes the problem it originally solved. This is the "VC trap" and it has consumed companies across the infrastructure space.

We considered several sustainability models:

1. **VC-funded proprietary platform** — Maximum growth, but inevitably leads to lock-in. Contradicts core mission.
2. **Open core** — Open source the core, proprietary enterprise features (SSO, audit). Works but creates pressure to move features from open to proprietary.
3. **Managed hosting / convenience** — Open source everything, charge for hosted deployment. Revenue from convenience, not captivity. Users can always self-host.
4. **Consortium funding** — SQLite model (consortium of corporate sponsors). Sustainable but slow to start, requires existing adoption.
5. **Consulting / professional services** — Implementation and migration services. Doesn't scale.

## Decision

We will open-source the planner (the static analysis engine that infers infrastructure from code) and offer a hosted runtime as the primary revenue source.

**Open source (always free):**
- The planner: static analysis, inference rules, infrastructure generation
- All runtime shims: EventEmitter, fs, process.env bridges
- Dapr components and configurations
- CLI tooling (`ii deploy`)

**Hosted service (revenue):**
- Managed deployment: one-command deploy to any cloud
- Managed infrastructure: Valkey, Libsql, OpenBao provisioned and maintained
- Monitoring and alerting
- Automatic scaling
- SOC2 compliance dashboard and audit evidence

The key principle: **"We're the easiest place to deploy, but we'll never hold your app hostage."** Users can always eject to self-hosted infrastructure because every component is open source and standards-based. We compete on convenience and operational excellence, not on lock-in.

## Consequences

**Positive:**
- Business model is aligned with technical mission — no lock-in tension.
- Open source builds trust and adoption faster than proprietary tools.
- Users who self-host today may become paying customers as they scale.
- Community contributions improve the planner for everyone.
- Eliminates the "what happens if II goes away" concern — everything is self-hostable.

**Negative:**
- Competing against "free" (self-hosted) requires the hosted service to be significantly better than DIY.
- Open-source competitors can fork and offer a competing hosted service.
- Revenue growth may be slower than proprietary alternatives — investors may not find this attractive.
- Must maintain both open-source community and commercial product simultaneously.
- Risk of "open-source free-rider" problem where large companies use without contributing.
