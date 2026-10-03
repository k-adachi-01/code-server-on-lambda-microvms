// Local-auth gate for the proxy (R4.11, R4.12, Q-1). A one-time 256-bit secret
// is printed as a login URL; the first visit to /__csmvm/login?k=<secret> swaps
// it for a session cookie (a separate 256-bit random value) and invalidates the
// secret. Requests without a valid cookie get 401. Host and WebSocket Origin
// are checked to block DNS rebinding. The cookie is stripped before upstream.

import { randomBytes, timingSafeEqual } from "node:crypto";

export const LOGIN_PATH = "/__csmvm/login";
export const COOKIE_NAME = "__csmvm";

function token256(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time string compare that tolerates length differences. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still do a compare to avoid an early-exit timing signal.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Parse a Cookie header into a name->value map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name.length > 0) out[name] = value;
  }
  return out;
}

export interface AuthDecision {
  action: "login" | "allow" | "deny";
  /** For a successful login: the Set-Cookie value and redirect location. */
  setCookie?: string;
  location?: string;
  status?: number;
}

/**
 * The local-auth state machine. Holds the one-time secret and the session
 * cookie value. `localAuth: false` disables all checks (plain localhost).
 */
export class LocalAuth {
  private secret: string | null;
  private readonly cookieValue: string;
  readonly loginUrl: string;

  constructor(
    private readonly listenPort: number,
    private readonly enabled: boolean,
  ) {
    this.secret = enabled ? token256() : null;
    this.cookieValue = token256();
    this.loginUrl = `http://127.0.0.1:${listenPort}${LOGIN_PATH}?k=${this.secret ?? ""}`;
  }

  /** Validate the Host header against the loopback host:port forms. */
  hostOk(host: string | undefined): boolean {
    if (!this.enabled) return true;
    if (host === undefined) return false;
    return host === `127.0.0.1:${this.listenPort}` || host === `localhost:${this.listenPort}`;
  }

  /** Validate a WebSocket Origin header (must be the loopback proxy origin). */
  originOk(origin: string | undefined): boolean {
    if (!this.enabled) return true;
    if (origin === undefined) return false;
    return (
      origin === `http://127.0.0.1:${this.listenPort}` ||
      origin === `http://localhost:${this.listenPort}`
    );
  }

  /**
   * Decide what to do with a request given its path and headers. A login hit
   * with the correct secret sets the cookie and invalidates the secret; a
   * request with the valid cookie is allowed; everything else is denied (401).
   */
  decide(
    path: string,
    headers: { cookie?: string; host?: string; secretParam?: string },
  ): AuthDecision {
    if (!this.enabled) return { action: "allow" };

    if (!this.hostOk(headers.host)) return { action: "deny", status: 403 };

    if (path.startsWith(LOGIN_PATH)) {
      if (
        this.secret !== null &&
        headers.secretParam !== undefined &&
        safeEqual(headers.secretParam, this.secret)
      ) {
        this.secret = null; // one-time use
        return {
          action: "login",
          setCookie: `${COOKIE_NAME}=${this.cookieValue}; HttpOnly; SameSite=Strict; Path=/`,
          location: "/",
        };
      }
      return { action: "deny", status: 401 };
    }

    const cookies = parseCookies(headers.cookie);
    const presented = cookies[COOKIE_NAME];
    if (presented !== undefined && safeEqual(presented, this.cookieValue)) {
      return { action: "allow" };
    }
    return { action: "deny", status: 401 };
  }

  /** Remove the __csmvm cookie from a Cookie header before forwarding upstream. */
  stripCookie(header: string | undefined): string | undefined {
    if (header === undefined) return undefined;
    const kept = Object.entries(parseCookies(header))
      .filter(([name]) => name !== COOKIE_NAME)
      .map(([name, value]) => `${name}=${value}`);
    return kept.length > 0 ? kept.join("; ") : undefined;
  }
}
