// In-memory MicrovmsPort for tests (R16.6). No AWS SDK is ever constructed; the
// suite runs with no credentials and no network. Supports:
//  - status scripts (a queue of statuses returned by successive get() calls),
//  - delayed visibility (first N get()s after run() return notFound),
//  - per-call error injection (by method name),
//  - idempotent clientToken (same token -> same microvmId),
//  - full call recording.

import type { GetResult, MicrovmsPort } from "../../src/shell/aws-adapter.js";
import type { RunMicrovmParams } from "../../src/core/run-params.js";

export interface FakeCall {
  method: string;
  args: unknown;
}

interface MicrovmRecord {
  microvmId: string;
  statusScript: string[]; // consumed front-to-back; last value sticks
  endpoint: string;
  notFoundFor: number; // remaining get() calls that should return notFound
}

/** A named error to inject; `name` is used by the adapter's error classifier. */
export class FakeAwsError extends Error {
  constructor(
    public override readonly name: string,
    message = name,
  ) {
    super(message);
  }
}

export interface FakeOptions {
  /** Status script for the next launched MicroVM (defaults to a RUNNING ramp). */
  statusScript?: string[];
  /** Number of initial get() calls that return notFound (eventual consistency). */
  notFoundFor?: number;
  /** Endpoint returned by get() once visible. */
  endpoint?: string;
}

export class FakeMicrovms implements MicrovmsPort {
  readonly calls: FakeCall[] = [];
  private readonly byToken = new Map<string, string>();
  private readonly vms = new Map<string, MicrovmRecord>();
  private idSeq = 0;

  /** Queued errors by method name; the next matching call throws and consumes one. */
  private readonly errorQueue = new Map<string, Error[]>();

  constructor(private readonly opts: FakeOptions = {}) {}

  /** Inject an error to be thrown on the next call to `method`. */
  injectError(method: string, err: Error): void {
    const q = this.errorQueue.get(method) ?? [];
    q.push(err);
    this.errorQueue.set(method, q);
  }

  /** Directly seed a MicroVM (for list/stray tests), returning its id. */
  seed(status: string, endpoint = "https://vm.example"): string {
    const id = this.nextId();
    this.vms.set(id, { microvmId: id, statusScript: [status], endpoint, notFoundFor: 0 });
    return id;
  }

  private nextId(): string {
    this.idSeq += 1;
    return `mvm-fake-${this.idSeq}`;
  }

  private maybeThrow(method: string): void {
    const q = this.errorQueue.get(method);
    if (q && q.length > 0) {
      const err = q.shift() as Error;
      throw err;
    }
  }

  async run(p: RunMicrovmParams): Promise<{ microvmId: string }> {
    this.calls.push({ method: "run", args: p });
    this.maybeThrow("run");
    // Idempotent clientToken: the same token yields the same id.
    const existing = this.byToken.get(p.clientToken);
    if (existing !== undefined) return { microvmId: existing };
    const id = this.nextId();
    this.byToken.set(p.clientToken, id);
    this.vms.set(id, {
      microvmId: id,
      statusScript: [...(this.opts.statusScript ?? ["PENDING", "RUNNING"])],
      endpoint: this.opts.endpoint ?? "https://vm.example",
      notFoundFor: this.opts.notFoundFor ?? 0,
    });
    return { microvmId: id };
  }

  async get(id: string): Promise<GetResult> {
    this.calls.push({ method: "get", args: id });
    this.maybeThrow("get");
    const vm = this.vms.get(id);
    if (vm === undefined) return { kind: "notFound" };
    if (vm.notFoundFor > 0) {
      vm.notFoundFor -= 1;
      return { kind: "notFound" };
    }
    const raw =
      vm.statusScript.length > 1
        ? (vm.statusScript.shift() as string)
        : (vm.statusScript[0] as string);
    return { kind: "status", raw, endpoint: vm.endpoint, remainingSeconds: 3600 };
  }

  async listByImage(imageArn: string): Promise<{ microvmId: string; status: string }[]> {
    this.calls.push({ method: "listByImage", args: imageArn });
    this.maybeThrow("listByImage");
    return [...this.vms.values()].map((vm) => ({
      microvmId: vm.microvmId,
      status: vm.statusScript[0] as string,
    }));
  }

  async suspend(id: string): Promise<void> {
    this.calls.push({ method: "suspend", args: id });
    this.maybeThrow("suspend");
    const vm = this.vms.get(id);
    if (vm) vm.statusScript = ["SUSPENDED"];
  }

  async resume(id: string): Promise<void> {
    this.calls.push({ method: "resume", args: id });
    this.maybeThrow("resume");
    const vm = this.vms.get(id);
    if (vm) vm.statusScript = ["RUNNING"];
  }

  async terminate(id: string): Promise<void> {
    this.calls.push({ method: "terminate", args: id });
    this.maybeThrow("terminate");
    const vm = this.vms.get(id);
    if (vm) vm.statusScript = ["TERMINATED"];
  }

  async createAuthToken(
    id: string,
    port: number,
    minutes: number,
  ): Promise<{ token: string; expiresAt: number }> {
    this.calls.push({ method: "createAuthToken", args: { id, port, minutes } });
    this.maybeThrow("createAuthToken");
    return { token: `fake-token-${id}-${port}`, expiresAt: Date.now() + minutes * 60_000 };
  }

  /** Count of calls to a given method. */
  countOf(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}
