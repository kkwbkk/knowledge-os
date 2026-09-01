#!/usr/bin/env node

import path from "node:path";
import { scanCapabilityVault } from "./index.js";

interface CliOptions {
  vaultRoot: string;
  scopePath?: string;
  schemaPath?: string;
  includeTemplates: boolean;
}

function usage(): string {
  return [
    "Usage: capability-os-scan --vault <path> [--scope <relative-path>] [--schema <path>] [--include-templates]",
    "",
    "Performs a read-only scan and prints metadata statistics. It never writes to the Vault and never prints note bodies."
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  let vaultRoot: string | undefined;
  let scopePath: string | undefined;
  let schemaPath: string | undefined;
  let includeTemplates = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === "--include-templates") {
      includeTemplates = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${arg}.`);
    if (arg === "--vault") vaultRoot = value;
    else if (arg === "--scope") scopePath = value;
    else if (arg === "--schema") schemaPath = value;
    else throw new Error(`Unknown option: ${arg}.`);
    index += 1;
  }

  if (!vaultRoot) throw new Error("--vault is required.");
  return {
    vaultRoot: path.resolve(vaultRoot),
    scopePath,
    schemaPath: schemaPath ? path.resolve(schemaPath) : undefined,
    includeTemplates
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const snapshot = await scanCapabilityVault({
    vaultRoot: options.vaultRoot,
    scopePath: options.scopePath,
    schemaPath: options.schemaPath,
    excludedDirectoryNames: options.includeTemplates ? [] : undefined
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        snapshotVersion: snapshot.snapshotVersion,
        schemaVersion: snapshot.schemaVersion,
        scopePath: snapshot.scopePath,
        sourceHash: snapshot.sourceHash,
        stats: snapshot.stats,
        issues: snapshot.issues
      },
      null,
      2
    )}\n`
  );
  if (snapshot.issues.length) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
  process.exitCode = 1;
});
