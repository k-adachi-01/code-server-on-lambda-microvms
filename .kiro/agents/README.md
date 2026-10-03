# Project Custom Agents

Three project-level custom agents live in this directory. They exist because the
work this project involves splits into modes whose **required capabilities are
genuinely different** — not because custom agents are a feature to tick off.
Giving one agent every capability would mean a reviewer that can also rewrite the
code it reviews, and ordinary coding sessions that can also delete billable AWS
resources. These agents keep those capabilities apart.

## Responsibility split (the mental model)

| Layer | Owns |
|---|---|
| **Steering** (`.kiro/steering/`) | Project-wide judgment principles that apply to *every* agent. |
| **Hooks / lint / hygiene / CI** | Enforcing repository invariants (import boundary, formatting, secret/hygiene scans). Authoritative. |
| **Custom agents** (this dir) | Changing the *capabilities, permissions, and context* available in a specific workflow. |
| **IAM** | The final, hard security boundary for anything that touches AWS. |

A custom agent is **not** a security boundary and **not** an invariant enforcer.
It shapes what a working mode can see and attempt. The guarantees still come from
IAM (for AWS) and from Oxlint / the hygiene scan / the test suite / CI (for the
codebase).

| Agent | What it changes vs a normal agent | Primary purpose |
|---|---|---|
| `aws-operator` | **Adds** AWS mutation capability | privilege elevation |
| `architecture-reviewer` | **Removes** all mutation capability | independent review |
| `experiment-runner` | **Adds** AWS capability + experiment context + evidence workflow | environment specialization |

`aws-operator` and `experiment-runner` are deliberately **not** merged: the first
is a capability boundary ("operate AWS safely"), the second is a workflow
boundary ("complete a Phase 0 / ENV experiment under one protocol"). They can use
the same AWS MCP server and still be different responsibilities.

## Invocation

Start a session with one of these agents, or switch mid-session:

```bash
kiro-cli --agent aws-operator        # or architecture-reviewer / experiment-runner
```
```text
> /agent swap
```

Project-level agents here take precedence over any same-named global agent.

---

## `aws-operator`

- **Purpose.** Operate AWS: CDK `diff`/`deploy`/`destroy`/`bootstrap` and the
  MicroVM lifecycle (`csmvm launch/suspend/resume/terminate`, `status`). It
  operates AWS; it does not implement features.
- **Why a custom agent.** AWS mutation capability should not sit in the ordinary
  coding tool surface, where it is one autocomplete away during unrelated work.
  This agent is a *privilege-elevation profile*: switching to it is the explicit,
  visible act of entering "I am about to change real, billable AWS" mode, with
  the AWS MCP server, AWS-related shell, and AWS operating context all turned on
  together.
- **Why not Steering.** Steering is advice shared by all agents; it cannot remove
  `write` or scope the tool surface. "Only AWS operation tools are present" is a
  tool-surface fact, which only an agent config can set.
- **Why not Hooks.** A hook can react to an event, but it cannot switch the set of
  available tools or MCP servers per working mode. Mode selection is the agent's
  job.
- **Tools / permissions.** `read`, `shell`, and the `aws-mcp` MCP server; **no**
  `write`, no unrelated MCP, powers off. Safe inspection (`git status/diff`, `cdk
  diff`, `csmvm status`, `sts get-caller-identity`) is allowed; AWS MCP calls and
  known mutation entry points are `ask`; confirmation-bypass and destructive forms
  (`--yes`, `--require-approval never`, `--force`, `sudo`, `rm -rf`) are `deny`.
- **Security boundary.** The permission rules are workflow-level capability
  isolation, **not** security. IAM (the profile/role credentials for the session)
  is the final boundary. Shell string-matching cannot catch every AWS mutation,
  and the AWS MCP server can call APIs directly — so IAM, not these rules, is what
  actually authorizes.
- **When to use.** You intend to deploy/destroy infra or run the MicroVM lifecycle
  against a real account.
- **When not to use.** Writing or changing code (it has no `write` — it will tell
  you to switch to the coding agent); running a structured Phase 0 experiment (use
  `experiment-runner`).

## `architecture-reviewer`

- **Purpose.** Independent, read-only review of architecture, tests, and security
  invariants, returning a classified set of findings.
- **Why a custom agent.** Separation of duties: the reviewer must not be able to
  silently rewrite the code under review. The guarantee comes from *reducing
  capability* — this agent has only `read`. That is a property of the agent's tool
  surface, not something advice or a hook can impose on a session.
- **Why not Steering.** Steering can say "review carefully" but cannot take away
  `write`/`shell`. "Cannot implement" has to be a capability fact.
- **Why not Hooks.** Hooks can *run* checks (and this project already does, in the
  pre-commit hook and CI), but they cannot remove write capability from a review
  session. Running checks and being unable to edit are different things; the
  latter is the agent's contribution.
- **Tools / permissions.** `read` only. No `write`, `shell`, AWS MCP, or
  sub-agent. Those capabilities are also explicitly denied as defense in depth.
  It does not get `shell` "just to run tests" — a shell can mutate the filesystem,
  which would weaken the "cannot implement" boundary; instead it names the
  verification commands (`pnpm check`, `pnpm test`, `pnpm hygiene`) for a human or
  the coding agent to run, and may use existing CI/test output as evidence.
- **Security boundary.** Read-only; it cannot change anything. It reviews the
  codebase's own security invariants (credential handling, token leakage, repo
  hygiene, confirmation bypass) but enforces nothing itself — Oxlint, the hygiene
  scan, the tests, and CI remain authoritative.
- **When to use.** Reviewing a change for architecture/test/security invariants
  with a true separation of duties.
- **When not to use.** Any time you want fixes applied — it will not apply them;
  it returns findings for the coding agent.

## `experiment-runner`

- **Purpose.** Execute Lambda MicroVMs Phase 0 / ENV verification experiments
  under a fixed protocol (hypothesis → cost gate → confirmed execution → evidence
  → cleanup → findings/spec update).
- **Why a custom agent.** Phase 0 is not ordinary coding: it uses real AWS, costs
  money per run, is confirmation-gated, has budget caps, needs cleanup, and feeds
  results back into `requirements.md` / `design.md`. Binding the AWS capability,
  the experiment context, the write scope (findings/spec only), and the protocol
  into one mode is exactly what a custom agent is for.
- **Why not Steering.** Steering cannot specialize the AWS tool surface or confine
  `write` to the findings/spec files — both are tool-surface/permission facts.
- **Why not Hooks.** A hook can fire a command, but it cannot carry per-experiment
  context or sequence the experiment workflow (cost gate, evidence rules, cleanup
  as a completion condition). That lifecycle lives in the agent's prompt.
- **Tools / permissions.** `read`, `write`, `shell`, `web`, and `aws-mcp`.
  Critically, `write` is **allowed only** for experiment records and the spec
  (`docs/phase0-findings.md`, `docs/env-results.md`, `docs/ENV-CHECKLIST.md`, and
  the three spec files) and **denied** for `src/**`, `infra/**`, `image/**`, and
  `test/**`. AWS mutation entry points are `ask`; bypass/destructive forms are
  `deny`.
- **Security boundary.** Same as `aws-operator`: permissions are a workflow
  speed-bump, **IAM is the real boundary**, and (if the AWS MCP proxy was started
  `--read-only`) that is a separate, independent layer that must not be assumed on.
- **When to use.** Running a Phase 0 spike (S1–S8) or the ENV end-to-end checklist
  and recording the evidence.
- **When not to use.** Making the implementation change an experiment reveals
  (record the finding and hand it to the coding agent); routine AWS operation
  outside the experiment protocol (use `aws-operator`).

---

## Notes, prerequisites, and limitations

- **AWS MCP server name.** These agents reference the `aws-mcp` server provided by
  the project's `lambda-microvms` Power (`.kiro/powers/lambda-microvms/mcp.json`).
  They intentionally do **not** set `includeMcpJson: true` (that would expose
  unrelated MCP servers such as Linear or Playwright) and do **not** re-declare the
  server inline (that would bake a personal AWS profile name into this public
  repo). Whether a Power-provided MCP server is visible to a custom agent depends
  on the Kiro runtime wiring the Power into the session; if `@aws-mcp` is not
  available in your session, enable the Power (or add an `aws-mcp` entry to your
  own, un-committed MCP settings) before using the AWS-operating agents.
- **No personal environment values.** No account id, SSO URL, local path, or AWS
  profile name appears in these files. Which credentials/profile a session uses is
  decided by your local AWS configuration and governed by IAM.
- **AWS MCP mutation consent.** If the AWS MCP proxy is run with `--read-only`, it
  disables non-read-only tools — an independent defense layer from both Kiro
  permissions and IAM. This is **not** assumed to be enabled here; confirm it per
  session if you want to rely on it.
- **Permissions are not exhaustive.** The shell `ask`/`deny` rules match known
  command spellings. They cannot classify every possible AWS mutation, so they are
  a reminder/speed-bump layered on top of IAM, never a replacement for it.
- **Hooks responsibility is not duplicated.** None of these agents re-implements
  the pre-commit hook or CI checks; invariant enforcement stays with those.
- **IDE + CLI.** The configs are written to work in both. Agent-level `hooks` are a
  CLI-only feature and are intentionally not relied on here for any guarantee.
