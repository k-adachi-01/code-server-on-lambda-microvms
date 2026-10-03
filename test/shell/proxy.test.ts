import { describe, expect, it } from "vite-plus/test";
import {
  LocalAuth,
  parseCookies,
  safeEqual,
  COOKIE_NAME,
  LOGIN_PATH,
} from "../../src/shell/proxy/local-auth.js";
import {
  upstreamRequestHeaders,
  sanitizeResponseHeaders,
  stateGate,
} from "../../src/shell/proxy/http.js";
import { wsSubprotocols } from "../../src/shell/proxy/server.js";
import { TokenCache } from "../../src/shell/proxy/token-cache.js";
import { Redactor } from "../../src/shell/redact.js";
import { FakeMicrovms } from "../fakes/fake-microvms.js";

describe("safeEqual / parseCookies", () => {
  it("compares equal and unequal strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
  it("parses a cookie header into a map", () => {
    expect(parseCookies("a=1; __csmvm=xyz; b=2")).toEqual({ a: "1", __csmvm: "xyz", b: "2" });
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe("LocalAuth", () => {
  it("login with the correct secret sets the cookie and invalidates the secret", () => {
    const auth = new LocalAuth(8787, true);
    const secret = auth.loginUrl.split("k=")[1] as string;
    const d1 = auth.decide(LOGIN_PATH, { host: "127.0.0.1:8787", secretParam: secret });
    expect(d1.action).toBe("login");
    expect(d1.setCookie).toContain(`${COOKIE_NAME}=`);
    expect(d1.setCookie).toContain("HttpOnly");
    expect(d1.setCookie).toContain("SameSite=Strict");
    // Secret is one-time: a second login attempt is denied.
    const d2 = auth.decide(LOGIN_PATH, { host: "127.0.0.1:8787", secretParam: secret });
    expect(d2.action).toBe("deny");
  });

  it("denies a request with no cookie (401)", () => {
    const auth = new LocalAuth(8787, true);
    const d = auth.decide("/", { host: "127.0.0.1:8787" });
    expect(d.action).toBe("deny");
    expect(d.status).toBe(401);
  });

  it("allows a request bearing the session cookie", () => {
    const auth = new LocalAuth(8787, true);
    const secret = auth.loginUrl.split("k=")[1] as string;
    const login = auth.decide(LOGIN_PATH, { host: "127.0.0.1:8787", secretParam: secret });
    const cookie = (login.setCookie as string).split(";")[0] as string; // __csmvm=value
    const d = auth.decide("/", { host: "127.0.0.1:8787", cookie });
    expect(d.action).toBe("allow");
  });

  it("rejects a bad Host header (403, DNS rebinding guard)", () => {
    const auth = new LocalAuth(8787, true);
    const d = auth.decide("/", { host: "evil.example" });
    expect(d.action).toBe("deny");
    expect(d.status).toBe(403);
  });

  it("checks WebSocket Origin", () => {
    const auth = new LocalAuth(8787, true);
    expect(auth.originOk("http://127.0.0.1:8787")).toBe(true);
    expect(auth.originOk("http://evil.example")).toBe(false);
    expect(auth.originOk(undefined)).toBe(false);
  });

  it("strips the __csmvm cookie before forwarding upstream", () => {
    const auth = new LocalAuth(8787, true);
    expect(auth.stripCookie("a=1; __csmvm=secret; b=2")).toBe("a=1; b=2");
    expect(auth.stripCookie("__csmvm=secret")).toBeUndefined();
  });

  it("localAuth:false allows everything (plain localhost)", () => {
    const auth = new LocalAuth(8787, false);
    expect(auth.decide("/", {}).action).toBe("allow");
    expect(auth.hostOk("anything")).toBe(true);
    expect(auth.originOk(undefined)).toBe(true);
  });
});

describe("http helpers", () => {
  it("injects auth + port and drops hop-by-hop + auth from responses", () => {
    const headers = upstreamRequestHeaders(
      { connection: "keep-alive", "user-agent": "x", cookie: "ignored" },
      { "X-aws-proxy-auth": "tok" },
      8080,
      "a=1",
    );
    expect(headers["connection"]).toBeUndefined();
    expect(headers["user-agent"]).toBe("x");
    expect(headers["cookie"]).toBe("a=1");
    expect(headers["X-aws-proxy-auth"]).toBe("tok");
    expect(headers["X-aws-proxy-port"]).toBe("8080");

    const resp = sanitizeResponseHeaders(
      { "content-type": "text/html", "x-aws-proxy-auth": "tok", connection: "close" },
      ["X-aws-proxy-auth"],
    );
    expect(resp["content-type"]).toBe("text/html");
    expect(resp["x-aws-proxy-auth"]).toBeUndefined();
    expect(resp["connection"]).toBeUndefined();
  });

  it("state gate: RUNNING serves, others 503 with the state", () => {
    expect(stateGate("RUNNING")).toEqual({ serve: true });
    const g = stateGate("SUSPENDED");
    expect(g.serve).toBe(false);
    expect(g.status).toBe(503);
    expect(JSON.parse(g.body as string)).toEqual({ state: "SUSPENDED" });
  });
});

describe("wsSubprotocols", () => {
  it("builds the three lambda-microvms subprotocols", () => {
    expect(wsSubprotocols("tok", 8080)).toEqual([
      "lambda-microvms",
      "lambda-microvms.authentication.tok",
      "lambda-microvms.port.8080",
    ]);
  });
});

describe("TokenCache", () => {
  it("mints once and reuses while fresh", async () => {
    const fake = new FakeMicrovms();
    const id = fake.seed("RUNNING");
    let t = 0;
    const cache = new TokenCache({
      port: fake,
      microvmId: id,
      codeServerPort: 8080,
      maxTokenMinutes: 15,
      refreshMarginSeconds: 60,
      now: () => t,
      redactor: new Redactor(),
    });
    const a = await cache.get();
    const b = await cache.get();
    expect(a.token).toBe(b.token);
    expect(fake.countOf("createAuthToken")).toBe(1);
  });

  it("refreshes when within the refresh margin", async () => {
    let t = 0;
    const fake = new FakeMicrovms({ now: () => t });
    const id = fake.seed("RUNNING");
    const cache = new TokenCache({
      port: fake,
      microvmId: id,
      codeServerPort: 8080,
      maxTokenMinutes: 15,
      refreshMarginSeconds: 60,
      now: () => t,
      redactor: new Redactor(),
    });
    await cache.get(); // expiresAt = 0 + 15*60000
    t = 15 * 60_000 - 30_000; // within the 60s margin
    await cache.get();
    expect(fake.countOf("createAuthToken")).toBe(2);
  });

  it("single-flights concurrent refreshes", async () => {
    const fake = new FakeMicrovms();
    const id = fake.seed("RUNNING");
    const cache = new TokenCache({
      port: fake,
      microvmId: id,
      codeServerPort: 8080,
      maxTokenMinutes: 15,
      refreshMarginSeconds: 60,
      now: () => 0,
      redactor: new Redactor(),
    });
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    expect(a.token).toBe(b.token);
    expect(fake.countOf("createAuthToken")).toBe(1);
  });

  it("registers the token with the redactor", async () => {
    const fake = new FakeMicrovms();
    const id = fake.seed("RUNNING");
    const redactor = new Redactor();
    const cache = new TokenCache({
      port: fake,
      microvmId: id,
      codeServerPort: 8080,
      maxTokenMinutes: 15,
      refreshMarginSeconds: 60,
      now: () => 0,
      redactor,
    });
    const { token } = await cache.get();
    expect(redactor.redact(`value ${token} end`)).toBe("value [REDACTED] end");
  });
});
