import { describe, expect, it } from "vite-plus/test";
import fc from "fast-check";
import { validateConfig, MAX_DURATION_SECONDS } from "../../src/core/config.js";
import { pbtParams, propertyTitle } from "../support/pbt.js";

// Property 16: Config bounds and run parameters (R2.5, R4.10, R11.1, R11.2).
//
// This covers the config-validation half of design Property 16: the 7200
// default for maximumDurationInSeconds, the suspendedDurationSeconds default and
// bound, and that no network connectors are present by default. (buildRunParams
// lands with task 7.2; its idlePolicy assertions are added there.)

const VALID_IMAGE_ARN = "arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:example";

describe(propertyTitle(16, "Config bounds and run parameters"), () => {
  it("applies defaults when optional fields are omitted", () => {
    const res = validateConfig({ imageArn: VALID_IMAGE_ARN });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.config;
    expect(c.region).toBe("ap-northeast-1");
    expect(c.maximumDurationInSeconds).toBe(7200);
    // suspendedDurationSeconds defaults to the resolved maximumDurationInSeconds.
    expect(c.suspendedDurationSeconds).toBe(7200);
    expect(c.codeServerPort).toBe(8080);
    expect(c.proxy.listenPort).toBe(8787);
    expect(c.proxy.localAuth).toBe(true);
    expect(c.token.maxExpirationMinutes).toBe(15);
    expect(c.retry.maxAttempts).toBe(5);
    expect(c.pollIntervalSeconds).toBe(3);
    // No network connectors by default (R2.8).
    expect(c.networkConnectorArns).toBeUndefined();
  });

  it("requires imageArn", () => {
    const res = validateConfig({});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.some((e) => e.path === "imageArn")).toBe(true);
  });

  it("accepts in-range integer durations and rejects out-of-range ones", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_DURATION_SECONDS }),
        fc.integer({ min: 1, max: MAX_DURATION_SECONDS }),
        (maxDur, suspended) => {
          const res = validateConfig({
            imageArn: VALID_IMAGE_ARN,
            maximumDurationInSeconds: maxDur,
            suspendedDurationSeconds: suspended,
          });
          expect(res.ok).toBe(true);
          if (!res.ok) return;
          expect(res.config.maximumDurationInSeconds).toBe(maxDur);
          expect(res.config.suspendedDurationSeconds).toBe(suspended);
        },
      ),
      pbtParams,
    );
  });

  it("rejects durations below 1 or above the maximum", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -10_000, max: 0 }),
          fc.integer({ min: MAX_DURATION_SECONDS + 1, max: MAX_DURATION_SECONDS + 100_000 }),
        ),
        (bad) => {
          const res = validateConfig({
            imageArn: VALID_IMAGE_ARN,
            maximumDurationInSeconds: bad,
          });
          expect(res.ok).toBe(false);
          if (res.ok) return;
          expect(res.errors.some((e) => e.path === "maximumDurationInSeconds")).toBe(true);
        },
      ),
      pbtParams,
    );
  });

  it("suspendedDurationSeconds defaults to the resolved maximumDurationInSeconds", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_DURATION_SECONDS }), (maxDur) => {
        const res = validateConfig({
          imageArn: VALID_IMAGE_ARN,
          maximumDurationInSeconds: maxDur,
        });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.config.suspendedDurationSeconds).toBe(maxDur);
      }),
      pbtParams,
    );
  });

  it("rejects token.maxExpirationMinutes outside 1..60", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer({ min: -100, max: 0 }), fc.integer({ min: 61, max: 10_000 })),
        (bad) => {
          const res = validateConfig({
            imageArn: VALID_IMAGE_ARN,
            token: { maxExpirationMinutes: bad },
          });
          expect(res.ok).toBe(false);
          if (res.ok) return;
          expect(res.errors.some((e) => e.path === "token.maxExpirationMinutes")).toBe(true);
        },
      ),
      pbtParams,
    );
  });

  it("rejects non-object input", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.array(fc.anything()),
        ),
        (notObj) => {
          const res = validateConfig(notObj);
          expect(res.ok).toBe(false);
        },
      ),
      pbtParams,
    );
  });
});
