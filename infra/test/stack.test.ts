import { describe, expect, it } from "vite-plus/test";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { CsmvmStack } from "../lib/stack.js";

const ENV = { env: { account: "123456789012", region: "ap-northeast-1" } };

function synth(withExecutionRole = false): Template {
  const app = new App();
  const stack = new CsmvmStack(app, "TestStack", { ...ENV, withExecutionRole });
  return Template.fromStack(stack);
}

const ALLOWED_TYPES = new Set([
  "AWS::IAM::Role",
  "AWS::IAM::Policy",
  "AWS::IAM::ManagedPolicy",
  "AWS::Lambda::MicrovmImage",
  "AWS::CDK::Metadata",
]);

describe("CsmvmStack", () => {
  it("creates only allowed resource types", () => {
    const t = synth();
    const resources = t.toJSON().Resources as Record<string, { Type: string }>;
    for (const [logicalId, res] of Object.entries(resources)) {
      expect(ALLOWED_TYPES.has(res.Type), `${logicalId} is ${res.Type}`).toBe(true);
    }
  });

  it("builds the MicroVM image with the 2 GB baseline and a build role", () => {
    const t = synth();
    const image = Object.values(t.findResources("AWS::Lambda::MicrovmImage"))[0];
    // CDK L1 renders these as PascalCase CloudFormation keys.
    const props = image?.Properties as {
      Name: string;
      Resources: { MinimumMemoryInMiB: number }[];
      BuildRoleArn: unknown;
      BaseImageArn: string;
    };
    expect(props.Name).toBe("csmvm-code-server");
    expect(props.Resources[0]?.MinimumMemoryInMiB).toBe(2048);
    expect(props.BuildRoleArn).toBeDefined();
    expect(props.BaseImageArn).toBe("arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1");
  });

  it("trusts only lambda.amazonaws.com for the build role, with aws:SourceAccount", () => {
    const t = synth();
    t.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sts:AssumeRole",
            Principal: { Service: "lambda.amazonaws.com" },
            Condition: { StringEquals: { "aws:SourceAccount": "123456789012" } },
          }),
        ]),
      },
    });
  });

  it("the operator policy has exactly the scoped instance actions + wildcard ListMicrovms", () => {
    const t = synth();
    const policies = t.findResources("AWS::IAM::ManagedPolicy");
    const doc = Object.values(policies)[0]?.Properties?.PolicyDocument as {
      Statement: { Sid: string; Action: string[] | string; Resource: unknown }[];
    };
    const scoped = doc.Statement.find((s) => s.Sid === "MicrovmInstanceActionsScopedToImage");
    expect(scoped).toBeDefined();
    expect(scoped?.Action).toEqual([
      "lambda:RunMicrovm",
      "lambda:GetMicrovm",
      "lambda:SuspendMicrovm",
      "lambda:ResumeMicrovm",
      "lambda:TerminateMicrovm",
      "lambda:CreateMicrovmAuthToken",
    ]);
    // Scoped statement must NOT use Resource "*".
    expect(JSON.stringify(scoped?.Resource)).not.toBe('"*"');

    const list = doc.Statement.find((s) => s.Sid === "ListMicrovmsRequiresWildcard");
    expect(list).toBeDefined();
    expect(list?.Action).toBe("lambda:ListMicrovms");
    expect(list?.Resource).toBe("*");
  });

  it("every wildcard Resource:* carries an allow-listed Sid", () => {
    const t = synth(true);
    const policies = {
      ...t.findResources("AWS::IAM::ManagedPolicy"),
      ...t.findResources("AWS::IAM::Policy"),
    };
    const ALLOWED_WILDCARD_SIDS = new Set(["ListMicrovmsRequiresWildcard"]);
    for (const res of Object.values(policies)) {
      const doc = res.Properties?.PolicyDocument as {
        Statement: { Sid?: string; Resource: unknown }[];
      };
      for (const stmt of doc.Statement) {
        const r = stmt.Resource;
        const isWildcard = r === "*" || (Array.isArray(r) && r.includes("*"));
        if (isWildcard) {
          expect(
            stmt.Sid !== undefined && ALLOWED_WILDCARD_SIDS.has(stmt.Sid),
            `wildcard without allow-listed Sid: ${JSON.stringify(stmt)}`,
          ).toBe(true);
        }
      }
    }
  });

  it("adds an Execution_Role + scoped iam:PassRole only when requested", () => {
    const without = synth(false);
    expect(Object.keys(without.findResources("AWS::IAM::Role")).length).toBe(1); // build role only

    const withRole = synth(true);
    expect(Object.keys(withRole.findResources("AWS::IAM::Role")).length).toBe(2);
    const policies = withRole.findResources("AWS::IAM::ManagedPolicy");
    const doc = Object.values(policies)[0]?.Properties?.PolicyDocument as {
      Statement: { Sid?: string; Action?: string }[];
    };
    const pass = doc.Statement.find((s) => s.Sid === "PassExecutionRole");
    expect(pass?.Action).toBe("iam:PassRole");
  });

  it("exposes ImageArn, Region, and OperatorPolicyArn outputs", () => {
    const outputs = synth().toJSON().Outputs as Record<string, unknown>;
    const names = Object.keys(outputs);
    expect(names).toContain("ImageArn");
    expect(names).toContain("Region");
    expect(names).toContain("OperatorPolicyArn");
  });

  it("adds no sandbox lifecycle tags by default (PoC-agnostic committed code)", () => {
    const t = synth();
    const image = Object.values(t.findResources("AWS::Lambda::MicrovmImage"))[0];
    const tags = (image?.Properties?.Tags as { Key: string }[] | undefined) ?? [];
    expect(tags.some((tag) => tag.Key === "auto_delete")).toBe(false);
    expect(tags.some((tag) => tag.Key === "expires_at")).toBe(false);
  });
});
