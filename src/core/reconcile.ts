// Pure reconciler (R9.1–R9.5, R3.4, R12.6). Reconciles the local State_File
// against the live remote view (GetMicrovm + ListMicrovms) and returns the
// reconciled View plus any recovery / notice effects. Deterministic; no I/O.

import type { Ctx, Effect, ReconcileInput, ReconcileResult, Session, Stray } from "./session.js";
import { mapRemoteStatus } from "./status-map.js";
import { step } from "./transitions.js";

/** A fresh NONE session for the given region. */
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

/** Active list entries = those whose status is not TERMINATED. */
function activeEntries(list: Stray[]): Stray[] {
  return list.filter((e) => e.status !== "TERMINATED");
}

/**
 * Reconcile the file/remote view. Steps follow the design algorithm 1–6.
 *
 * @param input the file read, the GetMicrovm observation, and the full list
 * @param ctx   injected clock + fresh ids
 */
export function reconcile(input: ReconcileInput, ctx: Ctx): ReconcileResult {
  const effects: Effect[] = [];

  // Step 1: corrupt file -> quarantine + notice, then treat as absent.
  let file = input.file;
  if (file.kind === "corrupt") {
    effects.push({ kind: "QuarantineStateFile" });
    effects.push({ kind: "Notify", code: "corrupt_state" });
    file = { kind: "absent" };
  }

  // Step 2: active list.
  const active = activeEntries(input.list);

  // Region: carried from a valid file, else a sensible default from an active
  // entry is not available (list carries no region), so fall back to the
  // design default region used by the config.
  const defaultRegion = file.kind === "valid" ? file.session.region : "ap-northeast-1";

  // Step 3: absent file.
  if (file.kind === "absent") {
    if (active.length === 1) {
      // Adopt the single active entry.
      const entry = active[0] as Stray;
      const mapped = mapRemoteStatus(entry.status);
      const session: Session = {
        sessionId: ctx.newSessionId,
        microvmId: entry.microvmId,
        state: mapped.state,
        adopted: true,
        launchClientToken: null,
        inFlightSince: null,
        lastReconciledAt: ctx.now,
        rawRemoteStatus: entry.status,
        region: defaultRegion,
      };
      return { view: { session, strays: [] }, effects };
    }
    if (active.length >= 2) {
      // Ambiguous: NONE with all active entries as strays (R9.4).
      return {
        view: {
          session: { ...noneSession(defaultRegion), lastReconciledAt: ctx.now },
          strays: active,
        },
        effects,
      };
    }
    // Empty: NONE.
    return {
      view: { session: { ...noneSession(defaultRegion), lastReconciledAt: ctx.now }, strays: [] },
      effects,
    };
  }

  // Step 4: valid file -> apply the observation via step().
  const observed = step(
    { session: file.session, strays: [] },
    { type: "Observed", remote: input.get },
    ctx,
  );
  let session: Session = observed.session;
  effects.push(...observed.effects);

  // strays = active entries excluding the session's bound id (R3.4).
  const strays = active.filter((e) => e.microvmId !== session.microvmId);

  // Step 5: interrupted-launch recovery — LAUNCHING with a token and no id.
  if (
    session.state === "LAUNCHING" &&
    session.launchClientToken !== null &&
    session.microvmId === null
  ) {
    effects.push({
      kind: "RunMicrovm",
      clientToken: session.launchClientToken,
      sessionId: session.sessionId as string,
    });
  }

  // Step 6: stamp lastReconciledAt.
  session = { ...session, lastReconciledAt: ctx.now };

  return { view: { session, strays }, effects };
}
