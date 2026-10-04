// Lambda MicroVMs lifecycle Hook_Handler (R13.1-R13.4). Runs inside the MicroVM
// image.
//
// Hook path contract (confirmed via the AWS MCP server's official docs,
// "Running and using MicroVMs"): Lambda POSTs each hook to
//   /aws/lambda-microvms/runtime/v1/<hook-name>
// on the configured hook port. Traffic to the app only begins after the `/run`
// hook returns HTTP 200. We match on the trailing <hook-name> so the full
// official path is handled; the bare `/<hook-name>` form is also accepted as a
// fallback for local probes and tests.
//
// Behavior:
//   run       poll code-server /healthz until a deadline (run-hook timeout - 2s),
//             then 200 if healthy else 503. code-server is already running from
//             the build-time snapshot (A-14); run does NOT start it. If a
//             per-VM value must be restored, do it here before the health check
//             (none needed by default — the image holds no per-user secret).
//   ready, validate     same health check but with the longer deadline.
//   resume, suspend, terminate   return 200 immediately and log the hook name
//             plus the sessionId from the payload.
//
// No secrets are read or generated here. Pure node:http + node:https.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { get as httpGet } from "node:http";

const HOOK_PORT = Number(process.env["CSMVM_HOOK_PORT"] ?? 9000);
const CODE_SERVER_PORT = Number(process.env["CSMVM_CODE_SERVER_PORT"] ?? 8080);
const RUN_DEADLINE_MS = Number(process.env["CSMVM_RUN_DEADLINE_MS"] ?? 8000);
const LONG_DEADLINE_MS = Number(process.env["CSMVM_LONG_DEADLINE_MS"] ?? 60000);

/** The official hook path prefix the Lambda MicroVMs runtime POSTs to. */
export const HOOK_PATH_PREFIX = "/aws/lambda-microvms/runtime/v1/";

/**
 * Extract the hook name from a request path. Accepts both the official
 * `/aws/lambda-microvms/runtime/v1/<hook-name>` form and a bare
 * `/<hook-name>` fallback. Returns the lowercase hook name (e.g. "run").
 */
export function hookNameFromPath(rawPath: string): string {
  const path = (rawPath || "/").split("?")[0] ?? "/";
  const withoutPrefix = path.startsWith(HOOK_PATH_PREFIX)
    ? path.slice(HOOK_PATH_PREFIX.length)
    : path.replace(/^\/+/, "");
  // Guard against a trailing slash or extra segments; take the first segment.
  return (withoutPrefix.split("/")[0] ?? "").toLowerCase();
}

/** Hook names that gate on a code-server health check. */
const HEALTH_HOOKS = new Set(["run", "ready", "validate"]);

/** Read and JSON-parse the request body (best-effort). */
function readPayload(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/** One code-server health probe: resolves true on any 2xx. */
function probeOnce(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpGet(
      { host: "127.0.0.1", port: CODE_SERVER_PORT, path: "/healthz", timeout: 2000 },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 400);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll code-server health until it is ready or the deadline passes. */
async function waitHealthy(deadlineMs: number): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    if (await probeOnce()) return true;
    if (Date.now() >= until) return false;
    await sleep(300);
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawPath = (req.url ?? "/").split("?")[0] ?? "/";
  const hook = hookNameFromPath(rawPath);
  const payload = await readPayload(req);
  const sessionId =
    typeof payload["sessionId"] === "string" ? (payload["sessionId"] as string) : "(none)";
  process.stdout.write(
    `hook ${req.method} ${rawPath} name=${hook} port=${HOOK_PORT} sessionId=${sessionId}\n`,
  );

  if (HEALTH_HOOKS.has(hook)) {
    const deadline = hook === "run" ? RUN_DEADLINE_MS : LONG_DEADLINE_MS;
    const healthy = await waitHealthy(deadline);
    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ healthy }));
    return;
  }

  // resume / suspend / terminate and anything else: ack immediately.
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

const server = createServer((req, res) => {
  void handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

// Start listening unless explicitly suppressed. Unit tests import this module
// for the pure helpers; they must not bind a port. Suppress when
// CSMVM_HOOK_NO_LISTEN=1 or when running under Vitest (which hoists imports
// above any test-set env, so the VITEST flag is the reliable guard).
if (process.env["CSMVM_HOOK_NO_LISTEN"] !== "1" && process.env["VITEST"] === undefined) {
  server.listen(HOOK_PORT, () => {
    process.stdout.write(`csmvm hook handler listening on :${HOOK_PORT}\n`);
  });
}
