#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
# Installs the pinned CI tools (linux x86_64) into ${NBO_CI_TOOLS:-.ci-tools}/bin.
# Every download is checked against the sha256 below; an installed kind or
# kubectl is re-hashed on every run (see installed() for docker and gcloud).
#
#   install-tools.sh [--gcloud]
#
# Writes $TOOLS/env.sh; later job steps run `. .ci-tools/env.sh` to get the
# tools on PATH. With --gcloud it also adds the SDK's own bin directory, which
# holds docker-credential-gcloud (what `gcloud auth configure-docker` makes
# docker call when it pushes to Artifact Registry).
#
# socat comes from apt and is installed only when NBO_CI_DIND=1.
set -euo pipefail

KIND_VERSION="v0.26.0"
KIND_URL="https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/kind-linux-amd64"
KIND_SHA256="d445b44c28297bc23fd67e51cc24bb294ae7b977712be2d4d312883d0835829b"

KUBECTL_VERSION="v1.31.4"
KUBECTL_URL="https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl"
KUBECTL_SHA256="298e19e9c6c17199011404278f0ff8168a7eca4217edad9097af577023a5620f"

DOCKER_VERSION="27.5.1"
DOCKER_URL="https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz"
DOCKER_SHA256="4f798b3ee1e0140eab5bf30b0edc4e84f4cdb53255a429dc3bbae9524845d640"

GCLOUD_VERSION="502.0.0"
GCLOUD_URL="https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-${GCLOUD_VERSION}-linux-x86_64.tar.gz"
GCLOUD_SHA256="b40e9fe64c3d2b0c7ff289b50ca39f572cce54c783c0f8579810f2307c8fdf0b"

WANT_GCLOUD=0
for arg in "$@"; do
  case "$arg" in
    --gcloud) WANT_GCLOUD=1 ;;
    *) echo "install-tools: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

TOOLS="${NBO_CI_TOOLS:-.ci-tools}"
BIN="$TOOLS/bin"
STAMPS="$TOOLS/stamps"
mkdir -p "$BIN" "$STAMPS"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# installed <name> <sha256> <binary path> [whole]: true when the tool is
# already installed AND verified now. A cache may have been written by another
# job, so a stamp file alone proves nothing: a single-file download (kind,
# kubectl) is re-hashed on every run; tools unpacked from an archive (docker,
# gcloud) are reinstalled every run unless NBO_CI_TRUST_STAMPS=1 (only for jobs
# that hold no credentials).
installed() {
  [ -f "$3" ] || return 1
  if [ "${4:-}" = "whole" ]; then
    [ "$(sha256sum "$3" | cut -d" " -f1)" = "$2" ]
  else
    [ "${NBO_CI_TRUST_STAMPS:-}" = "1" ] && [ "$(cat "$STAMPS/$1" 2>/dev/null || true)" = "$2" ]
  fi
}

# fetch <url> <sha256> <dest>: download and verify.
fetch() {
  curl -fsSL --retry 3 -o "$3" "$1"
  local got
  got="$(sha256sum "$3" | cut -d' ' -f1)"
  if [ "$got" != "$2" ]; then
    echo "install-tools: sha256 mismatch for $1" >&2
    echo "  expected $2" >&2
    echo "  got      $got" >&2
    exit 1
  fi
}

if installed kind "$KIND_SHA256" "$BIN/kind" whole; then
  echo "kind $KIND_VERSION already installed"
else
  echo "installing kind $KIND_VERSION"
  fetch "$KIND_URL" "$KIND_SHA256" "$WORK/kind"
  install -m 0755 "$WORK/kind" "$BIN/kind"
  echo "$KIND_SHA256" > "$STAMPS/kind"
fi

if installed kubectl "$KUBECTL_SHA256" "$BIN/kubectl" whole; then
  echo "kubectl $KUBECTL_VERSION already installed"
else
  echo "installing kubectl $KUBECTL_VERSION"
  fetch "$KUBECTL_URL" "$KUBECTL_SHA256" "$WORK/kubectl"
  install -m 0755 "$WORK/kubectl" "$BIN/kubectl"
  echo "$KUBECTL_SHA256" > "$STAMPS/kubectl"
fi

if installed docker "$DOCKER_SHA256" "$BIN/docker"; then
  echo "docker $DOCKER_VERSION already installed"
else
  echo "installing docker $DOCKER_VERSION (CLI only)"
  fetch "$DOCKER_URL" "$DOCKER_SHA256" "$WORK/docker.tgz"
  tar -xzf "$WORK/docker.tgz" -C "$WORK" docker/docker
  install -m 0755 "$WORK/docker/docker" "$BIN/docker"
  echo "$DOCKER_SHA256" > "$STAMPS/docker"
fi

if [ "$WANT_GCLOUD" = "1" ]; then
  if installed gcloud "$GCLOUD_SHA256" "$BIN/gcloud"; then
    echo "gcloud $GCLOUD_VERSION already installed"
  else
    echo "installing gcloud $GCLOUD_VERSION"
    fetch "$GCLOUD_URL" "$GCLOUD_SHA256" "$WORK/gcloud.tgz"
    rm -rf "$TOOLS/google-cloud-sdk"
    tar -xzf "$WORK/gcloud.tgz" -C "$TOOLS"
    ln -sf "../google-cloud-sdk/bin/gcloud" "$BIN/gcloud"
    echo "$GCLOUD_SHA256" > "$STAMPS/gcloud"
  fi
fi

if [ "${NBO_CI_DIND:-}" = "1" ]; then
  if command -v socat >/dev/null 2>&1; then
    echo "socat already installed"
  else
    echo "installing socat"
    SUDO=""
    [ "$(id -u)" = "0" ] || SUDO="sudo"
    $SUDO apt-get update -qq
    $SUDO apt-get install -y socat
  fi
fi

ABS_TOOLS="$(cd "$TOOLS" && pwd)"
TOOLS_PATH="$ABS_TOOLS/bin"
if [ "$WANT_GCLOUD" = "1" ]; then
  if [ ! -x "$ABS_TOOLS/google-cloud-sdk/bin/docker-credential-gcloud" ]; then
    echo "install-tools: the gcloud SDK has no docker-credential-gcloud in $ABS_TOOLS/google-cloud-sdk/bin" >&2
    exit 1
  fi
  TOOLS_PATH="$TOOLS_PATH:$ABS_TOOLS/google-cloud-sdk/bin"
fi
printf 'export PATH="%s:$PATH"\n' "$TOOLS_PATH" > "$TOOLS/env.sh"

echo "tools ready in $BIN (. $TOOLS/env.sh puts them on PATH)"
