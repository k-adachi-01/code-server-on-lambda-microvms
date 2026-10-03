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
