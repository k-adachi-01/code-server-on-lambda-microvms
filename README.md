# code-server on Lambda MicroVMs

An ephemeral, browser-based development environment that runs
[code-server](https://github.com/coder/code-server) inside a single **AWS Lambda MicroVM**.

A local TypeScript CLI launches one MicroVM, connects to code-server from a local browser
through a localhost-only authenticating reverse proxy, and lets you suspend, resume, and
terminate the session. There is no deployed control plane: the CLI calls the Lambda MicroVMs
APIs directly with your own short-lived AWS credentials. AWS CDK is used only for persistent
infrastructure (the MicroVM image build inputs and least-privilege IAM).

> **About this project**
> This is a submission for the [Kiro University Challenge 2026](https://kiro.dev/2026/university/).
> It was built with [Kiro](https://kiro.dev) — requirements, design, implementation plan, and
> code were produced through Kiro's spec-driven workflow.

## Scope

MVP: one user, one logical session, at most one active MicroVM.

Non-goals: multi-user support, a deployed control plane, workspace persistence beyond
suspend/resume, idle auto-suspend/resume, and speculative provider abstractions.

## How it works

```
Browser ──127.0.0.1──▶ Auth_Proxy ──HTTPS/WSS + JWE──▶ MicroVM endpoint ──▶ code-server
   ▲                      │                                                    (:8080)
   └── CLI commands ──────┘  (launch / status / connect / suspend / resume / terminate)
```

- The CLI owns the session lifecycle and reconciles local state against AWS (the source of truth).
- The **Auth_Proxy** runs in the foreground of `connect`, listens on `127.0.0.1` only, injects the
  AWS auth token the browser never sees, and gates access behind a one-time login secret.
- The MicroVM image starts code-server during the image build so it is captured in the snapshot.

Architecture and lifecycle details are in the spec (see [Project layout](#project-layout)).

## Prerequisites

- [Nix](https://nixos.org) with flakes enabled — supplies Node.js, pnpm, the AWS CDK CLI, and
  gitleaks at pinned versions.
- AWS credentials available through the standard AWS SDK credential provider chain (SSO
  recommended). The CLI never reads or writes credential files itself.
- The project's MicroVM image deployed once via CDK, and the Operator policy attached to the role
  you use.

## Getting started

```bash
# 1. Enter the pinned toolchain
nix develop

# 2. Install dependencies
pnpm install

# 3. (optional) enable the pre-commit hook: runs gitleaks + lint/format on staged files
vp hooks enable

# 4. Deploy persistent infrastructure (review the diff first — this creates AWS resources)
pnpm -C infra exec cdk diff
pnpm -C infra exec cdk deploy --outputs-file cdk-outputs.json

# 5. Import the deployed Image ARN / Region into the local config
pnpm csmvm config import

# 6. Attach the Operator_Policy (printed in the CDK outputs) to your SSO role.
```

`cdk deploy` / `cdk destroy` are intentionally run **without** auto-approval flags. Always review
`cdk diff` before applying.

## Usage

Run commands through the CLI (`csmvm`) inside `nix develop`.

| Command | What it does |
|---|---|
| `launch [--yes]` | Launch one MicroVM. Shows Image ARN, Region, and max duration for confirmation, then waits until code-server is ready and prints the proxy URL. |
| `status` | Print the reconciled session (ID, MicroVM ID, state, raw status, remaining duration, strays). Never mutates anything. |
| `connect` | Run the Auth_Proxy in the foreground and print a one-time login URL. Requires a running session. |
| `suspend` | Suspend the running MicroVM (stops compute charges). |
| `resume` | Resume the suspended MicroVM with the same files and identity. |
| `terminate [--yes] [--stray <id>]` | Terminate the MicroVM. `--stray <id>` cleans up an orphaned MicroVM on the project image. |
| `config import` | Fill the local config from `infra/cdk-outputs.json`. |

**Exit codes:** `0` success, user cancel, or already-terminated · `1` AWS or runtime failure ·
`2` validation error or a lifecycle rejection.

`launch` and `terminate` require confirmation. With no TTY and no `--yes`, they exit `2`.

### Connecting securely

`connect` prints a one-time login URL containing a per-connect secret. Opening it sets a
short-lived `HttpOnly; SameSite=Strict` session cookie and invalidates the secret. Without a valid
cookie the proxy returns `401`. Setting `proxy.localAuth: false` disables this and falls back to
plain localhost access — the CLI prints a warning when you do.

## Cost

- A running MicroVM incurs compute charges. `maximumDurationInSeconds` (default 7200 = 2h) is a hard
  upper bound on lifetime.
- A **suspended** MicroVM still incurs snapshot storage cost until you `terminate` it. `status`
  reminds you of this while suspended.
- Terminate the MicroVM when you are done. The `[ENV]` verification steps in `docs/ENV-CHECKLIST.md`
  list expected cost impact and cleanup commands.

## Configuration

Local config lives in `csmvm.config.json` (gitignored). Copy `csmvm.config.example.json` and fill
it, or run `config import` after a CDK deploy. The config holds the Region, Image ARN, duration
bounds, proxy settings, token settings, timeouts, and retry policy. It never contains credentials
or auth tokens.

## Development

Technology choices and conventions are fixed in [`.kiro/steering/tech.md`](.kiro/steering/tech.md).
In short: Nix supplies the environment, pnpm owns dependencies, and Vite+ is the JS/TS task runner.

```bash
pnpm check   # lint + format + typecheck (Oxlint / Oxfmt / tsc, via Vite+)
pnpm test    # Vitest + fast-check; runs with no AWS credentials and no network
pnpm build   # compile the CLI
```

The automated test suite needs no AWS access. Steps that touch real AWS are marked `[ENV]` and are
opt-in because they cost money.

## Project layout

```
src/core/    Pure lifecycle logic (no AWS SDK, fs, net, or process). Property-tested.
src/shell/   I/O: AWS adapter, state store, readiness probe, Auth_Proxy, redaction.
src/cli/     Command entry points and the effect interpreter.
image/        MicroVM image: Dockerfile, entrypoint, and the lifecycle hook handler.
infra/        CDK app: image build inputs and least-privilege IAM.
docs/         ENV checklist and Phase 0 findings.
.kiro/        Spec (requirements, design, tasks) and steering.
```

The authoritative documents, all under `.kiro/`:

- **Requirements** — `.kiro/specs/lambda-microvm-code-server/requirements.md`
- **Design** — `.kiro/specs/lambda-microvm-code-server/design.md`
- **Implementation plan** — `.kiro/specs/lambda-microvm-code-server/tasks.md`
- **Tech & conventions** — `.kiro/steering/tech.md`

## Security notes

- Credentials come only from the AWS SDK default chain; nothing is written to disk.
- The auth token lives in process memory only — never in the state file, logs, or browser-facing
  responses.
- The MicroVM image contains no secrets and no per-user build-time value.
- `gitleaks` runs pre-commit and in CI.
```
