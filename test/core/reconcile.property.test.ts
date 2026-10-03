import { describe, expect, it } from "vite-plus/test";
import fc from "fast-check";
import { reconcile } from "../../src/core/reconcile.js";
import { mapRemoteStatus } from "../../src/core/status-map.js";
import { pbtParams, propertyTitle } from "../support/pbt.js";
import { reconcileInput, ctx as ctxArb, microvmId } from "./arbitraries.js";

// Property 3 (reconcile half): deterministic.
describe(propertyTitle(3, "Core functions are deterministic (reconcile)"), () => {
  it("reconcile returns identical results for identical inputs", () => {
    fc.assert(
      fc.property(reconcileInput(), ctxArb(), (input, ctx) => {
        expect(reconcile(input, ctx)).toEqual(reconcile(input, ctx));
      }),
      pbtParams,
    );
  });
});

// Property 14: Reconcile output is always consistent (R9.3, R3.3).
describe(propertyTitle(14, "Reconcile output is always consistent"), () => {
  it("the bound microvmId never appears in strays, and lastReconciledAt is set", () => {
    fc.assert(
      fc.property(reconcileInput(), ctxArb(), (input, ctx) => {
        const { view } = reconcile(input, ctx);
        // lastReconciledAt is stamped.
        expect(view.session.lastReconciledAt).toBe(ctx.now);
        // Strays never include the session's bound id (R3.4).
        if (view.session.microvmId !== null) {
          expect(view.strays.some((s) => s.microvmId === view.session.microvmId)).toBe(false);
        }
        // NONE has a null sessionId.
        if (view.session.state === "NONE") {
          expect(view.session.sessionId).toBeNull();
        }
      }),
      pbtParams,
    );
  });

  it("a corrupt file emits QuarantineStateFile + Notify(corrupt_state)", () => {
    fc.assert(
      fc.property(ctxArb(), (ctx) => {
        const { effects } = reconcile(
          { file: { kind: "corrupt" }, get: { kind: "noId" }, list: [] },
          ctx,
        );
        expect(effects.some((e) => e.kind === "QuarantineStateFile")).toBe(true);
        expect(effects.some((e) => e.kind === "Notify" && e.code === "corrupt_state")).toBe(true);
      }),
      pbtParams,
    );
  });
});

// Property 15: Adoption with a missing State_File (R9.4).
describe(propertyTitle(15, "Adoption with a missing State_File"), () => {
  it("absent file + exactly one active list entry adopts it as a new adopted session", () => {
    fc.assert(
      fc.property(
        microvmId(),
        fc.constantFrom("RUNNING", "SUSPENDED", "SUSPENDING", "TERMINATING"),
        ctxArb(),
        (id, status, ctx) => {
          const { view } = reconcile(
            { file: { kind: "absent" }, get: { kind: "noId" }, list: [{ microvmId: id, status }] },
            ctx,
          );
          expect(view.session.microvmId).toBe(id);
          expect(view.session.sessionId).toBe(ctx.newSessionId);
          expect(view.session.adopted).toBe(true);
          expect(view.session.state).toBe(mapRemoteStatus(status).state);
          // The adopted id is not a stray.
          expect(view.strays.some((s) => s.microvmId === id)).toBe(false);
        },
      ),
      pbtParams,
    );
  });

  it("absent file + two+ active entries -> NONE with those as strays", () => {
    fc.assert(
      fc.property(microvmId(), microvmId(), ctxArb(), (a, b, ctx) => {
        fc.pre(a !== b);
        const list = [
          { microvmId: a, status: "RUNNING" },
          { microvmId: b, status: "RUNNING" },
        ];
        const { view } = reconcile({ file: { kind: "absent" }, get: { kind: "noId" }, list }, ctx);
        expect(view.session.state).toBe("NONE");
        expect(view.strays.length).toBe(2);
      }),
      pbtParams,
    );
  });

  it("absent file + zero active entries -> NONE, no strays", () => {
    fc.assert(
      fc.property(ctxArb(), (ctx) => {
        const { view } = reconcile(
          { file: { kind: "absent" }, get: { kind: "noId" }, list: [] },
          ctx,
        );
        expect(view.session.state).toBe("NONE");
        expect(view.strays).toEqual([]);
      }),
      pbtParams,
    );
  });

  it("TERMINATED entries are not active (excluded from adoption/strays)", () => {
    fc.assert(
      fc.property(microvmId(), ctxArb(), (id, ctx) => {
        const { view } = reconcile(
          {
            file: { kind: "absent" },
            get: { kind: "noId" },
            list: [{ microvmId: id, status: "TERMINATED" }],
          },
          ctx,
        );
        expect(view.session.state).toBe("NONE");
        expect(view.strays).toEqual([]);
      }),
      pbtParams,
    );
  });
});

// Property 10: Reconciler adopts the mapped remote state (R9.2). A valid file
// observing a recognized remote status moves to the mapped state.
describe(propertyTitle(10, "Reconciler adopts the mapped remote state"), () => {
  it("interrupted launch (valid LAUNCHING, token, no id) emits a recovery RunMicrovm", () => {
    fc.assert(
      fc.property(ctxArb(), (ctx) => {
        const session = {
          sessionId: "11111111-1111-4111-8111-111111111111",
          microvmId: null,
          state: "LAUNCHING" as const,
          adopted: false,
          launchClientToken: "lct-abc",
          inFlightSince: ctx.now,
          lastReconciledAt: null,
          rawRemoteStatus: null,
          region: "ap-northeast-1",
        };
        const { view, effects } = reconcile(
          { file: { kind: "valid", session }, get: { kind: "noId" }, list: [] },
          ctx,
        );
        expect(view.session.state).toBe("LAUNCHING");
        const run = effects.find((e) => e.kind === "RunMicrovm");
        expect(run).toBeDefined();
        if (run && run.kind === "RunMicrovm") {
          expect(run.clientToken).toBe("lct-abc");
        }
      }),
      pbtParams,
    );
  });
});
