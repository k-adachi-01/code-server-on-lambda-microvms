// Retry policy (pure, R12.1 / R12.2). "Full jitter" exponential backoff and the
// retryable-error classifier. No imports beyond types; randomness and sleeping
// are injected by the shell (the adapter passes rand01 and a sleep function).

/** Backoff parameters, from the validated CliConfig `retry` section. */
export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  capMs: number;
}

/**
 * Full-jitter backoff delay for a zero-based `attempt`:
 *   upper = min(capMs, baseMs * 2 ** attempt)
 *   delay = floor(rand01 * upper)
 *
 * `rand01` is a caller-supplied value in [0, 1) (injected for determinism in
 * tests). The result is an integer in [0, upper], and never exceeds `capMs`.
 */
export function retryDelayMs(
  attempt: number,
  p: { baseMs: number; capMs: number },
  rand01: number,
): number {
  const unbounded = p.baseMs * 2 ** attempt;
  const upper = Math.min(p.capMs, unbounded);
  return Math.floor(rand01 * upper);
}

/**
 * The AWS error names this project retries (R12.1). Transient server-side and
 * throttling faults are retryable; everything else is surfaced immediately.
 */
const RETRYABLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  "ThrottlingException",
  "InternalServerException",
]);

/** True when an AWS error with the given `name` should be retried. */
export function isRetryable(name: string): boolean {
  return RETRYABLE_ERROR_NAMES.has(name);
}
