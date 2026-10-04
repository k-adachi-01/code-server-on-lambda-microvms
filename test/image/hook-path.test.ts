// Unit tests for the hook path contract (R13.1-R13.4). The official Lambda
// MicroVMs runtime POSTs hooks to /aws/lambda-microvms/runtime/v1/<hook-name>
// (confirmed via the AWS MCP server's "Running and using MicroVMs" doc). The
// handler must match the hook name from that prefix; it previously matched only
// the bare path and would never have run the /run health gate in production.
//
// Suppress the module's server.listen() side effect on import.
process.env["CSMVM_HOOK_NO_LISTEN"] = "1";

import { describe, expect, it } from "vite-plus/test";
import { hookNameFromPath, HOOK_PATH_PREFIX } from "../../image/hooks/src/handler.js";

describe("hookNameFromPath", () => {
  it("extracts the hook name from the official runtime path prefix", () => {
    expect(HOOK_PATH_PREFIX).toBe("/aws/lambda-microvms/runtime/v1/");
    expect(hookNameFromPath("/aws/lambda-microvms/runtime/v1/run")).toBe("run");
    expect(hookNameFromPath("/aws/lambda-microvms/runtime/v1/resume")).toBe("resume");
    expect(hookNameFromPath("/aws/lambda-microvms/runtime/v1/suspend")).toBe("suspend");
    expect(hookNameFromPath("/aws/lambda-microvms/runtime/v1/terminate")).toBe("terminate");
    expect(hookNameFromPath("/aws/lambda-microvms/runtime/v1/ready")).toBe("ready");
    expect(hookNameFromPath("/aws/lambda-microvms/runtime/v1/validate")).toBe("validate");
  });

  it("accepts the bare /<hook-name> fallback (local probes/tests)", () => {
    expect(hookNameFromPath("/run")).toBe("run");
    expect(hookNameFromPath("/terminate")).toBe("terminate");
  });

  it("ignores query strings and trailing segments, and lowercases", () => {
    expect(hookNameFromPath("/aws/lambda-microvms/runtime/v1/run?x=1")).toBe("run");
    expect(hookNameFromPath("/aws/lambda-microvms/runtime/v1/run/extra")).toBe("run");
    expect(hookNameFromPath("/RUN")).toBe("run");
  });

  it("does not confuse an unknown path with a known hook", () => {
    // The default (immediate-200) branch keys off this NOT being run/ready/validate.
    expect(hookNameFromPath("/healthz")).toBe("healthz");
    expect(hookNameFromPath("/")).toBe("");
  });
});
