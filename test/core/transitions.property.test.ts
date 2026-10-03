import { describe, expect, it } from "vite-plus/test";
import fc from "fast-check";
import { step, permitted } from "../../src/core/transitions.js";
import { MUTATING } from "../../src/core/session.js";
import type { Effect } from "../../src/core/session.js";
import { pbtParams, propertyTitle } from "../support/pbt.js";
import { oracle } from "./oracle.js";
import {
  anyView,
  anySession,
  viewForSession,
  sessionForState,
  ctx as ctxArb,
  command,
} from "./arbitraries.js";

// Property 1: Command acceptance matches the transition table (R1.2, R1.3, R1.5, R3.2).
describe(propertyTitle(1, "Command acceptance matches the transition table"), () => {
  it("accepts/rejects exactly as the independent oracle says, with the same target", () => {
    fc.assert(
      fc.property(anyView(), command(), ctxArb(), (view, cmd, ctx) => {
        const expected = oracle(view, cmd);
        const res = step(view, { type: "Command", cmd }, ctx);

        expect(res.ok).toBe(expected.accepted);
        // permitted() must agree with step()'s acceptance.
        expect(permitted(view, cmd)).toBe(expected.accepted);

        if (expected.accepted) {
          if (res.ok) {
            expect(res.session.state).toBe(expected.to);
          }
        } else {
          if (!res.ok) {
            expect(res.rejection.code).toBe(expected.code);
            // Rejection returns the input session unchanged.
            expect(res.session).toEqual(view.session);
          }
        }
      }),
      pbtParams,
    );
  });
});

// Property 2: Rejections carry no mutating effects (R1.4).
describe(propertyTitle(2, "Rejections carry no mutating effects"), () => {
  it("a rejected command returns zero effects and an unchanged session", () => {
    fc.assert(
      fc.property(anyView(), command(), ctxArb(), (view, cmd, ctx) => {
        const res = step(view, { type: "Command", cmd }, ctx);
        if (!res.ok) {
          expect(res.effects).toEqual([]);
          expect(res.session).toEqual(view.session);
        } else {
          // Even accepted commands: no mutating effect ever targets a rejection,
          // but more importantly every emitted effect is a known kind.
          for (const e of res.effects as Effect[]) {
            expect(typeof e.kind).toBe("string");
          }
        }
      }),
      pbtParams,
    );
  });
});

// Property 9: Terminate is idempotent (R8.3).
describe(propertyTitle(9, "Terminate is idempotent"), () => {
  it("terminate on TERMINATED is rejected already_terminated with no effects", () => {
    fc.assert(
      fc.property(sessionForState("TERMINATED"), ctxArb(), (session, ctx) => {
        return fc.assert(
          fc.property(viewForSession(session), (view) => {
            const res = step(view, { type: "Command", cmd: "terminate" }, ctx);
            expect(res.ok).toBe(false);
            if (!res.ok) {
              expect(res.rejection.code).toBe("already_terminated");
              expect(res.effects).toEqual([]);
            }
          }),
          { numRuns: 10 },
        );
      }),
      pbtParams,
    );
  });

  it("terminate on TERMINATING self-loops to TERMINATING (stays terminating)", () => {
    fc.assert(
      fc.property(sessionForState("TERMINATING"), ctxArb(), (session, ctx) => {
        const view = { session, strays: [] };
        const res = step(view, { type: "Command", cmd: "terminate" }, ctx);
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.session.state).toBe("TERMINATING");
        }
      }),
      pbtParams,
    );
  });
});

// Property 7: Relaunch creates a new Session (R3.5).
describe(propertyTitle(7, "Relaunch creates a new Session"), () => {
  it("launch from NONE/TERMINATED (no strays) starts LAUNCHING with the ctx ids and a RunMicrovm", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<"NONE" | "TERMINATED">("NONE", "TERMINATED"),
        ctxArb(),
        (fromState, ctx) => {
          return fc.assert(
            fc.property(sessionForState(fromState), (session) => {
              const view = { session, strays: [] };
              const res = step(view, { type: "Command", cmd: "launch" }, ctx);
              expect(res.ok).toBe(true);
              if (!res.ok) return;
              expect(res.session.state).toBe("LAUNCHING");
              expect(res.session.sessionId).toBe(ctx.newSessionId);
              expect(res.session.microvmId).toBeNull();
              expect(res.session.launchClientToken).toBe(ctx.newClientToken);
              expect(res.session.adopted).toBe(false);
              // Exactly one RunMicrovm effect with the fresh token + sessionId.
              const runs = res.effects.filter((e) => e.kind === "RunMicrovm");
              expect(runs.length).toBe(1);
              const run = runs[0];
              if (run && run.kind === "RunMicrovm") {
                expect(run.clientToken).toBe(ctx.newClientToken);
                expect(run.sessionId).toBe(ctx.newSessionId);
              }
              expect(MUTATING.has("RunMicrovm")).toBe(true);
            }),
            { numRuns: 10 },
          );
        },
      ),
      pbtParams,
    );
  });

  it("launch is rejected strays_present when strays exist", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<"NONE" | "TERMINATED">("NONE", "TERMINATED"),
        ctxArb(),
        (fromState, ctx) => {
          return fc.assert(
            fc.property(sessionForState(fromState), (session) => {
              const view = { session, strays: [{ microvmId: "mvm-stray", status: "RUNNING" }] };
              const res = step(view, { type: "Command", cmd: "launch" }, ctx);
              expect(res.ok).toBe(false);
              if (!res.ok) {
                expect(res.rejection.code).toBe("strays_present");
                expect(res.effects).toEqual([]);
              }
            }),
            { numRuns: 10 },
          );
        },
      ),
      pbtParams,
    );
  });
});

// Keep anySession imported-and-used for future extension without lint noise.
void anySession;
