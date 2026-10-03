// Pure transition function (R1.2–R1.8, R2.x, R3.x, R6–R9, R12.6). `step` is the
// single source of truth for every state change; `permitted` shares its command
// guards without changing state. No imports beyond core types and the status
// map — this module stays pure (no AWS SDK, fs, net, process).
//
// The tables implemented here are the design "Transition table": user commands
// (C1–C8, C7b), adapter results (E1–E9), and observations (O1–O13). Rows are
// matched exactly; any (state, event) pair with no row leaves the session
// unchanged and emits nothing (protects R3.1).

import type {
  Command,
  Ctx,
  Effect,
  Event,
  RemoteObs,
  Session,
  SessionState,
  StepResult,
  View,
} from "./session.js";
import { isInFlight } from "./session.js";
import { mapRemoteStatus } from "./status-map.js";

/** The notFound / eventual-consistency grace: min(launch timeout, 30 s). */
function graceMs(ctx: Ctx): number {
  return Math.min(ctx.timeouts.launchMs, 30_000);
}

/** Timeout for the current in-flight state, or null if the state has none. */
function timeoutFor(state: SessionState, ctx: Ctx): number | null {
  switch (state) {
    case "LAUNCHING":
      return ctx.timeouts.launchMs;
    case "SUSPENDING":
      return ctx.timeouts.suspendMs;
    case "RESUMING":
      return ctx.timeouts.resumeMs;
    default:
      return null; // TERMINATING has no FAILED timeout
  }
}

/** T(state): the in-flight timeout has expired. */
function expired(session: Session, ctx: Ctx): boolean {
  const t = timeoutFor(session.state, ctx);
  if (t === null || session.inFlightSince === null) return false;
  return ctx.now - session.inFlightSince >= t;
}

/** Enter a new state, maintaining inFlightSince per the in-flight rule. */
function enter(
  session: Session,
  next: Partial<Session> & { state: SessionState },
  ctx: Ctx,
): Session {
  const wasInFlight = isInFlight(session.state);
  const willBeInFlight = isInFlight(next.state);
  let inFlightSince = session.inFlightSince;
  if (willBeInFlight && (!wasInFlight || next.state !== session.state)) {
    inFlightSince = ctx.now; // entering an in-flight state (or switching between them)
  } else if (!willBeInFlight) {
    inFlightSince = null; // leaving in-flight
  }
  return { ...session, ...next, inFlightSince };
}

/** The NONE session (file will be deleted by the store). */
function noneSession(region: string): Session {
  return {
    sessionId: null,
    microvmId: null,
    state: "NONE",
    adopted: false,
    launchClientToken: null,
    inFlightSince: null,
    lastReconciledAt: null,
    rawRemoteStatus: null,
    region,
  };
}

function ok(session: Session, effects: Effect[]): StepResult {
  return { ok: true, session, effects };
}

function reject(
  session: Session,
  cmd: Command,
  code: "not_permitted" | "strays_present" | "already_terminated",
): StepResult {
  return { ok: false, rejection: { state: session.state, cmd, code }, session, effects: [] };
}

/** Unchanged, no effects (catch-all for unlisted event/state pairs). */
function unchanged(session: Session): StepResult {
  return ok(session, []);
}

// --- User commands (C1–C8, C7b) ---------------------------------------------

function stepCommand(view: View, cmd: Command, ctx: Ctx): StepResult {
  const s = view.session;
  const hasId = s.microvmId !== null;
  const hasStrays = view.strays.length > 0;

  switch (cmd) {
    case "launch": {
      if (s.state !== "NONE" && s.state !== "TERMINATED") return reject(s, cmd, "not_permitted");
      if (hasStrays) return reject(s, cmd, "strays_present"); // C2
      // C1
      const launched = enter(
        {
          ...noneSession(s.region),
          sessionId: ctx.newSessionId,
          launchClientToken: ctx.newClientToken,
        },
        { state: "LAUNCHING" },
        ctx,
      );
      return ok(launched, [
        { kind: "RunMicrovm", clientToken: ctx.newClientToken, sessionId: ctx.newSessionId },
      ]);
    }

    case "suspend": {
      if (s.state !== "RUNNING" || !hasId) return reject(s, cmd, "not_permitted"); // C3
      return ok(enter(s, { state: "SUSPENDING" }, ctx), [
        { kind: "SuspendMicrovm", microvmId: s.microvmId as string },
      ]);
    }

    case "resume": {
      if (s.state !== "SUSPENDED" || !hasId) return reject(s, cmd, "not_permitted"); // C4
      return ok(enter(s, { state: "RESUMING" }, ctx), [
        { kind: "ResumeMicrovm", microvmId: s.microvmId as string },
      ]);
    }

    case "terminate": {
      if (s.state === "TERMINATED") return reject(s, cmd, "already_terminated"); // C8

      // C5: states with an id -> TerminateMicrovm.
      const c5states: SessionState[] = [
        "LAUNCHING",
        "RUNNING",
        "SUSPENDING",
        "SUSPENDED",
        "RESUMING",
        "FAILED",
      ];
      if (c5states.includes(s.state)) {
        if (hasId) {
          return ok(enter(s, { state: "TERMINATING" }, ctx), [
            { kind: "TerminateMicrovm", microvmId: s.microvmId as string },
          ]);
        }
        // C6: LAUNCHING with no id -> keep token, RunMicrovm to obtain the id.
        if (s.state === "LAUNCHING" && s.launchClientToken !== null) {
          return ok(enter(s, { state: "TERMINATING" }, ctx), [
            {
              kind: "RunMicrovm",
              clientToken: s.launchClientToken,
              sessionId: s.sessionId as string,
            },
          ]);
        }
        return reject(s, cmd, "not_permitted");
      }

      if (s.state === "TERMINATING") {
        // C7: self-loop with id -> re-issue terminate.
        if (hasId) {
          return ok(enter(s, { state: "TERMINATING" }, ctx), [
            { kind: "TerminateMicrovm", microvmId: s.microvmId as string },
          ]);
        }
        // C7b: self-loop, no id -> RunMicrovm to recover the id.
        if (s.launchClientToken !== null) {
          return ok(enter(s, { state: "TERMINATING" }, ctx), [
            {
              kind: "RunMicrovm",
              clientToken: s.launchClientToken,
              sessionId: s.sessionId as string,
            },
          ]);
        }
        return unchanged(s);
      }

      return reject(s, cmd, "not_permitted"); // NONE + terminate
    }
  }
}

// --- Adapter results (E1–E9) -------------------------------------------------

function stepRunSucceeded(s: Session, microvmId: string, ctx: Ctx): StepResult {
  if (s.microvmId !== null) return unchanged(s); // stale (protects R3.1)
  if (s.state === "LAUNCHING") {
    // E1
    return ok(enter(s, { state: "LAUNCHING", microvmId }, ctx), []);
  }
  if (s.state === "TERMINATING") {
    // E2
    return ok(enter(s, { state: "TERMINATING", microvmId, launchClientToken: null }, ctx), [
      { kind: "TerminateMicrovm", microvmId },
    ]);
  }
  return unchanged(s);
}

function stepRunFailed(
  s: Session,
  error: { retryable: boolean; outcomeUnknown?: boolean },
  ctx: Ctx,
): StepResult {
  if (s.microvmId !== null) return unchanged(s);
  if (s.state !== "LAUNCHING" && s.state !== "TERMINATING") return unchanged(s);
  const keepToken = error.retryable || error.outcomeUnknown === true;
  if (keepToken) {
    // E4: retryable-exhausted or unknown outcome -> keep token, stay put.
    return ok(s, [{ kind: "Notify", code: "launch_recoverable" }]);
  }
  // E3: non-retryable, known no-MicroVM outcome -> discard to NONE.
  return ok(enter(noneSession(s.region), { state: "NONE" }, ctx), [
    { kind: "Notify", code: "run_failed" },
  ]);
}

function stepMutationFailed(
  s: Session,
  op: "suspend" | "resume" | "terminate",
  error: { retryable: boolean },
  ctx: Ctx,
): StepResult {
  if (op === "suspend" && s.state === "SUSPENDING") {
    // E5
    return ok(enter(s, { state: "RUNNING" }, ctx), [
      { kind: "Reconcile" },
      { kind: "Notify", code: "state_adopted" },
    ]);
  }
  if (op === "resume" && s.state === "RESUMING") {
    // E6
    return ok(enter(s, { state: "SUSPENDED" }, ctx), [
      { kind: "Reconcile" },
      { kind: "Notify", code: "state_adopted" },
    ]);
  }
  if (op === "terminate" && s.state === "TERMINATING") {
    if (error.retryable) {
      // E7
      return ok(s, [{ kind: "Notify", code: "terminate_retryable" }]);
    }
    // E8
    return ok(s, [{ kind: "Reconcile" }, { kind: "Notify", code: "terminate_retryable" }]);
  }
  return unchanged(s);
}

function stepReadiness(s: Session, ctx: Ctx): StepResult {
  // E9: LAUNCHING/RESUMING with last raw RUNNING -> RUNNING, token cleared.
  if ((s.state === "LAUNCHING" || s.state === "RESUMING") && s.rawRemoteStatus === "RUNNING") {
    return ok(enter(s, { state: "RUNNING", launchClientToken: null }, ctx), [
      { kind: "Notify", code: "ready" },
    ]);
  }
  return unchanged(s);
}

// --- Observations (O1–O13), first match wins --------------------------------

function stepObserved(s: Session, remote: RemoteObs, ctx: Ctx): StepResult {
  const raw = remote.kind === "status" ? remote.raw : null;
  const recognized = raw !== null && mapRemoteStatus(raw).state !== "FAILED";
  const mapped = raw !== null ? mapRemoteStatus(raw).state : null;
  const withinGrace = s.inFlightSince !== null && ctx.now - s.inFlightSince < graceMs(ctx);

  // O1: TERMINATED is terminal.
  if (s.state === "TERMINATED") return unchanged(s);

  // O2 / O3: TERMINATING, FAILED.
  if (s.state === "TERMINATING" || s.state === "FAILED") {
    if (raw === "TERMINATED" || remote.kind === "notFound") {
      return ok(
        enter({ ...s, rawRemoteStatus: raw ?? s.rawRemoteStatus }, { state: "TERMINATED" }, ctx),
        [],
      ); // O2
    }
    // O3: record raw, stay.
    return ok({ ...s, rawRemoteStatus: raw ?? s.rawRemoteStatus }, []);
  }

  // O4: LAUNCHING with noId.
  if (s.state === "LAUNCHING" && remote.kind === "noId") {
    return unchanged(s);
  }

  // O5: LAUNCHING/RESUMING with expired timeout.
  if ((s.state === "LAUNCHING" || s.state === "RESUMING") && expired(s, ctx)) {
    return ok(
      enter({ ...s, rawRemoteStatus: raw ?? s.rawRemoteStatus }, { state: "FAILED" }, ctx),
      [
        {
          kind: "Notify",
          code: "timeout",
          detail: s.rawRemoteStatus ? { lastRaw: s.rawRemoteStatus } : {},
        },
      ],
    );
  }

  // O6: LAUNCHING/RESUMING; TERMINATING/TERMINATED/notFound after the grace.
  if (
    (s.state === "LAUNCHING" || s.state === "RESUMING") &&
    (raw === "TERMINATING" || raw === "TERMINATED" || (remote.kind === "notFound" && !withinGrace))
  ) {
    return ok(
      enter({ ...s, rawRemoteStatus: raw ?? s.rawRemoteStatus }, { state: "FAILED" }, ctx),
      [{ kind: "Notify", code: "timeout" }],
    );
  }

  // O7: LAUNCHING; PENDING, or notFound within the grace.
  if (
    s.state === "LAUNCHING" &&
    (raw === "PENDING" || (remote.kind === "notFound" && withinGrace))
  ) {
    return ok({ ...s, rawRemoteStatus: raw ?? s.rawRemoteStatus }, []);
  }

  // O8: RESUMING; SUSPENDED.
  if (s.state === "RESUMING" && raw === "SUSPENDED") {
    return ok({ ...s, rawRemoteStatus: raw }, []);
  }

  // O9: LAUNCHING/RESUMING; RUNNING -> record raw, probe readiness.
  if ((s.state === "LAUNCHING" || s.state === "RESUMING") && raw === "RUNNING") {
    const probed = { ...s, rawRemoteStatus: "RUNNING" };
    return ok(
      probed,
      s.microvmId !== null ? [{ kind: "ProbeReadiness", microvmId: s.microvmId }] : [],
    );
  }

  // O10: SUSPENDING; RUNNING and not expired.
  if (s.state === "SUSPENDING" && raw === "RUNNING" && !expired(s, ctx)) {
    return ok({ ...s, rawRemoteStatus: "RUNNING" }, []);
  }

  // O11: any; unrecognized raw -> FAILED, raw preserved.
  if (raw !== null && !recognized) {
    return ok(enter({ ...s, rawRemoteStatus: raw }, { state: "FAILED" }, ctx), [
      { kind: "Notify", code: "unknown_status", detail: { raw } },
    ]);
  }

  // O12: any other; notFound -> TERMINATED.
  if (remote.kind === "notFound") {
    return ok(enter(s, { state: "TERMINATED" }, ctx), []);
  }

  // O13: any other; recognized raw -> M(raw), Notify(state_adopted) if changed.
  if (raw !== null && recognized && mapped !== null) {
    const changed = mapped !== s.state;
    return ok(
      enter({ ...s, rawRemoteStatus: raw }, { state: mapped }, ctx),
      changed ? [{ kind: "Notify", code: "state_adopted" }] : [],
    );
  }

  return unchanged(s);
}

/**
 * The pure transition. Dispatches on the event type; command events use the
 * C-rows, adapter results the E-rows, and Observed the O-rows.
 */
export function step(view: View, ev: Event, ctx: Ctx): StepResult {
  switch (ev.type) {
    case "Command":
      return stepCommand(view, ev.cmd, ctx);
    case "RunSucceeded":
      return stepRunSucceeded(view.session, ev.microvmId, ctx);
    case "RunFailed":
      return stepRunFailed(view.session, ev.error, ctx);
    case "MutationFailed":
      return stepMutationFailed(view.session, ev.op, ev.error, ctx);
    case "ReadinessSucceeded":
      return stepReadiness(view.session, ctx);
    case "Observed":
      return stepObserved(view.session, ev.remote, ctx);
  }
}

/**
 * Whether a user command would be accepted. Shares the exact command guards of
 * `step` without changing state (used by the interpreter before confirmation).
 */
export function permitted(view: View, cmd: Command): boolean {
  return stepCommand(view, cmd, {
    now: 0,
    newSessionId: "",
    newClientToken: "x",
    timeouts: { launchMs: 1, suspendMs: 1, resumeMs: 1 },
  }).ok;
}
