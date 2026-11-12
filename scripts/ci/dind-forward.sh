#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
# Docker-in-Docker moves "localhost": kind's ports are open on the `docker`
# service, not in the job container. Forward them back to 127.0.0.1, point the
# kind kubeconfig at the forwarded API port, and pin the sslip.io names used by
# the harness in the hosts file so a sslip.io outage cannot fail the job.
# Does nothing unless NBO_CI_DIND=1.
set -euo pipefail

if [ "${NBO_CI_DIND:-}" != "1" ]; then
  echo "dind-forward: NBO_CI_DIND is not 1, nothing to do"
  exit 0
fi

CLUSTER_NAME="${NBO_KIND_CLUSTER:-nbo-local}"
DOCKER_HOST_NAME="${NBO_DIND_HOST:-docker}"
HOSTS_FILE="${NBO_HOSTS_FILE:-/etc/hosts}"

for port in 80 443 6443; do
  nohup socat "TCP-LISTEN:${port},fork,reuseaddr" "TCP:${DOCKER_HOST_NAME}:${port}" >/dev/null 2>&1 &
done

kubectl config set-cluster "kind-${CLUSTER_NAME}" --server=https://127.0.0.1:6443

for name in next-app ppr-app; do
  host="${name}.127.0.0.1.sslip.io"
  if ! grep -q "[[:space:]]${host}\$" "$HOSTS_FILE" 2>/dev/null; then
    echo "127.0.0.1 ${host}" >> "$HOSTS_FILE"
  fi
done

echo "dind-forward: 80, 443 and 6443 forwarded to ${DOCKER_HOST_NAME}"
