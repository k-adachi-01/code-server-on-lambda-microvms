---
inclusion: manual
---

# Project conventions (lambda-microvms power)

A compact restatement of the repository's binding conventions so they also apply when this power
is active. The authoritative source is `.kiro/steering/tech.md`; if anything here conflicts with
it, `tech.md` wins.

## Toolchain

- **Nix** supplies the environment (Node, pnpm, AWS CDK CLI, gitleaks at pinned versions). Run
  project commands inside `nix develop`.
- **pnpm** owns dependencies and `pnpm-lock.yaml`. Install with `pnpm install` / `pnpm add`. Never
  use npm, `npx`, pip, or commit `package-lock.json`.
- **Vite+ (`vp`)** is the JS/TS task runner only. Use the `package.json` scripts as the stable
  interface: `pnpm check`, `pnpm test`, `pnpm build`. Do not use `vp env` / `vp install` / `vp add`.
- Lint = Oxlint, format = Oxfmt (via Vite+). Do not add Biome, ESLint, or Prettier. Do not add
  Husky or any other git-hook manager.

## The core import boundary (hard rule)

`src/core/**` must import **zero** `@aws-sdk/*`, `node:fs`, `node:net`, `node:http`, `node:https`,
`node:process`, or `node:child_process`. Enforced by Oxlint `no-restricted-imports` and by
`test/hygiene/core-imports.test.ts` (authoritative). Side effects and the AWS SDK belong in
`src/shell/**`; the clock and IDs enter core through `Ctx`.

## Testing

Vitest + fast-check via `pnpm test`. The suite runs with **no AWS credentials and no network**.
Property tests (`[PBT]`) use `numRuns >= 100` and live under `test/core/`. CLI/shell tests use
in-memory fakes (`FakeMicrovms`, fake prompt, fake TTY, fake clock, temp dir) — never construct the
real SDK client in tests.

## AWS safety (PoC Sandbox)

Any AWS call that **creates or deletes** resources requires explicit user confirmation first, with
a cost estimate: `cdk deploy` / `cdk destroy`, and the `launch` / `terminate` CLI commands. Several
AWS facts are unverified and settled by the Phase 0 spike — prefer `aws___search_documentation`
and `aws___retrieve_skill` over improvising. `cdk deploy`/`destroy` run without auto-approval
flags; always review `cdk diff` first.

## Public-repo hygiene

This is a public submission. Keep personal-environment values out of the repo, separate from
secrets:

- **gitleaks** owns credentials/secrets only.
- The **repo-hygiene check** (`scripts/hygiene.mjs`, `pnpm hygiene` / `pnpm hygiene:staged`) fails
  on AWS account ids, SSO start/portal URLs, local user paths (`/Users/<name>/`, `/home/<name>/`),
  and personal profile names. Use placeholders only (`123456789012`, `/Users/<user>/`,
  `example.com`).
- The committed CDK must stay PoC-Sandbox-agnostic: no `auto_delete` / `expires_at` lifecycle or
  sandbox tags in committed `infra/` code.
