import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// End-to-end: build the CLI, then drive the full lifecycle through the compiled
// `csmvm` binary against the offline file-backed fake backend
// (CSMVM_FAKE_BACKEND=1). Proves the real binary runs — no AWS, no network.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const bin = join(repoRoot, "dist", "cli", "main.js");

let workdir: string;

function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [bin, ...args], {
      cwd: workdir,
      env: { ...process.env, CSMVM_FAKE_BACKEND: "1" },
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function stateFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workdir, ".session", "state.json"), "utf8"));
}

beforeAll(() => {
  // Compile the CLI so dist/cli/main.js exists (idempotent).
  execFileSync("pnpm", ["build"], { cwd: repoRoot, encoding: "utf8" });
  workdir = mkdtempSync(join(tmpdir(), "csmvm-e2e-"));
  writeFileSync(
    join(workdir, "csmvm.config.json"),
    JSON.stringify({
      region: "ap-northeast-1",
      imageArn: "arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:csmvm-code-server",
      pollIntervalSeconds: 1,
    }),
  );
});

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

describe("csmvm end-to-end lifecycle (offline fake backend)", () => {
  it("launch -> status -> suspend -> resume -> terminate all exit 0 and reach the right states", () => {
    const launch = run(["launch", "--yes"]);
    expect(launch.code).toBe(0);
    expect(stateFile()["state"]).toBe("RUNNING");

    const status = run(["status"]);
    expect(status.code).toBe(0);
    expect(status.out).toContain("state:     RUNNING");

    expect(run(["suspend"]).code).toBe(0);
    expect(stateFile()["state"]).toBe("SUSPENDED");

    expect(run(["resume"]).code).toBe(0);
    expect(stateFile()["state"]).toBe("RUNNING");

    expect(run(["terminate", "--yes"]).code).toBe(0);
    expect(stateFile()["state"]).toBe("TERMINATED");
  }, 60_000);

  it("terminate again is idempotent (exit 0)", () => {
    expect(run(["terminate", "--yes"]).code).toBe(0);
  }, 30_000);

  it("the state file never contains a token or credential field", () => {
    const raw = readFileSync(join(workdir, ".session", "state.json"), "utf8");
    expect(raw).not.toMatch(/password|secret|accessKey|sessionToken/i);
    expect(stateFile()["launchClientToken"]).toBeNull();
  });
});
