// Core session model (pure). No AWS SDK, fs, net, http(s), process, or
// child_process imports are allowed here — enforced by the Oxlint core override
// in vite.config.ts and by test/hygiene/core-imports.test.ts.
//
// This file holds the shared type vocabulary for the pure Lifecycle_Core. Only
// the subset needed by the modules implemented so far (status mapping, retry,
// config) is populated with behavior; the rest are the design's type contracts
// that later tasks (transitions, reconcile) build on.

/** The nine logical session states (design "Transition table"). */
export type SessionState =
  | "NONE"
  | "LAUNCHING"
  | "RUNNING"
  | "SUSPENDING"
  | "SUSPENDED"
  | "RESUMING"
  | "TERMINATING"
  | "TERMINATED"
  | "FAILED";

/** States that are backed by a real MicroVM on AWS (R1.1). */
export const REMOTE_BACKED = [
  "RUNNING",
  "SUSPENDING",
  "SUSPENDED",
  "TERMINATING",
  "TERMINATED",
] as const;

/** States that exist only locally, with no live remote binding (R1.1). */
export const LOCAL_ONLY = ["NONE", "LAUNCHING", "RESUMING", "FAILED"] as const;

/**
 * The raw lifecycle statuses the Lambda MicroVMs API reports. `PENDING` is the
 * pre-RUNNING transitional status; the others share a name with a remote-backed
 * SessionState.
 */
export type RemoteStatus =
  | "PENDING"
  | "RUNNING"
  | "SUSPENDING"
  | "SUSPENDED"
  | "TERMINATING"
  | "TERMINATED";

/** The six recognized remote statuses, as a runtime-iterable list. */
export const REMOTE_STATUSES: readonly RemoteStatus[] = [
  "PENDING",
  "RUNNING",
  "SUSPENDING",
  "SUSPENDED",
  "TERMINATING",
  "TERMINATED",
];

/**
 * In-flight states: the ones that set `inFlightSince = now` on entry, clear it
 * on exit, and are subject to an In_Flight_Timeout (`T(state)`). TERMINATING has
 * no FAILED timeout — it only leaves for TERMINATED (O2) — but it still carries
 * `inFlightSince` while it waits.
 */
export const IN_FLIGHT = ["LAUNCHING", "SUSPENDING", "RESUMING", "TERMINATING"] as const;

/** True for the four In_Flight states. */
export function isInFlight(state: SessionState): boolean {
  return (IN_FLIGHT as readonly string[]).includes(state);
}

/**
 * The local session record. `sessionId` is null exactly when `state` is NONE.
 * `microvmId` is set at most once per `sessionId` (R3.1). `launchClientToken` is
 * non-null only while LAUNCHING, or while TERMINATING with no `microvmId` yet
 * (the C6/C7b recovery path, R9.7). `inFlightSince` is non-null only in an
 * In_Flight state.
 */
export interface Session {
  sessionId: string | null;
  microvmId: string | null;
  state: SessionState;
  adopted: boolean;
  launchClientToken: string | null;
  inFlightSince: number | null;
  lastReconciledAt: number | null;
  rawRemoteStatus: string | null;
  region: string;
}

/**
 * Injected context that makes every core function pure. The shell pre-generates
 * the clock, the next session id, and the next client token so the core never
 * touches time, randomness, or I/O.
 */
export interface Ctx {
  now: number;
  newSessionId: string;
  newClientToken: string; // 1..128 chars (A-11)
  timeouts: { launchMs: number; suspendMs: number; resumeMs: number };
}

/** User-issued lifecycle commands. */
export type Command = "launch" | "suspend" | "resume" | "terminate";

/** An AWS error after the adapter has finished its own retries. */
export interface AwsErrorInfo {
  errorName: string;
  message: string;
  retryable: boolean;
  /**
   * True when the outcome of a RunMicrovm call is unknown (network/transport
   * error or client timeout). Drives the E4 (keep token) vs E3 (discard) split:
   * an unknown outcome must never discard to NONE.
   */
  outcomeUnknown?: boolean;
}

/** Events fed into `step`. */
export type Event =
  | { type: "Command"; cmd: Command }
  | { type: "RunSucceeded"; microvmId: string }
  | { type: "RunFailed"; error: AwsErrorInfo }
  | { type: "MutationFailed"; op: "suspend" | "resume" | "terminate"; error: AwsErrorInfo }
  | { type: "Observed"; remote: RemoteObs }
  | { type: "ReadinessSucceeded" };

/** A single remote observation (from GetMicrovm, or the absence of one). */
export type RemoteObs = { kind: "status"; raw: string } | { kind: "notFound" } | { kind: "noId" };

/** Notice codes surfaced via the `Notify` effect. */
export type NoticeCode =
  | "corrupt_state"
  | "launch_recovery_pending"
  | "run_failed"
  | "launch_recoverable"
  | "terminate_retryable"
  | "ready"
  | "timeout"
  | "unknown_status"
  | "state_adopted";

/** Side effects the shell must run after a state transition. */
export type Effect =
  | { kind: "RunMicrovm"; clientToken: string; sessionId: string }
  | { kind: "SuspendMicrovm"; microvmId: string }
  | { kind: "ResumeMicrovm"; microvmId: string }
  | { kind: "TerminateMicrovm"; microvmId: string }
  | { kind: "ProbeReadiness"; microvmId: string }
  | { kind: "Reconcile" }
  | { kind: "QuarantineStateFile" }
  | { kind: "Notify"; code: NoticeCode; detail?: Record<string, string> };

/** The effect kinds that actually mutate AWS, used to assert rejection safety. */
export const MUTATING: ReadonlySet<Effect["kind"]> = new Set([
  "RunMicrovm",
  "SuspendMicrovm",
  "ResumeMicrovm",
  "TerminateMicrovm",
]);

/** A stray MicroVM on the project image that is not the session's bound id. */
export interface Stray {
  microvmId: string;
  status: string;
}

/** The reconciled view the CLI operates on: the session plus any strays. */
export interface View {
  session: Session;
  strays: Stray[];
}

/** Reasons a command can be rejected (no state change, no effects). */
export type RejectionCode = "not_permitted" | "strays_present" | "already_terminated";

/** The result of `step`: either an accepted transition or a rejection. */
export type StepResult =
  | { ok: true; session: Session; effects: Effect[] }
  | {
      ok: false;
      rejection: { state: SessionState; cmd: Command; code: RejectionCode };
      session: Session;
      effects: [];
    };
