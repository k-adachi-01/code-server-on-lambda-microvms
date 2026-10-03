import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configImport } from "../../src/cli/config-import.js";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "csmvm-import-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function writeOutputs(obj: unknown): void {
  mkdirSync(join(base, "infra"), { recursive: true });
  writeFileSync(join(base, "infra/cdk-outputs.json"), JSON.stringify(obj));
}

describe("configImport", () => {
  it("fails when the outputs file is missing", () => {
    const res = configImport(base);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("cdk-outputs.json");
  });

  it("writes imageArn + region from the first stack with an ImageArn", () => {
    writeOutputs({
      CsmvmStack: {
        ImageArn: "arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:x",
        Region: "ap-northeast-1",
      },
    });
    const res = configImport(base);
    expect(res.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(join(base, "csmvm.config.json"), "utf8"));
    expect(cfg.imageArn).toBe("arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:x");
    expect(cfg.region).toBe("ap-northeast-1");
  });

  it("merges into an existing config, preserving other keys", () => {
    writeFileSync(
      join(base, "csmvm.config.json"),
      JSON.stringify({ maximumDurationInSeconds: 1800, region: "old" }),
    );
    writeOutputs({
      S: {
        ImageArn: "arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:y",
        Region: "ap-northeast-1",
      },
    });
    const res = configImport(base);
    expect(res.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(join(base, "csmvm.config.json"), "utf8"));
    expect(cfg.maximumDurationInSeconds).toBe(1800); // preserved
    expect(cfg.imageArn).toContain("microvm-image:y"); // added
    expect(cfg.region).toBe("ap-northeast-1"); // overwritten from outputs
  });

  it("fails when no stack output carries an ImageArn", () => {
    writeOutputs({ Other: { SomethingElse: "v" } });
    const res = configImport(base);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("no ImageArn");
  });
});
