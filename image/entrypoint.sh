#!/usr/bin/env bash
# MicroVM entrypoint (R5.4, R13.1, A-14). Starts the lifecycle Hook_Handler and
# code-server. Runs during the image build so the running code-server process is
# captured in the Firecracker snapshot and every MicroVM resumes from it.
#
# --auth none is used only because Phase 0 S1/S3 must confirm the endpoint
# enforces JWE auth before this is relied upon; if S3 shows otherwise, switch to
# the code-server password fallback set per VM at run time (never baked in here).
set -euo pipefail

CODE_SERVER_PORT="${CSMVM_CODE_SERVER_PORT:-8080}"

# Start the hook handler (separate port; Phase 0 S1 confirms the real contract).
node /opt/csmvm/hook-handler.mjs &

# Start code-server in the foreground. No password / secret is generated here.
exec code-server \
  --auth none \
  --bind-addr "0.0.0.0:${CODE_SERVER_PORT}" \
  --disable-telemetry \
  /home/coder/workspace
