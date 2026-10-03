// State store (shell, R9.5–R9.7, R4.5, R15.4). Persists the core Session to
// `.session/state.json` with atomic writes and strict schema validation. The
// zod schema lives here (shell only) so the core stays dependency-free; this
// module converts between the on-disk form (ISO timestamps, state never NONE)
// and the core Session (epoch-ms numbers).
//
// Shell code may use node builtins (unlike src/core/**).

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { FileRead, Session, SessionState } from "../core/session.js";
import { isInFlight } from "../core/session.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** On-disk session states (NONE is never written — NONE means file absent). */
const ON_DISK_STATES = [
  "LAUNCHING",
  "RUNNING",
  "SUSPENDING",
  "SUSPENDED",
  "RESUMING",
  "TERMINATING",
  "TERMINATED",
  "FAILED",
] as const;

const isoString = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: "must be an ISO timestamp",
});

// Schema version 1. `.strict()` rejects unknown keys (R9.7: no stray fields).
const stateFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string().min(1),
    microvmId: z.string().min(1).nullable(),
    state: z.enum(ON_DISK_STATES),
    adopted: z.boolean(),
    launchClientToken: z.string().min(1).nullable(),
    inFlightSince: isoString.nullable(),
    lastReconciledAt: isoString.nullable(),
    rawRemoteStatus: z.string().nullable(),
    region: z.string().min(1),
  })
  .strict()
  .superRefine((v, ctx) => {
    // Token required iff LAUNCHING, or TERMINATING with no microvmId (C6/C7b).
    const tokenRequired =
      v.state === "LAUNCHING" || (v.state === "TERMINATING" && v.microvmId === null);
    if (tokenRequired && v.launchClientToken === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `launchClientToken required for state ${v.state}`,
      });
    }
    if (!tokenRequired && v.launchClientToken !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `launchClientToken must be null for state ${v.state}`,
      });
    }
    // inFlightSince required iff an in-flight state.
    const inFlight = isInFlight(v.state as SessionState);
    if (inFlight && v.inFlightSince === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `inFlightSince required for in-flight state ${v.state}`,
      });
    }
    if (!inFlight && v.inFlightSince !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `inFlightSince must be null for state ${v.state}`,
      });
    }
  });

type StateFile = z.infer<typeof stateFileSchema>;

function toEpoch(iso: string | null): number | null {
  return iso === null ? null : Date.parse(iso);
}
function toIso(epoch: number | null): string | null {
  return epoch === null ? null : new Date(epoch).toISOString();
}

/** Convert a validated on-disk record to a core Session. */
function toSession(f: StateFile): Session {
  return {
    sessionId: f.sessionId,
    microvmId: f.microvmId,
    state: f.state,
    adopted: f.adopted,
    launchClientToken: f.launchClientToken,
    inFlightSince: toEpoch(f.inFlightSince),
    lastReconciledAt: toEpoch(f.lastReconciledAt),
    rawRemoteStatus: f.rawRemoteStatus,
    region: f.region,
  };
}

/** Convert a core Session (never NONE) to the on-disk record. */
function toFile(s: Session): StateFile {
  if (s.state === "NONE") {
    throw new Error("cannot persist a NONE session (NONE = file absent)");
  }
  if (s.sessionId === null) {
    throw new Error("cannot persist a session with a null sessionId");
  }
  return {
    schemaVersion: 1,
    sessionId: s.sessionId,
    microvmId: s.microvmId,
    state: s.state,
    adopted: s.adopted,
    launchClientToken: s.launchClientToken,
    inFlightSince: toIso(s.inFlightSince),
    lastReconciledAt: toIso(s.lastReconciledAt),
    rawRemoteStatus: s.rawRemoteStatus,
    region: s.region,
  };
}

/** The state store, bound to a session directory. */
export class StateStore {
  readonly dir: string;
  readonly file: string;

  /** @param baseDir directory that contains `.session/` (default: cwd) */
  constructor(baseDir: string = process.cwd()) {
    this.dir = join(baseDir, ".session");
    this.file = join(this.dir, "state.json");
  }

  /** Read the state file into a FileRead. Parse/validation failure -> corrupt. */
  read(): FileRead {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { kind: "corrupt" };
    }
    const parsed = stateFileSchema.safeParse(json);
    if (!parsed.success) return { kind: "corrupt" };
    return { kind: "valid", session: toSession(parsed.data) };
  }

  /**
   * Persist a Session. A NONE session deletes the file; any other state is
   * written atomically (temp file in the same dir, fsync, rename) with mode
   * 0600 inside a 0700 directory.
   */
  persist(session: Session): void {
    if (session.state === "NONE") {
      this.delete();
      return;
    }
    const record = toFile(session);
    const body = `${JSON.stringify(record, null, 2)}\n`;
    mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
    const tmp = join(this.dir, `.state.json.tmp-${process.pid}-${Date.now()}`);
    const fd = openSync(tmp, "w", FILE_MODE);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
  }

  /** Rename a corrupt file aside as `state.json.corrupt-<ISO>` (R9.5). */
  quarantine(): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = join(dirname(this.file), `state.json.corrupt-${stamp}`);
    try {
      renameSync(this.file, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /** Delete the state file (NONE). No error if already absent. */
  delete(): void {
    try {
      rmSync(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
