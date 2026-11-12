#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Copyright 2026 Nikita Dovhich
# cloudrun-cleanup.sh --prefix <ci-...> | --janitor [--older-than-hours N]
#
# Deletes the Cloud Run services and Artifact Registry packages a CI run left
# behind. Service accounts are left alone: `nbo deploy` (no per-service
# identity) never creates any, so the job needs no IAM list or delete rights. Safety: only names starting with `ci-`
# are ever touched, and this must run against a CI-only Google project.
#
#   --prefix P     everything whose app name starts with P (exact string prefix,
#                  so ci-1- never matches ci-12-next). P must start with ci-.
#   --janitor      every ci- resource older than N hours (default 3).
#
# Needs NBO_GCP_PROJECT, NBO_GCP_REGION, NBO_AR_REPO, and NBO_CI_GCP_PROJECT equal to
# NBO_GCP_PROJECT (set only in the CI variables; proves the project is CI-only). A failing delete is
# printed and the rest still run; the exit code is then 1. "not found" is success.
set -uo pipefail

usage() {
  echo "usage: cloudrun-cleanup.sh --prefix <ci-...> | --janitor [--older-than-hours N]" >&2
  exit 2
}

PREFIX=""
JANITOR=0
HOURS=3
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) [ "$#" -ge 2 ] || usage; PREFIX="$2"; shift 2 ;;
    --janitor) JANITOR=1; shift ;;
    --older-than-hours) [ "$#" -ge 2 ] || usage; HOURS="$2"; shift 2 ;;
    *) usage ;;
  esac
done
if [ -n "$PREFIX" ] && [ "$JANITOR" -eq 1 ]; then usage; fi
if [ -z "$PREFIX" ] && [ "$JANITOR" -eq 0 ]; then usage; fi

if [ "$JANITOR" -eq 1 ]; then
  case "$HOURS" in '' | *[!0-9]*) usage ;; esac
else
  case "$PREFIX" in
    ci-?*) ;;
    *)
      echo "refusing prefix $PREFIX: must start with ci- and name a run after it" >&2
      exit 1
      ;;
  esac
fi

[ "$JANITOR" -eq 1 ] && PREFIX="ci-"
for v in NBO_GCP_PROJECT NBO_GCP_REGION NBO_AR_REPO; do
  if [ -z "${!v:-}" ]; then
    echo "cloudrun-cleanup.sh: $v is not set" >&2
    exit 1
  fi
done
# The ci- prefix alone is not proof this is a CI-only project: the CI variables
# must name it a second time.
if [ -z "${NBO_CI_GCP_PROJECT:-}" ] || [ "$NBO_CI_GCP_PROJECT" != "$NBO_GCP_PROJECT" ]; then
  echo "refusing project $NBO_GCP_PROJECT: NBO_CI_GCP_PROJECT must be set to the same CI-only project" >&2
  exit 1
fi

# NBO_AR_REPO is the CLI's full form (<region>-docker.pkg.dev/<project>/<repo>);
# gcloud artifacts wants only the repository name.
AR_REPO_NAME="${NBO_AR_REPO##*/}"

STATUS=0
NOW=$(date +%s)

# old_enough <timestamp>: always true for --prefix; for the janitor, true when
# the RFC 3339 timestamp is at least HOURS old. An unparsable one is not old.
old_enough() {
  [ "$JANITOR" -eq 0 ] && return 0
  local t
  t=$(date -d "$1" +%s 2>/dev/null) || return 1
  [ $((NOW - t)) -ge $((HOURS * 3600)) ]
}

# do_delete <description> <command...>
do_delete() {
  local what="$1" out
  shift
  echo "deleting $what"
  if out=$("$@" 2>&1); then
    return 0
  fi
  if grep -qE 'NOT_FOUND|Resource .* not found|Cannot find service' <<<"$out"; then
    echo "  already gone"
    return 0
  fi
  echo "failed to delete $what: $out" >&2
  STATUS=1
}

# -- services -----------------------------------------------------------------
if ! services=$(gcloud run services list --project "$NBO_GCP_PROJECT" --region "$NBO_GCP_REGION" --format='value(metadata.name,metadata.creationTimestamp)'); then
  echo "could not list Cloud Run services" >&2
  STATUS=1
  services=""
fi
while IFS=$'\t' read -r name created; do
  [ -n "$name" ] || continue
  case "$name" in "$PREFIX"*) ;; *) continue ;; esac
  old_enough "$created" || continue
  do_delete "Cloud Run service $name" gcloud run services delete "$name" --project "$NBO_GCP_PROJECT" --region "$NBO_GCP_REGION" --quiet
done <<<"$services"

# -- artifact registry packages (nbo-app-<app>, nbo-fn-<app>-<fn>) -----------------
if ! packages=$(gcloud artifacts packages list --repository "$AR_REPO_NAME" --location "$NBO_GCP_REGION" --project "$NBO_GCP_PROJECT" --format='value(name,createTime)'); then
  echo "could not list Artifact Registry packages" >&2
  STATUS=1
  packages=""
fi
while IFS=$'\t' read -r pkg created; do
  [ -n "$pkg" ] || continue
  pkg="${pkg##*/}"
  app="${pkg#nbo-app-}"
  [ "$app" = "$pkg" ] && app="${pkg#nbo-fn-}"
  [ "$app" = "$pkg" ] && continue
  case "$app" in "$PREFIX"*) ;; *) continue ;; esac
  old_enough "$created" || continue
  do_delete "package $pkg" gcloud artifacts packages delete "$pkg" --repository "$AR_REPO_NAME" --location "$NBO_GCP_REGION" --project "$NBO_GCP_PROJECT" --quiet
done <<<"$packages"

exit "$STATUS"
