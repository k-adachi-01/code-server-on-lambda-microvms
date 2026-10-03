// validateConfig (pure, R4.10 / R11.1 / R11.2 / R2.5 / R2.8 / R12.1): hand-written
// validation of the raw CLI config object into a typed CliConfig with the design
// defaults applied. No dependencies — the shell owns reading the file; zod lives
// only in the shell's state store, never here.
//
// Bounds (design "Pure helpers" + task 7.1):
//   region                     : non-empty string, default "us-east-1"
//   imageArn                   : required non-empty string (no default)
//   maximumDurationInSeconds   : integer in [1, 28800], default 7200
//   suspendedDurationSeconds   : integer in [1, 28800], default = resolved max
//   codeServerPort             : integer port in [1, 65535], default 8080
//   proxy.listenPort           : integer port in [1, 65535], default 8787
//   proxy.localAuth            : boolean, default true
//   token.maxExpirationMinutes : integer in [1, 60], default 15
//   token.refreshMarginSeconds : integer >= 0, default 60
//   timeouts.{launch,suspend,resume}Seconds : integer >= 1, default 300
//   retry.maxAttempts          : integer >= 1, default 5
//   retry.baseMs               : integer >= 1, default 200
//   retry.capMs                : integer >= baseMs, default 10000
//   pollIntervalSeconds        : integer >= 1, default 3
//   networkConnectorArns       : optional string[]; absent by default (R2.8)

/** Hard upper bound for duration fields until Phase 0 (A-6/A-15) tightens it. */
export const MAX_DURATION_SECONDS = 28_800;

export interface CliConfig {
  region: string;
  imageArn: string;
  maximumDurationInSeconds: number;
  suspendedDurationSeconds: number;
  codeServerPort: number;
  proxy: { listenPort: number; localAuth: boolean };
  token: { maxExpirationMinutes: number; refreshMarginSeconds: number };
  timeouts: { launchSeconds: number; suspendSeconds: number; resumeSeconds: number };
  retry: { maxAttempts: number; baseMs: number; capMs: number };
  pollIntervalSeconds: number;
  networkConnectorArns?: string[];
}

export interface ConfigError {
  path: string;
  message: string;
}

export type ValidateResult = { ok: true; config: CliConfig } | { ok: false; errors: ConfigError[] };

type Obj = Record<string, unknown>;

function isObject(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/**
 * Validate and normalize a raw config object. Returns the typed CliConfig with
 * defaults applied, or the full list of errors (never throws). Unknown extra
 * keys are ignored (the shell's zod schema is the strict gate for the state
 * file; the config object is user-authored and tolerant of extras).
 */
export function validateConfig(raw: unknown): ValidateResult {
  const errors: ConfigError[] = [];

  if (!isObject(raw)) {
    return { ok: false, errors: [{ path: "", message: "config must be an object" }] };
  }

  // --- helpers that record an error and return a fallback ---------------------
  const intInRange = (
    value: unknown,
    path: string,
    min: number,
    max: number,
    dflt: number,
  ): number => {
    if (value === undefined) return dflt;
    if (!isInteger(value)) {
      errors.push({ path, message: `must be an integer` });
      return dflt;
    }
    if (value < min || value > max) {
      errors.push({ path, message: `must be between ${min} and ${max}` });
      return dflt;
    }
    return value;
  };

  const nonEmptyString = (value: unknown, path: string, dflt?: string): string => {
    if (value === undefined) {
      if (dflt !== undefined) return dflt;
      errors.push({ path, message: "is required" });
      return "";
    }
    if (typeof value !== "string" || value.length === 0) {
      errors.push({ path, message: "must be a non-empty string" });
      return dflt ?? "";
    }
    return value;
  };

  const boolean = (value: unknown, path: string, dflt: boolean): boolean => {
    if (value === undefined) return dflt;
    if (typeof value !== "boolean") {
      errors.push({ path, message: "must be a boolean" });
      return dflt;
    }
    return value;
  };

  // Bracket-access helper: `Obj` is an index-signature type, so dotted access
  // trips TS4111 under noPropertyAccessFromIndexSignature. Reading through this
  // keeps every lookup in bracket form.
  const pick = (obj: Obj, key: string): unknown => obj[key];

  const proxyRaw = pick(raw, "proxy");
  const tokenRaw = pick(raw, "token");
  const timeoutsRaw = pick(raw, "timeouts");
  const retryRaw = pick(raw, "retry");

  const proxy: Obj = isObject(proxyRaw) ? proxyRaw : {};
  const token: Obj = isObject(tokenRaw) ? tokenRaw : {};
  const timeouts: Obj = isObject(timeoutsRaw) ? timeoutsRaw : {};
  const retry: Obj = isObject(retryRaw) ? retryRaw : {};

  if (proxyRaw !== undefined && !isObject(proxyRaw)) {
    errors.push({ path: "proxy", message: "must be an object" });
  }
  if (tokenRaw !== undefined && !isObject(tokenRaw)) {
    errors.push({ path: "token", message: "must be an object" });
  }
  if (timeoutsRaw !== undefined && !isObject(timeoutsRaw)) {
    errors.push({ path: "timeouts", message: "must be an object" });
  }
  if (retryRaw !== undefined && !isObject(retryRaw)) {
    errors.push({ path: "retry", message: "must be an object" });
  }

  const region = nonEmptyString(pick(raw, "region"), "region", "us-east-1");
  const imageArn = nonEmptyString(pick(raw, "imageArn"), "imageArn");

  const maximumDurationInSeconds = intInRange(
    pick(raw, "maximumDurationInSeconds"),
    "maximumDurationInSeconds",
    1,
    MAX_DURATION_SECONDS,
    7200,
  );
  // suspendedDurationSeconds defaults to the resolved maximumDurationInSeconds.
  const suspendedDurationSeconds = intInRange(
    pick(raw, "suspendedDurationSeconds"),
    "suspendedDurationSeconds",
    1,
    MAX_DURATION_SECONDS,
    maximumDurationInSeconds,
  );

  const codeServerPort = intInRange(pick(raw, "codeServerPort"), "codeServerPort", 1, 65_535, 8080);

  const listenPort = intInRange(pick(proxy, "listenPort"), "proxy.listenPort", 1, 65_535, 8787);
  const localAuth = boolean(pick(proxy, "localAuth"), "proxy.localAuth", true);

  const maxExpirationMinutes = intInRange(
    pick(token, "maxExpirationMinutes"),
    "token.maxExpirationMinutes",
    1,
    60,
    15,
  );
  const refreshMarginSeconds = intInRange(
    pick(token, "refreshMarginSeconds"),
    "token.refreshMarginSeconds",
    0,
    Number.MAX_SAFE_INTEGER,
    60,
  );

  const launchSeconds = intInRange(
    pick(timeouts, "launchSeconds"),
    "timeouts.launchSeconds",
    1,
    Number.MAX_SAFE_INTEGER,
    300,
  );
  const suspendSeconds = intInRange(
    pick(timeouts, "suspendSeconds"),
    "timeouts.suspendSeconds",
    1,
    Number.MAX_SAFE_INTEGER,
    300,
  );
  const resumeSeconds = intInRange(
    pick(timeouts, "resumeSeconds"),
    "timeouts.resumeSeconds",
    1,
    Number.MAX_SAFE_INTEGER,
    300,
  );

  const maxAttempts = intInRange(
    pick(retry, "maxAttempts"),
    "retry.maxAttempts",
    1,
    Number.MAX_SAFE_INTEGER,
    5,
  );
  const baseMs = intInRange(pick(retry, "baseMs"), "retry.baseMs", 1, Number.MAX_SAFE_INTEGER, 200);
  const capMs = intInRange(pick(retry, "capMs"), "retry.capMs", 1, Number.MAX_SAFE_INTEGER, 10_000);
  if (capMs < baseMs) {
    errors.push({ path: "retry.capMs", message: "must be >= retry.baseMs" });
  }

  const pollIntervalSeconds = intInRange(
    pick(raw, "pollIntervalSeconds"),
    "pollIntervalSeconds",
    1,
    Number.MAX_SAFE_INTEGER,
    3,
  );

  // Optional network connectors: absent by default (R2.8). When present it must
  // be an array of non-empty strings.
  let networkConnectorArns: string[] | undefined;
  const connectorsRaw = pick(raw, "networkConnectorArns");
  if (connectorsRaw !== undefined) {
    if (
      !Array.isArray(connectorsRaw) ||
      !connectorsRaw.every((a) => typeof a === "string" && a.length > 0)
    ) {
      errors.push({
        path: "networkConnectorArns",
        message: "must be an array of non-empty strings",
      });
    } else {
      networkConnectorArns = [...(connectorsRaw as string[])];
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const config: CliConfig = {
    region,
    imageArn,
    maximumDurationInSeconds,
    suspendedDurationSeconds,
    codeServerPort,
    proxy: { listenPort, localAuth },
    token: { maxExpirationMinutes, refreshMarginSeconds },
    timeouts: { launchSeconds, suspendSeconds, resumeSeconds },
    retry: { maxAttempts, baseMs, capMs },
    pollIntervalSeconds,
    ...(networkConnectorArns !== undefined ? { networkConnectorArns } : {}),
  };
  return { ok: true, config };
}
