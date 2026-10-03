// Redaction (shell, R4.4, R12.5). Keeps auth tokens out of terminal output and
// logs. Two layers: (1) exact-match masking of registered token values (current
// and previous), and (2) a structural mask of any JWE-shaped string (five
// base64url segments separated by dots). Also provides a safe error formatter
// that builds messages from {operation, errorName, microvmId?} only — never
// from raw AWS error bodies, which can echo request data.

const MASK = "[REDACTED]";

/**
 * A JWE compact serialization is five base64url segments joined by dots. Match
 * conservatively: each segment is 8+ base64url chars so we do not mask ordinary
 * dotted identifiers (e.g. a.b.c.d.e of short words), while still catching real
 * tokens. The MicroVM auth token is JWE-shaped.
 */
const JWE_RE = /\b[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,}){4}\b/g;

/** Escape a string for safe use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Holds the set of exact token values to mask. The adapter registers each token
 * it mints (and the proxy its current/previous), so redaction catches them even
 * if they are not JWE-shaped.
 */
export class Redactor {
  private readonly tokens = new Set<string>();

  /** Register a token value to mask on sight. No-op for empty/undefined. */
  register(token: string | null | undefined): void {
    if (token !== null && token !== undefined && token.length > 0) {
      this.tokens.add(token);
    }
  }

  /** Mask registered tokens and any JWE-shaped substring in `text`. */
  redact(text: string): string {
    let out = text;
    // Exact token values first (longest first so overlaps resolve cleanly).
    for (const t of [...this.tokens].sort((a, b) => b.length - a.length)) {
      out = out.replace(new RegExp(escapeRe(t), "g"), MASK);
    }
    // Structural JWE mask.
    out = out.replace(JWE_RE, MASK);
    return out;
  }
}

/** Fields a redacted error message is built from (R12.5). */
export interface AwsErrorContext {
  operation: string;
  errorName: string;
  microvmId?: string;
}

/**
 * Build a user-facing error message from the safe fields only. The raw AWS
 * message/body is intentionally not included, so no request data can leak.
 */
export function formatAwsError(ctx: AwsErrorContext): string {
  const where = ctx.microvmId ? ` (microvm ${ctx.microvmId})` : "";
  return `${ctx.operation} failed: ${ctx.errorName}${where}`;
}

/** A console-like sink; the real one is `console`, tests inject a fake. */
export interface Sink {
  log(line: string): void;
  error(line: string): void;
}

/**
 * Wraps a sink so every line is redacted before it is written. All terminal
 * output goes through this (R4.4): the token never reaches stdout/stderr.
 */
export class RedactingLogger {
  constructor(
    private readonly redactor: Redactor,
    private readonly sink: Sink = { log: (l) => console.log(l), error: (l) => console.error(l) },
  ) {}

  log(line: string): void {
    this.sink.log(this.redactor.redact(line));
  }

  error(line: string): void {
    this.sink.error(this.redactor.redact(line));
  }
}
