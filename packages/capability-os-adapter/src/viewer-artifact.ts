import fs from "node:fs/promises";
import path from "node:path";
import {
  type AdapterIssue,
  type AdmissionLane,
  CAPABILITY_OS_OBJECT_TYPES,
  type CapabilityObjectType,
  type CapabilityRecord,
  type CapabilityVaultSnapshot
} from "./index.js";

export const CAPABILITY_OS_VIEWER_ARTIFACT = "capability-os.json";

export interface CapabilityViewerRelation {
  field: string;
  kind: string;
  target: string;
  targetId?: string;
  targetTitle?: string;
  targetPath?: string;
}

export interface CapabilityViewerRecord {
  id: string;
  type: CapabilityObjectType | "unknown";
  title: string;
  sourcePath: string;
  canonicalPath: string;
  obsidianUri: string;
  lifecycleStatus?: string;
  ingestStatus?: string;
  visibility?: string;
  updatedAt?: string;
  admission: AdmissionLane;
  admissionReason: string;
  relations: CapabilityViewerRelation[];
  issues: Array<Pick<AdapterIssue, "code" | "field" | "message">>;
}

export interface CapabilityViewerArtifact {
  kind: "capability-os-viewer";
  version: 1;
  generatedAt: string;
  sourceHash: string;
  canonicalAuthority: "obsidian-vault";
  derived: true;
  vaultName: string;
  scopePath: string;
  objectTypes: readonly CapabilityObjectType[];
  admissionLanes: readonly AdmissionLane[];
  stats: CapabilityVaultSnapshot["stats"];
  records: CapabilityViewerRecord[];
}

function stringField(record: CapabilityRecord, field: string): string | undefined {
  const value = record.frontmatter[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function withoutMarkdownExtension(value: string): string {
  return value.replace(/\.md$/i, "");
}

function normalizedLookupKey(value: string): string {
  return withoutMarkdownExtension(value)
    .replace(/^\/+/, "")
    .replace(/^能力操作系统\//, "")
    .trim()
    .toLocaleLowerCase();
}

function resolverFor(records: readonly CapabilityRecord[]): (target: string) => CapabilityRecord | undefined {
  const candidates = new Map<string, CapabilityRecord[]>();
  const add = (key: string, record: CapabilityRecord) => {
    const normalized = normalizedLookupKey(key);
    if (!normalized) return;
    const current = candidates.get(normalized) ?? [];
    if (!current.includes(record)) current.push(record);
    candidates.set(normalized, current);
  };

  for (const record of records) {
    if (record.id) add(record.id, record);
    add(record.title, record);
    add(record.relativePath, record);
    add(path.posix.basename(record.relativePath), record);
  }

  return (target: string) => {
    const matches = candidates.get(normalizedLookupKey(target)) ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  };
}

function obsidianUri(vaultName: string, canonicalPath: string): string {
  const params = new URLSearchParams({
    vault: vaultName,
    file: withoutMarkdownExtension(canonicalPath)
  });
  return `obsidian://open?${params.toString()}`;
}

export function buildCapabilityViewerArtifact(
  snapshot: CapabilityVaultSnapshot,
  generatedAt = new Date().toISOString()
): CapabilityViewerArtifact {
  const vaultName = path.basename(snapshot.vaultRoot);
  const resolveTarget = resolverFor(snapshot.records);
  const records = snapshot.records.map((record) => {
    const canonicalPath = path.posix.join(snapshot.scopePath, record.relativePath);
    const fallbackId = `invalid:${record.contentHash.slice(0, 16)}`;
    return {
      id: record.id ?? fallbackId,
      type: record.type ?? "unknown",
      title: record.title,
      sourcePath: record.relativePath,
      canonicalPath,
      obsidianUri: obsidianUri(vaultName, canonicalPath),
      lifecycleStatus: stringField(record, "status"),
      ingestStatus: stringField(record, "ingest_status"),
      visibility: stringField(record, "visibility"),
      updatedAt: stringField(record, "updated"),
      admission: record.admission.lane,
      admissionReason: record.admission.reason,
      relations: record.relations.map((relation) => {
        const target = resolveTarget(relation.target);
        return {
          ...relation,
          targetId: target?.id ?? undefined,
          targetTitle: target?.title,
          targetPath: target?.relativePath
        };
      }),
      issues: record.issues.map(({ code, field, message }) => ({ code, field, message }))
    } satisfies CapabilityViewerRecord;
  });

  return {
    kind: "capability-os-viewer",
    version: 1,
    generatedAt,
    sourceHash: snapshot.sourceHash,
    canonicalAuthority: "obsidian-vault",
    derived: true,
    vaultName,
    scopePath: snapshot.scopePath,
    objectTypes: CAPABILITY_OS_OBJECT_TYPES,
    admissionLanes: ["searchable", "review-only", "excluded", "invalid"],
    stats: snapshot.stats,
    records: records.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))
  };
}

export async function writeCapabilityViewerArtifact(
  snapshot: CapabilityVaultSnapshot,
  swarmRoot: string
): Promise<{ artifact: CapabilityViewerArtifact; artifactPath: string }> {
  const artifact = buildCapabilityViewerArtifact(snapshot);
  const artifactPath = path.join(path.resolve(swarmRoot), "state", CAPABILITY_OS_VIEWER_ARTIFACT);
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return { artifact, artifactPath };
}
