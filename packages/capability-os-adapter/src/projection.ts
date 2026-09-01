import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { CapabilityRecord, CapabilityVaultSnapshot } from "./index.js";

export interface ProjectionRecord {
  id: string;
  type: string;
  sourcePath: string;
  projectedPath: string;
  contentHash: string;
}

export interface ProjectionManifest {
  kind: "capability-os-projection";
  version: 1;
  sourceHash: string;
  records: ProjectionRecord[];
}

function isPathWithin(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function safeSegment(value: string): string {
  return (
    [...value.normalize("NFKC")]
      .map((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 32 || '<>:"/\\|?*'.includes(character) ? "-" : character;
      })
      .join("")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "object"
  );
}

function projectionPathFor(record: CapabilityRecord): string {
  const id = safeSegment(record.id ?? record.contentHash.slice(0, 16));
  return path.posix.join(record.type ?? "unknown", `${id}-${record.contentHash.slice(0, 10)}.md`);
}

function renderProjection(record: CapabilityRecord): string {
  const relationLines = record.relations.map((relation) => `- ${relation.kind}: [[${relation.target}]]`);
  const body = [
    `# ${record.title}`,
    "",
    "> [!info] Derived Capability OS projection",
    `> Canonical source: \`${record.relativePath}\` · object: \`${record.id}\` · type: \`${record.type}\``,
    "",
    "## Canonical content",
    "",
    record.body.trim(),
    ...(relationLines.length ? ["", "## Typed relations", "", ...relationLines] : []),
    ""
  ].join("\n");

  const frontmatter: Record<string, unknown> = {
    title: record.title,
    capability_os_id: record.id,
    capability_os_type: record.type,
    capability_os_status: record.frontmatter.status,
    capability_os_source_path: record.relativePath,
    capability_os_source_hash: record.contentHash,
    tags: [`capability-os/${record.type}`, "capability-os/searchable"]
  };
  if (typeof record.frontmatter.ingest_status === "string") {
    frontmatter.capability_os_ingest_status = record.frontmatter.ingest_status;
  }
  return matter.stringify(body, frontmatter);
}

async function assertManagedProjection(target: string): Promise<void> {
  const entries = await fs.readdir(target).catch(() => []);
  if (!entries.length) return;
  const raw = await fs.readFile(path.join(target, ".capability-os-projection.json"), "utf8").catch(() => null);
  if (!raw) throw new Error(`Refusing to replace an unmarked projection directory: ${target}`);
  const parsed = JSON.parse(raw) as Partial<ProjectionManifest>;
  if (parsed.kind !== "capability-os-projection" || parsed.version !== 1) {
    throw new Error(`Refusing to replace a projection directory with an unknown marker: ${target}`);
  }
}

export async function writeSearchableProjection(snapshot: CapabilityVaultSnapshot, outputDir: string): Promise<ProjectionManifest> {
  const target = path.resolve(outputDir);
  if (isPathWithin(snapshot.vaultRoot, target)) {
    throw new Error("Derived Capability OS projections must be written outside the canonical Vault.");
  }

  await assertManagedProjection(target);
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });

  const projected: ProjectionRecord[] = [];
  for (const record of snapshot.records) {
    if (record.admission.lane !== "searchable" || !record.id || !record.type) continue;
    const projectedPath = projectionPathFor(record);
    const absolutePath = path.join(target, projectedPath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, renderProjection(record), "utf8");
    projected.push({
      id: record.id,
      type: record.type,
      sourcePath: record.relativePath,
      projectedPath,
      contentHash: record.contentHash
    });
  }

  const manifest: ProjectionManifest = {
    kind: "capability-os-projection",
    version: 1,
    sourceHash: snapshot.sourceHash,
    records: projected.sort((left, right) => left.projectedPath.localeCompare(right.projectedPath))
  };
  await fs.writeFile(path.join(target, ".capability-os-projection.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}
