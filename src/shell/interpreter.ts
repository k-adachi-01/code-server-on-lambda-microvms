// Effect interpreter (shell, R1.4, R9.1, R10.3/R10.5, R12.4/R12.5/R12.6, R2.2).
// Wires the pure core (reconcile, permitted, step, buildRunParams) to the AWS
// adapter, the state store, prompts, and the readiness probe. Ordering invariant
// (design): validate -> reconcile -> permitted -> confirm -> step -> persist
// BEFORE executing effects -> feed each effect's result event back -> waitLoop.

import type { CliConfig } from "../core/config.js";
import { validateConfig } from "../core/config.js";
import { buildRunParams } from "../core/run-params.js";
import { reconcile } from "../core/reconcile.js";
import { permitted, step } from "../core/transitions.js";
import { isInFlight } from "../core/session.js";
import type {
  Command,
  Ctx,
  Effect,
  Event,
  ReconcileInput,
  Session,
  View,
} from "../core/session.js";
import type { MicrovmsPort } from "./aws-adapter.js";
import { awsErrorName } from "./aws-adapter.js";
import { isRetryable } from "../core/retry.js";
import type { StateStore } from "./state-store.js";
import { confirm } from "./prompt.js";
import { probeReadiness } from "./readiness.js";
import type { Redactor, RedactingLogger } from "./redact.js";

export interface InterpreterDeps {
  config: unknown; // raw config object (validated here)
  port: MicrovmsPort;
  store: StateStore;
  logger: RedactingLogger;
  redactor: Redactor;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  newId: () => string; // crypto.randomUUID in prod
  newToken: () => string;
  isTTY: boolean;
  assumeYes: boolean;
  ask?: (q: string) => Promise<string>;
  /** Injected fetch for the readiness probe (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

export type ExitCode = 0 | 1 | 2;

/** Build a Ctx for a core call from the deps + validated config. */
function makeCtx(deps: InterpreterDeps, cfg: CliConfig): Ctx {
  return {
    now: deps.now(),
    newSessionId: deps.newId(),
    newClientToken: deps.newToken(),
    timeouts: {
      launchMs: cfg.timeouts.launchSeconds * 1000,
      suspendMs: cfg.timeouts.suspendSeconds * 1000,
      resumeMs: cfg.timeouts.resumeSeconds * 1000,
    },
  };
}

/** Run reconcile against the live view (file + get + list). */
async function reconcileView(
  deps: InterpreterDeps,
  cfg: CliConfig,
  runRecovery: boolean,
): Promise<{ view: View; ctx: Ctx }> {
  const ctx = makeCtx(deps, cfg);
  const file = deps.store.read();
  const recordedId = file.kind === "valid" ? file.session.microvmId : null;
  const get = recordedId !== null ? await deps.port.get(recordedId) : { kind: "noId" as const };
  const list = await deps.port.listByImage(cfg.imageArn);
  const input: ReconcileInput = { file, get, list };
  const { view, effects } = reconcile(input, ctx);

  // Persist the reconciled session, then run recovery effects (unless this is a
  // read-only command like status).
  deps.store.persist(view.session);
  if (runRecovery) {
    const after = await runEffects(deps, cfg, view.session, effects);
    return { view: { session: after, strays: view.strays }, ctx };
  }
  return { view, ctx };
}

/** Map one Effect to its shell action, returning any resulting Event. */
async function execEffect(
  deps: InterpreterDeps,
  cfg: CliConfig,
  session: Session,
  effect: Effect,
): Promise<Event | null> {
  switch (effect.kind) {
    case "RunMicrovm": {
      const params = buildRunParams(cfg, effect.clientToken, effect.sessionId);
      try {
        const { microvmId } = await deps.port.run(params);
        return { type: "RunSucceeded", microvmId };
      } catch (err) {
        const name = awsErrorName(err);
        const retryable = isRetryable(name);
        // Network/transport errors have no AWS name -> outcome unknown (E4).
        const outcomeUnknown = name === "UnknownError";
        return {
          type: "RunFailed",
          error: { errorName: name, message: String(err), retryable, outcomeUnknown },
        };
      }
    }
    case "SuspendMicrovm":
      try {
        await deps.port.suspend(effect.microvmId);
        return null;
      } catch (err) {
        return mutationFailed("suspend", err);
      }
    case "ResumeMicrovm":
      try {
        await deps.port.resume(effect.microvmId);
        return null;
      } catch (err) {
        return mutationFailed("resume", err);
      }
    case "TerminateMicrovm":
      try {
        await deps.port.terminate(effect.microvmId);
        return null;
      } catch (err) {
        return mutationFailed("terminate", err);
      }
    case "ProbeReadiness": {
      const ready = await probeReadinessFor(deps, cfg, effect.microvmId);
      return ready ? { type: "ReadinessSucceeded" } : null;
    }
    case "Reconcile": {
      const id = session.microvmId;
      const obs = id !== null ? await deps.port.get(id) : { kind: "noId" as const };
      return { type: "Observed", remote: obs };
    }
    case "QuarantineStateFile":
      deps.store.quarantine();
      return null;
    case "Notify":
      deps.logger.log(formatNotice(effect));
      return null;
  }
}

function mutationFailed(op: "suspend" | "resume" | "terminate", err: unknown): Event {
  const name = awsErrorName(err);
  return {
    type: "MutationFailed",
    op,
    error: { errorName: name, message: String(err), retryable: isRetryable(name) },
  };
}

function formatNotice(effect: Extract<Effect, { kind: "Notify" }>): string {
  const detail =
    effect.detail && Object.keys(effect.detail).length > 0
      ? ` ${JSON.stringify(effect.detail)}`
      : "";
  return `[${effect.code}]${detail}`;
}

/** Probe readiness for a microvm: mint a token, GET /healthz. */
async function probeReadinessFor(
  deps: InterpreterDeps,
  cfg: CliConfig,
  microvmId: string,
): Promise<boolean> {
  try {
    const { token } = await deps.port.createAuthToken(
      microvmId,
      cfg.codeServerPort,
      cfg.token.maxExpirationMinutes,
    );
    deps.redactor.register(token);
    // token is a JSON-encoded header map (see adapter.createAuthToken).
    let authHeaders: Record<string, string> = {};
    try {
      authHeaders = JSON.parse(token) as Record<string, string>;
    } catch {
      authHeaders = { "X-aws-proxy-auth": token };
    }
    // We need the endpoint; read it from a fresh get.
    const obs = await deps.port.get(microvmId);
    const endpoint = "endpoint" in obs && obs.endpoint ? obs.endpoint : null;
    if (endpoint === null) return false;
    return await probeReadiness(endpoint, {
      authHeaders,
      codeServerPort: cfg.codeServerPort,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  } catch {
    return false;
  }
}

/** Run a list of effects, feeding each result event back through step. */
async function runEffects(
  deps: InterpreterDeps,
  cfg: CliConfig,
  startSession: Session,
  effects: Effect[],
): Promise<Session> {
  let session = startSession;
  for (const effect of effects) {
    const resultEvent = await execEffect(deps, cfg, session, effect);
    if (resultEvent !== null) {
      const res = step({ session, strays: [] }, resultEvent, makeCtx(deps, cfg));
      session = res.session;
      deps.store.persist(session);
      // A result event may itself produce follow-on effects (e.g. E2 Terminate).
      if (res.ok && res.effects.length > 0) {
        session = await runEffects(deps, cfg, session, res.effects);
      }
    }
  }
  return session;
}

/**
 * Poll `get` every pollInterval, feeding Observed (and ProbeReadiness-driven
 * ReadinessSucceeded) until the session leaves its in-flight state or the per-op
 * timeout fires. Returns the final session.
 */
async function waitLoop(
  deps: InterpreterDeps,
  cfg: CliConfig,
  startSession: Session,
): Promise<Session> {
  let session = startSession;
  const pollMs = cfg.pollIntervalSeconds * 1000;
  // Bound the loop defensively so a bug cannot hang forever; the core's T(state)
  // timeout is the real exit via an O5 FAILED transition.
  const maxIterations = 10_000;
  for (let i = 0; i < maxIterations; i++) {
    if (!isInFlight(session.state)) return session;
    await deps.sleep(pollMs);
    const id = session.microvmId;
    const obs = id !== null ? await deps.port.get(id) : { kind: "noId" as const };
    const res = step(
      { session, strays: [] },
      { type: "Observed", remote: obs },
      makeCtx(deps, cfg),
    );
    session = res.session;
    deps.store.persist(session);
    if (res.ok && res.effects.length > 0) {
      session = await runEffects(deps, cfg, session, res.effects);
    }
  }
  return session;
}

/** Result of a command run: the exit code and the final session. */
export interface RunResult {
  exitCode: ExitCode;
  session: Session;
}

/**
 * Run a lifecycle command end to end. `status` is read-only: it reconciles
 * without running recovery effects and never mutates.
 */
export async function runCommand(
  cmd: Command | "status",
  deps: InterpreterDeps,
): Promise<RunResult> {
  // 1. Validate config (zero AWS calls on failure).
  const validated = validateConfig(deps.config);
  if (!validated.ok) {
    for (const e of validated.errors) deps.logger.error(`config: ${e.path} ${e.message}`);
    return { exitCode: 2, session: noneSession() };
  }
  const cfg = validated.config;

  // 2. Reconcile (recovery effects run for every command except status).
  const isStatus = cmd === "status";
  const { view, ctx } = await reconcileView(deps, cfg, !isStatus);

  if (isStatus) {
    printStatus(deps, view);
    return { exitCode: 0, session: view.session };
  }

  // 3. Permission pre-check.
  if (!permitted(view, cmd)) {
    // already_terminated exits 0; everything else exits 2.
    const res = step(view, { type: "Command", cmd }, ctx);
    const code = !res.ok && res.rejection.code === "already_terminated" ? 0 : 2;
    if (!res.ok)
      deps.logger.log(`cannot ${cmd}: ${res.rejection.code} (state ${res.rejection.state})`);
    return { exitCode: code as ExitCode, session: view.session };
  }

  // 4. Confirm launch/terminate.
  if (cmd === "launch" || cmd === "terminate") {
    // R10.5: no TTY and no --yes => cannot obtain confirmation => exit 2.
    if (!deps.isTTY && !deps.assumeYes) {
      deps.logger.error(`${cmd} requires confirmation; pass --yes in a non-interactive shell`);
      return { exitCode: 2, session: view.session };
    }
    const message =
      cmd === "launch"
        ? `Launch a MicroVM from ${cfg.imageArn} in ${cfg.region} (max ${cfg.maximumDurationInSeconds}s)?`
        : `Terminate MicroVM ${view.session.microvmId ?? "(pending id)"}? Unsaved state will be lost.`;
    const approved = await confirm(message, {
      isTTY: deps.isTTY,
      assumeYes: deps.assumeYes,
      ...(deps.ask ? { ask: deps.ask } : {}),
    });
    if (!approved) {
      deps.logger.log("cancelled");
      return { exitCode: 0, session: view.session };
    }
  }

  // 5. step(Command) -> 6. persist BEFORE effects -> 7. run effects -> waitLoop.
  const res = step(view, { type: "Command", cmd }, ctx);
  if (!res.ok) {
    return { exitCode: 2, session: view.session };
  }
  deps.store.persist(res.session); // persist-before-execute (R12.4)
  let session = await runEffects(deps, cfg, res.session, res.effects);
  session = await waitLoop(deps, cfg, session);

  const exitCode: ExitCode = session.state === "FAILED" ? 1 : 0;
  if (session.state === "RUNNING") {
    deps.logger.log(`ready: http://127.0.0.1:${cfg.proxy.listenPort}  (run 'csmvm connect')`);
  }
  return { exitCode, session };
}

function printStatus(deps: InterpreterDeps, view: View): void {
  const s = view.session;
  deps.logger.log(
    [
      `session:   ${s.sessionId ?? "(none)"}`,
      `microvm:   ${s.microvmId ?? "(none)"}`,
      `state:     ${s.state}`,
      `rawStatus: ${s.rawRemoteStatus ?? "(none)"}`,
      `adopted:   ${s.adopted}`,
      `strays:    ${view.strays.map((x) => x.microvmId).join(", ") || "(none)"}`,
    ].join("\n"),
  );
  if (s.state === "SUSPENDED") {
    deps.logger.log(
      "note: a suspended MicroVM still incurs snapshot storage cost until terminated.",
    );
  }
}

function noneSession(): Session {
  return {
    sessionId: null,
    microvmId: null,
    state: "NONE",
    adopted: false,
    launchClientToken: null,
    inFlightSince: null,
    lastReconciledAt: null,
    rawRemoteStatus: null,
    region: "ap-northeast-1",
  };
}
