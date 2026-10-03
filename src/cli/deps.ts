// Builds the real InterpreterDeps for the CLI from the environment: the SDK
// adapter, the on-disk state store, a redacting logger, and the clock/id/token
// generators. Kept separate from main.ts so argument parsing stays thin.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateConfig } from "../core/config.js";
import type { RetryPolicy } from "../core/retry.js";
import { SdkMicrovms } from "../shell/aws-adapter.js";
import type { InterpreterDeps } from "../shell/interpreter.js";
import { Redactor, RedactingLogger } from "../shell/redact.js";
import { StateStore } from "../shell/state-store.js";

const CONFIG_FILE = "csmvm.config.json";

/** Read and parse csmvm.config.json from cwd; returns {} if absent/unreadable. */
export function loadRawConfig(baseDir: string = process.cwd()): unknown {
  try {
    return JSON.parse(readFileSync(join(baseDir, CONFIG_FILE), "utf8"));
  } catch {
    return {};
  }
}

/** Resolve the region + retry policy from the raw config (best-effort defaults). */
function resolveRegionAndPolicy(raw: unknown): { region: string; policy: RetryPolicy } {
  const res = validateConfig(raw);
  if (res.ok) {
    return { region: res.config.region, policy: res.config.retry };
  }
  // Invalid config: the interpreter will report and exit 2; use safe defaults
  // for the (unused) client so construction does not throw.
  return { region: "ap-northeast-1", policy: { maxAttempts: 5, baseMs: 200, capMs: 10_000 } };
}

export interface CliFlags {
  assumeYes: boolean;
}

/** Assemble InterpreterDeps backed by the real SDK and filesystem. */
export function buildDeps(flags: CliFlags, baseDir: string = process.cwd()): InterpreterDeps {
  const raw = loadRawConfig(baseDir);
  const { region, policy } = resolveRegionAndPolicy(raw);
  const redactor = new Redactor();
  const logger = new RedactingLogger(redactor);
  const port = new SdkMicrovms(region, policy);
  const store = new StateStore(baseDir);

  return {
    config: raw,
    port,
    store,
    logger,
    redactor,
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    newId: () => randomUUID(),
    newToken: () => `lct-${randomUUID()}`,
    isTTY: Boolean(process.stdin.isTTY),
    assumeYes: flags.assumeYes,
  };
}
