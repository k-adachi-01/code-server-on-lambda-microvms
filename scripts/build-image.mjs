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

let imageVersion;
try {
  console.log(`Creating MicroVM image "${name}" from ${codeArtifactUri}`);
  const created = await client.send(new CreateMicrovmImageCommand({ name, ...buildInputs }));
  imageVersion = created.imageVersion;
} catch (e) {
  if (e.name === "ValidationException" && /already exists/.test(e.message ?? "")) {
    console.log("image exists; creating a new version via UpdateMicrovmImage");
    const updated = await client.send(
      new UpdateMicrovmImageCommand({ imageIdentifier: imageArn, ...buildInputs }),
    );
    // Trust the version the service just created; only fall back to discovery
    // if the response omits it.
    imageVersion = updated.imageVersion;
  } else {
    throw e;
  }
}

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

/** Discover the newest image version via the API (no hardcoded version list). */
async function discoverNewestVersion() {
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
  if (versions.length === 0) return undefined;
  versions.sort(compareVersionsDesc);
  return versions[0];
}

// Find the newest build for the target version and poll it.
async function newestBuild() {
  // Prefer the version the create/update call returned; otherwise ask the API
  // for the newest version rather than guessing from a fixed list.
  const version = imageVersion ?? (await discoverNewestVersion());
  if (version === undefined) return null;
  const builds = await client.send(
    new ListMicrovmImageBuildsCommand({ imageIdentifier: imageArn, imageVersion: version }),
  );
  const items = builds.items ?? [];
  if (items.length === 0) return null;
  // newest createdAt
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return { imageVersion: version, buildId: items[0].buildId };
}

// Give the service a moment to register the new build.
await sleep(5000);
const nb = await newestBuild();
if (!nb) {
  console.error("could not find a build to poll");
  process.exit(1);
}
console.log(`polling imageVersion=${nb.imageVersion} buildId=${nb.buildId}`);

const deadline = Date.now() + 20 * 60 * 1000;
let last = "";
for (;;) {
  const b = await client.send(
    new GetMicrovmImageBuildCommand({
      imageIdentifier: imageArn,
      imageVersion: nb.imageVersion,
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
    console.log(`BUILD_OK imageArn=${imageArn} imageVersion=${nb.imageVersion}`);
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
