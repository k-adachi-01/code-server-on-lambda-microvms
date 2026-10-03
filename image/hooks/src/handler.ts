// Lambda MicroVMs lifecycle Hook_Handler (R13.1-R13.4). Runs inside the MicroVM
// image. The exact hook port, path prefix, and timing contract are confirmed in
// Phase 0 S1; this implements a reasonable default and logs method/path/port
// for every request so S1 can read the real contract from the logs.
//
// Behavior:
//   /run      poll code-server /healthz until a deadline (run-hook timeout - 2s),
//             then 200 if healthy else 503. code-server is already running from
//             the build-time snapshot (A-14); /run does NOT start it. If a
//             per-VM value must be restored, do it here before the health check
//             (none needed by default — the image holds no per-user secret).
//   /ready, /validate   same health check but with the longer deadline.
//   /resume, /suspend, /terminate   return 200 immediately and log the hook name
//             plus the sessionId from the payload.
//
// No secrets are read or generated here. Pure node:http + node:https.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { get as httpGet } from "node:http";

const HOOK_PORT = Number(process.env["CSMVM_HOOK_PORT"] ?? 9000);
const CODE_SERVER_PORT = Number(process.env["CSMVM_CODE_SERVER_PORT"] ?? 8080);
const RUN_DEADLINE_MS = Number(process.env["CSMVM_RUN_DEADLINE_MS"] ?? 8000);
const LONG_DEADLINE_MS = Number(process.env["CSMVM_LONG_DEADLINE_MS"] ?? 60000);

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
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  const payload = await readPayload(req);
  const sessionId =
    typeof payload["sessionId"] === "string" ? (payload["sessionId"] as string) : "(none)";
  // Log the contract fields so Phase 0 S1 can read the real values.
  process.stdout.write(`hook ${req.method} ${path} port=${HOOK_PORT} sessionId=${sessionId}\n`);

  if (path === "/run" || path === "/ready" || path === "/validate") {
    const deadline = path === "/run" ? RUN_DEADLINE_MS : LONG_DEADLINE_MS;
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

server.listen(HOOK_PORT, () => {
  process.stdout.write(`csmvm hook handler listening on :${HOOK_PORT}\n`);
});
