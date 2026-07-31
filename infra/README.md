# Infrastructure assets

- `openapi/e-agent.v1.json` is the public, versioned HTTP/SSE contract.
- `kubernetes/base` is a production-oriented Kustomize base. Replace image
  coordinates and the public hostname in an environment overlay.
- `kubernetes/overlays/hardened-network` is an opt-in default-deny
  `NetworkPolicy` overlay. Read its README and adapt the ingress, DNS, provider,
  SMTP, and telemetry egress rules to the target cluster before applying it.
- `observability` contains the Prometheus scrape configuration and initial
  availability, error-rate, queue, and memory alerts.
- `systemd/e-agent.service` runs the collaboration server on a hardened Linux
  host.

The Kubernetes manifests intentionally do not contain a `Secret`. Provision
`e-agent-secrets` through the cluster secret manager:

```sh
kubectl -n e-agent create secret generic e-agent-secrets \
  --from-literal=session-secret="$E_AGENT_SESSION_SECRET" \
  --from-literal=master-key="$E_AGENT_MASTER_KEY" \
  --from-literal=bootstrap-token="$E_AGENT_BOOTSTRAP_TOKEN"
```

The bootstrap token is required only while creating the first production Owner;
the Server ignores it once any user exists. Do not commit the generated manifest
or the values printed by your shell.
Its Kubernetes reference is optional only so an initialized persistent database can
restart after this one-time Secret is removed. For a fresh production database,
`GET /api/v1/auth/status` reports `bootstrapTokenRequired: true`; registration remains
locked until the Secret is supplied.

The base deliberately does not enable a cluster-specific network policy. To
preview the supplied hardened overlay:

```sh
kubectl kustomize infra/kubernetes/overlays/hardened-network
```
