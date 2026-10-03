// File-backed fake MicrovmsPort for local, offline end-to-end runs (NOT for
// production). Enabled only when CSMVM_FAKE_BACKEND is set, so the real `csmvm`
// binary can drive the whole lifecycle with no AWS account and no network.
//
// Unlike the in-memory test FakeMicrovms, this persists MicroVM records to a
// JSON file so state survives across separate `csmvm` process invocations
// (launch, status, suspend, ... are separate processes). It is deliberately
// simple: a MicroVM goes PENDING -> RUNNING on the first get, and suspend/
// resume/terminate flip its status.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GetResult, MicrovmsPort } from "./aws-adapter.js";
import type { RunMicrovmParams } from "../core/run-params.js";

interface FakeRecord {
  microvmId: string;
  status: string;
  seenGets: number;
  endpoint: string;
}
interface FakeDb {
  byToken: Record<string, string>;
  vms: Record<string, FakeRecord>;
  seq: number;
}

export class FileFakeMicrovms implements MicrovmsPort {
  private readonly path: string;

  constructor(baseDir: string) {
    this.path = join(baseDir, ".session", "fake-backend.json");
  }

  private load(): FakeDb {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as FakeDb;
    } catch {
      return { byToken: {}, vms: {}, seq: 0 };
    }
  }
  private save(db: FakeDb): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(db));
  }

  async run(p: RunMicrovmParams): Promise<{ microvmId: string }> {
    const db = this.load();
    const existing = db.byToken[p.clientToken];
    if (existing !== undefined) return { microvmId: existing };
    db.seq += 1;
    const id = `mvm-fake-${db.seq}`;
    db.byToken[p.clientToken] = id;
    db.vms[id] = {
      microvmId: id,
      status: "PENDING",
      seenGets: 0,
      endpoint: `fake-${db.seq}.local`,
    };
    this.save(db);
    return { microvmId: id };
  }

  async get(id: string): Promise<GetResult> {
    const db = this.load();
    const vm = db.vms[id];
    if (vm === undefined) return { kind: "notFound" };
    // PENDING ramps to RUNNING on the second observation.
    if (vm.status === "PENDING") {
      vm.seenGets += 1;
      if (vm.seenGets >= 1) vm.status = "RUNNING";
      this.save(db);
    }
    return { kind: "status", raw: vm.status, endpoint: vm.endpoint, remainingSeconds: 3600 };
  }

  async listByImage(): Promise<{ microvmId: string; status: string }[]> {
    const db = this.load();
    return Object.values(db.vms).map((v) => ({ microvmId: v.microvmId, status: v.status }));
  }

  private setStatus(id: string, status: string): void {
    const db = this.load();
    const vm = db.vms[id];
    if (vm !== undefined) {
      vm.status = status;
      this.save(db);
    }
  }

  async suspend(id: string): Promise<void> {
    this.setStatus(id, "SUSPENDED");
  }
  async resume(id: string): Promise<void> {
    this.setStatus(id, "RUNNING");
  }
  async terminate(id: string): Promise<void> {
    this.setStatus(id, "TERMINATED");
  }

  async createAuthToken(
    id: string,
    port: number,
    minutes: number,
  ): Promise<{ token: string; expiresAt: number }> {
    return {
      token: JSON.stringify({ "X-aws-proxy-auth": `fake-${id}-${port}` }),
      expiresAt: Date.now() + minutes * 60_000,
    };
  }
}
