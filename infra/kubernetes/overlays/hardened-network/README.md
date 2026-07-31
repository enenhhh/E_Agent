# Hardened network overlay

This overlay is intentionally opt-in because Kubernetes `NetworkPolicy` cannot
portably express provider FQDN allowlists and ingress-controller labels differ
between clusters.

Before applying it:

1. Confirm the CNI enforces ingress and egress policies, including IPv6.
2. Change the `ingress-nginx` namespace selector if your controller uses a
   different namespace.
3. Confirm CoreDNS carries the `k8s-app: kube-dns` label.
4. Replace the broad public TCP/443 rule with CNI-specific FQDN policies where
   available, and add explicit SMTP/OTel/internal-provider rules only when used.
5. Test model discovery, streaming, health probes, DNS, and rollout/rollback in
   a staging namespace.

Preview and apply:

```sh
kubectl kustomize infra/kubernetes/overlays/hardened-network
kubectl apply -k infra/kubernetes/overlays/hardened-network
```

The overlay denies all traffic by default, admits the ingress controller to the
two application ports, permits cluster DNS, and permits the Server to reach
public HTTPS addresses while excluding common private, loopback, link-local,
benchmark, multicast, and documentation ranges.
