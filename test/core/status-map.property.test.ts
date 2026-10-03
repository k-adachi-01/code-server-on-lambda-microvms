import { describe, expect, it } from "vite-plus/test";
import fc from "fast-check";
import { mapRemoteStatus } from "../../src/core/status-map.js";
import { REMOTE_STATUSES, REMOTE_BACKED } from "../../src/core/session.js";
import { pbtParams, propertyTitle } from "../support/pbt.js";

// Property 4: Remote status mapping is total (R1.7).
//
// For every possible string input, mapRemoteStatus returns a defined
// SessionState and echoes the raw value unchanged. Recognized statuses map to
// their documented state (PENDING -> LAUNCHING, the five remote-backed statuses
// to their same-named state); every unrecognized string maps to FAILED.

const ALL_STATES = new Set([
  "NONE",
  "LAUNCHING",
  "RUNNING",
  "SUSPENDING",
  "SUSPENDED",
  "RESUMING",
  "TERMINATING",
  "TERMINATED",
  "FAILED",
]);

const RECOGNIZED_EXPECTED: Record<string, string> = {
  PENDING: "LAUNCHING",
  RUNNING: "RUNNING",
  SUSPENDING: "SUSPENDING",
  SUSPENDED: "SUSPENDED",
  TERMINATING: "TERMINATING",
  TERMINATED: "TERMINATED",
};

describe(propertyTitle(4, "Remote status mapping is total"), () => {
  it("maps every string to a defined state and preserves the raw value", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const { state, raw: echoed } = mapRemoteStatus(raw);
        // Raw is always echoed unchanged.
        expect(echoed).toBe(raw);
        // The result is always one of the nine known states (totality).
        expect(ALL_STATES.has(state)).toBe(true);
        // Unrecognized inputs always map to FAILED.
        if (!Object.hasOwn(RECOGNIZED_EXPECTED, raw)) {
          expect(state).toBe("FAILED");
        }
      }),
      pbtParams,
    );
  });

  it("maps each recognized remote status to its documented state", () => {
    fc.assert(
      fc.property(fc.constantFrom(...REMOTE_STATUSES), (status) => {
        const { state } = mapRemoteStatus(status);
        expect(state).toBe(RECOGNIZED_EXPECTED[status]);
      }),
      pbtParams,
    );
  });

  it("maps the five same-named remote-backed statuses to themselves", () => {
    for (const s of REMOTE_BACKED) {
      expect(mapRemoteStatus(s).state).toBe(s);
    }
  });
});
