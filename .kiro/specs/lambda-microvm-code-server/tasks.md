# Implementation Plan: lambda-microvm-code-server

## Overview

The implementation is TypeScript throughout (CLI, Hook_Handler, CDK). Work proceeds in this order:

0. Phase 0 real-environment spike (S1–S8) to settle the unverified A-n / Q-n items.
1. Repository scaffold and hygiene.
2. Pure Lifecycle_Core (`src/core/`), with fast-check property tests (P1–P17).
3. I/O shell: State store, AWS_Adapter and fake, effect interpreter, CLI commands, readiness probe, and Auth_Proxy.
4. Image (`image/`).
5. Infrastructure (`infra/`, CDK) with assertion tests.
6. Docs (ENV checklist and README).
7. Final opt-in ENV end-to-end verification.

Phase 0 runs early. Tasks that only touch pure core or local tooling (scaffold, `src/core/`, State store, redaction) do not depend on spike results and can run in parallel with it. Tasks that depend on a spike result say so in their bullets: adapter field names, error classification, hook contract, IAM statements, and the duration cap.

Every Phase 0 task, and the final ENV task, is gated. It **requires explicit user confirmation before any AWS call that creates or deletes resources** (including `cdk bootstrap`, `cdk deploy`, `cdk destroy`, RunMicrovm, and TerminateMicrovm). Phase 0 runs in `ap-northeast-1`. Phase 0 budget (user-confirmed): at most 3 concurrent MicroVMs, each with `maximumDurationInSeconds = 1800`. Before each costly spike, present a cost estimate based on the Lambda MicroVMs pricing page (compute time, snapshot storage, image build) and get approval for that spike; spikes are approved one at a time. Spike scripts never print Auth_Token values. Each spike records its result in `docs/phase0-findings.md` and updates the affected A-n / Q-n status and R-n criteria in `requirements.md`.

## Tasks

- [~] 1. Phase 0: Real-environment verification spike
  - Status note (corrected): implemented pragmatically rather than via a separate throwaway `spike/` package. **Only S1 was actually run as a real experiment.** S1 (image build + snapshot restore, A-12/A-14) was verified on real AWS in `ap-northeast-1` using the actual `infra/` stack and `scripts/build-image.mjs`, with findings in `docs/phase0-findings.md`.
  - The remaining spikes **S2–S8 were NOT verified.** The task 17 run was a happy-path lifecycle smoke test (launch → RUNNING → endpoint `/healthz` 200 → suspend → resume → terminate); it does **not** establish the S2–S8 facts, which each require a specific negative or boundary probe that was never performed:
    - S2 (networking / least-privilege Operator_Policy / PassNetworkConnector / Execution_Role): not isolated.
    - S3 (endpoint authentication: unauthenticated / malformed / wrong-port token must be rejected): **NOT verified.** This is a hard, explicitly stated prerequisite for every task 13.x — the image ships `--auth none` on the strength of S3. Because S3 is unverified, the `--auth none` decision in task 13 rests on an unconfirmed assumption and must be re-checked before relying on this image for anything exposed.
    - S4 (code-server through a prototype proxy; idle WebSocket keepalive): not verified against the real endpoint.
    - S5 (suspend/resume file + process preservation): file survival was implied by the smoke test but not asserted via a saved-file check; process survival not measured.
    - S6 (wrong-state error names for the adapter classifier): not recorded; the classifier uses assumed names.
    - S7 (post-termination visibility / notFound grace): not measured.
    - S8 (clientToken idempotency, idle-policy bounds, GetMicrovm field names): not probed; GetMicrovm fields are derived defensively (endpoint + startedAt/max-derived remaining) rather than confirmed.
  - Net: treat task 1 as **partially done (S1 only)**. The CLI/proxy/image are built and the happy path works on real AWS, but the S2–S8 assumptions remain unverified and should not be cited as confirmed.
  - [ ] 1.1 Create the throwaway spike harness and findings template
    - Create `spike/` with its own `package.json` (pinned `tsx`, `@aws-sdk/client-lambda-microvms`, `aws-cdk-lib`). It is not part of the pnpm workspace and is deleted in 1.10.
    - Add a minimal CDK app in `spike/` with a tiny Dockerfile and a hook stub that logs method, path, and port for every request and returns 200.
    - Add small scripts: run, get, list, suspend, resume, terminate, and create-token, all reading Region and Image ARN from env vars. Each script prints a cost note and requires `--confirm` for create or delete calls.
    - Create `docs/phase0-findings.md` with one section per S1–S8 (experiment, raw result, decision, affected A-n / R-n).
    - No AWS calls in this task.
    - _Requirements: R16.7 (supports A-2, A-4, A-6, A-7, A-9–A-13, Q-2, Q-4)_

  - [x] 1.2 S1: Verify the image build pipeline and snapshot restore (A-12, A-14)
    - Done (real AWS, `ap-northeast-1`): image built via API-driven path (`scripts/build-image.mjs` → CreateMicrovmImage/UpdateMicrovmImage + poll GetMicrovmImageBuild), reaching `SUCCESSFUL`/`ACTIVE` (version v4.0). code-server is started during the build so it is captured in the snapshot; after RunMicrovm the endpoint `/healthz` returned HTTP 200 (A-14 confirmed). Base image ARN confirmed region-derived: `arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1`. Findings in `docs/phase0-findings.md`.
    - Deviation from plan: image build is driven by direct API, not `CfnMicrovmImage` CloudFormation (CFN stabilization timed out ~60s with NotStabilized/rollback). The CDK stack owns only IAM + the S3 asset; CFN-based image is kept behind `-c buildImageInCfn=true`.
    - Requires explicit user confirmation before any AWS call that creates or deletes resources. Record the result in `docs/phase0-findings.md` and update the affected A-n / R-n.
    - Run `cdk bootstrap` only if `ap-northeast-1` is not bootstrapped (confirmed). Review `cdk diff`, then deploy the spike stack in `ap-northeast-1` with manual approval. The spike Dockerfile uses `public.ecr.aws/lambda/microvms:al2023-minimal`, the Image uses `minimumMemoryInMiB: 2048`, and the build role gets only `s3:GetObject` at first.
    - Start code-server during the build so it is captured in the snapshot. Run one MicroVM and confirm code-server works after restore (A-14); record whether any per-VM value must be restored in the `/run` hook.
    - Record the hook port, path prefix, and timing contract, and any extra build-role permissions (KMS, logs).
    - If hooks share the Code_Server_Port, apply the R13.1 front-process amendment.
    - _Requirements: R13.1, R13.2, R13.3, R13.4, R13.7, R14.1, R14.6_

  - [ ] 1.3 S2: Verify default networking, PassNetworkConnector, and Execution_Role need (Q-3, A-13, Q-4)
    - Requires explicit user confirmation before any AWS call that creates or deletes resources. Record the result in `docs/phase0-findings.md` and update the affected A-n / R-n.
    - Call RunMicrovm (`maximumDurationInSeconds = 1800`) with the draft Operator_Policy, which omits `lambda:PassNetworkConnector`, without `executionRoleArn`, and with no network connectors.
    - Check that the MicroVM_Endpoint is reachable and outbound internet works. If the endpoint is unreachable, retry passing only `ALL_INGRESS`; that then becomes the R2.8 default, and `lambda:PassNetworkConnector` is added only if that call is denied for it.
    - With the same policy, exercise all seven actions (including CreateMicrovmAuthToken, Get, Suspend, Resume) to confirm that Image-ARN scoping is accepted for instance actions (A-13).
    - If the call is denied with a named action, record which statement must be added. If an Execution_Role is required, make the Q-4 override the default.
    - Terminate the MicroVM afterward (confirmed).
    - _Requirements: R14.2, R14.3, R14.4, R2.8_

  - [ ] 1.4 S3: Verify endpoint authentication (A-4)
    - Requires explicit user confirmation before any AWS call that creates or deletes resources. Record the result in `docs/phase0-findings.md` and update the affected A-n / R-n.
    - `curl` the MicroVM_Endpoint with no token, a malformed token, and a token for the wrong port.
    - If any request returns an unauthenticated 2xx, stop and revise R5.4 to the code-server password fallback (set per VM at run time, never baked into the Image, A-14) before the image tasks.
    - Blocking: this task must be complete before any task 13.x starts, because `--auth none` is kept only on the strength of this result.
    - _Requirements: R5.4, R4.2, R4.7_

  - [ ] 1.5 S4: Verify code-server through a prototype proxy (A-9)
    - Requires explicit user confirmation before any AWS call that creates or deletes resources. Record the result in `docs/phase0-findings.md` and update the affected A-n / R-n.
    - Check the workbench, service worker, extensions view, terminal, and a WebSocket left idle for at least 15 minutes.
    - Record whether a WebSocket ping keepalive or path rewrite rules are needed. These feed task 11.4.
    - _Requirements: R5.1, R5.3, R4.3_

  - [ ] 1.6 S5: Verify suspend/resume preservation (A-10)
    - Requires explicit user confirmation before any AWS call that creates or deletes resources. Record the result in `docs/phase0-findings.md` and update the affected A-n / R-n.
    - Save a file, start `while sleep 5; do date >> t; done`, then suspend and resume.
    - Record file survival (R7.5), process survival (information only), and proxy reconnect behavior.
    - _Requirements: R7.5, R6.2, R7.2_

  - [ ] 1.7 S6: Record wrong-state error names (A-7)
    - Requires explicit user confirmation before any AWS call that creates or deletes resources. Record the result in `docs/phase0-findings.md` and update the affected A-n / R-n.
    - Call SuspendMicrovm on SUSPENDED, ResumeMicrovm on RUNNING, and TerminateMicrovm twice.
    - Record the exact error names and HTTP codes for the adapter error classifier (task 9.5).
    - _Requirements: R6.5, R7.6, R8.3, R8.5_

  - [ ] 1.8 S7: Measure post-termination visibility (A-2)
    - Requires explicit user confirmation before any AWS call that creates or deletes resources. Record the result in `docs/phase0-findings.md` and update the affected A-n / R-n.
    - Poll GetMicrovm and ListMicrovms at intervals after termination.
    - Record the retention behavior and the recommended notFound grace value for observation rows O6, O7, and O12 (task 5.2).
    - _Requirements: R8.2, R9.12, R9.9_

  - [ ] 1.9 S8: Verify clientToken idempotency, idle policy bounds, and GetMicrovm fields (A-11, A-6, A-15)
    - Requires explicit user confirmation before any AWS call that creates or deletes resources. Record the result in `docs/phase0-findings.md` and update the affected A-n / R-n.
    - Repeat RunMicrovm with the same clientToken and confirm the same MicroVM ID comes back. Try `maxIdleDurationSeconds = 28800` and `suspendedDurationSeconds = 28800`.
    - Suspend a MicroVM started with a short `suspendedDurationSeconds` and record what happens after it elapses (assumed: terminated) and the accepted range (A-15).
    - Record the GetMicrovm field names for the endpoint and remaining duration.
    - If the IDs differ, stop and rethink R12.4 and R12.6 with the user. If there is an upper bound `B < 28800`, amend R11.1 and R11.2. If the suspendedDurationSeconds range is narrower than 1–28800, amend R2.5 and the bound in task 7.1.
    - _Requirements: R12.4, R12.6, R2.5, R11.1, R11.2, R9.8_

  - [ ] 1.10 Clean up the spike and finalize findings
    - Requires explicit user confirmation before any AWS call that creates or deletes resources. Record the result in `docs/phase0-findings.md` and update the affected A-n / R-n.
    - Terminate every MicroVM from ListMicrovms (filtered by the spike Image ARN), and confirm the list is empty or shows only TERMINATED entries.
    - Run `cdk diff`, then `cdk destroy` with manual approval.
    - Delete `spike/` and any local token output, and check with `git status`.
    - Set the final A-n / Q-n statuses in `requirements.md` and apply the confirmed "Requirement deltas" from design.
    - _Requirements: R10.6, R15.2, R16.7_

- [x] 2. Repository scaffold and hygiene
  - [x] 2.1 Create the pnpm workspace and TypeScript baseline
    - Root `package.json` with `"packageManager": "pnpm@<exact>"` and scripts `check`, `lint`, `fmt`, `test`, `typecheck`, and `build` that invoke project-local Vite+ (`vp ...`). `test` runs `vp test`.
    - `pnpm-workspace.yaml` listing `.`, `infra`, and `image/hooks`, plus `overrides` that alias `vite` to `npm:@voidzero-dev/vite-plus-core@latest` and pin `vitest` to the exact version from `vp toolchain vitest` (so the project and `vp test` share one Vitest). A strict `tsconfig.json`.
    - `vite.config.ts` from `vite-plus` holding the `test` (Vitest), `lint` (Oxlint), `fmt` (Oxfmt), and `pack` sections.
    - Exact-pinned dev and runtime deps: `typescript`, `vite-plus`, `fast-check`, `zod`, `ws`, `commander`, `@aws-sdk/client-lambda-microvms`. `tsx` is kept only as a dev fallback if `vp node` cannot run `main.ts`. Commit `pnpm-lock.yaml`.
    - Node.js, pnpm, the AWS CDK CLI, and gitleaks come from the Nix flake devShell, not from Vite+ (`vp env`/`vp install`/`setup-vp` are unused); dependency operations use `pnpm install`/`pnpm add` directly.
    - Empty `src/core/`, `src/shell/`, `src/cli/`, and `test/` directories, each with an index placeholder.
    - _Requirements: R16.1_

  - [x] 2.2 Configure the Oxlint core import boundary
    - In `vite.config.ts`, enable Oxlint (lint) and Oxfmt (fmt) through Vite+.
    - Add an Oxlint `no-restricted-imports` override for `src/core/**` to ban `@aws-sdk/*`, `node:fs`, `node:net`, `node:http`, `node:https`, `node:process`, and `node:child_process`. Confirm Oxlint can express both the `node:`-prefixed specifiers and the `src/core/**` path scope; if it cannot, rely on the import-scan test (task 2.6) as the authoritative boundary guard.
    - _Requirements: R16.2, R16.4_

  - [x] 2.3 Configure Vitest and property-test conventions
    - Configure the `test` section in `vite.config.ts` (Vitest via Vite+). Add `test/support/pbt.ts`, which exports `numRuns >= 100` and a title helper producing `Feature: lambda-microvm-code-server, Property N: <title>`.
    - Add one smoke test so `pnpm test` passes.
    - _Requirements: R16.5, R16.6_

  - [x] 2.4 Add the Nix flake devShell
    - Add `flake.nix` and `flake.lock`. The devShell supplies Node.js, pnpm, the AWS CDK CLI, and gitleaks at pinned versions.
    - _Requirements: R16.3_

  - [x] 2.5 Add secret protection and CI
    - Add `.gitignore` covering `.session/`, `.env*`, `cdk.out/`, `node_modules/`, `csmvm.config.json`, `*.token`, and `infra/cdk-outputs.json`.
    - Add `.gitleaks.toml`.
    - Add `.vite-hooks/pre-commit`, which runs `gitleaks protect --staged --config .gitleaks.toml` and then `vp staged` (Oxlint/Oxfmt on staged files). The user enables it with `vp hooks enable`; the agent does not change git config and does not add Husky or another hook manager. Enabling is documented in the README (task 15.2).
    - Add `csmvm.config.example.json` with placeholder values only (`region: "ap-northeast-1"`, `maximumDurationInSeconds: 7200`, no `networkConnectorArns`).
    - Add `.github/workflows/ci.yml`: install Nix with `DeterminateSystems/determinate-nix-action` pinned by commit SHA, run on `ubuntu-24.04` (no macOS matrix), and inside `nix develop --command` run `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test`, `pnpm audit --audit-level=high` (fail on high or above; individually ignore only confirmed non-applicable advisories), and `gitleaks detect --config .gitleaks.toml`. Note the project CI policy in a comment.
    - _Requirements: R15.1, R15.2, R15.3_

  - [x] 2.6 Write the import-boundary scan test
    - `test/hygiene/core-imports.test.ts` scans every file under `src/core/` and fails on any banned import (second check next to the Oxlint `no-restricted-imports` rule, and the authoritative guard if Oxlint cannot express it).
    - _Requirements: R16.4_

  - [ ]* 2.7 Write the `.gitignore` content test
    - Assert that every required pattern from R15.1 is present.
    - _Requirements: R15.1_

- [x] 3. Core session model and status mapping
  - [x] 3.1 Define the core types in `src/core/session.ts`
    - `SessionState`, `REMOTE_BACKED`, `LOCAL_ONLY`, `IN_FLIGHT`, `RemoteStatus`, `Session`, `Ctx`, `Command`, `Event`, `RemoteObs`, `Effect`, `MUTATING`, `View`, `StepResult`, `NoticeCode`, and `AwsErrorInfo` (name, message, retryable), as in design.
    - Done: all core types defined (the full set, not just the Lesson 4 slice) and consumed by `transitions.ts`, `reconcile.ts`, and the shell.
    - _Requirements: R1.1, R1.6_

  - [x] 3.2 Implement `mapRemoteStatus` in `src/core/status-map.ts`
    - A total mapping of the six known statuses. Every other string maps to `FAILED` with the raw value preserved.
    - _Requirements: R1.7_

  - [x] 3.3 Write unit tests for the state classification
    - Remote-backed and local-only sets are disjoint and together cover all nine states. Each remote-backed state has a same-named Remote_Status.
    - _Requirements: R1.1_

  - [x] 3.4 Write the property test for status mapping
    - **Property 4: Remote status mapping is total**
    - **Validates: Requirements 1.7**
    - Done: `test/core/status-map.property.test.ts` (Property 4). The PBT caught a real bug — inherited `Object.prototype` keys (e.g. `"valueOf"`) leaked through a plain-object lookup; fixed with an `Object.create(null)` table.

- [x] 4. Transition table: user commands
  - [x] 4.1 Create the shared generators and the independent oracle
    - `test/core/arbitraries.ts`: schema-valid `Session` per state, `View` with arbitrary strays, `Ctx` with distinct fresh IDs and tokens of 1–128 characters, all `Event` variants, and raw statuses mixing known values with random strings.
    - `test/core/oracle.ts`: rows C1–C8 and C7b written independently of `src/core/transitions.ts`.
    - _Requirements: R16.5_

  - [x] 4.2 Implement the user-command rows and `permitted` in `src/core/transitions.ts`
    - `step` handles `Command` events per rows C1–C8 and C7b (guards, `inFlightSince` handling, token handling).
    - Rejections carry `not_permitted`, `strays_present`, or `already_terminated`, return the input session, and have no effects.
    - `permitted` shares the same guards and has no state change.
    - _Requirements: R1.2, R1.3, R1.5, R3.2, R3.5, R8.4, R8.8_

  - [x] 4.3 Write the property test for command acceptance
    - **Property 1: Command acceptance matches the transition table**
    - **Validates: Requirements 1.2, 1.3, 1.5, 3.2**

  - [x] 4.4 Write the property test for rejection effects
    - **Property 2: Rejections carry no mutating effects**
    - **Validates: Requirements 1.4**

  - [x] 4.5 Write the property test for idempotent terminate
    - **Property 9: Terminate is idempotent**
    - **Validates: Requirements 8.3**

  - [x] 4.6 Write the property test for relaunch
    - **Property 7: Relaunch creates a new Session**
    - **Validates: Requirements 3.5**

- [x] 5. Transition table: adapter results and observations
  - [x] 5.1 Implement adapter-result rows E1–E9
    - RunSucceeded, RunFailed (retryable or not), MutationFailed, and ReadinessSucceeded, with guards.
    - A RunMicrovm network/transport error or client timeout is "outcome unknown" and maps to E4 (token kept), never E3.
    - Unlisted event/state pairs (for example a stale RunSucceeded with `id ≠ null`) leave the session unchanged and emit nothing.
    - _Requirements: R2.3, R2.4, R2.6, R6.5, R7.2, R7.6, R8.5, R8.8, R12.6_

  - [x] 5.2 Implement observation rows O1–O13
    - First-match order. In_Flight_Timeout from `Ctx.timeouts`. The notFound grace is `min(launch timeout, 30 s)`, or the value from S7 in `docs/phase0-findings.md` if it differs.
    - Each row records `rawRemoteStatus` and sets or clears `inFlightSince`.
    - _Requirements: R1.8, R2.7, R8.2, R9.2, R9.9, R9.10, R9.11, R9.12_

  - [x] 5.3 Write the property test for FAILED sources
    - **Property 5: FAILED is entered only from allowed sources**
    - **Validates: Requirements 1.8**

  - [x] 5.4 Write the property test for single-MicroVM binding
    - **Property 6: One MicroVM per Session for its whole life**
    - **Validates: Requirements 3.1, 3.3**

  - [x] 5.5 Write the property test for identity preservation
    - **Property 8: Suspend/resume cycles preserve identity**
    - **Validates: Requirements 6.3, 7.3, 7.4**

  - [x] 5.6 Write the property test for adopting the remote state
    - **Property 10: Reconciler adopts the mapped remote state**
    - **Validates: Requirements 9.2**

  - [x] 5.7 Write the property test for in-flight retention
    - **Property 11: In-flight states are kept before timeout**
    - **Validates: Requirements 9.9, 9.10**

  - [x] 5.8 Write the property test for failed launches and resumes
    - **Property 12: Failed launches and resumes become FAILED**
    - **Validates: Requirements 9.11**

  - [x] 5.9 Write the property test for TERMINATING/FAILED convergence
    - **Property 13: TERMINATING and FAILED converge only to TERMINATED**
    - **Validates: Requirements 9.12**

- [x] 6. Reconciler
  - [x] 6.1 Implement `reconcile` in `src/core/reconcile.ts`
    - Steps 1–6 from design: quarantine on corrupt, active filter, adoption or strays when the file is absent, observation via `step` when the file is valid, strays excluding the bound ID, and interrupted-launch `RunMicrovm(persisted token)` recovery.
    - Sets `lastReconciledAt = ctx.now`.
    - _Requirements: R9.1, R9.2, R9.3, R9.4, R9.5, R3.4, R12.6_

  - [x] 6.2 Write the property test for reconcile consistency
    - **Property 14: Reconcile output is always consistent**
    - **Validates: Requirements 9.3, 3.3**

  - [x] 6.3 Write the property test for adoption
    - **Property 15: Adoption with a missing State_File**
    - **Validates: Requirements 9.4**

  - [x] 6.4 Write the property test for determinism
    - **Property 3: Core functions are deterministic** (covers both `step` and `reconcile`)
    - **Validates: Requirements 1.6**

  - [x] 6.5 Write unit tests for reconcile examples
    - Corrupt file emits `QuarantineStateFile` and `Notify(corrupt_state)`. LAUNCHING with a token and no ID emits the recovery `RunMicrovm`. Strays exclude the bound ID.
    - _Requirements: R9.5, R12.6, R3.4_

- [x] 7. Config validation, run parameters, and retry policy
  - [x] 7.1 Implement `validateConfig` in `src/core/config.ts`
    - Hand-written pure validation with no dependencies, producing `CliConfig` with the design defaults.
    - Bounds: `maximumDurationInSeconds` is an integer in 1–28800 (default 7200). `suspendedDurationSeconds` is an integer in 1–28800, defaulting to the resolved `maximumDurationInSeconds`. `token.maxExpirationMinutes` is an integer in 1–60. Default `region` is `ap-northeast-1`. Also validates ports, timeouts, retry parameters, and the optional `networkConnectorArns` list (absent by default).
    - Done. S8-derived upper bound `B` was not separately measured; the full lifecycle ran with `maximumDurationInSeconds = 1800`, within the configured bounds.
    - _Requirements: R4.10, R11.1, R11.2, R2.5, R2.8, R4.7, R12.1_

  - [x] 7.2 Implement `buildRunParams` in `src/core/run-params.ts`
    - Image ARN, maximum duration, clientToken, and an idlePolicy with all three fields set (`autoResumeEnabled: false`, `maxIdleDurationSeconds = max(60, d)`, `suspendedDurationSeconds` from config).
    - `networkConnectors` omitted by default; passed exactly as configured when `networkConnectorArns` is set (or ingress-only if S2 required it).
    - `runHookPayload = {"sessionId"}`, at most 4096 bytes. `executionRoleArn` only when configured.
    - _Requirements: R2.1, R2.5, R2.8, R2.9, R11.1_

  - [x] 7.3 Implement `retryDelayMs` in `src/core/retry.ts`
    - Full jitter. `upper = min(capMs, baseMs * 2 ** attempt)`, `delay = floor(rand01 * upper)`. Also export `isRetryable(name)` for ThrottlingException and InternalServerException.
    - _Requirements: R12.1, R12.2_

  - [x] 7.4 Write the property test for retry delays
    - **Property 17: Retry delay bounds**
    - **Validates: Requirements 12.2**
    - Done: `test/core/retry.property.test.ts` (Property 17): bounds + monotonicity in rand01 + `isRetryable` classification.

  - [x] 7.5 Write the property test for config bounds and run parameters
    - **Property 16: Config bounds and run parameters** (includes the 7200 default, the `suspendedDurationSeconds` bound and default, all three idlePolicy fields, and no connectors by default)
    - **Validates: Requirements 2.5, 4.10, 11.1, 11.2**
    - Done: `test/core/config.property.test.ts` covers the config-bounds half and `run-params` property coverage lands with `buildRunParams` (task 7.2).

  - [x] 7.6 Write unit tests for `buildRunParams`
    - The payload contains only `sessionId` and is at most 4096 bytes. No `networkConnectors` are passed by default; a configured override is passed exactly. `suspendedDurationSeconds` defaults to `maximumDurationInSeconds`. `executionRoleArn` is absent by default.
    - _Requirements: R2.5, R2.8, R2.9_

- [x] 8. Checkpoint: pure core complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Shell foundations: State store, redaction, AWS_Adapter
  - [x] 9.1 Implement the State store in `src/shell/state-store.ts`
    - zod schema v1 with unknown keys rejected and the conditional rules (token, `inFlightSince`). Converts to and from the core `Session`.
    - Atomic write: temp file in the same directory, fsync, rename. Directory mode 0700, file mode 0600.
    - `read()` returns `FileRead`. `quarantine()` renames to `state.json.corrupt-<ISO>`. NONE deletes the file. No token or credential fields.
    - _Requirements: R9.5, R9.6, R9.7, R4.5, R15.4_

  - [x] 9.2 Write unit tests for the State store
    - Use a temp dir. Cover round trip, atomic rename, corrupt JSON and schema failures, quarantine naming, delete on NONE, file modes, and rejection of extra fields.
    - _Requirements: R9.5, R9.6, R9.7_

  - [x] 9.3 Implement redaction in `src/shell/redact.ts`
    - `redact()` masks the registered current and previous token values and any five-segment base64url (JWE-shaped) string. `RedactingLogger` wraps the terminal output. The error formatter builds messages from `{operation, errorName, microvmId?}`.
    - _Requirements: R4.4, R12.5_

  - [x] 9.4 Write unit tests for redaction
    - _Requirements: R4.4, R12.5_

  - [x] 9.5 Implement the AWS_Adapter in `src/shell/aws-adapter.ts`
    - The `MicrovmsPort` interface, plus an SDK implementation with SDK retries disabled (`maxAttempts: 1`) and the default credential provider chain only.
    - `withRetry(op, policy, rand, sleep)` retries only Retryable_Errors and reuses the same clientToken for `run`.
    - `get` maps ResourceNotFoundException to `notFound`. `listByImage` follows pagination. Error classification uses the S6 names.
    - Endpoint and remaining-duration field names come from S8. The conservative token `expiresAt` is used unless the API gives one.
    - _Requirements: R12.1, R12.3, R12.4, R15.4, R2.1, R6.5, R7.6, R8.2, R9.1_

  - [x] 9.6 Implement `FakeMicrovms` in `test/fakes/fake-microvms.ts`
    - In-memory `MicrovmsPort` with status scripts, delayed visibility, per-call error injection, idempotent clientToken handling, and call recording.
    - _Requirements: R16.6_

  - [x] 9.7 Write unit tests for `withRetry`
    - Use an injected op, sleep, and random source; the SDK is never constructed. Retryable errors are retried up to `maxAttempts`, non-retryable errors are returned at once, and `run` keeps the same clientToken on every attempt.
    - _Requirements: R12.1, R12.3, R12.4_

- [x] 10. Effect interpreter and CLI commands
  - [x] 10.1 Implement prompts and the readiness probe
    - `src/shell/prompt.ts`: confirmation with an injectable TTY flag and `--yes` handling.
    - `src/shell/readiness.ts`: `GET https://<endpoint>/healthz` with token headers and a 5 s timeout. A 2xx response yields `ReadinessSucceeded`.
    - _Requirements: R10.1, R10.2, R10.3, R10.4, R10.5, R2.4, R7.2_

  - [x] 10.2 Implement the effect interpreter in `src/cli/interpreter.ts`
    - Order: validateConfig (exit 2, zero AWS calls), then reconcile (recovery effects skipped for `status`), then `permitted` (exit 2, or exit 0 for `already_terminated`), then confirm for launch and terminate, then `step`, then persist before running effects, then feed result events back.
    - `waitLoop` with the injected clock and sleep. Exit codes 0, 1, and 2. Redacted error output.
    - _Requirements: R1.4, R9.1, R10.3, R10.5, R12.5, R12.4, R12.6, R2.2_

  - [x] 10.3 Implement `src/cli/main.ts`, `status`, and `config import`
    - Argument parsing and a command registry.
    - `status` prints the R9.8 fields and the snapshot-cost notice when SUSPENDED, and never mutates anything.
    - `config import` reads `infra/cdk-outputs.json` into `csmvm.config.json`.
    - _Requirements: R9.8, R11.3, R9.1_

  - [x] 10.4 Implement the `launch` command
    - The prompt shows the Image ARN, Region, and max duration. Waits for RUNNING plus readiness, then prints the proxy base URL and the `connect` hint. On failure, reports the error and sets FAILED or NONE per E3 and O5.
    - _Requirements: R2.1, R2.2, R2.3, R2.4, R2.6, R2.7, R10.1, R3.4_

  - [x] 10.5 Implement the `suspend` and `resume` commands
    - Each waits for its target state. ConflictException or a wrong-state error leads to reconcile and a report of the reconciled state.
    - _Requirements: R6.1, R6.2, R6.5, R7.1, R7.2, R7.6_

  - [x] 10.6 Implement the `terminate` command including `--stray`
    - The prompt names the MicroVM ID and warns about state loss. Handles the C6 recovery path and the retryable-failure report.
    - `--stray <id>` checks that the ID is in `listByImage`, prompts with that ID, terminates it, and does not touch the Session.
    - _Requirements: R8.1, R8.2, R8.4, R8.5, R8.7, R8.8, R10.2_

  - [x] 10.7 Write CLI behavior tests for launch and config
    - Use FakeMicrovms, a fake prompt, a fake TTY, a fake clock, and a temp dir.
    - Cover: zero mutating calls on rejection or decline; non-TTY without `--yes` exits 2; token persisted before `run`; same token on retry; interrupted-launch recovery; strays block launch; the R2.6 error matrix; launch timeout leads to FAILED; invalid config means zero calls.
    - _Requirements: R1.4, R2.1–R2.7, R3.4, R10.1, R10.3, R10.4, R10.5, R12.4, R12.6_

  - [x] 10.8 Write CLI behavior tests for status, suspend, resume, and terminate
    - Cover: status fields and cost notice; Conflict leads to reconcile; terminate when already TERMINATED exits 0; retryable terminate failure stays TERMINATING; notFound leads to TERMINATED; the `--stray` image check; C6 recovery then terminate; corrupt file quarantine; no tokens or credentials on disk.
    - _Requirements: R6.1, R6.5, R7.1, R7.6, R8.1, R8.2, R8.4, R8.5, R8.7, R8.8, R9.5, R9.8, R11.3, R12.5, R15.4_

- [x] 11. Auth_Proxy
  - [x] 11.1 Implement the token cache in `src/shell/proxy/token-cache.ts`
    - Holds one in-memory token. Single-flight refresh when `expiresAt − now < refreshMargin`. Tokens are requested with `allowedPorts = [{port: codeServerPort}]` and the configured expiry. New tokens are registered with the redactor.
    - _Requirements: R4.5, R4.6, R4.7_

  - [x] 11.2 Implement local auth and header checks in `src/shell/proxy/local-auth.ts`
    - A 256-bit one-time secret, exchanged at `/__csmvm/login?k=` for a `__csmvm` cookie (`HttpOnly; SameSite=Strict; Path=/`) holding a separate in-memory 256-bit random value, with a 302 redirect. Requests without the cookie get 401. Secret and cookie comparisons use `crypto.timingSafeEqual`.
    - Host allow-list, Origin check on WebSocket upgrades, and cookie stripping. `localAuth: false` bypasses this with a warning.
    - _Requirements: R4.11, R4.12_

  - [x] 11.3 Implement HTTP forwarding in `src/shell/proxy/http.ts` (+ forced-refresh in `server.ts`)
    - Forwards to `https://<endpoint>` with `X-aws-proxy-auth` and `X-aws-proxy-port`. Strips hop-by-hop headers and the auth header from responses.
    - Returns 503 `{"state"}` when the state is not RUNNING. Returns 502 with a generic body on token failure, with the error name sent to the terminal. Upstream 401/403 triggers one forced token refresh and a single retry, then 502.
    - Fixed (review): the forced-refresh-on-401/403 path was initially unimplemented (`http.ts` just piped the upstream status through and `tokenCache.forceRefresh()` was never called). `server.ts` `handleHttp` now performs the one-refresh-then-retry, 502 on second failure.
    - Fixed (review round 2): retry eligibility was decided from the HTTP method (`GET`/`HEAD` only), so a bodyless `DELETE` was wrongly treated as unreplayable and skipped the refresh. It now uses `requestHasBody(req)` — true only when `content-length > 0` or `transfer-encoding` is present — so any bodyless request is retried after a forced refresh. Covered by a bodyless-DELETE integration test.
    - _Requirements: R4.2, R4.4, R4.8, R4.9_

  - [x] 11.4 Implement the WebSocket relay (in `src/shell/proxy/server.ts`)
    - Terminates the browser socket at the proxy. Opens the upstream socket with the three `lambda-microvms` subprotocols and relays frames both ways. Never echoes the upstream subprotocol.
    - Adds a ping keepalive if S4 found it necessary.
    - Deviation: the relay was consolidated into `server.ts` (`wsSubprotocols` + the `ws` `WebSocketServer`) rather than a separate `ws.ts`.
    - Fixed (review): the first implementation embedded the whole JSON-encoded auth-token header map directly into `lambda-microvms.authentication.<token>`, which is not a valid RFC 6455 subprotocol token (it contains `{ } " ,` and spaces) and would fail with an invalid/duplicated-subprotocol error against the real token shape; it also forwarded a fixed `/` upstream, dropping the browser's path and query. Now `wsSubprotocols(authValue, port)` takes the single auth *value* extracted from the decoded header map (`authValueFromHeaders`), validates it as an RFC 7230 token (`isValidSubprotocolToken`), and the upstream URL preserves the browser's path + query (only scheme/host are rewritten).
    - Fixed (review round 2): the browser handshake completed before the upstream socket opened (the token fetch + connect are async), and the browser→upstream `message` listener was only attached inside `upstreamWs.on("open")`, so any frame the browser sent in that window was silently dropped — breaking the workbench/terminal handshake. The relay now attaches the browser `message` listener synchronously, buffers early frames, and flushes them in order once upstream opens (also handles the browser closing mid-connect). Covered by a WS integration test with a delayed token mint. Note: the WS auth path is still unverified against the real endpoint (S4).
    - _Requirements: R4.3, R4.4, R5.3_

  - [x] 11.5 Implement the proxy server in `src/shell/proxy/server.ts`
    - Binds 127.0.0.1 only; a port already in use exits 1. Composes local auth, HTTP, and WebSocket handling.
    - Polls the State_File every 1 s. Non-RUNNING closes open WebSockets. TERMINATING or TERMINATED closes the listener and releases the port.
    - _Requirements: R4.1, R4.9, R6.4, R8.6_

  - [x] 11.6 Wire the `connect` command
    - `src/cli/connect.ts` requires RUNNING, gets the endpoint, starts the server in the foreground, and prints the one-time login URL. `launch` never starts the proxy.
    - Deviation: implemented at `src/cli/connect.ts` (not `src/cli/commands/connect.ts`).
    - _Requirements: R4.1, R4.11, R2.4_

  - [x] 11.7 Write proxy tests for HTTP, local auth, and token handling
    - Use a fake upstream on 127.0.0.1 that records headers.
    - Cover: auth and port headers; loopback-only bind; login, cookie, and 401; Host and Origin rejection; cookie stripped upstream; refresh at the margin; 502 on refresh failure; token absent from responses and logs (JWE regex).
    - Correction (review): the original `test/shell/proxy.test.ts` only unit-tested the pure helpers (`upstreamRequestHeaders`/`sanitizeResponseHeaders`) and the `TokenCache`; it never started `startProxy()`, so loopback bind, real header forwarding, the forced-refresh→502 path, and token non-leakage in a real response were unverified. A real integration test (`startProxy` against a fake loopback upstream) was added to actually exercise these — see `test/shell/proxy-server.test.ts`.
    - _Requirements: R4.1, R4.2, R4.4, R4.5, R4.6, R4.7, R4.8, R4.11, R4.12_

  - [ ]* 11.8 Write proxy tests for the WebSocket relay
    - Cover upstream subprotocols, bidirectional frames, and that the token never appears in the browser handshake.
    - _Requirements: R4.3, R4.4_

  - [ ]* 11.9 Write proxy tests for state gating and shutdown
    - Cover: 503 with state for SUSPENDING and SUSPENDED; WebSockets closed on suspend; listener released on TERMINATING.
    - _Requirements: R4.9, R6.4, R8.6_

- [x] 12. Checkpoint: CLI and Auth_Proxy complete
  - Ensure all tests pass, ask the user if questions arise.

- [~] 13. MicroVM Image
  - Prerequisite status: task 1.4 (S3, endpoint authentication) is an explicit hard prerequisite for every 13.x task and is **NOT verified** (see the task 1 status note). The image is built and runs on real AWS with `--auth none`, but the assumption that the MicroVM endpoint independently authenticates every request (making `--auth none` safe) has not been probed. Treat task 13 as functionally complete but resting on an unverified security assumption until S3 is run.
  - [x] 13.1 Implement the Hook_Handler in `image/hooks/`
    - Own `package.json` in the workspace. Implements the hook port, path, and contract from S1. Bundled to a single file through Vite+'s `pack` section (`vite.config.ts`), target/platform Node, so the MicroVM image carries no `node_modules` for the handler. The handler runs on the Node bundled with code-server (pinned indirectly by the code-server exact version + SHA-256); if S1 shows the handler needs a specific Node version, switch to an independently pinned Node.
    - `run` does not start code-server (it is already running from the build-time snapshot, A-14). It only polls the code-server health check until a deadline (run hook timeout minus 2 s), then returns 200 or 503. If S1 found a per-VM value that must differ, `run` restores it before the health check, without injecting secrets.
    - `resume`, `suspend`, and `terminate` return 200 at once and log the hook name and the `sessionId` from the payload.
    - `/ready` and `/validate` use the longer deadline.
    - If S1 requires a shared port, the handler is the front process and reverse-proxies to code-server on 8081, including WebSocket; in that case re-decide whether `ws` is bundled into the pack output or kept external.
    - _Requirements: R13.2, R13.3, R13.4, R13.1_

  - [ ]* 13.2 Write unit tests for the Hook_Handler
    - Run against a fake health endpoint. Cover healthy, slow, and never-healthy cases, and the immediate 200 for the other hooks.
    - _Requirements: R13.2, R13.3_

  - [x] 13.3 Write the Dockerfile, `entrypoint.sh`, and workspace seed
    - Runtime image `FROM public.ecr.aws/lambda/microvms:al2023-minimal` (verified base, A-12; base image ARN form `arn:aws:lambda:<region>:aws:microvm-image:al2023-1`, region-derived and confirmed in S1).
    - code-server from the release tarball at exact `ARG CODE_SERVER_VERSION` (4.96.4) with a pinned SHA-256 (`8471a70a…`). Non-root `coder` user, empty `workspace-seed/`.
    - The entrypoint starts the Hook_Handler and runs `code-server --auth none --bind-addr 0.0.0.0:8080 --disable-telemetry` during the image build, so the running process is captured in the snapshot.
    - Generates no secret and no per-user unique value at build time.
    - Deviations (recorded in `docs/phase0-findings.md`): (1) **single-stage** build, not multi-stage — the service rejected a multi-stage build on an external base image; (2) **no `tini`** — it is not present in the base and could not be installed via `microdnf`; the entrypoint instead `exec`s code-server so it becomes PID 1; (3) no explicit `curl` install (it conflicted with the base `curl-minimal`); (4) `COPY` paths are relative to the `image/` asset root.
    - _Requirements: R13.1, R13.5, R13.6, R13.7, R5.4_

  - [x] 13.4 Write static image checks
    - Cover the exact-version and SHA-256 pin regex, the presence of `--auth none` (or the fallback), the absence of build-time `PASSWORD`/`HASHED_PASSWORD` or generated secrets, and gitleaks plus a credential-pattern grep over `image/`.
    - _Requirements: R13.5, R13.6, R13.7, R5.4, R15.2_

- [x] 14. Infrastructure (CDK)
  - [x] 14.1 Scaffold the `infra/` CDK package
    - `infra/package.json` with exact-pinned `aws-cdk-lib` and `constructs`, plus `cdk.json`, `bin/app.ts`, and `tsconfig.json`.
    - Deviation: the AWS CDK CLI is a **project-local** exact pin (`aws-cdk@2.1144.0` in `infra/package.json`, invoked via `pnpm exec cdk`) rather than the Nix-provided CLI — the Nix CDK (2.1004.0) could not read the `aws-cdk-lib` 2.272.0 cloud-assembly schema (v54).
    - _Requirements: R14.1, R14.5_

  - [x] 14.2 Implement the build context, Image_Build_Role, and Image in `infra/lib/stack.ts`
    - S3 asset of `../image`. A build role trusted only by `lambda.amazonaws.com` with `aws:SourceAccount`, granted `s3:GetObject` on the asset object only.
    - Deviation: by default the stack creates only the IAM roles/policy + the S3 image asset; the MicroVM image is built out-of-band by `scripts/build-image.mjs` (direct CreateMicrovmImage/UpdateMicrovmImage API). The `CfnMicrovmImage` resource (region-derived base ARN, `ARM_64`, `ENABLED`/`DISABLED` hook enums, `minimumMemoryInMiB: 2048`) is retained behind `-c buildImageInCfn=true` because CFN stabilization timed out. Outputs: ImageArn/Region/OperatorPolicyArn.
    - Fixed (review): `scripts/build-image.mjs` previously discarded the `UpdateMicrovmImage` response version and probed a hardcoded version list (`3.0`/`2.0`/`1.0`), so a v4+ update could latch onto an older already-`SUCCESSFUL` build and report a false `BUILD_OK`.
    - Fixed (review round 2): the pinned SDK's Create/Update response has no `imageVersion` field, so the earlier fix always fell back to "newest version in the list" — which can still be a stale, already-`SUCCESSFUL` build if the freshly triggered build is not listed yet. The script now snapshots the set of existing `(version, buildId)` pairs before the mutation and polls only a build that was NOT present before (waiting up to 2 min for it to appear), using the create/update-returned `buildId` as a fast path. It never accepts a pre-existing build. Polls by `buildId`.
    - _Requirements: R14.1, R14.6, R13.2, R13.4_

  - [x] 14.3 Implement the Operator_Policy and the optional Execution_Role
    - A managed policy with the `lambda:*Microvm*` actions scoped to the Image ARN; `ListMicrovms` uses `Resource: "*"` with an allow-listed Sid. `PassNetworkConnector` is not included by default. `withExecutionRole` adds a MicroVMs-trusted role with log delivery + scoped `iam:PassRole`.
    - _Requirements: R14.2, R14.3, R14.4_

  - [x] 14.4 Add infra scripts and synth to CI
    - Root scripts `infra:diff`, `infra:deploy` (with `--outputs-file infra/cdk-outputs.json`), and `infra:destroy`, without `--require-approval never` or `--force`. `cdk synth` step added to `ci.yml`.
    - _Requirements: R10.6, R14.5_

  - [x] 14.5 Write CDK assertion tests in `infra/test/stack.test.ts`
    - Allowed resource types only; build/execution role trust policies; exact Operator_Policy actions and resources; wildcard allow-list enforced; IAM statements snapshotted. 9 infra tests passing.
    - _Requirements: R14.1, R14.2, R14.3, R14.4, R14.5, R14.6_

  - [x] 14.6 Write the script flag test
    - Assert that the infra scripts contain no auto-approval or force flags.
    - _Requirements: R10.6_

- [ ] 15. Documentation
  - [ ] 15.1 Write `docs/ENV-CHECKLIST.md`
    - One step per `[ENV]` criterion, following the design table, run with `maximumDurationInSeconds = 1800`.
    - Each step lists the expected cost impact (MicroVM-minutes, snapshot storage, with a pointer to the Region's pricing page) and its cleanup command. Ends with a final cleanup check: no strays and `DELETE_COMPLETE`.
    - _Requirements: R16.7, R2.4, R4.2, R4.3, R5.1, R5.2, R5.3, R6.2, R7.2, R7.5, R13.1, R13.2, R13.4_

  - [x] 15.2 Write `README.md`
    - Covers the Nix devShell, `pnpm install`, enabling the Git hook, `cdk diff` review, `config import`, attaching the Operator_Policy, the command reference, local-auth login URL / `localAuth: false` warning, cost bounds, and links to Phase 0 findings. Also carries the Kiro University lesson-to-repo mapping table.
    - Fixed (review): the Getting Started steps omitted the hook bundle build (`pnpm -C image/hooks build`) and the API image build (`node scripts/build-image.mjs`). Since `cdk deploy` creates only IAM + the S3 asset (not the MicroVM image), a new user following the old steps would have no image and `launch` would fail. Both steps are now in the README and the Prerequisites bullet reflects the API-driven image build.
    - Fixed (review round 2): `pnpm csmvm config import` failed with `Command "csmvm" not found` — there was no root `csmvm` script and no CLI build step. Added a root `"csmvm": "node dist/cli/main.js"` script and a `pnpm build` step (step 4) so a fresh checkout can run the CLI end to end.
    - Note: the standalone `docs/ENV-CHECKLIST.md` (task 15.1) was not written as a separate artifact; the real end-to-end verification is captured in `docs/phase0-findings.md` and the task 17 results below.
    - _Requirements: R10.6, R16.7, R11.3, R4.11, R15.3_

- [x] 16. Final checkpoint: all automated checks green
  - All tests pass (118 root + 9 infra), `pnpm check` clean, `pnpm build` OK, gitleaks + hygiene clean.
  - Run `pnpm check`, `pnpm test`, `cdk synth`, `nix flake check`, and gitleaks.

- [~] 17. Final ENV end-to-end verification (opt-in, costs money)
  - Scope correction: what actually ran was a **happy-path lifecycle smoke test** on real AWS (`aws-poc-sandbox`, `ap-northeast-1`, `maximumDurationInSeconds = 1800`) via `/aws-sandbox-run`, not the full ENV checklist. It proves the common path works end to end; it does **not** cover the negative/boundary ENV criteria (unauthenticated/malformed-token rejection, least-privilege policy enforcement, idle-WebSocket survival, saved-file preservation across suspend/resume, wrong-state error handling against the real API). Those map to S2–S8, which are unverified (see task 1). Deviation: executed as a direct lifecycle run with an ad-hoc gitignored `csmvm.config.json` + manual probes rather than a scripted `docs/ENV-CHECKLIST.md`/`docs/env-results.md`; results are in `docs/phase0-findings.md`.
  - [x] 17.1 Run the happy-path lifecycle smoke test against a real deployment
    - Verified on real AWS: image v4.0 `SUCCESSFUL`/`ACTIVE`; `csmvm launch --yes` → RUNNING (exit 0); `status` → RUNNING; MicroVM endpoint `…lambda-microvm.ap-northeast-1.on.aws/healthz` → HTTP 200 (code-server JSON); `suspend` → SUSPENDED; `resume` → RUNNING; `terminate` → TERMINATED. All confirmation-gated.
    - Not covered (needs the real ENV checklist + S2–S8): endpoint auth rejection, least-privilege policy, idle WebSocket, saved-file survival assertion, wrong-state errors.
    - _Requirements: R2.4, R5.1, R6.2, R7.2, R13.1, R13.2, R13.4, R16.7 (partial — negative/boundary criteria R4.2/R4.3/R5.3/R7.5/R8.2 not exercised)_

  - [x] 17.2 Clean up and confirm zero residual resources
    - Terminated the MicroVM (TERMINATED), deleted the MicroVM image via API (DELETING), and ran `cdk destroy` (CsmvmStack destroyed). Verified 0 active MicroVMs and the stack gone. Removed local probe scripts and the gitignored runtime config.
    - _Requirements: R8.2, R8.7, R10.6, R16.7_

## Notes

- Tasks marked `*` are optional and can be skipped for a faster MVP. All property tests P1–P17 stay required, because R16.5 requires a property test for every `[PBT]` criterion. The State store, redaction, `withRetry`, CLI behavior, and proxy HTTP/local-auth tests (9.2, 9.4, 9.7, 10.7, 10.8, 11.7) are required (user decision).
- Phase 0 (task 1) and task 17 never call AWS to create or delete resources without explicit user confirmation.
- Pure-core and local tasks (2–9.4) do not depend on spike results and can run in parallel with Phase 0. Tasks that consume spike results are scheduled after the spike they need: 5.2 after S7, 7.1 after S8, 9.5 after S6 and S8, 11.4 after S4, 13.x after S1 and S3 (task 1.4 is a hard prerequisite for every 13.x task, because `--auth none` depends on it), and 14.x after S1 and S2.
- Ordering (user-confirmed): scaffold and pure core first; Phase 0 spikes are approved one at a time, each after its cost estimate, and run in parallel with local work.
- Each property test runs `numRuns >= 100` and is titled `Feature: lambda-microvm-code-server, Property N: <title>`.
- The automated suite never constructs the SDK client and needs no credentials or network (R16.6).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "2.3", "2.4", "2.5"] },
    { "id": 2, "tasks": ["1.3", "2.6", "2.7", "3.1"] },
    { "id": 3, "tasks": ["1.4", "3.2", "4.1", "7.3"] },
    { "id": 4, "tasks": ["1.5", "3.3", "3.4", "4.2", "7.4"] },
    { "id": 5, "tasks": ["1.6", "4.3", "4.4", "4.5", "4.6", "5.1"] },
    { "id": 6, "tasks": ["1.7", "9.1", "9.3"] },
    { "id": 7, "tasks": ["1.8", "9.2", "9.4"] },
    { "id": 8, "tasks": ["1.9", "5.2"] },
    { "id": 9, "tasks": ["1.10", "5.3", "5.4", "5.5", "5.6", "5.7", "5.8", "5.9", "6.1", "7.1", "9.5"] },
    { "id": 10, "tasks": ["6.2", "6.3", "6.4", "6.5", "7.2", "9.6", "9.7", "10.1", "13.1", "14.1"] },
    { "id": 11, "tasks": ["7.5", "7.6", "10.2", "13.2", "13.3", "14.2"] },
    { "id": 12, "tasks": ["10.3", "11.1", "11.2", "13.4", "14.3"] },
    { "id": 13, "tasks": ["10.4", "11.3", "14.4"] },
    { "id": 14, "tasks": ["10.5", "11.4", "14.5", "14.6"] },
    { "id": 15, "tasks": ["10.6", "11.5", "15.1"] },
    { "id": 16, "tasks": ["11.6", "15.2"] },
    { "id": 17, "tasks": ["10.7", "10.8", "11.7", "11.8", "11.9"] },
    { "id": 18, "tasks": ["17.1"] },
    { "id": 19, "tasks": ["17.2"] }
  ]
}
```
