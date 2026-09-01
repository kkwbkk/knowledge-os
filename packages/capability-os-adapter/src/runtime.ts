import fs from "node:fs/promises";
import path from "node:path";
import { compileVault, ingestDirectory, initVault, type SearchResult, searchVault } from "@swarmvaultai/engine";
import { type ScanCapabilityVaultOptions, scanCapabilityVault } from "./index.js";
import { writeSearchableProjection } from "./projection.js";

export interface RebuildCapabilityRuntimeOptions extends ScanCapabilityVaultOptions {
  runtimeRoot: string;
  query?: string;
  queryLimit?: number;
}

export interface RebuildCapabilityRuntimeResult {
  runtimeRoot: string;
  sourceHash: string;
  scannedObjects: number;
  searchableObjects: number;
  reviewOnlyObjects: number;
  excludedObjects: number;
  invalidObjects: number;
  projectedObjects: number;
  ingestedObjects: number;
  compiledPages: number;
  queryResults: SearchResult[];
}

interface RuntimeMarker {
  kind: "capability-os-runtime";
  version: 1;
}

const marker: RuntimeMarker = { kind: "capability-os-runtime", version: 1 };

function isPathWithin(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

async function assertManagedRuntime(runtimeRoot: string): Promise<void> {
  const entries = await fs.readdir(runtimeRoot).catch(() => []);
  if (!entries.length) return;
  const markerPath = path.join(runtimeRoot, ".capability-os-runtime.json");
  const raw = await fs.readFile(markerPath, "utf8").catch(() => null);
  if (!raw) throw new Error(`Refusing to rebuild an unmarked runtime directory: ${runtimeRoot}`);
  const parsed = JSON.parse(raw) as Partial<RuntimeMarker>;
  if (parsed.kind !== marker.kind || parsed.version !== marker.version) {
    throw new Error(`Refusing to rebuild a runtime directory with an unknown marker: ${runtimeRoot}`);
  }
}

async function configureDeterministicRuntime(swarmRoot: string): Promise<void> {
  const configPath = path.join(swarmRoot, "swarmvault.config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  config.benchmark = { enabled: false, questions: [], maxQuestions: 3 };
  config.graph = { deterministicCommunities: true };
  config.retrieval = { backend: "sqlite", shardSize: 25000, hybrid: false, rerank: false };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function rebuildCapabilityRuntime(options: RebuildCapabilityRuntimeOptions): Promise<RebuildCapabilityRuntimeResult> {
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const vaultRoot = path.resolve(options.vaultRoot);
  if (isPathWithin(vaultRoot, runtimeRoot)) {
    throw new Error("Capability OS runtime must live outside the canonical Vault.");
  }
  await assertManagedRuntime(runtimeRoot);
  await fs.mkdir(runtimeRoot, { recursive: true });
  await fs.writeFile(path.join(runtimeRoot, ".capability-os-runtime.json"), `${JSON.stringify(marker, null, 2)}\n`, "utf8");

  const projectionRoot = path.join(runtimeRoot, "projection");
  const swarmRoot = path.join(runtimeRoot, "swarmvault");
  await fs.rm(swarmRoot, { recursive: true, force: true });

  const snapshot = await scanCapabilityVault(options);
  if (snapshot.issues.length) {
    throw new Error(`Capability OS scan found ${snapshot.issues.length} contract issue(s); runtime rebuild aborted.`);
  }
  const projection = await writeSearchableProjection(snapshot, projectionRoot);

  await initVault(swarmRoot);
  await configureDeterministicRuntime(swarmRoot);
  const ingest = await ingestDirectory(swarmRoot, projectionRoot, {
    repoRoot: projectionRoot,
    include: ["**/*.md"],
    gitignore: false,
    swarmvaultignore: false,
    redact: false
  });
  if (ingest.failed?.length) {
    throw new Error(`SwarmVault ingestion failed for ${ingest.failed.length} projected object(s).`);
  }
  const compile = await compileVault(swarmRoot);
  const queryResults = options.query ? await searchVault(swarmRoot, options.query, options.queryLimit ?? 5) : [];

  return {
    runtimeRoot,
    sourceHash: snapshot.sourceHash,
    scannedObjects: snapshot.stats.markdownFiles,
    searchableObjects: snapshot.stats.searchableObjects,
    reviewOnlyObjects: snapshot.stats.reviewOnlyObjects,
    excludedObjects: snapshot.stats.excludedObjects,
    invalidObjects: snapshot.stats.invalidObjects,
    projectedObjects: projection.records.length,
    ingestedObjects: ingest.imported.length + ingest.updated.length,
    compiledPages: compile.pageCount,
    queryResults
  };
}
