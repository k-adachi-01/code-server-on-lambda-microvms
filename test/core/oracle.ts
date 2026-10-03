// Independent oracle for the user-command rows (C1–C8, C7b), written straight
// from the design transition table and NOT from src/core/transitions.ts. The
// property tests compare the implementation against this oracle, so the oracle
// must stay an independent restatement of the table (task 4.1).

import type { Command, RejectionCode, SessionState, View } from "../../src/core/session.js";

export interface OracleOutcome {
  accepted: boolean;
  /** Present when accepted: the target state the row moves to. */
  to?: SessionState;
  /** Present when rejected: the rejection code. */
  code?: RejectionCode;
}

/**
 * Decide the user-command outcome for (state, strays, cmd) per rows C1–C8/C7b.
 * Pairs not covered by any row are `not_permitted` (R1.3).
 */
export function oracle(view: View, cmd: Command): OracleOutcome {
  const { state } = view.session;
  const hasId = view.session.microvmId !== null;
  const hasStrays = view.strays.length > 0;

  if (cmd === "launch") {
    // C1 / C2: only from NONE or TERMINATED.
    if (state === "NONE" || state === "TERMINATED") {
      return hasStrays
        ? { accepted: false, code: "strays_present" }
        : { accepted: true, to: "LAUNCHING" };
    }
    return { accepted: false, code: "not_permitted" };
  }

  if (cmd === "suspend") {
    // C3: only from RUNNING.
    return state === "RUNNING"
      ? { accepted: true, to: "SUSPENDING" }
      : { accepted: false, code: "not_permitted" };
  }

  if (cmd === "resume") {
    // C4: only from SUSPENDED.
    return state === "SUSPENDED"
      ? { accepted: true, to: "RESUMING" }
      : { accepted: false, code: "not_permitted" };
  }

  // cmd === "terminate"
  // C8: TERMINATED -> already_terminated.
  if (state === "TERMINATED") {
    return { accepted: false, code: "already_terminated" };
  }
  // C5: LAUNCHING, RUNNING, SUSPENDING, SUSPENDED, RESUMING, FAILED with id != null.
  // C6: LAUNCHING with id == null.
  // C7 / C7b: TERMINATING (self-loop), with or without id.
  const c5states: SessionState[] = [
    "LAUNCHING",
    "RUNNING",
    "SUSPENDING",
    "SUSPENDED",
    "RESUMING",
    "FAILED",
  ];
  if (c5states.includes(state)) {
    // Both id present (C5) and the LAUNCHING id==null case (C6) are accepted.
    if (hasId || state === "LAUNCHING") {
      return { accepted: true, to: "TERMINATING" };
    }
    // A non-LAUNCHING state in c5states with no id has no row -> not permitted.
    return { accepted: false, code: "not_permitted" };
  }
  if (state === "TERMINATING") {
    // C7 (id) and C7b (no id) both self-loop to TERMINATING.
    return { accepted: true, to: "TERMINATING" };
  }
  // NONE + terminate: no row.
  return { accepted: false, code: "not_permitted" };
}

/** States from which each command is permitted at least sometimes (for coverage). */
export const COMMANDS: readonly Command[] = ["launch", "suspend", "resume", "terminate"];
