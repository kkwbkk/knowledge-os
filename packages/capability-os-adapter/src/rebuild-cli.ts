#!/usr/bin/env node

import path from "node:path";
import { rebuildCapabilityRuntime } from "./runtime.js";

interface CliOptions {
  vaultRoot: string;
  runtimeRoot: string;
  scopePath?: string;
  schemaPath?: string;
  query?: string;
}

function usage(): string {
  return [
    "Usage: capability-os-rebuild --vault <path> --runtime <path> [--scope <relative-path>] [--schema <path>] [--query <text>]",
    "",
    "Rebuilds an isolated SwarmVault runtime. The runtime must be outside the canonical Vault."
  ].join("\n");
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
  if (!values["--vault"] || !values["--runtime"]) {
    throw new Error("--vault and --runtime are required.");
  }
  return {
    vaultRoot: path.resolve(values["--vault"]),
    runtimeRoot: path.resolve(values["--runtime"]),
    scopePath: values["--scope"],
    schemaPath: values["--schema"] ? path.resolve(values["--schema"]) : undefined,
    query: values["--query"]
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await rebuildCapabilityRuntime(options);
  process.stdout.write(
    `${JSON.stringify(
      {
        ...result,
        queryResults: result.queryResults.map((entry) => ({
          pageId: entry.pageId,
          path: entry.path,
          title: entry.title,
          rank: entry.rank
        }))
      },
      null,
      2
    )}\n`
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
  process.exitCode = 1;
});
