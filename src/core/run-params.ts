// buildRunParams (pure, R2.1 / R2.5 / R2.8 / R2.9 / R11.1): assemble the
// RunMicrovm parameters from the validated config, the persisted client token,
// and the session id. No imports beyond the config type — stays pure.

import type { CliConfig } from "./config.js";

/** The idle policy passed to RunMicrovm (all three fields set, A-6 / A-15). */
export interface IdlePolicy {
  autoResumeEnabled: boolean;
  maxIdleDurationSeconds: number;
  suspendedDurationSeconds: number;
}

/** Parameters for a RunMicrovm call (shell maps this onto the SDK shape). */
export interface RunMicrovmParams {
  imageArn: string;
  maximumDurationInSeconds: number;
  clientToken: string;
  idlePolicy: IdlePolicy;
  /** JSON string `{"sessionId"}`, at most 4096 bytes, no secrets. */
  runHookPayload: string;
  /** Omitted entirely unless configured (R2.8). */
  networkConnectors?: string[];
  /** Omitted unless configured (Q-4). */
  executionRoleArn?: string;
}

/** Maximum size of the run hook payload in bytes (R2.9). */
export const MAX_RUN_HOOK_PAYLOAD_BYTES = 4096;

/**
 * Build the RunMicrovm parameters. The idle policy always sets all three
 * fields; `maxIdleDurationSeconds` is at least 60. Network connectors and the
 * execution role are included only when the config provides them. The run hook
 * payload carries only the session id and must stay within the 4096-byte limit.
 */
export function buildRunParams(
  cfg: CliConfig,
  clientToken: string,
  sessionId: string,
): RunMicrovmParams {
  const runHookPayload = JSON.stringify({ sessionId });
  if (new TextEncoder().encode(runHookPayload).length > MAX_RUN_HOOK_PAYLOAD_BYTES) {
    // sessionId is a UUID in practice, so this never triggers; guard anyway so a
    // malformed id fails loudly in core rather than at the AWS boundary.
    throw new Error("runHookPayload exceeds 4096 bytes");
  }

  const params: RunMicrovmParams = {
    imageArn: cfg.imageArn,
    maximumDurationInSeconds: cfg.maximumDurationInSeconds,
    clientToken,
    idlePolicy: {
      autoResumeEnabled: false,
      maxIdleDurationSeconds: Math.max(60, cfg.maximumDurationInSeconds),
      suspendedDurationSeconds: cfg.suspendedDurationSeconds,
    },
    runHookPayload,
  };

  if (cfg.networkConnectorArns !== undefined && cfg.networkConnectorArns.length > 0) {
    params.networkConnectors = [...cfg.networkConnectorArns];
  }
  if (cfg.executionRoleArn !== undefined) {
    params.executionRoleArn = cfg.executionRoleArn;
  }

  return params;
}
