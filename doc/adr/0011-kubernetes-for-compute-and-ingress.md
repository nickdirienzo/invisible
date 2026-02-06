# 11. Target Kubernetes for Compute and HTTP Ingress

Date: 2025-02-06

## Status

Accepted

## Context

The planner produces an intermediate representation (IR) describing what infrastructure an application needs. We need a primary compile target for the two most fundamental primitives: compute (run this container) and HTTP ingress (route traffic to it).

We evaluated:

1. **Cloud-specific services** — AWS ECS/Fargate, GCP Cloud Run, Azure Container Apps. Each is a good experience in isolation, but targeting one first couples the IR design to that provider's model. We'd be designing around ECS task definitions or Cloud Run service specs rather than a universal abstraction.
2. **Bare VMs with Docker** — Maximum control and aligned with self-hosted ethos, but requires building service discovery, health checking, rolling deploys, and ingress routing from scratch.
3. **Kubernetes** — Industry-standard container orchestration. Declarative manifests for compute (Deployment + Service) and ingress (Ingress or Gateway API). Runs everywhere: EKS, GKE, AKS, self-hosted, k3s, kind for local dev.

Kubernetes is the natural choice for several reasons:

- **Dapr integration** — ADR-0006 chose Dapr for distributed primitives. Dapr's primary deployment model is as a Kubernetes sidecar managed by the Dapr operator. Targeting k8s means Dapr works out of the box.
- **Portability** — A set of k8s manifests runs on any conformant cluster regardless of cloud. This directly supports ADR-0002 (open standards over cloud-specific services).
- **Ecosystem** — cert-manager for TLS, external-dns for DNS, the Gateway API for advanced routing — all compose declaratively without vendor lock-in.
- **IR alignment** — Kubernetes resources are already structured data (YAML/JSON). The compiler is a straightforward mapping from our IR to k8s resource specs.

For local development, we'll compile the same IR to docker-compose. This gives developers a zero-infrastructure inner loop — `docker compose up` runs the same app without needing a local k8s cluster.

## Decision

We will target Kubernetes as the primary compile target for compute and HTTP ingress:

**Compute:**
- Each service in the IR compiles to a Deployment + Service.
- Container image is built from the service's source directory.
- Scale bounds map to replica count (and later HPA).
- Dapr annotations are injected for services that need distributed primitives.

**HTTP Ingress:**
- Ingress rules compile to Kubernetes Gateway API resources (preferred) or Ingress resources (fallback for older clusters).
- TLS is handled by cert-manager with Let's Encrypt by default.
- Host and path routing map directly from the IR's ingress rules.

**Local Development:**
- The same IR compiles to a docker-compose.yml for local dev.
- No k8s cluster required locally — native Docker containers with port mapping.
- Dapr runs as a container sidecar in the compose stack when needed.

**Future Cloud Targets:**
- The IR is designed to be cloud-agnostic. Additional compilers (ECS, Cloud Run, etc.) can be added later without changing the IR schema or application code.

## Consequences

**Positive:**
- One IR, multiple targets from day one — docker-compose locally, k8s in production.
- Dapr sidecar injection works natively with the Kubernetes operator.
- Every major cloud has a managed k8s offering, so "deploy to k8s" covers AWS, GCP, Azure, and self-hosted.
- The Gateway API is the future of k8s ingress — investing here pays forward.
- Developers never write k8s manifests — the compiler handles it.

**Negative:**
- Kubernetes has significant operational complexity. Users deploying to their own clusters need k8s knowledge for day-2 operations (this is where the hosted runtime offering adds value).
- k8s is heavyweight for simple apps — a hello-world Express app gets a Deployment, Service, and Gateway route. The docker-compose target mitigates this for local dev.
- The Gateway API is newer and not yet supported by all ingress controllers. We need an Ingress fallback path.
- Users who want serverless scale-to-zero (like Cloud Run) won't get it from vanilla k8s — we'd need Knative or KEDA, adding complexity.
