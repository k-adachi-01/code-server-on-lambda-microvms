import { describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Static image checks (R13.5, R13.6, R13.7, R5.4, R15.2). These assert the
// Dockerfile/entrypoint invariants without building the image.

const dockerfile = readFileSync(
  fileURLToPath(new URL("../../image/Dockerfile", import.meta.url)),
  "utf8",
);
const entrypoint = readFileSync(
  fileURLToPath(new URL("../../image/entrypoint.sh", import.meta.url)),
  "utf8",
);

describe("MicroVM image Dockerfile", () => {
  it("uses the verified AL2023 base container (A-12), single-stage", () => {
    expect(dockerfile).toContain("FROM public.ecr.aws/lambda/microvms:al2023-minimal");
    // Single-stage: no external first-stage base image (Phase 0 S1 finding).
    expect(dockerfile).not.toContain("node:22");
    expect(dockerfile).not.toContain("COPY --from=");
  });

  it("pins code-server to an exact version (ARG) and verifies a SHA-256 (R13.6)", () => {
    expect(/ARG CODE_SERVER_VERSION=\d+\.\d+\.\d+/.test(dockerfile)).toBe(true);
    expect(/ARG CODE_SERVER_SHA256=[0-9a-f]{64}/.test(dockerfile)).toBe(true);
    // The SHA is actually checked.
    expect(dockerfile).toContain("sha256sum -c -");
  });

  it("runs as a non-root user", () => {
    expect(dockerfile).toContain("useradd");
    expect(/^USER coder$/m.test(dockerfile)).toBe(true);
  });

  it("generates no build-time password, secret, or keys (R13.5, R13.7)", () => {
    expect(/\bPASSWORD\b/.test(dockerfile)).toBe(false);
    expect(/\bHASHED_PASSWORD\b/.test(dockerfile)).toBe(false);
    expect(/\bSUDO_PASSWORD\b/.test(dockerfile)).toBe(false);
    // No key generation at build time.
    expect(/ssh-keygen|openssl\s+genrsa|openssl\s+rand/.test(dockerfile)).toBe(false);
  });
});

describe("MicroVM entrypoint", () => {
  it("starts code-server with --auth none pending Phase 0 S3 (R5.4)", () => {
    expect(entrypoint).toContain("--auth none");
    expect(entrypoint).toContain("--bind-addr");
    expect(entrypoint).toContain("--disable-telemetry");
  });

  it("starts the hook handler", () => {
    expect(entrypoint).toContain("/opt/csmvm/hook-handler.mjs");
  });

  it("sets no password / secret at startup (per-VM fallback only, never baked)", () => {
    expect(/PASSWORD=/.test(entrypoint)).toBe(false);
    expect(/HASHED_PASSWORD=/.test(entrypoint)).toBe(false);
  });
});
