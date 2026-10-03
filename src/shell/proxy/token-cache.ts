// Auth-token cache for the proxy (R4.5–R4.7). Holds one in-memory token, with a
// single-flight refresh when it is close to expiry. Tokens are requested with
// allowedPorts = [{ port: codeServerPort }] and the configured expiry, and each
// new token is registered with the redactor so it never leaks to logs/output.

import type { MicrovmsPort } from "../aws-adapter.js";
import type { Redactor } from "../redact.js";

export interface TokenCacheDeps {
  port: MicrovmsPort;
  microvmId: string;
  codeServerPort: number;
  maxTokenMinutes: number;
  refreshMarginSeconds: number;
  now: () => number;
  redactor: Redactor;
}

export interface CachedToken {
  token: string;
  expiresAt: number;
}

export class TokenCache {
  private current: CachedToken | null = null;
  private inflight: Promise<CachedToken> | null = null;

  constructor(private readonly deps: TokenCacheDeps) {}

  /** True when there is no token or it is within the refresh margin of expiry. */
  private stale(): boolean {
    if (this.current === null) return true;
    const marginMs = this.deps.refreshMarginSeconds * 1000;
    return this.current.expiresAt - this.deps.now() < marginMs;
  }

  /** Return a fresh-enough token, minting one if needed (single-flight). */
  async get(): Promise<CachedToken> {
    if (!this.stale() && this.current !== null) return this.current;
    if (this.inflight !== null) return this.inflight;
    this.inflight = this.refresh();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  /** Force a refresh (used after an upstream 401/403). */
  async forceRefresh(): Promise<CachedToken> {
    this.current = null;
    return this.get();
  }

  private async refresh(): Promise<CachedToken> {
    const { token, expiresAt } = await this.deps.port.createAuthToken(
      this.deps.microvmId,
      this.deps.codeServerPort,
      this.deps.maxTokenMinutes,
    );
    this.deps.redactor.register(token);
    this.current = { token, expiresAt };
    return this.current;
  }
}
