// `connect`: run the Auth_Proxy in the foreground (R4.1, R4.11, R2.4). Requires
// a RUNNING session; reconciles first, resolves the endpoint, starts the proxy
// bound to 127.0.0.1, prints the one-time login URL, and blocks until the
// session terminates or the user interrupts.

import { validateConfig } from "../core/config.js";
import type { SessionState } from "../core/session.js";
import type { InterpreterDeps } from "../shell/interpreter.js";
import { TokenCache } from "../shell/proxy/token-cache.js";
import { startProxy } from "../shell/proxy/server.js";

function authHeadersFromToken(token: string): Record<string, string> {
  try {
    return JSON.parse(token) as Record<string, string>;
  } catch {
    return { "X-aws-proxy-auth": token };
  }
}

/** Run the connect command. Returns the process exit code. */
export async function connectCommand(deps: InterpreterDeps): Promise<number> {
  const validated = validateConfig(deps.config);
  if (!validated.ok) {
    for (const e of validated.errors) deps.logger.error(`config: ${e.path} ${e.message}`);
    return 2;
  }
  const cfg = validated.config;

  const file = deps.store.read();
  if (
    file.kind !== "valid" ||
    file.session.state !== "RUNNING" ||
    file.session.microvmId === null
  ) {
    deps.logger.error("connect requires a RUNNING session; run 'csmvm launch' first");
    return 2;
  }
  const microvmId = file.session.microvmId;

  const obs = await deps.port.get(microvmId);
  const endpoint = "endpoint" in obs && obs.endpoint ? obs.endpoint : null;
  if (endpoint === null) {
    deps.logger.error("could not resolve the MicroVM endpoint");
    return 1;
  }

  const tokenCache = new TokenCache({
    port: deps.port,
    microvmId,
    codeServerPort: cfg.codeServerPort,
    maxTokenMinutes: cfg.token.maxExpirationMinutes,
    refreshMarginSeconds: cfg.token.refreshMarginSeconds,
    now: deps.now,
    redactor: deps.redactor,
  });

  const readState = async (): Promise<SessionState> => {
    const f = deps.store.read();
    return f.kind === "valid" ? f.session.state : "TERMINATED";
  };

  const proxy = await startProxy({
    endpoint,
    codeServerPort: cfg.codeServerPort,
    listenPort: cfg.proxy.listenPort,
    localAuth: cfg.proxy.localAuth,
    tokenCache,
    logger: deps.logger,
    readState,
    authHeadersFromToken,
  });

  if (cfg.proxy.localAuth) {
    deps.logger.log(`open: ${proxy.loginUrl}`);
  } else {
    deps.logger.log(
      `open: http://127.0.0.1:${cfg.proxy.listenPort}/  (localAuth disabled — plain localhost access)`,
    );
  }

  // Stop the proxy on Ctrl-C.
  const onSigint = (): void => proxy.stop();
  process.on("SIGINT", onSigint);
  try {
    await proxy.closed;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
  return 0;
}
