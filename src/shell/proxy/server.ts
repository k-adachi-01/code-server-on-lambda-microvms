// Auth_Proxy server (R4.1, R4.3, R4.9, R6.4, R8.6). Binds 127.0.0.1 only,
// composes local auth + token cache + HTTP forwarding + WebSocket relay, and
// polls the session state to gate traffic and shut down on terminate.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { WebSocketServer, WebSocket } from "ws";
import type { SessionState } from "../../core/session.js";
import type { RedactingLogger } from "../redact.js";
import { LocalAuth } from "./local-auth.js";
import type { TokenCache } from "./token-cache.js";
import { sanitizeResponseHeaders, stateGate, upstreamRequestHeaders } from "./http.js";

export interface ProxyServerDeps {
  endpoint: string; // MicroVM endpoint host
  codeServerPort: number;
  listenPort: number;
  localAuth: boolean;
  tokenCache: TokenCache;
  logger: RedactingLogger;
  /** Reads the current session state (polled from the State_File). */
  readState: () => Promise<SessionState>;
  /** Parse the JSON token into a header map (adapter encodes it as JSON). */
  authHeadersFromToken: (token: string) => Record<string, string>;
}

/** The three WebSocket subprotocols the MicroVM endpoint expects (R4.3). */
export function wsSubprotocols(token: string, port: number): string[] {
  return [
    "lambda-microvms",
    `lambda-microvms.authentication.${token}`,
    `lambda-microvms.port.${port}`,
  ];
}

export interface RunningProxy {
  loginUrl: string;
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
  const auth = new LocalAuth(deps.listenPort, deps.localAuth);
  const openSockets = new Set<WebSocket>();

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

    // Forward to the upstream MicroVM endpoint over HTTPS.
    const { token } = await deps.tokenCache.get();
    const authHeaders = deps.authHeadersFromToken(token);
    const strippedCookie = auth.stripCookie(req.headers.cookie);
    const headers = upstreamRequestHeaders(
      req.headers,
      authHeaders,
      deps.codeServerPort,
      strippedCookie,
    );
    await forward(req, res, headers, Object.keys(authHeaders));
  }

  function forward(
    req: IncomingMessage,
    res: ServerResponse,
    headers: Record<string, string>,
    authHeaderNames: string[],
  ): Promise<void> {
    return new Promise((resolve) => {
      const upstream = httpsRequest(
        { hostname: deps.endpoint, port: 443, method: req.method, path: req.url, headers },
        (upRes) => {
          const safe = sanitizeResponseHeaders(
            upRes.headers as Record<string, string | string[]>,
            authHeaderNames,
          );
          res.writeHead(upRes.statusCode ?? 502, safe);
          upRes.pipe(res);
          upRes.on("end", resolve);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end("upstream error");
        resolve();
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
      void relayWebSocket(browserWs);
    });
  });

  async function relayWebSocket(browserWs: WebSocket): Promise<void> {
    openSockets.add(browserWs);
    try {
      const { token } = await deps.tokenCache.get();
      const upstreamWs = new WebSocket(
        `wss://${deps.endpoint}/`,
        wsSubprotocols(token, deps.codeServerPort),
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

      deps.logger.log(`proxy listening on http://127.0.0.1:${deps.listenPort}`);
      resolve({ loginUrl: auth.loginUrl, closed, stop: shutdown });
    });
  });
}
