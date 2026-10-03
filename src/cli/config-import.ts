// `config import`: fill csmvm.config.json from the CDK outputs file
// (infra/cdk-outputs.json). Reads ImageArn and Region from the stack outputs
// and merges them into an existing (or new) config file. No AWS calls.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_FILE = "csmvm.config.json";
const OUTPUTS_FILE = "infra/cdk-outputs.json";

export interface ImportResult {
  ok: boolean;
  message: string;
}

/**
 * Read `infra/cdk-outputs.json`, extract the first stack's ImageArn/Region
 * outputs, and write them into `csmvm.config.json` (merging with any existing
 * config). Returns a human-readable result.
 */
export function configImport(baseDir: string = process.cwd()): ImportResult {
  let outputs: Record<string, Record<string, string>>;
  try {
    outputs = JSON.parse(readFileSync(join(baseDir, OUTPUTS_FILE), "utf8"));
  } catch {
    return {
      ok: false,
      message: `could not read ${OUTPUTS_FILE}; run 'cdk deploy --outputs-file' first`,
    };
  }

  // Outputs are keyed by stack name; take the first stack that has an ImageArn.
  let imageArn: string | undefined;
  let region: string | undefined;
  for (const stack of Object.values(outputs)) {
    if (stack["ImageArn"] !== undefined) {
      imageArn = stack["ImageArn"];
      region = stack["Region"];
      break;
    }
  }
  if (imageArn === undefined) {
    return { ok: false, message: `no ImageArn output found in ${OUTPUTS_FILE}` };
  }

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(join(baseDir, CONFIG_FILE), "utf8"));
  } catch {
    existing = {};
  }

  const merged = {
    ...existing,
    imageArn,
    ...(region !== undefined ? { region } : {}),
  };
  writeFileSync(join(baseDir, CONFIG_FILE), `${JSON.stringify(merged, null, 2)}\n`, {
    mode: 0o600,
  });
  return { ok: true, message: `wrote ${CONFIG_FILE} (imageArn, region) from ${OUTPUTS_FILE}` };
}
