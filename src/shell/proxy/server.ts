// Auth_Proxy server (R4.1, R4.3, R4.9, R6.4, R8.6). Binds 127.0.0.1 only,
// composes local auth + token cache + HTTP forwarding + WebSocket relay, and
// polls the session state to gate traffic and shut down on terminate.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { SessionState } from "../../core/session.js";
import type { RedactingLogger } from "../redact.js";
import { LocalAuth } from "./local-auth.js";
import type { TokenCache } from "./token-cache.js";
import { sanitizeResponseHeaders, stateGate, upstreamRequestHeaders } from "./http.js";

/** How the proxy opens the upstream request. Injectable so tests can point at a
 *  loopback HTTP server instead of the real HTTPS MicroVM endpoint on :443. */
export type UpstreamRequest = (
  options: RequestOptions,
  onResponse: (res: IncomingMessage) => void,
) => ClientRequest;

export interface ProxyServerDeps {
  endpoint: string; // MicroVM endpoint host
  codeServerPort: number;
  listenPort: number;
  localAuth: boolean;
  tokenCache: TokenCache;
  logger: RedactingLogger;
  /** Reads the current session state (polled from the State_File). */
  readState: () => Promise<SessionState>;
  /** Decode the stored token (JSON header map) into HTTP auth headers. */
  authHeadersFromToken: (token: string) => Record<string, string>;
  /** Open the upstream request. Defaults to HTTPS on port 443 (the real endpoint). */
  upstreamRequest?: UpstreamRequest;
  /** Build the upstream WebSocket URL. Defaults to wss://<endpoint><path>. */
  upstreamWsUrl?: (endpoint: string, reqUrl: string) => string;
}

/** The header name carrying the MicroVM endpoint auth value. */
export const AUTH_HEADER = "X-aws-proxy-auth";

/**
 * The WebSocket subprotocols the MicroVM endpoint expects (R4.3). The
 * authentication value must be a single opaque subprotocol token: a
 * `Sec-WebSocket-Protocol` value is a comma-separated list of RFC 6455 tokens,
 * so it must not contain separators or whitespace (`,`, spaces, `{`, `"`, …).
 *
 * `authValue` is the *value* of the auth header (e.g. the X-aws-proxy-auth
 * value), never the JSON-encoded header map — embedding the raw JSON produced
 * an invalid/duplicated-subprotocol error before the socket ever opened.
 */
export function wsSubprotocols(authValue: string, port: number): string[] {
  if (!isValidSubprotocolToken(authValue)) {
    throw new Error("auth value is not a valid WebSocket subprotocol token");
  }
  return [
    "lambda-microvms",
    `lambda-microvms.authentication.${authValue}`,
    `lambda-microvms.port.${port}`,
  ];
}

/** RFC 6455 subprotocol tokens are RFC 7230 tokens: visible ASCII, no separators. */
export function isValidSubprotocolToken(value: string): boolean {
  // tchar per RFC 7230; excludes separators, whitespace, quotes, braces, commas.
  return value.length > 0 && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
}

/** Extract the single auth value from the decoded header map for the WS subprotocol. */
export function authValueFromHeaders(headers: Record<string, string>): string {
  const direct = headers[AUTH_HEADER] ?? headers[AUTH_HEADER.toLowerCase()];
  if (direct !== undefined) return direct;
  // Fall back to the sole value if the map has exactly one entry.
  const values = Object.values(headers);
  if (values.length === 1) return values[0] as string;
  throw new Error(
    `cannot find a single auth value in headers (keys: ${Object.keys(headers).join(",")})`,
  );
}

export interface RunningProxy {
  loginUrl: string;
  /** The actual loopback port the proxy bound to (useful when listenPort is 0). */
  port: number;
  /** Resolves when the proxy shuts down (session terminated or stop() called). */
  closed: Promise<void>;
  stop: () => void;
}

/**
 * Start the proxy. Binds loopback only; a port already in use rejects. The
 * returned promise's `closed` resolves when the session reaches TERMINATING/
 * TERMINATED or stop() is called.
 */
export function startProxy(deps: ProxyServerDeps): Promise<RunningProxy> {
  let boundPort = deps.listenPort;
  const auth = new LocalAuth(() => boundPort, deps.localAuth);
  const openSockets = new Set<WebSocket>();
  const upstreamRequest: UpstreamRequest =
    deps.upstreamRequest ??
    ((options, onResponse) =>
      httpsRequest({ ...options, hostname: deps.endpoint, port: 443 }, onResponse));
  const buildWsUrl =
    deps.upstreamWsUrl ??
    ((endpoint, reqUrl) => {
      const u = new URL(reqUrl, `wss://${endpoint}`);
      u.protocol = "wss:";
      u.host = endpoint;
      return u.toString();
    });

  const server = createServer((req, res) => {
    void handleHttp(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end("proxy error");
    });
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const decision = auth.decide(url.pathname, {
      ...(req.headers.cookie !== undefined ? { cookie: req.headers.cookie } : {}),
      ...(req.headers.host !== undefined ? { host: req.headers.host } : {}),
      ...(url.searchParams.get("k") !== null
        ? { secretParam: url.searchParams.get("k") as string }
        : {}),
    });
    if (decision.action === "deny") {
      res.writeHead(decision.status ?? 401);
      res.end();
      return;
    }
    if (decision.action === "login") {
      res.writeHead(302, {
        "Set-Cookie": decision.setCookie as string,
        Location: decision.location as string,
      });
      res.end();
      return;
    }

    // State gate.
    const state = await deps.readState();
    const gate = stateGate(state);
    if (!gate.serve) {
      res.writeHead(gate.status ?? 503, { "Content-Type": "application/json" });
      res.end(gate.body ?? "");
      return;
    }

    // Forward to the upstream MicroVM endpoint over HTTPS. On an upstream
    // 401/403 we force one token refresh and retry once; a second failure
    // becomes a 502 (R4.8). The retry is only safe for requests without a body
    // (the request stream can be piped only once).
    const method = (req.method ?? "GET").toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD" && req.headers["content-length"] !== "0";
    const firstToken = (await deps.tokenCache.get()).token;
    const first = await forward(req, res, firstToken);
    if (first === "auth-failed") {
      if (hasBody) {
        // The request body stream is already consumed; we cannot safely retry.
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "bad_gateway" }));
        }
        return;
      }
      const refreshed = (await deps.tokenCache.forceRefresh()).token;
      const second = await forward(req, res, refreshed);
      if (second === "auth-failed") {
        deps.logger.error("upstream rejected the auth token after refresh");
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "bad_gateway" }));
        }
      }
    }
  }

  /**
   * Forward one request. Returns `"done"` when the response was written to the
   * client, or `"auth-failed"` when the upstream returned 401/403 — in which
   * case nothing is written, so the caller can decide to force-refresh and
   * retry, or emit a 502. The caller owns the final write on an auth failure.
   */
  function forward(
    req: IncomingMessage,
    res: ServerResponse,
    token: string,
  ): Promise<"done" | "auth-failed"> {
    const authHeaders = deps.authHeadersFromToken(token);
    const strippedCookie = auth.stripCookie(req.headers.cookie);
    const headers = upstreamRequestHeaders(
      req.headers,
      authHeaders,
      deps.codeServerPort,
      strippedCookie,
    );
    const authHeaderNames = Object.keys(authHeaders);
    return new Promise((resolve) => {
      const upstream = upstreamRequest({ method: req.method, path: req.url, headers }, (upRes) => {
        const status = upRes.statusCode ?? 502;
        // An auth rejection never reaches the client: drain the body and let
        // the caller decide (refresh+retry, or 502).
        if (status === 401 || status === 403) {
          upRes.resume(); // discard the body
          upRes.on("end", () => resolve("auth-failed"));
          return;
        }
        const safe = sanitizeResponseHeaders(
          upRes.headers as Record<string, string | string[]>,
          authHeaderNames,
        );
        res.writeHead(status, safe);
        upRes.pipe(res);
        upRes.on("end", () => resolve("done"));
      });
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end("upstream error");
        resolve("done");
      });
      req.pipe(upstream);
    });
  }

  // WebSocket relay.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const decision = auth.decide(url.pathname, {
      ...(req.headers.cookie !== undefined ? { cookie: req.headers.cookie } : {}),
      ...(req.headers.host !== undefined ? { host: req.headers.host } : {}),
    });
    if (decision.action !== "allow" || !auth.originOk(req.headers.origin)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (browserWs) => {
      void relayWebSocket(browserWs, req.url ?? "/");
    });
  });

  async function relayWebSocket(browserWs: WebSocket, reqUrl: string): Promise<void> {
    openSockets.add(browserWs);
    try {
      const { token } = await deps.tokenCache.get();
      const authValue = authValueFromHeaders(deps.authHeadersFromToken(token));
      // Preserve the browser's path + query; only swap scheme/host for upstream.
      const upstreamWs = new WebSocket(
        buildWsUrl(deps.endpoint, reqUrl),
        wsSubprotocols(authValue, deps.codeServerPort),
      );
      const pump = (from: WebSocket, to: WebSocket): void => {
        from.on(
          "message",
          (data, isBinary) =>
            to.readyState === WebSocket.OPEN && to.send(data, { binary: isBinary }),
        );
        from.on("close", () => to.close());
        from.on("error", () => to.close());
      };
      upstreamWs.on("open", () => {
        pump(browserWs, upstreamWs);
        pump(upstreamWs, browserWs);
      });
      upstreamWs.on("error", () => browserWs.close());
    } catch {
      browserWs.close();
    } finally {
      browserWs.on("close", () => openSockets.delete(browserWs));
    }
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.listenPort, "127.0.0.1", () => {
      server.removeListener("error", reject);

      let resolveClosed: () => void;
      const closed = new Promise<void>((r) => (resolveClosed = r));

      // Poll session state every 1s: close WS when not RUNNING; shut down on
      // TERMINATING/TERMINATED.
      const poll = setInterval(() => {
        void deps.readState().then((state) => {
          if (state !== "RUNNING") {
            for (const ws of openSockets) ws.close();
          }
          if (state === "TERMINATING" || state === "TERMINATED") {
            shutdown();
          }
        });
      }, 1000);

      const shutdown = (): void => {
        clearInterval(poll);
        for (const ws of openSockets) ws.close();
        wss.close();
        server.close(() => resolveClosed());
      };

      const addr = server.address();
      boundPort = typeof addr === "object" && addr !== null ? addr.port : deps.listenPort;
      deps.logger.log(`proxy listening on http://127.0.0.1:${boundPort}`);
      resolve({ loginUrl: auth.loginUrl, port: boundPort, closed, stop: shutdown });
    });
  });
}
