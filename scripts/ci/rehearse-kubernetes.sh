#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
# Local rehearsal of the `kubernetes` CI job: the same containers the GitLab
# runner uses, on this machine's Docker, without touching the local kind
# cluster or any host port.
#
#   rehearse-kubernetes.sh
#
# What it does:
#   1. Unpacks `git archive HEAD` into the Docker volume nbo-ci-rehearse-work
#      (a clean tree of the committed files: uncommitted edits never reach it,
#      and the build runs on the VM's own disk, not on a slow bind mount).
#   2. Creates the Docker network nbo-ci-rehearse, starts a privileged
#      docker:27.5.1-dind container (alias `docker`, TLS off), and a
#      node:24.11.1-bookworm container with that volume at /work and the CI
#      job's variables. No host Docker socket is mounted into the job container.
#   3. Runs the job's before_script and script lines, read from .gitlab-ci.yml
#      through `check-pipeline.mjs --print-job kubernetes` (or from the file in
#      NBO_REHEARSE_JOB_FILE, one command per line, when set). After the last
#      line that runs dind-forward.sh it runs assertions that the job talks to
#      the cluster inside the dind daemon and not to the host's:
#        - no docker.sock in the job container,
#        - the kube server is https://127.0.0.1:6443,
#        - `kind get clusters` inside dind lists nbo-local,
#        - that cluster's node container id differs from the host cluster's.
#      Every job line is preceded by "[rehearse HH:MM:SS] <line>", so a
#      saved log shows how long each step took.
#   4. On exit removes both containers (and the dind volume), the network and
#      the work volume.
#
# On Windows (powershell.exe on PATH) it keeps the machine from sleeping
# for the whole run (scripts/ci/keep-awake.ps1, released on exit): a host
# that slept mid-job came back with Docker Desktop's disk read-only (EROFS)
# and its engine dead (exit 125).
#
# Environment: NBO_REHEARSE_JOB_FILE, NBO_REHEARSE_KEEP=1 (keep
# everything for debugging), NBO_REHEARSE_TMP (log/job files, default
# the system temp folder), NBO_REHEARSE_KEEP_AWAKE=0 (let the machine sleep).
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

# pwd -W gives a C:/... path on Git Bash, which git and docker both accept.
ROOT="$(cd "$(dirname "$0")/../.." && { pwd -W 2>/dev/null || pwd; })"
VOL="nbo-ci-rehearse-work"
TMP="${NBO_REHEARSE_TMP:-$(cd "${TMPDIR:-/tmp}" && { pwd -W 2>/dev/null || pwd; })}"
NET="nbo-ci-rehearse"
DIND="nbo-ci-rehearse-dind"
JOB="nbo-ci-rehearse-job"
DIND_IMAGE="docker:27.5.1-dind"
NODE_IMAGE="node:24.11.1-bookworm"
HOST_CLUSTER="nbo-local"

mkdir -p "$TMP"
JOB_SCRIPT="$TMP/nbo-ci-rehearse-job.sh"
JOB_LINES="$TMP/nbo-ci-rehearse-lines.txt"
CI_YML="$TMP/nbo-ci-rehearse-gitlab-ci.yml"
AWAKE_LOCK="$TMP/nbo-ci-rehearse-awake.lock"

cleanup() {
  local code=$?
  # Releases the keep-awake helper: it exits once the lock is gone.
  rm -f "$AWAKE_LOCK"
  if [ "${NBO_REHEARSE_KEEP:-}" = "1" ]; then
    echo "rehearse: NBO_REHEARSE_KEEP=1, leaving containers, network and volume in place" >&2
    exit "$code"
  fi
  docker rm -f -v "$JOB" "$DIND" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm -f "$VOL" >/dev/null 2>&1 || true
  rm -f "$JOB_SCRIPT" "$JOB_LINES" "$CI_YML"
  exit "$code"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || { echo "rehearse: docker not found" >&2; exit 1; }
for name in "$JOB" "$DIND"; do
  if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
    echo "rehearse: container $name already exists (a previous run?): remove it first" >&2
    exit 1
  fi
done
if docker network ls --format '{{.Name}}' | grep -qx "$NET"; then
  echo "rehearse: network $NET already exists: remove it first" >&2
  exit 1
fi

# Keep Windows awake while the rehearsal runs (see the header).
if [ "${NBO_REHEARSE_KEEP_AWAKE:-1}" != "0" ] && command -v powershell.exe >/dev/null 2>&1; then
  : >"$AWAKE_LOCK"
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$ROOT/scripts/ci/keep-awake.ps1" -LockFile "$AWAKE_LOCK" </dev/null >/dev/null 2>&1 &
  echo "rehearse: keeping the machine awake until the run ends"
fi

# The host cluster's node container id, to prove later that the job's cluster is another one.
HOST_NODE_ID="$(docker inspect -f '{{.Id}}' "${HOST_CLUSTER}-control-plane" 2>/dev/null || true)"
echo "rehearse: host cluster node container: ${HOST_NODE_ID:-none}"

if docker volume ls --format '{{.Name}}' | grep -qx "$VOL"; then
  echo "rehearse: volume $VOL already exists: remove it first" >&2
  exit 1
fi
echo "== unpacking a clean tree of HEAD into volume $VOL =="
docker volume create "$VOL" >/dev/null
git -C "$ROOT" archive --format=tar HEAD | docker run --rm -i -v "$VOL:/work" "$NODE_IMAGE" tar -x -C /work

echo "== reading the job's lines =="
if [ -n "${NBO_REHEARSE_JOB_FILE:-}" ]; then
  cp "$NBO_REHEARSE_JOB_FILE" "$JOB_LINES"
else
  if ! git -C "$ROOT" show HEAD:.gitlab-ci.yml >"$CI_YML" 2>/dev/null; then
    echo "rehearse: HEAD has no .gitlab-ci.yml; commit the pipeline or set NBO_REHEARSE_JOB_FILE" >&2
    exit 1
  fi
  node "$ROOT/scripts/ci/check-pipeline.mjs" --file "$CI_YML" --print-job kubernetes >"$JOB_LINES"
fi
if [ ! -s "$JOB_LINES" ]; then
  echo "rehearse: the kubernetes job has no script lines" >&2
  exit 1
fi

# Build the script the container runs: the job's lines in order, with the
# review assertions after the last line that runs dind-forward.sh.
last_forward="$(grep -n 'dind-forward\.sh' "$JOB_LINES" | tail -n 1 | cut -d: -f1 || true)"
if [ -z "$last_forward" ]; then
  echo "rehearse: no job line runs dind-forward.sh" >&2
  exit 1
fi
ASSERT_LINES='
echo "== rehearsal assertions: the job talks to the dind cluster, not the host one =="
if [ -e /var/run/docker.sock ]; then echo "assert: /var/run/docker.sock exists in the job container" >&2; exit 1; fi
server="$(kubectl config view --minify -o jsonpath={.clusters[0].cluster.server})"
if [ "$server" != "https://127.0.0.1:6443" ]; then echo "assert: kube server is $server, expected https://127.0.0.1:6443" >&2; exit 1; fi
if ! kind get clusters | grep -qx nbo-local; then echo "assert: kind get clusters inside dind does not list nbo-local" >&2; exit 1; fi
inner_id="$(docker inspect -f "{{.Id}}" nbo-local-control-plane)"
if [ -z "$inner_id" ]; then echo "assert: no node container inside dind" >&2; exit 1; fi
if [ -n "${NBO_REHEARSE_HOST_NODE_ID:-}" ] && [ "$inner_id" = "$NBO_REHEARSE_HOST_NODE_ID" ]; then echo "assert: the job sees the host cluster node container" >&2; exit 1; fi
echo "assertions ok: server $server, node container $inner_id (host: ${NBO_REHEARSE_HOST_NODE_ID:-none})"
'
# stamp: each line, preceded by an echo of "[rehearse HH:MM:SS] <line>"
# (the line's \ " $ and ` escaped so the echo prints it as written).
stamp() {
  local line esc
  while IFS= read -r line || [ -n "$line" ]; do
    esc="$(printf '%s' "$line" | sed -e 's/[\\"$`]/\\&/g')"
    printf 'echo "[rehearse $(date +%%T)] %s"\n%s\n' "$esc" "$line"
  done
}
{
  echo 'set -eo pipefail'
  echo 'cd /work'
  head -n "$last_forward" "$JOB_LINES" | stamp
  printf '%s\n' "$ASSERT_LINES"
  tail -n +"$((last_forward + 1))" "$JOB_LINES" | stamp
  echo 'echo "[rehearse $(date +%T)] job lines done"'
} >"$JOB_SCRIPT"

echo "== network and dind =="
docker network create "$NET" >/dev/null
docker run -d --name "$DIND" --privileged --network "$NET" --network-alias docker \
  -e DOCKER_TLS_CERTDIR="" "$DIND_IMAGE" --tls=false >/dev/null
for i in $(seq 1 60); do
  if docker exec "$DIND" docker info >/dev/null 2>&1; then break; fi
  if [ "$i" = "60" ]; then
    echo "rehearse: the dind daemon never came up" >&2
    docker logs "$DIND" 2>&1 | tail -n 30 >&2
    exit 1
  fi
  sleep 2
done
echo "dind ready"

START=$(date +%s)
echo "== running the job in $NODE_IMAGE =="
set +e
docker run --name "$JOB" --network "$NET" \
  -v "$VOL:/work" -v "$JOB_SCRIPT:/rehearse-job.sh:ro" \
  -e CI=true -e GITLAB_CI=true -e CI_COMMIT_SHA="$(git -C "$ROOT" rev-parse HEAD)" \
  -e DOCKER_HOST=tcp://docker:2375 -e DOCKER_TLS_CERTDIR="" \
  -e NBO_CI_DIND=1 -e NBO_KIND_CONFIG=scripts/ci/kind-config.yaml -e NBO_KIND_CLUSTER=nbo-local \
  -e NBO_INGRESS_NGINX_MANIFEST="https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.1/deploy/static/provider/kind/deploy.yaml" \
  -e NBO_CERT_MANAGER_MANIFEST="https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml" \
  -e npm_config_manage_package_manager_versions=false \
  -e NBO_BUILD_ID="$(git -C "$ROOT" rev-parse HEAD)" \
  -e NBO_REHEARSE_HOST_NODE_ID="$HOST_NODE_ID" \
  "$NODE_IMAGE" bash /rehearse-job.sh
code=$?
set -e
echo "rehearse: job exited $code after $(($(date +%s) - START)) s"
exit "$code"
