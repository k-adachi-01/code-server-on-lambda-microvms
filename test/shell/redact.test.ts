import { describe, expect, it } from "vite-plus/test";
import { Redactor, RedactingLogger, formatAwsError } from "../../src/shell/redact.js";
import type { Sink } from "../../src/shell/redact.js";

describe("Redactor", () => {
  it("masks a registered token value", () => {
    const r = new Redactor();
    r.register("lct-super-secret-token");
    expect(r.redact("using lct-super-secret-token now")).toBe("using [REDACTED] now");
  });

  it("masks a JWE-shaped five-segment base64url string", () => {
    const r = new Redactor();
    const jwe = "abcdefgh.ijklmnop.qrstuvwx.yz012345.6789ABCD";
    expect(r.redact(`auth=${jwe};`)).toBe("auth=[REDACTED];");
  });

  it("masks both the current and a previous token", () => {
    const r = new Redactor();
    r.register("token-current-value");
    r.register("token-previous-value");
    const out = r.redact("cur=token-current-value prev=token-previous-value");
    expect(out).toBe("cur=[REDACTED] prev=[REDACTED]");
  });

  it("does not mask ordinary short dotted identifiers", () => {
    const r = new Redactor();
    // a.b.c.d.e has segments shorter than 8 chars -> not JWE-shaped.
    expect(r.redact("path a.b.c.d.e stays")).toBe("path a.b.c.d.e stays");
  });

  it("leaves text with no secrets unchanged", () => {
    const r = new Redactor();
    expect(r.redact("nothing to hide here")).toBe("nothing to hide here");
  });

  it("ignores empty/null token registration", () => {
    const r = new Redactor();
    r.register("");
    r.register(null);
    r.register(undefined);
    expect(r.redact("a.b")).toBe("a.b");
  });
});

describe("formatAwsError", () => {
  it("builds a message from operation + errorName only (no raw body)", () => {
    expect(formatAwsError({ operation: "RunMicrovm", errorName: "ThrottlingException" })).toBe(
      "RunMicrovm failed: ThrottlingException",
    );
  });

  it("includes the microvm id when present", () => {
    expect(
      formatAwsError({
        operation: "TerminateMicrovm",
        errorName: "ConflictException",
        microvmId: "mvm-1",
      }),
    ).toBe("TerminateMicrovm failed: ConflictException (microvm mvm-1)");
  });
});

describe("RedactingLogger", () => {
  it("redacts every line before writing to the sink", () => {
    const logs: string[] = [];
    const errs: string[] = [];
    const sink: Sink = { log: (l) => logs.push(l), error: (l) => errs.push(l) };
    const r = new Redactor();
    r.register("lct-secret");
    const logger = new RedactingLogger(r, sink);

    logger.log("ok lct-secret done");
    logger.error("fail abcdefgh.ijklmnop.qrstuvwx.yz012345.6789ABCD");

    expect(logs).toEqual(["ok [REDACTED] done"]);
    expect(errs).toEqual(["fail [REDACTED]"]);
  });
});
