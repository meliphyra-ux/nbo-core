#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
set -euo pipefail
cd "$(dirname "$0")/.."

# NBO_KIND_CLUSTER names the cluster (nbo deploy reads the same variable for kind load).
CLUSTER_NAME="${NBO_KIND_CLUSTER:-nbo-local}"
# Overrides (CI pins versions); the defaults are the local behaviour.
KIND_CONFIG="${NBO_KIND_CONFIG:-scripts/local-k8s/kind-config.yaml}"
INGRESS_NGINX_MANIFEST="${NBO_INGRESS_NGINX_MANIFEST:-https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml}"
CERT_MANAGER_MANIFEST="${NBO_CERT_MANAGER_MANIFEST:-https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml}"
# Pod readiness waits. A fresh dind pulls every image cold, and the ingress-nginx
# controller took 3 to 4 minutes there (2026-11-12); 180s was too short.
WAIT_TIMEOUT="${NBO_BOOTSTRAP_WAIT_TIMEOUT:-600s}"

command -v kind >/dev/null 2>&1 || { echo "kind not found on PATH — install it from https://kind.sigs.k8s.io/docs/user/quick-start/#installation" >&2; exit 1; }

echo "== checking for an existing cluster =="
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  echo "cluster $CLUSTER_NAME already exists, reusing it"
else
  echo "== creating kind cluster $CLUSTER_NAME =="
  kind create cluster --name "$CLUSTER_NAME" --config "$KIND_CONFIG"
fi

kubectl cluster-info --context "kind-$CLUSTER_NAME"

wait_for_pods() {
  local namespace="$1" selector="$2"
  # kubectl wait errors immediately with "no matching resources found" if
  # the pod doesn't exist yet, instead of waiting for it to be created, so
  # poll for the pod to exist first.
  for _ in $(seq 1 60); do
    if kubectl get pods -n "$namespace" -l "$selector" --no-headers 2>/dev/null | grep -q .; then
      break
    fi
    sleep 2
  done
  kubectl wait --namespace "$namespace" \
    --for=condition=ready pod \
    --selector="$selector" \
    --timeout="$WAIT_TIMEOUT"
}

echo "== installing ingress-nginx =="
kubectl apply -f "$INGRESS_NGINX_MANIFEST"
echo "waiting for ingress-nginx controller to be ready..."
wait_for_pods ingress-nginx app.kubernetes.io/component=controller

echo "== installing cert-manager =="
kubectl apply -f "$CERT_MANAGER_MANIFEST"
echo "waiting for cert-manager to be ready..."
wait_for_pods cert-manager app.kubernetes.io/instance=cert-manager

echo "== applying the selfsigned ClusterIssuer =="
kubectl apply -f scripts/local-k8s/cluster-issuer.yaml
kubectl wait --for=condition=ready clusterissuer/selfsigned-issuer --timeout=60s

echo "== bootstrap complete: cluster '$CLUSTER_NAME', ingress on 127.0.0.1:80/443, selfsigned-issuer ready =="
