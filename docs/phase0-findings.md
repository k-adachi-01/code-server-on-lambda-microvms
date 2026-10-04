# Phase 0 findings

Real-environment spike results for `code-server-on-lambda-microvms`, run in the
PoC Sandbox account in `ap-northeast-1`. Observations are kept separate from the
decisions drawn from them. No account id, SSO URL, or other personal-environment
value is recorded here (public repo; see steering `tech.md`).

## S1 — Image build pipeline and snapshot restore (A-12, A-14)

### Observed

- **Credentials / region**: `aws sts get-caller-identity` through the sandbox
  runner succeeds; the account is a PoC Sandbox with `SandboxAdministratorAccess`.
  CDK is already bootstrapped in `ap-northeast-1` (`CDKToolkit` = CREATE_COMPLETE).
- **Base image ARN (A-12)**: `aws lambda-microvms list-managed-microvm-images`
  returns exactly one managed base image:
  `arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1`. This matches the
  region-derived form the CDK stack computes
  (`arn:aws:lambda:<region>:aws:microvm-image:al2023-1`). **A-12 base ARN:
  Verified.**
- **code-server pin (R13.6)**: code-server `4.96.4` linux-arm64 tarball SHA-256
  is `8471a70ac790ce43c302c43451e45eb2cf000a927db5bb2c8a9899b72e32fff6`. Set in
  the Dockerfile.
- **Docker image build**: the image initially failed to build locally because
  installing `curl` conflicts with the base image's `curl-minimal`, and the
  `al2023-minimal` base uses `microdnf` (no `--allowerasing`). After dropping
  the explicit `curl` package, the image **builds successfully for arm64** with
  the code-server SHA-256 verified and the bundled hook handler copied in.
- **CloudFormation `AWS::Lambda::MicrovmImage` build (A-12)**: deploying the
  image through CloudFormation **fails with `NotStabilized` after ~60 seconds**
  ("did not stabilize"), and the stack rolls back cleanly (no stranded
  resources). The ~60s window is shorter than a real image build (which runs the
  Dockerfile, boots code-server, and snapshots).
- **Builds do succeed in this account via the API**: `ListMicrovmImages` shows
  pre-existing images (e.g. `python-sandbox`) in `UPDATED` state with active
  versions — so the image-build service works; the failure is specific to the
  CloudFormation stabilization window, not the build itself.

### Decision

- **Build the MicroVM image via the direct `create-microvm-image` /
  `update-microvm-image` API with polling of `GetMicrovmImageBuild`, not through
  CloudFormation.** The CloudFormation `CfnMicrovmImage` resource times out
  stabilization (~60s) before a real build finishes. The CDK stack now owns only
  the persistent IAM (build role + Operator policy) and uploads the build
  context as an S3 asset; `scripts/build-image.mjs` drives the build via the API.
- **The MicroVM image built successfully** — version `4.0`, `state=SUCCESSFUL`,
  `status=ACTIVE` — after the real fixes below.

### Real fixes found only by deploying

1. **CDK CLI vs library**: the Nix CDK CLI 2.1004.0 cannot read
   `aws-cdk-lib@2.272.0`'s cloud-assembly schema (v54; needs CLI >= 2.1144.0).
   Pinned `aws-cdk@2.1144.0` as a project-local CLI.
2. **Dockerfile `curl` conflict**: installing `curl` conflicts with the base
   image's `curl-minimal`; `al2023-minimal` uses `microdnf` (no
   `--allowerasing`). Dropped the explicit `curl`.
3. **Build-context root**: the CDK S3 asset zips the *contents* of `image/`, so
   the Dockerfile is at the context root — `COPY` paths are
   `hooks/dist/handler.mjs` / `workspace-seed/` / `entrypoint.sh`, not
   `image/...`. Also moved to a **single-stage** Dockerfile (the service rejected
   a multi-stage build whose first stage used an external docker.io base image),
   pre-bundling the hook handler locally.
4. **No `tini` in the base** (contradicts the A-12 "tini from base" assumption):
   `/usr/bin/tini` is absent in `al2023-minimal`, so `ENTRYPOINT ["/usr/bin/tini",
   ...]` failed with "Failed to start container". The entrypoint now runs as the
   container init and `exec`s code-server as PID1. The build error progressed
   "container image build failed" -> "Failed to start container" -> SUCCESSFUL,
   confirming each fix.

### Observed (build success)

- Image version `4.0`: `ARM_64`, `GRAVITON` gen 4, baseImageVersion `1.0`.
- The service auto-attached an `INTERNET_EGRESS` network connector by default
  (consistent with Q-3: outbound internet works without extra configuration).
- Build duration a few minutes (IN_PROGRESS -> SUCCESSFUL). The terminal success
  state is `SUCCESSFUL` (not CREATED/AVAILABLE); the build script treats it so.

### Unverified / follow-up

- The exact `GetMicrovmImageBuild` status progression and build duration for
  this image (to set a sensible client-side poll timeout) — to be recorded when
  the API-driven build runs to completion.
- A-14 (snapshot restore: code-server works after resume) — not yet reached;
  depends on a completed image build + a launched MicroVM.
- The hook contract details (S1 port/path/timing) — the handler listens on
  :9000 and serves /run, /ready, /validate, /resume, /suspend, /terminate; the
  CloudFormation hook fields are ENABLED/DISABLED enums. Confirm against a real
  running MicroVM once the build path works.

### Affected items

- A-12 (base ARN): Verified.
- R13.6 (code-server exact version + SHA-256): Verified value recorded.
- A-12 (build pipeline via CloudFormation): **amended** — build via the direct
  API, not CFN.
- A-14 (snapshot restore): still Unverified (blocked on the build path).

## MCP-sourced correction — hook path contract (Lesson 6, S1 follow-up)

### How this was found (MCP actually used)

Using the project's own MCP server (`.kiro/powers/lambda-microvms/mcp.json` →
the official **MCP Proxy for AWS**, `uvx mcp-proxy-for-aws-cli`, control plane
`https://aws-mcp.us-east-1.api.aws/mcp`, `AWS_REGION=ap-northeast-1`), the agent:

1. `initialize` + `tools/list` → 8 tools returned (`aws___run_script`,
   `aws___search_documentation`, `aws___read_documentation`,
   `aws___retrieve_skill`, `aws___list_regions`,
   `aws___get_regional_availability`, `aws___get_presigned_url`,
   `aws___get_tasks`). Server identified itself as "MCP Proxy for AWS" v1.7.0.
2. `tools/call aws___search_documentation { search_phrase: "Lambda MicroVMs
   lifecycle RunMicrovm SuspendMicrovm hooks" }` → top result **"Running and
   using MicroVMs"**.

SigV4 auth for the AWS MCP endpoint used short-lived PoC-Sandbox credentials
from `aws-agent-lease` (read-only docs call; no AWS resource was created,
changed, or deleted).

### What the official doc said

> Hooks listen on the path `/aws/lambda-microvms/runtime/v1/<hook-name>` on the
> port you configure. Your MicroVM begins receiving external traffic after the
> `/run` hook returns HTTP 200.

Hook names and timing confirmed: `run` (traffic gate), `resume` (VM stays
`SUSPENDED` until it returns), `suspend`, `terminate` (final only), plus the
image-build hooks `ready` / `validate`.

### Bug this surfaced (and fixed)

`image/hooks/src/handler.ts` matched on the **bare** path (`req.url === "/run"`
etc.). In production Lambda POSTs to
`/aws/lambda-microvms/runtime/v1/run`, which would never match — so every hook,
including the traffic-gating `/run`, would have fallen through to the default
immediate-200 branch and the health check would never run. Fixed by parsing the
hook name from the official prefix (`hookNameFromPath` /
`HOOK_PATH_PREFIX = "/aws/lambda-microvms/runtime/v1/"`), with the bare form kept
as a fallback for local probes/tests. This closes the S1 "hook path contract"
follow-up that was previously listed as unverified.

### Affected items

- S1 hook path/timing contract: **Verified against official AWS docs via MCP**
  (path prefix `/aws/lambda-microvms/runtime/v1/`, `/run` is the traffic gate).
- `image/hooks` handler: corrected to match the official path prefix.
