import { describe, expect, it } from "vite-plus/test";
import { withRetry, awsErrorName } from "../../src/shell/aws-adapter.js";
import type { RetryPolicy } from "../../src/core/retry.js";
import { FakeAwsError, FakeMicrovms } from "../fakes/fake-microvms.js";
import type { RunMicrovmParams } from "../../src/core/run-params.js";

const policy: RetryPolicy = { maxAttempts: 5, baseMs: 10, capMs: 100 };
const noSleep = async (): Promise<void> => {};
const zeroRand = (): number => 0;

describe("withRetry", () => {
  it("returns the first success without sleeping", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => void sleeps.push(ms);
    const out = await withRetry(
      async () => {
        calls += 1;
        return "ok";
      },
      policy,
      zeroRand,
      sleep,
    );
    expect(out).toBe("ok");
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("retries a retryable error up to maxAttempts then rethrows", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new FakeAwsError("ThrottlingException");
        },
        policy,
        zeroRand,
        noSleep,
      ),
    ).rejects.toThrow("ThrottlingException");
    expect(calls).toBe(policy.maxAttempts); // 5 attempts total
  });

  it("eventually succeeds after transient retryable failures", async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new FakeAwsError("InternalServerException");
        return "recovered";
      },
      policy,
      zeroRand,
      noSleep,
    );
    expect(out).toBe("recovered");
    expect(calls).toBe(3);
  });

  it("does not retry a non-retryable error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new FakeAwsError("ValidationException");
        },
        policy,
        zeroRand,
        noSleep,
      ),
    ).rejects.toThrow("ValidationException");
    expect(calls).toBe(1);
  });
});

describe("awsErrorName", () => {
  it("reads .name from an error-like object", () => {
    expect(awsErrorName(new FakeAwsError("ThrottlingException"))).toBe("ThrottlingException");
    expect(awsErrorName({})).toBe("UnknownError");
    expect(awsErrorName("boom")).toBe("UnknownError");
  });
});

describe("FakeMicrovms", () => {
  const params = (clientToken: string): RunMicrovmParams => ({
    imageArn: "arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:x",
    maximumDurationInSeconds: 7200,
    clientToken,
    idlePolicy: {
      autoResumeEnabled: false,
      maxIdleDurationSeconds: 7200,
      suspendedDurationSeconds: 7200,
    },
    runHookPayload: JSON.stringify({ sessionId: "s" }),
  });

  it("returns the same microvmId for a repeated clientToken (idempotency)", async () => {
    const fake = new FakeMicrovms();
    const a = await fake.run(params("tok-1"));
    const b = await fake.run(params("tok-1"));
    expect(a.microvmId).toBe(b.microvmId);
    expect(fake.countOf("run")).toBe(2);
  });

  it("honors delayed visibility (notFound then status)", async () => {
    const fake = new FakeMicrovms({ notFoundFor: 2, statusScript: ["RUNNING"] });
    const { microvmId } = await fake.run(params("tok-2"));
    expect((await fake.get(microvmId)).kind).toBe("notFound");
    expect((await fake.get(microvmId)).kind).toBe("notFound");
    expect((await fake.get(microvmId)).kind).toBe("status");
  });

  it("injects a per-call error", async () => {
    const fake = new FakeMicrovms();
    fake.injectError("suspend", new FakeAwsError("ConflictException"));
    const { microvmId } = await fake.run(params("tok-3"));
    await expect(fake.suspend(microvmId)).rejects.toThrow("ConflictException");
    // Second call no longer throws.
    await fake.suspend(microvmId);
  });

  it("records calls in order", async () => {
    const fake = new FakeMicrovms();
    const { microvmId } = await fake.run(params("tok-4"));
    await fake.get(microvmId);
    await fake.terminate(microvmId);
    expect(fake.calls.map((c) => c.method)).toEqual(["run", "get", "terminate"]);
  });
});
