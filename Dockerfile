# NBO in one image: the control-plane and the tools it calls.
# Keep this file to plain instructions (no RUN --mount): it must build with the
# classic builder as well as BuildKit.
#
# x64 only: every tool below is pinned to its x64 download, and the edge and
# relay images NBO builds from this checkout are x64 too.

# --- Install and build. -------------------------------------------------------
FROM node:24-bookworm-slim AS builder
RUN npm install --global pnpm@11.25.0
WORKDIR /app
COPY . .
# One step, so the full dependency tree and pnpm's store never become a layer.
# The second install keeps only the dependencies of what runs here: at runtime
# NBO rebuilds only its own control-plane, CLI and edge packages.
RUN pnpm install --frozen-lockfile --filter '!./fixtures/**' \
 && pnpm --recursive --filter '!./fixtures/**' run build \
 && rm -rf node_modules packages/*/node_modules spec/node_modules packages/terraform-provider \
 && pnpm install --frozen-lockfile --offline \
      --filter '@nbo/controlplane...' --filter '@nbo/cli...' --filter '@nbo/edge...' \
 && rm -rf "$(pnpm store path)" /root/.cache

# --- Build the Terraform provider for every platform. -------------------------
FROM golang:1.25.8-bookworm AS provider
WORKDIR /src
COPY packages/terraform-provider/ ./
RUN set -eu; \
    for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64; do \
      os="${target%/*}"; arch="${target#*/}"; \
      ext=""; if [ "$os" = windows ]; then ext=".exe"; fi; \
      CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -o "/dist/${os}_${arch}/terraform-provider-nbo_v0.1.0${ext}" . ; \
    done

# --- Download the pinned tools. -----------------------------------------------
FROM node:24-bookworm-slim AS tools
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /tools
RUN curl -fsSL -o kubectl https://dl.k8s.io/release/v1.34.13/bin/linux/amd64/kubectl \
 && echo "b4bb494e9466a7a94bb851414548bc0d3e2f8da90757e6eccc3371e648648591  kubectl" | sha256sum -c - \
 && chmod +x kubectl
RUN curl -fsSL -o docker.tgz https://download.docker.com/linux/static/stable/x86_64/docker-28.5.2.tgz \
 && echo "ea90cfd12e1eeb12aa1c971741adb8bd4ed88e2a574eaac13f5029a1dbc6300d  docker.tgz" | sha256sum -c - \
 && tar -xzf docker.tgz --strip-components=1 docker/docker \
 && rm docker.tgz
RUN curl -fsSL -o docker-buildx https://github.com/docker/buildx/releases/download/v0.29.1/buildx-v0.29.1.linux-amd64 \
 && echo "7d2d7d6d4680aa349614965aaa33ccec43f1a9a21e908a5ce4cb6adfa5ad5141  docker-buildx" | sha256sum -c - \
 && chmod +x docker-buildx
# gcloud, without what NBO never calls (gsutil, bq, anthoscli) and the
# installer's own backup copy. Domain mappings need the beta component: the GA
# `gcloud run domain-mappings` group can't reach managed Cloud Run.
RUN curl -fsSL -o gcloud.tgz https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-590.0.1-linux-x86_64.tar.gz \
 && echo "d1ae7be7e12c4e7d8286fab4774f5441020aca89dc7793ddacbace8d11d20f06  gcloud.tgz" | sha256sum -c - \
 && tar -xzf gcloud.tgz \
 && rm gcloud.tgz \
 && google-cloud-sdk/bin/gcloud components install beta --quiet \
 && rm -rf google-cloud-sdk/.install/.backup google-cloud-sdk/platform/gsutil google-cloud-sdk/platform/bq \
           google-cloud-sdk/bin/anthoscli google-cloud-sdk/bin/gsutil google-cloud-sdk/bin/bq \
 && find google-cloud-sdk -name __pycache__ -type d -prune -exec rm -rf {} +

# --- What runs. ---------------------------------------------------------------
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates git openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global pnpm@11.25.0 \
 && npm cache clean --force
COPY --from=tools /tools/kubectl /tools/docker /usr/local/bin/
COPY --from=tools /tools/docker-buildx /usr/local/lib/docker/cli-plugins/docker-buildx
COPY --from=tools /tools/google-cloud-sdk /opt/google-cloud-sdk
ENV PATH=/opt/google-cloud-sdk/bin:$PATH
# The whole built checkout, not just dist/: installing the edge and deploying
# run `pnpm deploy` here to build the app images (@nbo/deploy's
# kubernetes-target.ts); the edge image is built by Docker from
# packages/edge-rs (its own Rust toolchain stage), so this image needs none.
# NBO_EDGE_IMPL=rust opts in to it; the Node edge (packages/edge) is the default.
WORKDIR /app
COPY --from=builder /app /app
# Served by the control-plane (NBO_TERRAFORM_PROVIDER_DIR) for download.
COPY --from=provider /dist /app/terraform-provider/dist
# nbo-server: the operator's setup command (`docker compose exec nbo nbo-server ...`).
RUN chmod +x /app/packages/controlplane/dist/server-cli.js \
 && ln -s /app/packages/controlplane/dist/server-cli.js /usr/local/bin/nbo-server
# Fails the build, not the first deploy, if anything NBO calls is missing.
# Needs neither the network nor a Docker daemon.
RUN set -eu; \
    gcloud beta --help > /dev/null; \
    kubectl version --client > /dev/null; \
    docker --version > /dev/null; \
    docker buildx version > /dev/null; \
    git --version > /dev/null; \
    ssh -V 2> /dev/null; \
    pnpm --version > /dev/null; \
    test -f packages/controlplane/dist/main.js; \
    nbo-server help > /dev/null; \
    test -f packages/edge-rs/Dockerfile; \
    test -f packages/edge-rs/Cargo.lock; \
    for f in linux_amd64/terraform-provider-nbo_v0.1.0 linux_arm64/terraform-provider-nbo_v0.1.0 \
             darwin_amd64/terraform-provider-nbo_v0.1.0 darwin_arm64/terraform-provider-nbo_v0.1.0 \
             windows_amd64/terraform-provider-nbo_v0.1.0.exe; do \
      test -f "terraform-provider/dist/$f"; \
    done
EXPOSE 8081
# /data is a volume, so the temp folder has to be made after it is mounted.
CMD ["sh", "-c", "mkdir -p /data/tmp && exec node packages/controlplane/dist/main.js"]
