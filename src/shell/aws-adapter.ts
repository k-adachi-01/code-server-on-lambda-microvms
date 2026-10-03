// AWS adapter (shell, R12.1/R12.3/R12.4, R15.4, R2.1, R6.5, R7.6, R8.2, R9.1).
// Defines the MicrovmsPort the CLI depends on, a pure withRetry wrapper, and the
// real @aws-sdk/client-lambda-microvms implementation. The SDK's own retries are
// disabled so the project's withRetry is the only retry layer; credentials come
// only from the default provider chain.

import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import type { RemoteObs } from "../core/session.js";
import type { RunMicrovmParams } from "../core/run-params.js";
import { isRetryable, retryDelayMs } from "../core/retry.js";
import type { RetryPolicy } from "../core/retry.js";

/** A GetMicrovm result enriched with the fields the CLI reads. */
export type GetResult = RemoteObs & { endpoint?: string; remainingSeconds?: number };

/** The port the CLI depends on; FakeMicrovms implements the same shape in tests. */
export interface MicrovmsPort {
  run(p: RunMicrovmParams): Promise<{ microvmId: string }>;
  get(id: string): Promise<GetResult>;
  listByImage(imageArn: string): Promise<{ microvmId: string; status: string }[]>;
  suspend(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  terminate(id: string): Promise<void>;
  createAuthToken(
    id: string,
    port: number,
    minutes: number,
  ): Promise<{ token: string; expiresAt: number }>;
}

/** Extract an AWS error name from an unknown thrown value. */
export function awsErrorName(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const o = err as { name?: unknown };
    if (typeof o.name === "string") return o.name;
  }
  return "UnknownError";
}

/**
 * Retry `op` using the project policy: only Retryable_Errors (ThrottlingException,
 * InternalServerException) are retried, up to `policy.maxAttempts`, sleeping
 * `retryDelayMs(attempt, policy, rand())` between attempts. All other errors are
 * rethrown immediately (R12.3). `rand` and `sleep` are injected so the behavior
 * is deterministic in tests and no SDK is constructed.
 */
export async function withRetry<T>(
  op: () => Promise<T>,
  policy: RetryPolicy,
  rand: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await op();
    } catch (err) {
      const name = awsErrorName(err);
      const lastAttempt = attempt >= policy.maxAttempts - 1;
      if (!isRetryable(name) || lastAttempt) {
        throw err;
      }
      await sleep(retryDelayMs(attempt, policy, rand()));
      attempt += 1;
    }
  }
}

/** The real SDK-backed adapter. */
export class SdkMicrovms implements MicrovmsPort {
  private readonly client: LambdaMicrovmsClient;

  constructor(
    region: string,
    private readonly policy: RetryPolicy,
    private readonly rand: () => number = Math.random,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
    client?: LambdaMicrovmsClient,
  ) {
    // Disable the SDK's own retries (maxAttempts: 1); default credential chain.
    this.client = client ?? new LambdaMicrovmsClient({ region, maxAttempts: 1 });
  }

  private retry<T>(op: () => Promise<T>): Promise<T> {
    return withRetry(op, this.policy, this.rand, this.sleep);
  }

  async run(p: RunMicrovmParams): Promise<{ microvmId: string }> {
    // The same clientToken is reused on every retry (R12.4) because withRetry
    // re-invokes this exact closure with the fixed `p`.
    const out = await this.retry(() =>
      this.client.send(
        new RunMicrovmCommand({
          imageIdentifier: p.imageArn,
          maximumDurationInSeconds: p.maximumDurationInSeconds,
          clientToken: p.clientToken,
          idlePolicy: p.idlePolicy,
          runHookPayload: p.runHookPayload,
          ...(p.networkConnectors !== undefined
            ? { ingressNetworkConnectors: p.networkConnectors }
            : {}),
          ...(p.executionRoleArn !== undefined ? { executionRoleArn: p.executionRoleArn } : {}),
        }),
      ),
    );
    if (out.microvmId === undefined) throw new Error("RunMicrovm returned no microvmId");
    return { microvmId: out.microvmId };
  }

  async get(id: string): Promise<GetResult> {
    try {
      const out = await this.retry(() =>
        this.client.send(new GetMicrovmCommand({ microvmIdentifier: id })),
      );
      const base: GetResult = { kind: "status", raw: out.state ?? "UNKNOWN" };
      if (out.endpoint !== undefined) base.endpoint = out.endpoint;
      // No explicit remaining-duration field: derive from startedAt + max.
      if (out.startedAt !== undefined && out.maximumDurationInSeconds !== undefined) {
        const endMs = out.startedAt.getTime() + out.maximumDurationInSeconds * 1000;
        base.remainingSeconds = Math.max(0, Math.round((endMs - Date.now()) / 1000));
      }
      return base;
    } catch (err) {
      if (awsErrorName(err) === "ResourceNotFoundException") return { kind: "notFound" };
      throw err;
    }
  }

  async listByImage(imageArn: string): Promise<{ microvmId: string; status: string }[]> {
    const results: { microvmId: string; status: string }[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.retry(() =>
        this.client.send(new ListMicrovmsCommand({ imageIdentifier: imageArn, nextToken })),
      );
      for (const item of page.items ?? []) {
        if (item.microvmId !== undefined) {
          results.push({ microvmId: item.microvmId, status: item.state ?? "UNKNOWN" });
        }
      }
      nextToken = page.nextToken;
    } while (nextToken !== undefined && nextToken !== "");
    return results;
  }

  async suspend(id: string): Promise<void> {
    await this.retry(() => this.client.send(new SuspendMicrovmCommand({ microvmIdentifier: id })));
  }

  async resume(id: string): Promise<void> {
    await this.retry(() => this.client.send(new ResumeMicrovmCommand({ microvmIdentifier: id })));
  }

  async terminate(id: string): Promise<void> {
    await this.retry(() =>
      this.client.send(new TerminateMicrovmCommand({ microvmIdentifier: id })),
    );
  }

  async createAuthToken(
    id: string,
    port: number,
    minutes: number,
  ): Promise<{ token: string; expiresAt: number }> {
    const requestStart = Date.now();
    const out = await this.retry(() =>
      this.client.send(
        new CreateMicrovmAuthTokenCommand({
          microvmIdentifier: id,
          expirationInMinutes: minutes,
          allowedPorts: [{ port }],
        }),
      ),
    );
    // authToken is a header map { headerName: headerValue }; the proxy forwards
    // it verbatim. We serialize it as JSON for the single-string token slot.
    const token = JSON.stringify(out.authToken ?? {});
    const expiresAt = requestStart + minutes * 60_000;
    return { token, expiresAt };
  }
}
