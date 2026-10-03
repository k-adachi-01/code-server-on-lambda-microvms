# MicroVM image for code-server (R13.1, R13.5-R13.7, R5.4; A-12, A-14).
#
# SINGLE-STAGE from the AWS-managed AL2023 base. Phase 0 S1 finding: the MicroVM
# image build service failed on a multi-stage build whose first stage used an
# external (docker.io) base image. The build runs FROM the managed base only, so
# the hook handler is bundled LOCALLY (image/hooks -> dist/handler.mjs) and
# copied into the context before upload; no npm/pnpm runs during the image build.
#
# The entrypoint starts code-server at IMAGE BUILD TIME (as the container init;
# no tini — see below) so the running
# process is captured in the Firecracker snapshot (A-14) and every MicroVM
# resumes from it. The image holds NO secret and NO per-user build-time value
# (R13.5, R13.7): no code-server password, session secret, or keys.

FROM public.ecr.aws/lambda/microvms:al2023-minimal

# code-server pinned to an exact version with a verified SHA-256 (R13.6).
ARG CODE_SERVER_VERSION=4.96.4
ARG CODE_SERVER_SHA256=8471a70ac790ce43c302c43451e45eb2cf000a927db5bb2c8a9899b72e32fff6

# Runtime packages. curl is already present as curl-minimal in the base; it is
# not reinstalled (that caused a curl/curl-minimal conflict). The base uses
# microdnf with a limited flag set.
RUN dnf install -y git tar gzip shadow-utils nodejs && dnf clean all

# Download and verify code-server, then install it.
RUN curl -fsSL -o /tmp/code-server.tar.gz \
      "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-arm64.tar.gz" \
 && echo "${CODE_SERVER_SHA256}  /tmp/code-server.tar.gz" | sha256sum -c - \
 && mkdir -p /opt/code-server \
 && tar -xzf /tmp/code-server.tar.gz -C /opt/code-server --strip-components=1 \
 && ln -s /opt/code-server/bin/code-server /usr/local/bin/code-server \
 && rm /tmp/code-server.tar.gz

# Non-root user with an empty workspace (Q-5).
RUN useradd --create-home --uid 1000 coder \
 && mkdir -p /home/coder/workspace \
 && chown -R coder:coder /home/coder
COPY --chown=coder:coder workspace-seed/ /home/coder/workspace/

# The hook handler, pre-bundled locally to a single file (no node_modules).
COPY hooks/dist/handler.mjs /opt/csmvm/hook-handler.mjs

COPY entrypoint.sh /opt/csmvm/entrypoint.sh
RUN chmod +x /opt/csmvm/entrypoint.sh

USER coder
WORKDIR /home/coder
EXPOSE 8080 9000

# No tini in the AL2023 base (Phase 0 S1 finding — the A-12 "tini from base"
# assumption was wrong). The entrypoint runs as the container init and execs
# code-server as the foreground process.
ENTRYPOINT ["/opt/csmvm/entrypoint.sh"]
