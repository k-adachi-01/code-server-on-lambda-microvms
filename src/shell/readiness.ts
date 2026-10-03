// Readiness probe (shell, R2.4, R7.2). GETs the MicroVM's /healthz endpoint with
// the auth-token headers; any 2xx means code-server is reachable. 5 s timeout.
// `fetchImpl` is injectable so tests do not hit the network.

export interface ReadinessDeps {
  /** Auth header map from CreateMicrovmAuthToken (name -> value). */
  authHeaders: Record<string, string>;
  /** The MicroVM port header value (X-aws-proxy-port). */
  codeServerPort: number;
  /** Injected fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Timeout in ms (default 5000). */
  timeoutMs?: number;
}

/**
 * Probe `https://<endpoint>/healthz`. Resolves true on any 2xx, false on a
 * non-2xx response or any error/timeout (readiness is best-effort; the caller
 * keeps polling until the state leaves the in-flight state or times out).
 */
export async function probeReadiness(endpoint: string, deps: ReadinessDeps): Promise<boolean> {
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(`https://${endpoint}/healthz`, {
      method: "GET",
      headers: {
        ...deps.authHeaders,
        "X-aws-proxy-port": String(deps.codeServerPort),
      },
      signal: controller.signal,
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
