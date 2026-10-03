---
name: lambda-microvms
description: Build and operate this repository — a local TypeScript CLI (csmvm) that runs code-server inside a single AWS Lambda MicroVM. Use when working on this project's CLI, core lifecycle, shell adapters, MicroVM image, CDK infra, or when the user mentions Lambda MicroVMs, code-server, csmvm, or the Auth_Proxy.
---

# Lambda MicroVMs — code-server project skill

A specialized power for the `code-server-on-lambda-microvms` project: an ephemeral,
browser-based development environment that runs [code-server](https://github.com/coder/code-server)
inside a single **AWS Lambda MicroVM**. A local TypeScript CLI launches one MicroVM, connects to
code-server through a localhost-only authenticating reverse proxy, and lets you suspend, resume,
and terminate the session.

This skill carries **repository-specific** knowledge. It does **not** duplicate the AWS-maintained
Lambda MicroVMs skill — retrieve that on demand through the bundled AWS MCP Server (see below).

## Use the AWS MCP Server first

This power bundles the **Agent Toolkit for AWS** AWS MCP Server (`aws-mcp` in `mcp.json`). Lambda
MicroVMs is a newer AWS service that is often missing or stale in model training data. Before you
reason about MicroVM APIs, IAM shapes, or regional behavior, use the MCP tools:

- `aws___retrieve_skill` — pull the official **AWS Lambda MicroVMs skill** (step-by-step build /
  run / suspend / resume / terminate procedures) on demand.
- `aws___search_documentation` / `aws___read_documentation` — current MicroVMs / Lambda docs.
- `aws___list_regions` / `aws___get_regional_availability` — confirm service/region availability.
- `aws___run_script` — run a Python script in an isolated AWS sandbox for multi-step operations.

Authentication uses the local AWS SDK credential chain (SSO recommended). Documentation search and
skill discovery work **without** credentials; any API-executing tool needs credentials and will
fail with "No AWS credentials" until you sign in.

### Region note

The AWS MCP Server here is configured with `--metadata AWS_REGION=ap-northeast-1` (Tokyo). That is
the **MCP operating region**, which is distinct from the **project runtime region** in
`csmvm.config.json` (the example config ships `us-east-1`). Keep the two separate: changing one
does not change the other. Lambda MicroVMs is GA in Tokyo (one of the original launch regions).

## What this project is (and is not)

**MVP scope:** one user, one logical session, at most one active MicroVM. There is **no deployed
control plane** — the CLI calls the Lambda MicroVMs APIs directly with the user's own short-lived
AWS credentials. CDK is used only for persistent infrastructure (the MicroVM image build inputs
and least-privilege IAM).

**Non-goals (do not add without an explicit request):** multi-user support, a deployed control
plane, workspace persistence beyond suspend/resume, idle auto-suspend/resume, and speculative
provider abstractions.

## Architecture

```
Browser ──127.0.0.1──▶ Auth_Proxy ──HTTPS/WSS + JWE──▶ MicroVM endpoint ──▶ code-server (:8080)
   ▲                      │
   └── CLI commands ──────┘  (launch / status / connect / suspend / resume / terminate)
```

- The CLI owns the session lifecycle and reconciles local state against AWS (AWS is the source of
  truth).
- The **Auth_Proxy** runs in the foreground of `connect`, listens on `127.0.0.1` only, injects the
  AWS auth token the browser never sees, and gates access behind a one-time login secret
  (short-lived `HttpOnly; SameSite=Strict` cookie; `401` without it). `proxy.localAuth: false`
  disables this and the CLI prints a warning.
- The MicroVM image starts code-server during the image **build** so it is captured in the snapshot.

## csmvm CLI surface

Run through the `csmvm` bin inside `nix develop`.

| Command | What it does |
|---|---|
| `launch [--yes]` | Launch one MicroVM. Prints Image ARN, Region, max duration for confirmation, waits for code-server readiness, prints the proxy URL. |
| `status` | Print the reconciled session; never mutates. |
| `connect` | Run the Auth_Proxy in the foreground; print a one-time login URL. Requires a running session. |
| `suspend` | Suspend the running MicroVM (stops compute charges). |
| `resume` | Resume the suspended MicroVM with the same files and identity. |
| `terminate [--yes] [--stray <id>]` | Terminate the MicroVM. `--stray <id>` cleans up an orphaned MicroVM on the project image. |
| `config import` | Fill local config from `infra/cdk-outputs.json`. |

**Exit codes:** `0` success / user cancel / already-terminated · `1` AWS or runtime failure ·
`2` validation error or lifecycle rejection. `launch` and `terminate` require confirmation; with no
TTY and no `--yes` they exit `2`.

## Code boundaries (enforced)

- `src/core/**` is **pure**: no `@aws-sdk/*`, `node:fs`, `node:net`, `node:http(s)`, `node:process`,
  or `node:child_process`. Enforced by Oxlint and by `test/hygiene/core-imports.test.ts` (the
  authoritative guard). The clock and IDs enter core through `Ctx`.
- All I/O lives in `src/shell/**`: the AWS adapter (`@aws-sdk/client-lambda-microvms`), state store,
  readiness probe, Auth_Proxy, redaction.
- `src/cli/**` holds command entry points and the effect interpreter.

When adding MicroVM behavior, keep decision logic in `core` and side effects in `shell`; do not
reach for the AWS SDK from `core`.

## Toolchain (see `.kiro/steering/tech.md` — authoritative)

Nix supplies the environment; pnpm owns dependencies; Vite+ is the JS/TS task runner. Use the
`package.json` scripts: `pnpm check`, `pnpm test`, `pnpm build`. The test suite runs with **no AWS
credentials and no network**. Do not add Biome / ESLint / Prettier, Husky, or npm/pip usage.

## Safety

Any AWS call that creates or deletes resources (`cdk deploy`/`destroy`, `launch`, `terminate`)
requires explicit user confirmation first, with a cost estimate — this is a PoC Sandbox project and
several AWS facts are settled only by the Phase 0 spike. A **suspended** MicroVM still incurs
snapshot storage cost until `terminate`. This is a public repository: never commit account ids,
SSO URLs, local user paths, or personal profile names (use placeholders like `123456789012`).
