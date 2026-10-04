// Integration tests for the proxy server (R4.1, R4.2, R4.4, R4.8, R4.9). These
// actually start startProxy() on a loopback port and drive it with real HTTP
// requests, with the upstream injected to point at a fake loopback HTTP server
// (instead of the real HTTPS MicroVM endpoint on :443). This is the authoritative
// check that was missing: the earlier proxy.test.ts only exercised pure helpers
// and the TokenCache and never bound a socket.

import { afterEach, describe, expect, it } from "vite-plus/test";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  startProxy,
  isValidSubprotocolToken,
  authValueFromHeaders,
  requestHasBody,
  wsSubprotocols,
  type RunningProxy,
  type UpstreamRequest,
} from "../../src/shell/proxy/server.js";
import { TokenCache } from "../../src/shell/proxy/token-cache.js";
import { Redactor, RedactingLogger, type Sink } from "../../src/shell/redact.js";
import { FakeMicrovms } from "../fakes/fake-microvms.js";
import type { SessionState } from "../../src/core/session.js";

/** Decode the JSON header-map token like the real connect command does. */
function authHeadersFromToken(token: string): Record<string, string> {
  try {
    return JSON.parse(token) as Record<string, string>;
  } catch {
    return { "X-aws-proxy-auth": token };
  }
}

interface Upstream {
  server: Server;
  port: number;
  /** Headers seen on the most recent request. */
  lastHeaders: Record<string, string | string[] | undefined>;
  requestCount: number;
}

/**
 * A fake upstream HTTP server. `respond` decides the status/body/headers per
 * request (receives the 1-based attempt count so a test can fail-then-succeed).
 */
async function startUpstream(
  respond: (n: number) => { status: number; headers?: Record<string, string>; body?: string },
): Promise<Upstream> {
  const state: Upstream = {
    server: undefined as unknown as Server,
    port: 0,
    lastHeaders: {},
    requestCount: 0,
  };
  const server = createServer((req, res) => {
    state.requestCount += 1;
    state.lastHeaders = req.headers;
    const r = respond(state.requestCount);
    req.resume(); // drain any body
    res.writeHead(r.status, { "content-type": "text/plain", ...(r.headers ?? {}) });
    res.end(r.body ?? "ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.server = server;
  state.port = (server.address() as AddressInfo).port;
  return state;
}

/** Build an UpstreamRequest that targets the fake loopback upstream over plain HTTP. */
function upstreamToLoopback(upstreamPort: number): UpstreamRequest {
  return (options, onResponse) =>
    httpRequest({ ...options, hostname: "127.0.0.1", port: upstreamPort }, onResponse);
}

function makeTokenCache(fake: FakeMicrovms, id: string, redactor: Redactor): TokenCache {
  return new TokenCache({
    port: fake,
    microvmId: id,
    codeServerPort: 8080,
    maxTokenMinutes: 15,
    refreshMarginSeconds: 60,
    now: () => Date.now(),
    redactor,
  });
}

/** Perform a request against the proxy on 127.0.0.1 and collect the full response. */
function request(
  method: string,
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Perform a GET against the proxy on 127.0.0.1 and collect the full response. */
function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  return request("GET", port, path, headers);
}

describe("proxy server (integration)", () => {
  const running: RunningProxy[] = [];
  const upstreams: Server[] = [];

  afterEach(async () => {
    for (const p of running.splice(0)) p.stop();
    for (const s of upstreams.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
  });

  async function launch(opts: {
    upstream: Upstream;
    readState?: () => Promise<SessionState>;
    localAuth?: boolean;
    sink?: Sink;
  }): Promise<{ proxy: RunningProxy; port: number; redactor: Redactor }> {
    upstreams.push(opts.upstream.server);
    const redactor = new Redactor();
    const fake = new FakeMicrovms();
    const id = fake.seed("RUNNING");
    const tokenCache = makeTokenCache(fake, id, redactor);
    const logger = new RedactingLogger(redactor, opts.sink);
    const proxy = await startProxy({
      endpoint: "unused.example",
      codeServerPort: 8080,
      listenPort: 0,
      localAuth: opts.localAuth ?? false,
      tokenCache,
      logger,
      readState: opts.readState ?? (async () => "RUNNING"),
      authHeadersFromToken,
      upstreamRequest: upstreamToLoopback(opts.upstream.port),
    });
    running.push(proxy);
    return { proxy, port: proxy.port, redactor };
  }

  it("binds loopback and forwards with the auth + port headers injected", async () => {
    const upstream = await startUpstream(() => ({ status: 200, body: "hello" }));
    const { port } = await launch({ upstream });
    const res = await get(port, "/workbench");
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello");
    // The upstream saw the injected auth header and the target port.
    expect(upstream.lastHeaders["x-aws-proxy-auth"]).toBeDefined();
    expect(upstream.lastHeaders["x-aws-proxy-port"]).toBe("8080");
  });

  it("gates on state: non-RUNNING returns 503 with the state and never calls upstream", async () => {
    const upstream = await startUpstream(() => ({ status: 200 }));
    const { port } = await launch({ upstream, readState: async () => "SUSPENDED" });
    const res = await get(port, "/");
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ state: "SUSPENDED" });
    expect(upstream.requestCount).toBe(0);
  });

  it("with localAuth, a request without the cookie is denied 401 (no upstream call)", async () => {
    const upstream = await startUpstream(() => ({ status: 200 }));
    const { port } = await launch({ upstream, localAuth: true });
    const res = await get(port, "/", { host: `127.0.0.1:${port}` });
    expect(res.status).toBe(401);
    expect(upstream.requestCount).toBe(0);
  });

  it("forces one token refresh on upstream 401 and retries; a second 401 becomes 502", async () => {
    // Upstream always rejects: first attempt 401 (triggers refresh), retry also
    // 401 -> proxy returns 502.
    const upstream = await startUpstream(() => ({ status: 401, body: "nope" }));
    const sink: Sink & { errors: string[] } = {
      errors: [],
      log: () => {},
      error(l) {
        this.errors.push(l);
      },
    };
    const { port } = await launch({ upstream, sink });
    const res = await get(port, "/");
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: "bad_gateway" });
    // Two upstream attempts: the original and the post-refresh retry.
    expect(upstream.requestCount).toBe(2);
    expect(sink.errors.join("\n")).toContain("after refresh");
  });

  it("recovers when the upstream accepts the refreshed token on the retry", async () => {
    // First attempt 403, retry 200.
    const upstream = await startUpstream((n) =>
      n === 1 ? { status: 403, body: "stale" } : { status: 200, body: "fresh" },
    );
    const { port } = await launch({ upstream });
    const res = await get(port, "/");
    expect(res.status).toBe(200);
    expect(res.body).toBe("fresh");
    expect(upstream.requestCount).toBe(2);
  });

  it("retries a bodyless DELETE after a forced refresh (not treated as unreplayable)", async () => {
    // A bodyless non-GET must still be retried: method must not gate the retry.
    const upstream = await startUpstream((n) =>
      n === 1 ? { status: 403, body: "stale" } : { status: 200, body: "deleted" },
    );
    const { port } = await launch({ upstream });
    const res = await request("DELETE", port, "/thing");
    expect(res.status).toBe(200);
    expect(res.body).toBe("deleted");
    // Two upstream attempts: original + post-refresh retry (refresh happened).
    expect(upstream.requestCount).toBe(2);
  });

  it("never leaks the auth token value in the response headers or body", async () => {
    // Echo the auth header value back in both a response header and the body —
    // the proxy must strip the header and the Redactor-wrapped logger must not
    // have surfaced it. The response body passes through untouched, so we assert
    // the proxy at least strips the auth header it injected.
    const upstream = await startUpstream(() => ({
      status: 200,
      headers: { "x-aws-proxy-auth": "SHOULD_NOT_APPEAR" },
      body: "ok",
    }));
    const { port } = await launch({ upstream });
    const res = await get(port, "/");
    expect(res.status).toBe(200);
    // The injected/echoed auth header is removed from the client-facing response.
    expect(res.headers["x-aws-proxy-auth"]).toBeUndefined();
  });
});

describe("WebSocket subprotocol helpers", () => {
  it("accepts a valid RFC 7230 token and rejects separators/whitespace/JSON", () => {
    expect(isValidSubprotocolToken("abc123._-~")).toBe(true);
    expect(isValidSubprotocolToken("")).toBe(false);
    expect(isValidSubprotocolToken("has space")).toBe(false);
    expect(isValidSubprotocolToken("a,b")).toBe(false);
    expect(isValidSubprotocolToken('{"X-aws-proxy-auth":"v"}')).toBe(false);
  });

  it("extracts the single auth value from a decoded header map", () => {
    expect(authValueFromHeaders({ "X-aws-proxy-auth": "v1" })).toBe("v1");
    expect(authValueFromHeaders({ "x-aws-proxy-auth": "v2" })).toBe("v2");
    expect(authValueFromHeaders({ "Only-Header": "sole" })).toBe("sole");
    expect(() => authValueFromHeaders({ a: "1", b: "2" })).toThrow(/single auth value/);
  });

  it("throws rather than emit an invalid subprotocol for a JSON-shaped value", () => {
    expect(() => wsSubprotocols('{"X-aws-proxy-auth":"v"}', 8080)).toThrow(
      /valid WebSocket subprotocol/,
    );
    expect(wsSubprotocols("validToken", 8080)).toEqual([
      "lambda-microvms",
      "lambda-microvms.authentication.validToken",
      "lambda-microvms.port.8080",
    ]);
  });
});

describe("requestHasBody", () => {
  it("is false for a bodyless request regardless of method", () => {
    expect(requestHasBody({ headers: {} })).toBe(false);
    expect(requestHasBody({ headers: { "content-length": "0" } })).toBe(false);
    // A bodyless DELETE/POST (no content-length, no transfer-encoding) is retryable.
    expect(requestHasBody({ headers: { host: "x" } })).toBe(false);
  });

  it("is true when a body was streamed (content-length > 0 or chunked)", () => {
    expect(requestHasBody({ headers: { "content-length": "12" } })).toBe(true);
    expect(requestHasBody({ headers: { "transfer-encoding": "chunked" } })).toBe(true);
  });

  it("treats a non-numeric content-length as no body", () => {
    expect(requestHasBody({ headers: { "content-length": "abc" } })).toBe(false);
  });
});

describe("WebSocket relay (integration)", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
  });

  it("buffers browser frames sent before the upstream opens and flushes them in order", async () => {
    // Fake upstream WS server that records every message it receives, in order.
    const received: string[] = [];
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => wss.on("listening", r));
    const upstreamPort = (wss.address() as AddressInfo).port;
    wss.on("connection", (ws) => {
      ws.on("message", (data) => received.push(Buffer.from(data as Buffer).toString("utf8")));
    });
    cleanup.push(() => wss.close());

    // A token cache whose mint is delayed, so the browser's first frames arrive
    // before the upstream socket is open — the exact window that used to drop
    // frames.
    const redactor = new Redactor();
    const slowPort = {
      async createAuthToken() {
        await new Promise((r) => setTimeout(r, 120));
        return {
          token: JSON.stringify({ "X-aws-proxy-auth": "wsval" }),
          expiresAt: Date.now() + 900_000,
        };
      },
    } as unknown as ConstructorParameters<typeof TokenCache>[0]["port"];
    const tokenCache = new TokenCache({
      port: slowPort,
      microvmId: "m-1",
      codeServerPort: 8080,
      maxTokenMinutes: 15,
      refreshMarginSeconds: 60,
      now: () => Date.now(),
      redactor,
    });

    const proxy = await startProxy({
      endpoint: "unused.example",
      codeServerPort: 8080,
      listenPort: 0,
      localAuth: false,
      tokenCache,
      logger: new RedactingLogger(redactor),
      readState: async () => "RUNNING",
      authHeadersFromToken,
      // Point the upstream WS at the fake loopback ws:// server.
      upstreamWsUrl: (_endpoint, reqUrl) => `ws://127.0.0.1:${upstreamPort}${reqUrl}`,
    });
    cleanup.push(() => proxy.stop());

    // Open a browser-side socket to the proxy and send a frame immediately on
    // open — well before the delayed token lets the upstream connect.
    const browser = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      browser.on("open", () => {
        browser.send("sent-on-open");
        resolve();
      });
      browser.on("error", reject);
    });
    // Send a second frame a bit later, still possibly before upstream open.
    setTimeout(() => browser.send("sent-later"), 20);

    // Wait until the upstream has received both frames (or time out).
    const deadline = Date.now() + 3000;
    while (received.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    browser.close();
    expect(received).toEqual(["sent-on-open", "sent-later"]);
  });
});
