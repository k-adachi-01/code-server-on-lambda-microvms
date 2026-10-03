// CDK stack for code-server-on-lambda-microvms (R14.1-R14.6, R13.2-R13.4).
// Persistent infrastructure only: the MicroVM image build inputs and the
// least-privilege IAM the operator attaches to their own role.
//
// This committed stack is PoC-Sandbox-AGNOSTIC (tech.md): it embeds no
// auto_delete/expires_at lifecycle or sandbox tags. Those tags are applied only
// when the deploy environment provides AUTO_DELETE / EXPIRES_AT (as the
// aws-sandbox-run runner does), so sandbox specifics live outside the repo.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Stack,
  type StackProps,
  CfnOutput,
  Tags,
  aws_lambda as lambda,
  aws_iam as iam,
  aws_s3_assets as s3assets,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface CsmvmStackProps extends StackProps {
  /** Add an Execution_Role + scoped iam:PassRole (Q-4). Default false. */
  withExecutionRole?: boolean;
}

export class CsmvmStack extends Stack {
  constructor(scope: Construct, id: string, props: CsmvmStackProps = {}) {
    super(scope, id, props);

    const region = Stack.of(this).region;
    const account = Stack.of(this).account;

    // 1. Build context: zip of ../image uploaded to S3 (Dockerfile + hooks).
    const asset = new s3assets.Asset(this, "ImageBuildContext", {
      path: path.join(__dirname, "..", "..", "image"),
    });

    // 2. Image_Build_Role: assumable ONLY by the MicroVMs build principal, with
    //    a confused-deputy guard, granted s3:GetObject on the asset object only.
    const buildRole = new iam.Role(this, "ImageBuildRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": account } },
      }),
      description: "code-server MicroVM image build role (s3:GetObject on the build asset only)",
    });
    asset.grantRead(buildRole);

    // 3. Image. NOTE (Phase 0 S1): building the image through CloudFormation
    //    fails — AWS::Lambda::MicrovmImage stabilization times out at ~60s,
    //    far shorter than a real Dockerfile build + snapshot, so CloudFormation
    //    rolls the image back. The image is therefore built via the direct
    //    create-microvm-image API with polling (scripts/build-image.mjs), not
    //    here. The CloudFormation image resource is kept behind an opt-in
    //    context flag only for reference/experimentation.
    //    The managed base image ARN is region-derived; confirmed in S1 as
    //    arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1.
    const baseImageArn = `arn:aws:lambda:${region}:aws:microvm-image:al2023-1`;
    if (this.node.tryGetContext("buildImageInCfn") === "true") {
      const image = new lambda.CfnMicrovmImage(this, "Image", {
        name: "csmvm-code-server",
        description: "code-server on Lambda MicroVMs",
        baseImageArn,
        baseImageVersion: "1",
        buildRoleArn: buildRole.roleArn,
        codeArtifact: { uri: asset.s3ObjectUrl },
        resources: [{ minimumMemoryInMiB: 2048 }],
        cpuConfigurations: [{ architecture: "ARM_64" }],
        additionalOsCapabilities: [],
        egressNetworkConnectors: [],
        environmentVariables: [],
        logging: { disabled: true },
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
      });
      image.node.addDependency(buildRole);
      new CfnOutput(this, "CfnImageRef", { value: image.ref });
    }

    // The image ARN name the operator policy and the build script use. The
    // build script creates the image with this exact name.
    const imageName = "csmvm-code-server";
    const imageArn = `arn:aws:lambda:${region}:${account}:microvm-image:${imageName}`;

    // Expose the inputs the API-driven build script needs.
    new CfnOutput(this, "BuildRoleArn", { value: buildRole.roleArn });
    new CfnOutput(this, "CodeArtifactUri", { value: asset.s3ObjectUrl });
    new CfnOutput(this, "BaseImageArn", { value: baseImageArn });

    // 4. Operator_Policy: the seven lambda:*Microvm* instance actions scoped to
    //    the Image ARN; ListMicrovms needs Resource:* (no resource-level
    //    scoping) and is isolated in its own allow-listed statement.
    const operatorPolicy = new iam.ManagedPolicy(this, "OperatorPolicy", {
      description: "code-server MicroVM operator policy (attach to your own role)",
      statements: [
        new iam.PolicyStatement({
          sid: "MicrovmInstanceActionsScopedToImage",
          actions: [
            "lambda:RunMicrovm",
            "lambda:GetMicrovm",
            "lambda:SuspendMicrovm",
            "lambda:ResumeMicrovm",
            "lambda:TerminateMicrovm",
            "lambda:CreateMicrovmAuthToken",
          ],
          resources: [imageArn, `${imageArn}:*`],
        }),
        new iam.PolicyStatement({
          sid: "ListMicrovmsRequiresWildcard",
          actions: ["lambda:ListMicrovms"],
          resources: ["*"],
        }),
      ],
    });

    // 5. Optional Execution_Role (Q-4): only when explicitly requested.
    if (props.withExecutionRole === true) {
      const execRole = new iam.Role(this, "ExecutionRole", {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com", {
          conditions: { StringEquals: { "aws:SourceAccount": account } },
        }),
        description: "code-server MicroVM execution role (log delivery only)",
      });
      execRole.addToPolicy(
        new iam.PolicyStatement({
          sid: "LogDelivery",
          actions: ["logs:CreateLogStream", "logs:PutLogEvents", "logs:CreateLogGroup"],
          resources: [`arn:aws:logs:${region}:${account}:*`],
        }),
      );
      operatorPolicy.addStatements(
        new iam.PolicyStatement({
          sid: "PassExecutionRole",
          actions: ["iam:PassRole"],
          resources: [execRole.roleArn],
          conditions: { StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } },
        }),
      );
      new CfnOutput(this, "ExecutionRoleArn", { value: execRole.roleArn });
    }

    // 6. Outputs for `csmvm config import`.
    new CfnOutput(this, "ImageArn", { value: imageArn });
    new CfnOutput(this, "Region", { value: region });
    new CfnOutput(this, "OperatorPolicyArn", { value: operatorPolicy.managedPolicyArn });

    // Env-driven sandbox lifecycle tags — applied ONLY when the deploy
    // environment supplies them (e.g. via aws-sandbox-run). The committed code
    // carries no sandbox specifics (tech.md).
    const autoDelete = process.env["AUTO_DELETE"];
    const expiresAt = process.env["EXPIRES_AT"];
    if (autoDelete !== undefined) Tags.of(this).add("auto_delete", autoDelete);
    if (expiresAt !== undefined) Tags.of(this).add("expires_at", expiresAt);
  }
}
