#!/usr/bin/env node
// API-driven MicroVM image build (Phase 0 S1 finding: CloudFormation's
// AWS::Lambda::MicrovmImage stabilization times out at ~60s, far shorter than a
// real build, so the image is built via create/update-microvm-image + polling
// of GetMicrovmImageBuild instead). Reads the CDK stack outputs
// (infra/cdk-outputs.json) for the build role and the uploaded code artifact.
//
// Usage: node scripts/build-image.mjs
// Env:   AWS creds via the standard provider chain (use aws-sandbox-run).
//        CSMVM_REGION (default ap-northeast-1).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LambdaMicrovmsClient,
  CreateMicrovmImageCommand,
  UpdateMicrovmImageCommand,
  GetMicrovmImageBuildCommand,
  ListMicrovmImageBuildsCommand,
  ListMicrovmImageVersionsCommand,
} from "@aws-sdk/client-lambda-microvms";

const region = process.env["CSMVM_REGION"] ?? "ap-northeast-1";
const outputs = JSON.parse(readFileSync(join("infra", "cdk-outputs.json"), "utf8"));
const stack = outputs["CsmvmStack"];
const buildRoleArn = stack["BuildRoleArn"];
const baseImageArn = stack["BaseImageArn"];
const codeArtifactUri = stack["CodeArtifactUri"];
const name = "csmvm-code-server";
const imageArn = stack["ImageArn"];

const client = new LambdaMicrovmsClient({ region });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const buildInputs = {
  baseImageArn,
  buildRoleArn,
  description: "code-server on Lambda MicroVMs",
  codeArtifact: { uri: codeArtifactUri },
  resources: [{ minimumMemoryInMiB: 2048 }],
  hooks: {
    port: 9000,
    microvmHooks: {
      run: "ENABLED",
      runTimeoutInSeconds: 10,
      resume: "ENABLED",
      resumeTimeoutInSeconds: 10,
      suspend: "ENABLED",
      suspendTimeoutInSeconds: 10,
      terminate: "ENABLED",
      terminateTimeoutInSeconds: 10,
    },
    microvmImageHooks: {
      ready: "ENABLED",
      readyTimeoutInSeconds: 120,
      validate: "ENABLED",
      validateTimeoutInSeconds: 120,
    },
  },
  clientToken: `csmvm-build-${Date.now()}`,
};

/** Compare two version strings like "4.0"/"10.0" numerically, descending. */
function compareVersionsDesc(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** List all image versions via the API (no hardcoded version list). */
async function listVersions() {
  const versions = [];
  let nextToken;
  do {
    const page = await client.send(
      new ListMicrovmImageVersionsCommand({ imageIdentifier: imageArn, nextToken }),
    );
    for (const v of page.items ?? []) {
      if (v.imageVersion !== undefined) versions.push(v.imageVersion);
    }
    nextToken = page.nextToken;
  } while (nextToken !== undefined && nextToken !== "");
  versions.sort(compareVersionsDesc);
  return versions;
}

/** List every (version, buildId, createdAt) across the newest few versions. */
async function listAllBuilds() {
  const out = [];
  // Only the newest handful of versions can plausibly hold the build we just
  // triggered; scan a bounded window to keep this cheap.
  const versions = (await listVersions()).slice(0, 5);
  for (const version of versions) {
    let nextToken;
    do {
      const page = await client.send(
        new ListMicrovmImageBuildsCommand({
          imageIdentifier: imageArn,
          imageVersion: version,
          nextToken,
        }),
      );
      for (const b of page.items ?? []) {
        if (b.buildId !== undefined) {
          out.push({ version, buildId: b.buildId, createdAt: b.createdAt });
        }
      }
      nextToken = page.nextToken;
    } while (nextToken !== undefined && nextToken !== "");
  }
  return out;
}

const BUILD_KEY = (b) => `${b.version}#${b.buildId}`;

/**
 * Find the build this run just triggered. We never trust "newest in the list":
 * a freshly triggered build may not be visible yet, and the previous version's
 * build is already SUCCESSFUL — picking it would report a false BUILD_OK.
 * Instead we poll until a (version, buildId) pair appears that was NOT present
 * before the create/update call, and return exactly that build.
 */
async function waitForNewBuild(priorKeys, hintVersion, hintBuildId) {
  // Fast path: the create/update call told us the exact build.
  if (hintVersion !== undefined && hintBuildId !== undefined) {
    return { version: hintVersion, buildId: hintBuildId };
  }
  const findDeadline = Date.now() + 2 * 60 * 1000; // up to 2 min for it to appear
  for (;;) {
    const builds = await listAllBuilds();
    const fresh = builds.filter((b) => !priorKeys.has(BUILD_KEY(b)));
    if (fresh.length > 0) {
      // If several appeared, take the newest by createdAt.
      fresh.sort(
        (a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
      );
      return { version: fresh[0].version, buildId: fresh[0].buildId };
    }
    if (Date.now() > findDeadline) return null;
    await sleep(5000);
  }
}

// Snapshot existing builds BEFORE mutating, so we can identify the new one.
const priorBuilds = await listAllBuilds();
const priorKeys = new Set(priorBuilds.map(BUILD_KEY));

let hintVersion;
let hintBuildId;
try {
  console.log(`Creating MicroVM image "${name}" from ${codeArtifactUri}`);
  const created = await client.send(new CreateMicrovmImageCommand({ name, ...buildInputs }));
  hintVersion = created.imageVersion;
  hintBuildId = created.buildId;
} catch (e) {
  if (e.name === "ValidationException" && /already exists/.test(e.message ?? "")) {
    console.log("image exists; creating a new version via UpdateMicrovmImage");
    const updated = await client.send(
      new UpdateMicrovmImageCommand({ imageIdentifier: imageArn, ...buildInputs }),
    );
    hintVersion = updated.imageVersion;
    hintBuildId = updated.buildId;
  } else {
    throw e;
  }
}

const nb = await waitForNewBuild(priorKeys, hintVersion, hintBuildId);
if (!nb) {
  console.error("could not identify the newly triggered build to poll");
  process.exit(1);
}
console.log(`polling imageVersion=${nb.version} buildId=${nb.buildId}`);

const deadline = Date.now() + 20 * 60 * 1000;
let last = "";
for (;;) {
  const b = await client.send(
    new GetMicrovmImageBuildCommand({
      imageIdentifier: imageArn,
      imageVersion: nb.version,
      buildId: nb.buildId,
    }),
  );
  if (b.buildState !== last) {
    console.log(`  buildState=${b.buildState}${b.stateReason ? ` (${b.stateReason})` : ""}`);
    last = b.buildState;
  }
  if (
    ["SUCCESSFUL", "CREATED", "AVAILABLE", "ACTIVE", "COMPLETED", "COMPLETE"].includes(b.buildState)
  ) {
    console.log(`BUILD_OK imageArn=${imageArn} imageVersion=${nb.version} buildId=${nb.buildId}`);
    process.exit(0);
  }
  if (/FAIL/i.test(b.buildState ?? "")) {
    console.error(`BUILD_FAILED state=${b.buildState} reason=${b.stateReason ?? "(none)"}`);
    process.exit(1);
  }
  if (Date.now() > deadline) {
    console.error(`BUILD_TIMEOUT after 20 min; last state=${b.buildState}`);
    process.exit(1);
  }
  await sleep(10_000);
}
