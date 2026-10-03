import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../../src/shell/state-store.js";
import type { Session } from "../../src/core/session.js";

let base: string;
let store: StateStore;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "csmvm-state-"));
  store = new StateStore(base);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function runningSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: "8f0c0000-0000-4000-8000-000000000000",
    microvmId: "mvm-abc",
    state: "RUNNING",
    adopted: false,
    launchClientToken: null,
    inFlightSince: null,
    lastReconciledAt: 1_700_000_000_000,
    rawRemoteStatus: "RUNNING",
    region: "ap-northeast-1",
    ...overrides,
  };
}

describe("StateStore", () => {
  it("round-trips a RUNNING session through persist/read", () => {
    const s = runningSession();
    store.persist(s);
    const r = store.read();
    expect(r.kind).toBe("valid");
    if (r.kind === "valid") expect(r.session).toEqual(s);
  });

  it("round-trips a LAUNCHING session (token + inFlightSince present)", () => {
    const s = runningSession({
      state: "LAUNCHING",
      microvmId: null,
      launchClientToken: "lct-xyz",
      inFlightSince: 1_700_000_123_000,
      rawRemoteStatus: null,
    });
    store.persist(s);
    const r = store.read();
    expect(r.kind).toBe("valid");
    if (r.kind === "valid") expect(r.session).toEqual(s);
  });

  it("returns absent when no file exists", () => {
    expect(store.read().kind).toBe("absent");
  });

  it("NONE deletes the file", () => {
    store.persist(runningSession());
    expect(store.read().kind).toBe("valid");
    store.persist(
      runningSession({
        state: "NONE",
        sessionId: null,
        microvmId: null,
        launchClientToken: null,
        inFlightSince: null,
        rawRemoteStatus: null,
      }),
    );
    expect(store.read().kind).toBe("absent");
  });

  it("keeps the file on TERMINATED (status can still report it)", () => {
    store.persist(runningSession({ state: "TERMINATED", rawRemoteStatus: "TERMINATED" }));
    const r = store.read();
    expect(r.kind).toBe("valid");
    if (r.kind === "valid") expect(r.session.state).toBe("TERMINATED");
  });

  it("treats invalid JSON as corrupt", () => {
    mkdirSync(store.dir, { recursive: true });
    writeFileSync(store.file, "{ not json");
    expect(store.read().kind).toBe("corrupt");
  });

  it("treats a schema violation (unknown key) as corrupt", () => {
    mkdirSync(store.dir, { recursive: true });
    const bad = { ...JSON.parse(JSON.stringify(toDisk(runningSession()))), surprise: 1 };
    writeFileSync(store.file, JSON.stringify(bad));
    expect(store.read().kind).toBe("corrupt");
  });

  it("treats a missing required token (LAUNCHING without token) as corrupt", () => {
    mkdirSync(store.dir, { recursive: true });
    const bad = toDisk(runningSession({ state: "LAUNCHING", microvmId: null, inFlightSince: 1 }));
    bad["launchClientToken"] = null;
    writeFileSync(store.file, JSON.stringify(bad));
    expect(store.read().kind).toBe("corrupt");
  });

  it("quarantine renames the file to state.json.corrupt-<stamp>", () => {
    mkdirSync(store.dir, { recursive: true });
    writeFileSync(store.file, "{ not json");
    store.quarantine();
    expect(store.read().kind).toBe("absent"); // original gone
    const quarantined = readdirSync(store.dir).filter((n) => n.startsWith("state.json.corrupt-"));
    expect(quarantined.length).toBe(1);
  });

  it("writes the directory 0700 and the file 0600", () => {
    store.persist(runningSession());
    expect(statSync(store.dir).mode & 0o777).toBe(0o700);
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
  });

  it("writes atomically (no leftover temp files)", () => {
    store.persist(runningSession());
    const leftovers = readdirSync(store.dir).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("persists timestamps as ISO strings on disk", () => {
    store.persist(runningSession({ lastReconciledAt: 1_700_000_000_000 }));
    const onDisk = JSON.parse(readFileSync(store.file, "utf8"));
    expect(typeof onDisk.lastReconciledAt).toBe("string");
    expect(onDisk.schemaVersion).toBe(1);
    // No NONE on disk.
    expect(onDisk.state).not.toBe("NONE");
  });
});

/** Produce the on-disk record for a session (ISO timestamps) for test fixtures. */
function toDisk(s: Session): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sessionId: s.sessionId,
    microvmId: s.microvmId,
    state: s.state,
    adopted: s.adopted,
    launchClientToken: s.launchClientToken,
    inFlightSince: s.inFlightSince === null ? null : new Date(s.inFlightSince).toISOString(),
    lastReconciledAt:
      s.lastReconciledAt === null ? null : new Date(s.lastReconciledAt).toISOString(),
    rawRemoteStatus: s.rawRemoteStatus,
    region: s.region,
  };
}
