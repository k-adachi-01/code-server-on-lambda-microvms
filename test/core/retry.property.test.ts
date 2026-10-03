import { describe, expect, it } from "vite-plus/test";
import fc from "fast-check";
import { retryDelayMs, isRetryable } from "../../src/core/retry.js";
import { pbtParams, propertyTitle } from "../support/pbt.js";

// Property 17: Retry delay bounds (R12.2).
//
// For full-jitter backoff with upper = min(capMs, baseMs * 2 ** attempt), the
// delay is an integer in [0, upper] and never exceeds capMs, for every attempt,
// policy, and rand01 in [0, 1).

describe(propertyTitle(17, "Retry delay bounds"), () => {
  it("stays within [0, min(capMs, baseMs*2**attempt)] and never exceeds capMs", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 40 }), // attempt (bounded so 2**attempt stays finite)
        fc.integer({ min: 1, max: 60_000 }), // baseMs
        fc.integer({ min: 1, max: 60_000 }), // capMs candidate
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), // rand01 in [0,1)
        (attempt, baseMs, capMsCandidate, rand01) => {
          const capMs = Math.max(baseMs, capMsCandidate); // capMs >= baseMs (config invariant)
          const upper = Math.min(capMs, baseMs * 2 ** attempt);
          const delay = retryDelayMs(attempt, { baseMs, capMs }, rand01);

          expect(Number.isInteger(delay)).toBe(true);
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(upper);
          expect(delay).toBeLessThanOrEqual(capMs);
        },
      ),
      pbtParams,
    );
  });

  it("is monotonic in rand01 for a fixed attempt and policy", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 20 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
        (attempt, baseMs, capMsCandidate, r1, r2) => {
          const capMs = Math.max(baseMs, capMsCandidate);
          const p = { baseMs, capMs };
          const lo = Math.min(r1, r2);
          const hi = Math.max(r1, r2);
          expect(retryDelayMs(attempt, p, lo)).toBeLessThanOrEqual(retryDelayMs(attempt, p, hi));
        },
      ),
      pbtParams,
    );
  });

  it("classifies only ThrottlingException and InternalServerException as retryable", () => {
    expect(isRetryable("ThrottlingException")).toBe(true);
    expect(isRetryable("InternalServerException")).toBe(true);
    fc.assert(
      fc.property(fc.string(), (name) => {
        const expected = name === "ThrottlingException" || name === "InternalServerException";
        expect(isRetryable(name)).toBe(expected);
      }),
      pbtParams,
    );
  });
});
