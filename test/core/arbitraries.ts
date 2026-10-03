// Shared fast-check arbitraries for the core transition/reconcile properties.
// These generate schema-valid Sessions per state, Views with arbitrary strays,
// Ctx with distinct fresh ids, every Event variant, and raw statuses that mix
// known values with random strings (task 4.1).

import fc from "fast-check";
import type {
  AwsErrorInfo,
  Command,
  Ctx,
  Event,
  FileRead,
  ReconcileInput,
  RemoteObs,
  Session,
  SessionState,
  Stray,
  View,
} from "../../src/core/session.js";
import { REMOTE_STATUSES } from "../../src/core/session.js";

const ALL_STATES: readonly SessionState[] = [
  "NONE",
  "LAUNCHING",
  "RUNNING",
  "SUSPENDING",
  "SUSPENDED",
  "RESUMING",
  "TERMINATING",
  "TERMINATED",
  "FAILED",
];

const IN_FLIGHT_STATES: readonly SessionState[] = [
  "LAUNCHING",
  "SUSPENDING",
  "RESUMING",
  "TERMINATING",
];

/** A microvm-id-shaped string. */
export const microvmId = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 1, maxLength: 24 }).map((s) => `mvm-${s.replace(/[^a-zA-Z0-9]/g, "")}x`);

/** A client token of 1..128 chars (A-11). */
export const clientToken = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 1, maxLength: 128 }).map((s) => `lct-${s.replace(/[^a-zA-Z0-9]/g, "")}`);

const region = (): fc.Arbitrary<string> =>
  fc.constantFrom("ap-northeast-1", "us-east-1", "eu-west-1");

/**
 * A schema-valid Session for a given state. Enforces the design invariants:
 * NONE has null sessionId; token present only for LAUNCHING or TERMINATING with
 * no id; inFlightSince present only in in-flight states; microvmId present for
 * states that must have run a MicroVM.
 */
export function sessionForState(state: SessionState): fc.Arbitrary<Session> {
  const inFlight = IN_FLIGHT_STATES.includes(state);
  // States that always have a bound microvmId.
  const mustHaveId = ["RUNNING", "SUSPENDING", "SUSPENDED", "RESUMING"].includes(state);

  return fc
    .record({
      sessionId: state === "NONE" ? fc.constant(null) : fc.uuid(),
      microvmId: mustHaveId ? microvmId() : fc.option(microvmId(), { nil: null }),
      adopted: fc.boolean(),
      inFlightSince: inFlight ? fc.integer({ min: 0, max: 2_000_000_000_000 }) : fc.constant(null),
      lastReconciledAt: fc.option(fc.integer({ min: 0, max: 2_000_000_000_000 }), { nil: null }),
      rawRemoteStatus: fc.option(fc.constantFrom<string>(...REMOTE_STATUSES, "WEIRD_STATUS"), {
        nil: null,
      }),
      region: region(),
    })
    .chain((base) => {
      // Token presence rule: only LAUNCHING, or TERMINATING with microvmId null.
      const needsTokenMaybe =
        state === "LAUNCHING" || (state === "TERMINATING" && base.microvmId === null);
      const tokenArb = needsTokenMaybe ? clientToken() : fc.constant<string | null>(null);
      return tokenArb.map((launchClientToken) => ({
        ...base,
        state,
        launchClientToken,
      }));
    });
}

/** Any schema-valid Session. */
export const anySession = (): fc.Arbitrary<Session> =>
  fc.constantFrom(...ALL_STATES).chain((s) => sessionForState(s));

/** A Session restricted to the given states. */
export const sessionIn = (states: readonly SessionState[]): fc.Arbitrary<Session> =>
  fc.constantFrom(...states).chain((s) => sessionForState(s));

export const stray = (): fc.Arbitrary<Stray> =>
  fc.record({
    microvmId: microvmId(),
    status: fc.constantFrom<string>(...REMOTE_STATUSES, "WEIRD"),
  });

export const strays = (): fc.Arbitrary<Stray[]> => fc.array(stray(), { maxLength: 3 });

/** A View over an arbitrary session with arbitrary strays. */
export const anyView = (): fc.Arbitrary<View> =>
  fc.record({ session: anySession(), strays: strays() });

export const viewForSession = (session: Session): fc.Arbitrary<View> =>
  strays().map((s) => ({ session, strays: s }));

/** A Ctx with distinct fresh ids/tokens and positive timeouts. */
export const ctx = (): fc.Arbitrary<Ctx> =>
  fc.record({
    now: fc.integer({ min: 1, max: 2_000_000_000_000 }),
    newSessionId: fc.uuid(),
    newClientToken: clientToken(),
    timeouts: fc.record({
      launchMs: fc.integer({ min: 1_000, max: 600_000 }),
      suspendMs: fc.integer({ min: 1_000, max: 600_000 }),
      resumeMs: fc.integer({ min: 1_000, max: 600_000 }),
    }),
  });

export const command = (): fc.Arbitrary<Command> =>
  fc.constantFrom<Command>("launch", "suspend", "resume", "terminate");

export const awsError = (): fc.Arbitrary<AwsErrorInfo> =>
  fc
    .record({
      errorName: fc.constantFrom(
        "ThrottlingException",
        "InternalServerException",
        "ValidationException",
        "AccessDeniedException",
        "ResourceNotFoundException",
      ),
      message: fc.string(),
      retryable: fc.boolean(),
      outcomeUnknown: fc.option(fc.boolean(), { nil: undefined }),
    })
    .map(({ outcomeUnknown, ...rest }): AwsErrorInfo =>
      // Omit the optional key entirely when undefined (exactOptionalPropertyTypes).
      outcomeUnknown === undefined ? rest : { ...rest, outcomeUnknown },
    );

export const remoteObs = (): fc.Arbitrary<RemoteObs> =>
  fc.oneof(
    fc.record({
      kind: fc.constant<"status">("status"),
      raw: fc.constantFrom<string>(...REMOTE_STATUSES, "WEIRD_STATUS"),
    }),
    fc.record({ kind: fc.constant<"notFound">("notFound") }),
    fc.record({ kind: fc.constant<"noId">("noId") }),
  );

export const event = (): fc.Arbitrary<Event> =>
  fc.oneof(
    command().map((cmd) => ({ type: "Command", cmd }) as Event),
    microvmId().map((m) => ({ type: "RunSucceeded", microvmId: m }) as Event),
    awsError().map((error) => ({ type: "RunFailed", error }) as Event),
    fc
      .record({
        op: fc.constantFrom<"suspend" | "resume" | "terminate">("suspend", "resume", "terminate"),
        error: awsError(),
      })
      .map((r) => ({ type: "MutationFailed", ...r }) as Event),
    remoteObs().map((remote) => ({ type: "Observed", remote }) as Event),
    fc.constant({ type: "ReadinessSucceeded" } as Event),
  );

export { ALL_STATES, IN_FLIGHT_STATES };

// --- Reconcile input arbitraries --------------------------------------------

export const fileRead = (): fc.Arbitrary<FileRead> =>
  fc.oneof(
    fc.constant<FileRead>({ kind: "absent" }),
    fc.constant<FileRead>({ kind: "corrupt" }),
    anySession().map((session): FileRead => ({ kind: "valid", session })),
  );

export const reconcileInput = (): fc.Arbitrary<ReconcileInput> =>
  fc.record({
    file: fileRead(),
    get: remoteObs(),
    list: strays(),
  });
