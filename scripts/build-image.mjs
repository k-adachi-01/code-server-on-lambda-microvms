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
    await client.send(new UpdateMicrovmImageCommand({ imageIdentifier: imageArn, ...buildInputs }));
    imageVersion = undefined; // discovered below from the newest build
  } else {
    throw e;
  }
}

// Find the newest build (highest version) and poll it.
async function newestBuild() {
  // Try the known version first, else list across versions by probing.
  const versions = imageVersion ? [imageVersion] : ["3.0", "2.0", "1.0"];
  for (const v of versions) {
    try {
      const builds = await client.send(
        new ListMicrovmImageBuildsCommand({ imageIdentifier: imageArn, imageVersion: v }),
      );
      const items = builds.items ?? [];
      if (items.length > 0) {
        // newest createdAt
        items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        return { imageVersion: v, buildId: items[0].buildId };
      }
    } catch {
      /* version may not exist; try next */
    }
  }
  return null;
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
