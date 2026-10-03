// mapRemoteStatus (R1.7): a TOTAL mapping from any raw remote status string to
// a SessionState, preserving the raw value. Pure; no imports beyond types.
//
// Recognized statuses map as follows:
//   RUNNING | SUSPENDING | SUSPENDED | TERMINATING | TERMINATED -> same-named
//     remote-backed SessionState.
//   PENDING -> LAUNCHING. PENDING is the pre-RUNNING transitional status; a
//     session observing it is still coming up, so it maps to the local-only
//     LAUNCHING state. (The observation table resolves PENDING via O7 before
//     O13 ever calls mapRemoteStatus, but the mapping must still be defined for
//     totality.)
// Any other string (unrecognized) -> FAILED, with the raw value preserved so
//   callers can record it (R1.8, observation row O11).

import type { SessionState } from "./session.js";

/**
 * Lookup for the recognized remote statuses. A null-prototype object is used so
 * inherited Object.prototype keys (e.g. "valueOf", "toString", "constructor")
 * cannot be mistaken for recognized statuses — those must map to FAILED.
 */
const RECOGNIZED: Readonly<Record<string, SessionState>> = Object.assign(Object.create(null), {
  PENDING: "LAUNCHING",
  RUNNING: "RUNNING",
  SUSPENDING: "SUSPENDING",
  SUSPENDED: "SUSPENDED",
  TERMINATING: "TERMINATING",
  TERMINATED: "TERMINATED",
});

/**
 * Total mapping of a raw remote status to a SessionState. Every string input
 * produces a result; unrecognized values map to FAILED. The `raw` field always
 * echoes the input unchanged.
 */
export function mapRemoteStatus(raw: string): { state: SessionState; raw: string } {
  const state = RECOGNIZED[raw] ?? "FAILED";
  return { state, raw };
}
