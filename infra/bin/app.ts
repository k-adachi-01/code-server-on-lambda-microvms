#!/usr/bin/env node
// CDK app entry. One stack: CsmvmStack. Region/account come from the standard
// CDK environment (CDK_DEFAULT_REGION / CDK_DEFAULT_ACCOUNT). withExecutionRole
// is read from CDK context (-c withExecutionRole=true), default false (Q-4).

import { App } from "aws-cdk-lib";
import { CsmvmStack } from "../lib/stack.js";

const app = new App();

const withExecutionRole = app.node.tryGetContext("withExecutionRole") === "true";
const region = process.env["CDK_DEFAULT_REGION"] ?? "ap-northeast-1";
const account = process.env["CDK_DEFAULT_ACCOUNT"];

new CsmvmStack(app, "CsmvmStack", {
  withExecutionRole,
  env: { region, ...(account !== undefined ? { account } : {}) },
});

app.synth();
