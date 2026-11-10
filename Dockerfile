# Build the server in a Rust image; ship only the binary and its runtime libs.
FROM rust:1.91-slim-bookworm AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential pkg-config \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY baton-server/Cargo.toml baton-server/Cargo.lock ./
RUN mkdir -p src \
 && printf 'fn main() {}\n' > src/main.rs \
 && cargo build --release \
 && rm -rf src
COPY baton-server/src ./src
# The dummy build above leaves a newer artifact; force this package to rebuild.
RUN find src -type f -exec touch {} + && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 baton \
 && useradd -u 10001 -g 10001 -M -s /usr/sbin/nologin baton
COPY --from=build /src/target/release/baton-server /usr/local/bin/baton-server
USER 10001:10001
ENV BATON_DB=/data/baton.db
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/bin/sh", "-c", "umask 077; exec /usr/local/bin/baton-server"]
