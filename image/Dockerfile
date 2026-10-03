# MicroVM image for code-server (R13.1, R13.5-R13.7, R5.4; A-12, A-14).
#
# Multi-stage:
#   1. hooks   compile+bundle the lifecycle Hook_Handler to a single JS file.
#   2. runtime AL2023 base, code-server pinned by exact version + SHA-256,
#      non-root coder user, empty workspace. The entrypoint starts code-server
#      at IMAGE BUILD TIME under tini so the running process is captured in the
#      Firecracker snapshot (A-14) and every MicroVM resumes from it.
#
# The image holds NO secret and NO per-user build-time value (R13.5, R13.7):
# no code-server password, session secret, or keys are generated here.

# ---- stage 1: bundle the hook handler ----
FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS hooks
WORKDIR /build
COPY image/hooks/package.json ./package.json
# The bundle has no runtime node_modules; install only the dev bundler.
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate && pnpm install --no-frozen-lockfile
COPY image/hooks/src ./src
RUN pnpm run build && test -f dist/handler.mjs

# ---- stage 2: runtime ----
FROM public.ecr.aws/lambda/microvms:al2023-minimal AS runtime

# code-server pinned to an exact version with a verified SHA-256 (R13.6).
# Bump both together; re-check the hook handler against the bundled Node when
# code-server is upgraded.
ARG CODE_SERVER_VERSION=4.96.4
ARG CODE_SERVER_SHA256=0000000000000000000000000000000000000000000000000000000000000000

# Runtime packages (git, curl, tini) come from the AL2023 base / pinned repos.
RUN dnf install -y git curl tar gzip shadow-utils nodejs && dnf clean all

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
COPY --chown=coder:coder image/workspace-seed/ /home/coder/workspace/

# The bundled hook handler (single file, no node_modules).
COPY --from=hooks /build/dist/handler.mjs /opt/csmvm/hook-handler.mjs

COPY image/entrypoint.sh /opt/csmvm/entrypoint.sh
RUN chmod +x /opt/csmvm/entrypoint.sh

USER coder
WORKDIR /home/coder
EXPOSE 8080 9000

# tini is PID 1; the entrypoint starts the hook handler and code-server. This
# runs during the image build so the snapshot captures code-server already
# serving (A-14).
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/csmvm/entrypoint.sh"]
