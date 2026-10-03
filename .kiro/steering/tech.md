# Technology & Development Conventions

Practical rules for implementing this project. Follow them without re-litigating the choices.

## Toolchain roles

- **Nix flake devShell** supplies the environment: Node.js, pnpm, the AWS CDK CLI, and gitleaks, all at pinned versions. Run project commands inside `nix develop`.
- **pnpm** owns npm dependencies, `pnpm-lock.yaml`, the `packageManager` field, and the workspace. Install/add with `pnpm install` / `pnpm add` directly.
- **Vite+ (`vite-plus`)** is a project-local devDependency used only as the JS/TS task runner: `check`, `lint` (Oxlint), `fmt` (Oxfmt), `test` (Vitest), `build`, `pack`. Config lives in a single `vite.config.ts`.
- **`package.json` scripts** are the stable interface for humans, agents, and CI. Call `pnpm check`, `pnpm test`, etc.; those invoke project-local `vp`.

Do **not** use Vite+'s runtime or package-manager management: no `vp env`, `vp install`, `vp add`, or `setup-vp`. Node and pnpm come from Nix; dependencies come from pnpm.

## Language & build

- TypeScript everywhere (CLI, `image/hooks`, CDK).
- **CLI**: compile with `tsc` to JS and point `package.json` `bin` at the output. Do not bundle or make a standalone executable. In development, run `main.ts` with `vp node`; if its TS execution can't handle the code, fall back to project-local `tsx`.
- **`image/hooks`**: bundle to a single file via Vite+'s `pack` section (target/platform Node) so the MicroVM image carries no `node_modules` for the handler. It runs on the Node bundled with code-server. Only if the handler needs a specific Node version, switch to an independently pinned Node.
- **CDK**: separate pnpm workspace package under `infra/`. CLI from Nix, `aws-cdk-lib` / `constructs` exact-pinned in pnpm.

## Lint, format, and the core import boundary

- Lint = Oxlint, format = Oxfmt, both through Vite+. Do not add Biome, ESLint, or Prettier. (This overrides the global AGENTS.md "use Biome" rule for this repository.)
- `src/core/**` must import zero AWS SDK, `node:fs`, `node:net`, `node:http`, `node:https`, `node:process`, or `node:child_process`. Enforce it two ways:
  1. Oxlint `no-restricted-imports` scoped to `src/core/**`.
  2. The import-scan test `test/hygiene/core-imports.test.ts`. This test is the authoritative guard — if Oxlint can't express the rule, the test alone must still fail on violations.

## Testing

- Vitest (via `pnpm test` → `vp test`) + fast-check. Pin `vitest` to the exact version from `vp toolchain vitest`, and alias `vite` to `npm:@voidzero-dev/vite-plus-core@latest` in `pnpm-workspace.yaml` `overrides`, so the project and `vp test` share one Vitest.
- Property tests (`[PBT]`) run `numRuns >= 100` and live under `test/core/`. The pure core needs no fakes — the clock and IDs come in through `Ctx`.
- CLI/shell tests use `FakeMicrovms` (in-memory `MicrovmsPort`), a fake prompt, a fake TTY flag, a fake clock, and a temp dir. The real SDK client is never constructed in tests. The suite runs with no AWS credentials and no network.

## Dependencies & supply chain

- Exact-pin all deps. Commit `pnpm-lock.yaml`; install in CI with `--frozen-lockfile`.
- Known runtime/dev deps: `commander` (CLI arg parsing), `zod` (state-file schema, shell only), `ws` (proxy WebSocket), `@aws-sdk/client-lambda-microvms`.
- Confirmation prompts use `node:readline/promises` directly — no prompt library. Keep `isTTY` and the prompt function injectable for tests.
- `pnpm audit --audit-level=high` runs in CI and must pass; individually ignore only confirmed non-applicable advisories. `minimumReleaseAge` is not used.

## Git hooks

- The pre-commit hook is `.vite-hooks/pre-commit`; it runs `gitleaks protect --staged`, then the repo-hygiene check (`node scripts/hygiene.mjs --staged`), then `vp staged`. The user enables it with `vp hooks enable`.
- Never change git config. Do not add Husky or any other hook manager.

## Repository hygiene (public repo)

This repo is a public submission. Keep personal-environment values out of it, separate from secrets:

- **gitleaks = credentials/secrets only.** `.gitleaks.toml` detects tokens, keys, and other secrets. Do not add account-id / SSO-URL / profile-name / local-path rules to it.
- **A separate repo-hygiene check** (`scripts/hygiene.mjs`, exposed as `pnpm hygiene` for the full tree and `pnpm hygiene:staged` for staged changes) fails the pre-commit hook and CI on personal-environment values: AWS account ids (standalone and inside ARNs), AWS SSO start/portal URLs, local user paths (`/Users/<name>/`, `/home/<name>/`), and personal AWS profile names. Detection is by generic pattern — no real account id, SSO URL, username, or profile name is hardcoded. Obvious placeholders (`123456789012`, `/Users/<user>/`, `example.com`) are allowed. Profile-name detection uses a denylist that is **empty by default** in the committed check and is populated locally via the `CSMVM_HYGIENE_PROFILES` env var or a gitignored `.hygiene-profiles.local` file (one name per line) — so no real names ever enter the repo.
- **The public CDK must stay PoC-Sandbox-agnostic.** Committed `infra/` code must not embed sandbox specifics: `auto_delete` / `expires_at` lifecycle and sandbox tags are supplied by external deploy operations, not by committed code.
- **Kiro hooks are optional early-detection aids, not required guards.** The pre-commit hook and CI hygiene step are the authoritative guards.

## CI

- GitHub Actions on `ubuntu-24.04` (no macOS matrix). Install Nix with `DeterminateSystems/determinate-nix-action` pinned by commit SHA.
- Inside `nix develop --command`, run: `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test`, `pnpm audit --audit-level=high`, `gitleaks detect`.
- Vite+ task caching is not configured yet; add it only if CI time becomes a problem.

## Image (`image/`)

- Base container `public.ecr.aws/lambda/microvms:al2023-minimal`. code-server pinned to an exact version with SHA-256 verification; record the bundled Node version at build time and re-check hooks when code-server is bumped.
- git / curl / tini come from the AL2023 base image / pinned repos — no individual exact pin.
- The image contains no secrets and no per-user unique build-time value (build-time state is shared across all MicroVMs).

## AWS / Phase 0

- Several AWS facts are unverified and settled by the Phase 0 spike (see `tasks.md` section 1 and `requirements.md` "Assumptions and Open Questions"). Any AWS call that creates or deletes resources requires explicit user confirmation first; present a cost estimate before each costly spike.
