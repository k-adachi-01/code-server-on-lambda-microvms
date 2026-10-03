import { describe, expect, it } from "vite-plus/test";
import fc from "fast-check";
import { buildRunParams, MAX_RUN_HOOK_PAYLOAD_BYTES } from "../../src/core/run-params.js";
import { validateConfig, MAX_DURATION_SECONDS } from "../../src/core/config.js";
import type { CliConfig } from "../../src/core/config.js";
import { pbtParams, propertyTitle } from "../support/pbt.js";
import { clientToken } from "./arbitraries.js";

const IMAGE_ARN = "arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:example";

/** A valid CliConfig arbitrary, built through validateConfig so it is realistic. */
function cliConfig(overrides: Record<string, unknown> = {}): fc.Arbitrary<CliConfig> {
  return fc
    .record({
      maximumDurationInSeconds: fc.integer({ min: 1, max: MAX_DURATION_SECONDS }),
      suspendedDurationSeconds: fc.integer({ min: 1, max: MAX_DURATION_SECONDS }),
    })
    .map(({ maximumDurationInSeconds, suspendedDurationSeconds }) => {
      const res = validateConfig({
        imageArn: IMAGE_ARN,
        maximumDurationInSeconds,
        suspendedDurationSeconds,
        ...overrides,
      });
      if (!res.ok) throw new Error("fixture config invalid: " + JSON.stringify(res.errors));
      return res.config;
    });
}

const sessionId = (): fc.Arbitrary<string> => fc.uuid();

// Property 16 (run-params half): buildRunParams honors the config bounds and the
// run-params contract (R2.1, R2.5, R2.8, R2.9, R11.1).
describe(propertyTitle(16, "Config bounds and run parameters (run-params)"), () => {
  it("sets maximumDurationInSeconds from config and a full idlePolicy", () => {
    fc.assert(
      fc.property(cliConfig(), clientToken(), sessionId(), (cfg, token, sid) => {
        const p = buildRunParams(cfg, token, sid);
        expect(p.maximumDurationInSeconds).toBe(cfg.maximumDurationInSeconds);
        expect(p.imageArn).toBe(cfg.imageArn);
        expect(p.clientToken).toBe(token);
        // idlePolicy: all three fields, autoResume off, maxIdle >= 60.
        expect(p.idlePolicy.autoResumeEnabled).toBe(false);
        expect(p.idlePolicy.maxIdleDurationSeconds).toBe(
          Math.max(60, cfg.maximumDurationInSeconds),
        );
        expect(p.idlePolicy.maxIdleDurationSeconds).toBeGreaterThanOrEqual(60);
        expect(p.idlePolicy.suspendedDurationSeconds).toBe(cfg.suspendedDurationSeconds);
      }),
      pbtParams,
    );
  });

  it("runHookPayload contains only sessionId and stays within 4096 bytes", () => {
    fc.assert(
      fc.property(cliConfig(), clientToken(), sessionId(), (cfg, token, sid) => {
        const p = buildRunParams(cfg, token, sid);
        expect(JSON.parse(p.runHookPayload)).toEqual({ sessionId: sid });
        expect(new TextEncoder().encode(p.runHookPayload).length).toBeLessThanOrEqual(
          MAX_RUN_HOOK_PAYLOAD_BYTES,
        );
      }),
      pbtParams,
    );
  });

  it("omits networkConnectors and executionRoleArn by default", () => {
    fc.assert(
      fc.property(cliConfig(), clientToken(), sessionId(), (cfg, token, sid) => {
        const p = buildRunParams(cfg, token, sid);
        expect(p.networkConnectors).toBeUndefined();
        expect(p.executionRoleArn).toBeUndefined();
      }),
      pbtParams,
    );
  });

  it("passes configured networkConnectorArns through exactly", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .string({ minLength: 1, maxLength: 20 })
            .map((s) => `arn:nc:${s.replace(/[^a-zA-Z0-9]/g, "")}x`),
          {
            minLength: 1,
            maxLength: 3,
          },
        ),
        clientToken(),
        sessionId(),
        (arns, token, sid) => {
          return fc.assert(
            fc.property(cliConfig({ networkConnectorArns: arns }), (cfg) => {
              const p = buildRunParams(cfg, token, sid);
              expect(p.networkConnectors).toEqual(arns);
            }),
            { numRuns: 5 },
          );
        },
      ),
      pbtParams,
    );
  });
});
