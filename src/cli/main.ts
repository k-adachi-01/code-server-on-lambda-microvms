#!/usr/bin/env node
// csmvm CLI entry (R9.8, R10.x, R11.3). Thin commander wiring over the effect
// interpreter. Exit codes: 0 success/cancel/already-terminated, 1 AWS/runtime,
// 2 validation/lifecycle rejection.

import { Command } from "commander";
import { buildDeps } from "./deps.js";
import { configImport } from "./config-import.js";
import { runCommand, terminateStray } from "../shell/interpreter.js";

async function main(): Promise<number> {
  const program = new Command();
  program
    .name("csmvm")
    .description("Run code-server in a single AWS Lambda MicroVM")
    .allowExcessArguments(false);

  let exitCode = 0;

  program
    .command("status")
    .description("Print the reconciled session; never mutates")
    .action(async () => {
      exitCode = (await runCommand("status", buildDeps({ assumeYes: false }))).exitCode;
    });

  program
    .command("launch")
    .description("Launch one MicroVM")
    .option("--yes", "skip the confirmation prompt", false)
    .action(async (opts: { yes: boolean }) => {
      exitCode = (await runCommand("launch", buildDeps({ assumeYes: opts.yes }))).exitCode;
    });

  program
    .command("suspend")
    .description("Suspend the running MicroVM")
    .action(async () => {
      exitCode = (await runCommand("suspend", buildDeps({ assumeYes: false }))).exitCode;
    });

  program
    .command("resume")
    .description("Resume the suspended MicroVM")
    .action(async () => {
      exitCode = (await runCommand("resume", buildDeps({ assumeYes: false }))).exitCode;
    });

  program
    .command("terminate")
    .description("Terminate the MicroVM")
    .option("--yes", "skip the confirmation prompt", false)
    .option("--stray <id>", "terminate an orphaned MicroVM on the project image")
    .action(async (opts: { yes: boolean; stray?: string }) => {
      const deps = buildDeps({ assumeYes: opts.yes });
      exitCode =
        opts.stray !== undefined
          ? (await terminateStray(opts.stray, deps)).exitCode
          : (await runCommand("terminate", deps)).exitCode;
    });

  program
    .command("connect")
    .description("Run the localhost Auth_Proxy and print a one-time login URL")
    .action(() => {
      // The Auth_Proxy ships in a dedicated module (task 10); connect requires a
      // RUNNING session and runs the proxy in the foreground. Placeholder until
      // the proxy is wired.
      process.stderr.write("connect: not yet available in this build\n");
      exitCode = 1;
    });

  program
    .command("config")
    .description("Config helpers")
    .command("import")
    .description("Fill csmvm.config.json from infra/cdk-outputs.json")
    .action(() => {
      const res = configImport();
      process.stdout.write(`${res.message}\n`);
      exitCode = res.ok ? 0 : 2;
    });

  await program.parseAsync(process.argv);
  return exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`csmvm: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
