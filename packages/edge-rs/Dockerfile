# The NBO edge: a static Rust binary in a distroless image.
# Build context: packages/edge-rs (the control-plane runs
# `docker build -f packages/edge-rs/Dockerfile packages/edge-rs`).
FROM rust:1.96-bookworm AS build
WORKDIR /src
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
# Dependency layer: build a dummy crate first, so editing src/ does not
# rebuild every dependency.
RUN mkdir src \
 && echo 'fn main() {}' > src/main.rs \
 && touch src/lib.rs \
 && cargo build --release --locked --bin nbo-edge \
 && rm -rf src target/release/nbo-edge target/release/deps/nbo_edge* target/release/deps/libnbo_edge* target/release/.fingerprint/nbo-edge-*
COPY assets ./assets
COPY src ./src
RUN cargo build --release --locked --bin nbo-edge \
 && strip target/release/nbo-edge

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/nbo-edge /nbo-edge
EXPOSE 8080 8443 9444
ENTRYPOINT ["/nbo-edge"]
