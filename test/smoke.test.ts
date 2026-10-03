import { describe, expect, it } from "vite-plus/test";
import fc from "fast-check";
import { NUM_RUNS, pbtParams, propertyTitle } from "./support/pbt.js";

// Smoke test: proves the Vite+ / Vitest / fast-check toolchain is wired up so
// `pnpm test` passes on the scaffold (task 2.3). Real lifecycle properties
// arrive with the core (task 3+).
//
// Vitest APIs are imported from `vite-plus/test` (Vite+ re-exports vitest@5.0.1
// there); a direct `vitest` dependency is intentionally not installed.

describe("scaffold smoke test", () => {
  it("runs at least 100 property cases (NUM_RUNS >= 100)", () => {
    expect(NUM_RUNS).toBeGreaterThanOrEqual(100);
    expect(pbtParams.numRuns).toBeGreaterThanOrEqual(100);
  });

  it("builds the canonical property title", () => {
    expect(propertyTitle(4, "Remote status mapping is total")).toBe(
      "Feature: lambda-microvm-code-server, Property 4: Remote status mapping is total",
    );
  });

  it("exercises fast-check with the shared pbt params (toolchain check)", () => {
    const result = fc.check(
      fc.property(fc.string(), (s) => {
        const reverse = (x: string): string => Array.from(x).reverse().join("");
        return reverse(reverse(s)) === s;
      }),
      pbtParams,
    );
    expect(result.failed).toBe(false);
    expect(result.numRuns).toBeGreaterThanOrEqual(NUM_RUNS);
  });
});
