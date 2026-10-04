// HTTP forwarding helpers for the proxy (R4.2, R4.4, R4.8, R4.9). Pure helpers
// for header hygiene and the state-gating decision, kept separate from the
// node:http server so they can be unit-tested without sockets.

import type { SessionState } from "../../core/session.js";

/** Hop-by-hop headers that must not be forwarded (RFC 7230 + the auth header). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Build the upstream request headers: drop hop-by-hop, inject auth + port. */
export function upstreamRequestHeaders(
  incoming: Record<string, string | string[] | undefined>,
  authHeaders: Record<string, string>,
  codeServerPort: number,
  strippedCookie: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    // Let the HTTP client use the MicroVM endpoint as Host. Forwarding the
    // browser's localhost Host makes the AWS ingress reject valid auth (403).
    if (lower === "host") continue;
    if (lower === "cookie") continue; // replaced below with the stripped form
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (strippedCookie !== undefined) out["cookie"] = strippedCookie;
  // Inject the MicroVM auth headers and the target port.
  for (const [k, v] of Object.entries(authHeaders)) out[k] = v;
  out["X-aws-proxy-port"] = String(codeServerPort);
  return out;
}

/** Remove the auth header(s) and hop-by-hop headers from an upstream response. */
export function sanitizeResponseHeaders(
  upstream: Record<string, string | string[] | undefined>,
  authHeaderNames: string[],
): Record<string, string | string[]> {
  const drop = new Set([
    ...authHeaderNames.map((n) => n.toLowerCase()),
    ...HOP_BY_HOP,
    "x-aws-proxy-auth",
    "x-aws-proxy-port",
  ]);
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(upstream)) {
    if (value === undefined) continue;
    if (drop.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

export interface StateGate {
  serve: boolean;
  status?: number;
  body?: string;
}

/**
 * Decide whether to serve a request given the current session state (R4.9).
 * RUNNING serves; anything else returns 503 with the state (SUSPENDING/
 * SUSPENDED), and TERMINATING/TERMINATED signal the server to shut down.
 */
export function stateGate(state: SessionState): StateGate {
  if (state === "RUNNING") return { serve: true };
  return { serve: false, status: 503, body: JSON.stringify({ state }) };
}
