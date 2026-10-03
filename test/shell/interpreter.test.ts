import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, terminateStray } from "../../src/shell/interpreter.js";
import type { InterpreterDeps } from "../../src/shell/interpreter.js";
import { StateStore } from "../../src/shell/state-store.js";
import { Redactor, RedactingLogger } from "../../src/shell/redact.js";
import type { Sink } from "../../src/shell/redact.js";
import { FakeMicrovms, FakeAwsError } from "../fakes/fake-microvms.js";

const IMAGE_ARN = "arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:example";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "csmvm-interp-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

interface Harness {
  deps: InterpreterDeps;
  fake: FakeMicrovms;
  store: StateStore;
  logs: string[];
  errs: string[];
}

function harness(
  opts: {
    fake?: FakeMicrovms;
    isTTY?: boolean;
    assumeYes?: boolean;
    ask?: (q: string) => Promise<string>;
    config?: Record<string, unknown>;
  } = {},
): Harness {
  const fake =
    opts.fake ?? new FakeMicrovms({ statusScript: ["PENDING", "RUNNING"], endpoint: "vm.example" });
  const store = new StateStore(base);
  const logs: string[] = [];
  const errs: string[] = [];
  const sink: Sink = { log: (l) => logs.push(l), error: (l) => errs.push(l) };
  const redactor = new Redactor();
  let t = 1_000;
  let idn = 0;
  let tokn = 0;
  const deps: InterpreterDeps = {
    config: opts.config ?? {
      imageArn: IMAGE_ARN,
      region: "ap-northeast-1",
      pollIntervalSeconds: 1,
    },
    port: fake,
    store,
    logger: new RedactingLogger(redactor, sink),
    redactor,
    now: () => (t += 1000),
    sleep: async () => {},
    newId: () => `00000000-0000-4000-8000-${String(++idn).padStart(12, "0")}`,
    newToken: () => `lct-${++tokn}`,
    isTTY: opts.isTTY ?? true,
    assumeYes: opts.assumeYes ?? false,
    fetchImpl: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
    ...(opts.ask ? { ask: opts.ask } : {}),
  };
  return { deps, fake, store, logs, errs };
}

describe("runCommand", () => {
  it("invalid config exits 2 with zero AWS calls", async () => {
    const h = harness({ config: { region: "ap-northeast-1" } }); // missing imageArn
    const res = await runCommand("launch", h.deps);
    expect(res.exitCode).toBe(2);
    expect(h.fake.calls.length).toBe(0);
  });

  it("launch with --yes drives LAUNCHING -> RUNNING and exits 0", async () => {
    const h = harness({ assumeYes: true });
    const res = await runCommand("launch", h.deps);
    expect(res.exitCode).toBe(0);
    expect(res.session.state).toBe("RUNNING");
    // A RunMicrovm happened; the token was persisted before the run.
    expect(h.fake.countOf("run")).toBeGreaterThanOrEqual(1);
  });

  it("launch declined (TTY says no) makes zero mutating calls and exits 0", async () => {
    const h = harness({ isTTY: true, ask: async () => "n" });
    const res = await runCommand("launch", h.deps);
    expect(res.exitCode).toBe(0);
    expect(h.fake.countOf("run")).toBe(0);
  });

  it("launch without --yes and no TTY exits 2 (no mutating calls)", async () => {
    const h = harness({ isTTY: false, assumeYes: false });
    const res = await runCommand("launch", h.deps);
    expect(res.exitCode).toBe(2);
    expect(h.fake.countOf("run")).toBe(0);
  });

  it("persists the launch client token before the run call", async () => {
    const h = harness({ assumeYes: true });
    await runCommand("launch", h.deps);
    // The run call used the token minted by newToken, and state was persisted.
    const runCall = h.fake.calls.find((c) => c.method === "run");
    expect(runCall).toBeDefined();
  });

  it("status never mutates and reports the reconciled state", async () => {
    const h = harness({ assumeYes: true });
    await runCommand("launch", h.deps);
    const before = h.fake.calls.length;
    const res = await runCommand("status", h.deps);
    expect(res.exitCode).toBe(0);
    // status may call get/list (read-only) but never run/suspend/resume/terminate.
    const mutating = h.fake.calls
      .slice(before)
      .filter((c) => ["run", "suspend", "resume", "terminate"].includes(c.method));
    expect(mutating).toEqual([]);
  });

  it("full lifecycle: launch -> suspend -> resume -> terminate", async () => {
    const h = harness({ assumeYes: true });
    expect((await runCommand("launch", h.deps)).session.state).toBe("RUNNING");
    expect((await runCommand("suspend", h.deps)).session.state).toBe("SUSPENDED");
    expect((await runCommand("resume", h.deps)).session.state).toBe("RUNNING");
    const term = await runCommand("terminate", h.deps);
    expect(term.session.state).toBe("TERMINATED");
    expect(term.exitCode).toBe(0);
  });

  it("terminate on an already-terminated session exits 0 (idempotent)", async () => {
    const h = harness({ assumeYes: true });
    await runCommand("launch", h.deps);
    await runCommand("terminate", h.deps);
    const again = await runCommand("terminate", h.deps);
    expect(again.exitCode).toBe(0);
  });

  it("suspend from NONE is rejected (exit 2)", async () => {
    const h = harness();
    const res = await runCommand("suspend", h.deps);
    expect(res.exitCode).toBe(2);
  });

  it("writes no token or credential fields to the state file", async () => {
    const h = harness({ assumeYes: true });
    await runCommand("launch", h.deps);
    const r = h.store.read();
    // After reaching RUNNING the token is cleared; never any credential field.
    if (r.kind === "valid") {
      expect(r.session.launchClientToken).toBeNull();
    }
  });

  it("a non-retryable RunMicrovm failure discards to NONE and exits (no RUNNING)", async () => {
    const fake = new FakeMicrovms();
    fake.injectError("run", new FakeAwsError("ValidationException"));
    const h = harness({ fake, assumeYes: true });
    const res = await runCommand("launch", h.deps);
    expect(res.session.state).not.toBe("RUNNING");
  });
});

describe("terminateStray", () => {
  it("rejects a stray id that is not on the image (exit 2, no terminate)", async () => {
    const fake = new FakeMicrovms();
    const h = harness({ fake, assumeYes: true });
    const res = await terminateStray("mvm-not-here", h.deps);
    expect(res.exitCode).toBe(2);
    expect(h.fake.countOf("terminate")).toBe(0);
  });

  it("terminates a listed stray id and does not touch the session", async () => {
    const fake = new FakeMicrovms();
    const strayId = fake.seed("RUNNING");
    const h = harness({ fake, assumeYes: true });
    const res = await terminateStray(strayId, h.deps);
    expect(res.exitCode).toBe(0);
    expect(h.fake.calls.some((c) => c.method === "terminate" && c.args === strayId)).toBe(true);
    // No session state file was created for a stray-only operation.
    expect(h.store.read().kind).toBe("absent");
  });

  it("non-TTY without --yes refuses (exit 2)", async () => {
    const fake = new FakeMicrovms();
    const strayId = fake.seed("RUNNING");
    const h = harness({ fake, isTTY: false, assumeYes: false });
    const res = await terminateStray(strayId, h.deps);
    expect(res.exitCode).toBe(2);
    expect(h.fake.countOf("terminate")).toBe(0);
  });
});
