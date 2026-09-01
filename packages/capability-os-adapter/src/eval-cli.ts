#!/usr/bin/env node

import path from "node:path";
import { evaluateGoldenQuestions } from "./golden-eval.js";

interface CliOptions {
  vaultRoot: string;
  runtimeRoot: string;
  scopePath?: string;
  schemaPath?: string;
  questionSetPath?: string;
  expectedQuestionCount?: number;
  topK?: number;
}

function usage(): string {
  return [
    "Usage: capability-os-eval --vault <path> --runtime <path> [--questions <path>] [--scope <relative-path>] [--schema <path>] [--expected-count <n>] [--top-k <n>]",
    "",
    "Runs the private golden-question set against an existing isolated runtime. CLI output contains summary metrics only."
  ].join("\n");
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer.`);
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${arg}.`);
    values[arg] = value;
  }
  if (!values["--vault"] || !values["--runtime"]) throw new Error("--vault and --runtime are required.");
  return {
    vaultRoot: path.resolve(values["--vault"]),
    runtimeRoot: path.resolve(values["--runtime"]),
    scopePath: values["--scope"],
    schemaPath: values["--schema"] ? path.resolve(values["--schema"]) : undefined,
    questionSetPath: values["--questions"] ? path.resolve(values["--questions"]) : undefined,
    expectedQuestionCount: values["--expected-count"] ? positiveInteger(values["--expected-count"], "--expected-count") : undefined,
    topK: values["--top-k"] ? positiveInteger(values["--top-k"], "--top-k") : undefined
  };
}

async function main(): Promise<void> {
  const report = await evaluateGoldenQuestions(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
  if (!report.summary.automatedGatePassed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
  process.exitCode = 1;
});
