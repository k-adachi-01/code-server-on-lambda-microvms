import { describe, expect, it } from "vite-plus/test";
import fc from "fast-check";
import { step } from "../../src/core/transitions.js";
import type { SessionState } from "../../src/core/session.js";
import { pbtParams, propertyTitle } from "../support/pbt.js";
import {
  anyView,
  anySession,
  sessionForState,
  sessionIn,
  ctx as ctxArb,
  event as eventArb,
  remoteObs,
} from "./arbitraries.js";

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

// Property 3: Core functions are deterministic (R1.6). Covers step; reconcile is
// covered in reconcile.property.test.ts.
describe(propertyTitle(3, "Core functions are deterministic"), () => {
  it("step returns identical results for identical inputs", () => {
    fc.assert(
      fc.property(anyView(), eventArb(), ctxArb(), (view, ev, ctx) => {
        const a = step(view, ev, ctx);
        const b = step(view, ev, ctx);
        expect(a).toEqual(b);
      }),
      pbtParams,
    );
  });
});

// Property 5: FAILED is entered only from allowed sources (R1.8). The only rows
// that reach FAILED are O5/O6 (LAUNCHING, RESUMING) and O11 (unrecognized raw).
describe(propertyTitle(5, "FAILED is entered only from allowed sources"), () => {
  it("a transition into FAILED comes only from LAUNCHING/RESUMING timeout/terminal, or an unrecognized status", () => {
    fc.assert(
      fc.property(anyView(), eventArb(), ctxArb(), (view, ev, ctx) => {
        const res = step(view, ev, ctx);
        if (res.ok && res.session.state === "FAILED" && view.session.state !== "FAILED") {
          // Entering FAILED is only ever via an Observed event.
          expect(ev.type).toBe("Observed");
          if (ev.type === "Observed") {
            const fromLaunchOrResume =
              view.session.state === "LAUNCHING" || view.session.state === "RESUMING";
            const unrecognized =
              ev.remote.kind === "status" &&
              ![
                "PENDING",
                "RUNNING",
                "SUSPENDING",
                "SUSPENDED",
                "TERMINATING",
                "TERMINATED",
              ].includes(ev.remote.raw);
            expect(fromLaunchOrResume || unrecognized).toBe(true);
          }
        }
      }),
      pbtParams,
    );
  });
});

// Property 6: One MicroVM per Session for its whole life (R3.1, R3.3). step never
// changes an already-set microvmId, and only sets it from null.
describe(propertyTitle(6, "One MicroVM per Session for its whole life"), () => {
  it("step never rebinds an existing microvmId to a different value", () => {
    fc.assert(
      fc.property(anyView(), eventArb(), ctxArb(), (view, ev, ctx) => {
        const before = view.session.microvmId;
        const res = step(view, ev, ctx);
        const after = res.session.microvmId;
        if (before !== null) {
          // An existing id is never changed (it may be carried unchanged).
          expect(after).toBe(before);
        }
      }),
      pbtParams,
    );
  });
});

// Property 8: Suspend/resume cycles preserve identity (R6.3, R7.3, R7.4). The
// session id and microvm id are stable across suspend/resume observations.
describe(propertyTitle(8, "Suspend/resume cycles preserve identity"), () => {
  it("observing status while SUSPENDING/SUSPENDED/RESUMING keeps sessionId and microvmId", () => {
    fc.assert(
      fc.property(
        sessionIn(["SUSPENDING", "SUSPENDED", "RESUMING"]),
        remoteObs(),
        ctxArb(),
        (session, remote, ctx) => {
          const res = step({ session, strays: [] }, { type: "Observed", remote }, ctx);
          expect(res.session.sessionId).toBe(session.sessionId);
          if (session.microvmId !== null) {
            expect(res.session.microvmId).toBe(session.microvmId);
          }
        },
      ),
      pbtParams,
    );
  });
});

// Property 11: In-flight states are kept before timeout (R9.9, R9.10). LAUNCHING
// observing PENDING (within grace) stays LAUNCHING; RESUMING observing SUSPENDED
// stays RESUMING; SUSPENDING observing RUNNING (not expired) stays SUSPENDING.
describe(propertyTitle(11, "In-flight states are kept before timeout"), () => {
  it("LAUNCHING + PENDING (fresh) stays LAUNCHING", () => {
    fc.assert(
      fc.property(ctxArb(), (ctx) => {
        return fc.assert(
          fc.property(sessionForState("LAUNCHING"), (session) => {
            // Make it fresh: inFlightSince = now so grace/timeout have not passed.
            const s = {
              ...session,
              inFlightSince: ctx.now,
              microvmId: session.microvmId ?? "mvm-x",
            };
            const res = step(
              { session: s, strays: [] },
              { type: "Observed", remote: { kind: "status", raw: "PENDING" } },
              ctx,
            );
            expect(res.session.state).toBe("LAUNCHING");
          }),
          { numRuns: 10 },
        );
      }),
      pbtParams,
    );
  });

  it("RESUMING + SUSPENDED stays RESUMING", () => {
    fc.assert(
      fc.property(ctxArb(), (ctx) => {
        return fc.assert(
          fc.property(sessionForState("RESUMING"), (session) => {
            const s = { ...session, inFlightSince: ctx.now };
            const res = step(
              { session: s, strays: [] },
              { type: "Observed", remote: { kind: "status", raw: "SUSPENDED" } },
              ctx,
            );
            expect(res.session.state).toBe("RESUMING");
          }),
          { numRuns: 10 },
        );
      }),
      pbtParams,
    );
  });
});

// Property 12: Failed launches and resumes become FAILED (R9.11). An expired
// in-flight LAUNCHING/RESUMING observation goes to FAILED.
describe(propertyTitle(12, "Failed launches and resumes become FAILED"), () => {
  it("LAUNCHING/RESUMING past the timeout with an id goes to FAILED", () => {
    fc.assert(
      fc.property(fc.constantFrom<SessionState>("LAUNCHING", "RESUMING"), ctxArb(), (st, ctx) => {
        return fc.assert(
          fc.property(sessionForState(st), (session) => {
            // Force expiry: inFlightSince well before now minus the timeout.
            const s = { ...session, microvmId: session.microvmId ?? "mvm-x", inFlightSince: 0 };
            const bigNowCtx = { ...ctx, now: 10_000_000_000 };
            const res = step(
              { session: s, strays: [] },
              { type: "Observed", remote: { kind: "status", raw: "PENDING" } },
              bigNowCtx,
            );
            expect(res.session.state).toBe("FAILED");
          }),
          { numRuns: 10 },
        );
      }),
      pbtParams,
    );
  });
});

// Property 13: TERMINATING and FAILED converge only to TERMINATED (R9.12). From
// TERMINATING/FAILED, an observation either stays or moves to TERMINATED, never
// to another state.
describe(propertyTitle(13, "TERMINATING and FAILED converge only to TERMINATED"), () => {
  it("observations from TERMINATING/FAILED yield only the same state or TERMINATED", () => {
    fc.assert(
      fc.property(
        sessionIn(["TERMINATING", "FAILED"]),
        remoteObs(),
        ctxArb(),
        (session, remote, ctx) => {
          const res = step({ session, strays: [] }, { type: "Observed", remote }, ctx);
          expect([session.state, "TERMINATED"]).toContain(res.session.state);
        },
      ),
      pbtParams,
    );
  });
});

// Keep broad arbitraries referenced.
void anySession;
void ALL_STATES;
