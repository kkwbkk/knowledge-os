import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import YAML from "yaml";

export const CAPABILITY_OS_OBJECT_TYPES = [
  "source",
  "learning",
  "knowledge",
  "playbook",
  "topic",
  "artifact",
  "project",
  "application",
  "capability",
  "evidence",
  "review",
  "feedback",
  "system"
] as const;

export const DEFAULT_INGEST_CONTROLLED_TYPES = ["source", "learning", "knowledge", "playbook", "artifact"] as const;

export type CapabilityObjectType = (typeof CAPABILITY_OS_OBJECT_TYPES)[number];
export type IngestStatus = "raw" | "pending" | "accepted" | "rejected";
export type AdmissionLane = "searchable" | "review-only" | "excluded" | "invalid";

export interface CapabilitySchema {
  schemaVersion: string;
  objectTypes: readonly CapabilityObjectType[];
  lifecycleStatus: ReadonlySet<string>;
  ingestStatus: ReadonlySet<IngestStatus>;
  visibility: ReadonlySet<string>;
  requiredCommon: readonly string[];
  ingestControlledTypes: ReadonlySet<CapabilityObjectType>;
  relationFields: Readonly<Record<string, string>>;
}

export interface AdapterIssue {
  code:
    | "duplicate-id"
    | "frontmatter-parse-error"
    | "invalid-ingest-status"
    | "invalid-lifecycle-status"
    | "invalid-visibility"
    | "missing-ingest-status"
    | "missing-required-field"
    | "unknown-object-type";
  message: string;
  path: string;
  field?: string;
}

export interface CapabilityRelation {
  field: string;
  kind: string;
  target: string;
}

export interface AdmissionDecision {
  lane: AdmissionLane;
  reason: string;
}

export interface CapabilityRecord {
  id: string | null;
  type: CapabilityObjectType | null;
  title: string;
  relativePath: string;
  contentHash: string;
  frontmatter: Record<string, unknown>;
  body: string;
  wikilinks: string[];
  relations: CapabilityRelation[];
  admission: AdmissionDecision;
  issues: AdapterIssue[];
}

export interface CapabilitySnapshotStats {
  markdownFiles: number;
  validObjects: number;
  invalidObjects: number;
  searchableObjects: number;
  reviewOnlyObjects: number;
  excludedObjects: number;
  byType: Record<string, number>;
  byAdmission: Record<AdmissionLane, number>;
}

export interface CapabilityVaultSnapshot {
  snapshotVersion: "1.0";
  schemaVersion: string;
  vaultRoot: string;
  scopePath: string;
  sourceHash: string;
  records: CapabilityRecord[];
  issues: AdapterIssue[];
  stats: CapabilitySnapshotStats;
}

export interface ScanCapabilityVaultOptions {
  vaultRoot: string;
  scopePath?: string;
  schemaPath?: string;
  excludedDirectoryNames?: readonly string[];
}

const DEFAULT_SCOPE_PATH = "能力操作系统";
const DEFAULT_EXCLUDED_DIRECTORY_NAMES = ["模板"] as const;
const OBJECT_TYPE_SET = new Set<string>(CAPABILITY_OS_OBJECT_TYPES);

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function isPathWithin(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`Capability OS schema field ${field} must be a non-empty string array.`);
  }
  return value.map((entry) => entry.trim());
}

function requireStringRecord(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Capability OS schema field ${field} must be a string map.`);
  }
  const entries = Object.entries(value);
  if (entries.some(([key, entry]) => !key.trim() || typeof entry !== "string" || !entry.trim())) {
    throw new Error(`Capability OS schema field ${field} must be a string map.`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function assertExactObjectTypes(objectTypes: readonly string[]): asserts objectTypes is readonly CapabilityObjectType[] {
  const actual = new Set(objectTypes);
  const missing = CAPABILITY_OS_OBJECT_TYPES.filter((type) => !actual.has(type));
  const unexpected = objectTypes.filter((type) => !OBJECT_TYPE_SET.has(type));
  if (missing.length || unexpected.length || actual.size !== CAPABILITY_OS_OBJECT_TYPES.length) {
    throw new Error(
      `Capability OS object type contract drifted. Missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}.`
    );
  }
}

export async function loadCapabilitySchema(schemaPath: string): Promise<CapabilitySchema> {
  const raw = await fs.readFile(path.resolve(schemaPath), "utf8");
  const parsed = YAML.parse(raw) as Record<string, unknown>;
  const objectTypes = requireStringArray(parsed.object_types, "object_types");
  assertExactObjectTypes(objectTypes);

  const ingestStatuses = requireStringArray(parsed.ingest_status, "ingest_status");
  const knownIngestStatuses = new Set<IngestStatus>(["raw", "pending", "accepted", "rejected"]);
  if (ingestStatuses.some((status) => !knownIngestStatuses.has(status as IngestStatus))) {
    throw new Error("Capability OS schema contains an unsupported ingest_status value.");
  }

  const controlledTypes = requireStringArray(parsed.ingest_controlled_types, "ingest_controlled_types");
  if (controlledTypes.some((type) => !OBJECT_TYPE_SET.has(type))) {
    throw new Error("Capability OS schema contains an unknown ingest-controlled object type.");
  }
  const controlledTypeSet = new Set(controlledTypes);
  const missingControlledTypes = DEFAULT_INGEST_CONTROLLED_TYPES.filter((type) => !controlledTypeSet.has(type));
  const unexpectedControlledTypes = controlledTypes.filter(
    (type) => !(DEFAULT_INGEST_CONTROLLED_TYPES as readonly string[]).includes(type)
  );
  if (missingControlledTypes.length || unexpectedControlledTypes.length) {
    throw new Error(
      `Capability OS ingest-controlled contract drifted. Missing: ${missingControlledTypes.join(", ") || "none"}; unexpected: ${unexpectedControlledTypes.join(", ") || "none"}.`
    );
  }

  return {
    schemaVersion: String(parsed.schema_version ?? "unknown"),
    objectTypes,
    lifecycleStatus: new Set(requireStringArray(parsed.lifecycle_status, "lifecycle_status")),
    ingestStatus: new Set(ingestStatuses as IngestStatus[]),
    visibility: new Set(requireStringArray(parsed.visibility, "visibility")),
    requiredCommon: requireStringArray(parsed.required_common, "required_common"),
    ingestControlledTypes: new Set(controlledTypes as CapabilityObjectType[]),
    relationFields: requireStringRecord(parsed.relation_fields, "relation_fields")
  };
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(absolutePath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(absolutePath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function normalizedFrontmatter(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) => (entry instanceof Date ? entry.toISOString().slice(0, 10) : entry))
  ) as Record<string, unknown>;
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => stringValues(entry));
  }
  return [];
}

function normalizeWikilinkTarget(value: string): string {
  const withoutBrackets = value.replace(/^\[\[/, "").replace(/\]\]$/, "");
  return withoutBrackets.split("|")[0].split("#")[0].trim();
}

export function extractWikilinks(markdown: string): string[] {
  const links = [...markdown.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => normalizeWikilinkTarget(match[1])).filter(Boolean);
  return [...new Set(links)].sort((left, right) => left.localeCompare(right));
}

function extractRelations(frontmatter: Record<string, unknown>, schema: CapabilitySchema): CapabilityRelation[] {
  const relations: CapabilityRelation[] = [];
  for (const [field, kind] of Object.entries(schema.relationFields)) {
    for (const rawTarget of stringValues(frontmatter[field])) {
      const target = normalizeWikilinkTarget(rawTarget);
      if (target) {
        relations.push({ field, kind, target });
      }
    }
  }
  return relations.sort((left, right) => `${left.kind}:${left.target}`.localeCompare(`${right.kind}:${right.target}`));
}

function titleFor(relativePath: string, frontmatter: Record<string, unknown>, body: string): string {
  if (typeof frontmatter.title === "string" && frontmatter.title.trim()) {
    return frontmatter.title.trim();
  }
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || path.basename(relativePath, path.extname(relativePath));
}

function validateFrontmatter(
  relativePath: string,
  frontmatter: Record<string, unknown>,
  schema: CapabilitySchema
): { id: string | null; type: CapabilityObjectType | null; issues: AdapterIssue[] } {
  const issues: AdapterIssue[] = [];
  for (const field of schema.requiredCommon) {
    const value = frontmatter[field];
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
      issues.push({
        code: "missing-required-field",
        field,
        message: `Missing required frontmatter field: ${field}.`,
        path: relativePath
      });
    }
  }

  const rawType = frontmatter.type;
  const type = typeof rawType === "string" && OBJECT_TYPE_SET.has(rawType) ? (rawType as CapabilityObjectType) : null;
  if (!type) {
    issues.push({
      code: "unknown-object-type",
      field: "type",
      message: `Unknown Capability OS object type: ${String(rawType ?? "missing")}.`,
      path: relativePath
    });
  }

  const lifecycleStatus = frontmatter.status;
  if (typeof lifecycleStatus !== "string" || !schema.lifecycleStatus.has(lifecycleStatus)) {
    issues.push({
      code: "invalid-lifecycle-status",
      field: "status",
      message: `Invalid lifecycle status: ${String(lifecycleStatus ?? "missing")}.`,
      path: relativePath
    });
  }

  const visibility = frontmatter.visibility;
  if (typeof visibility !== "string" || !schema.visibility.has(visibility)) {
    issues.push({
      code: "invalid-visibility",
      field: "visibility",
      message: `Invalid visibility: ${String(visibility ?? "missing")}.`,
      path: relativePath
    });
  }

  if (type && schema.ingestControlledTypes.has(type)) {
    const ingestStatus = frontmatter.ingest_status;
    if (ingestStatus === undefined || ingestStatus === null || ingestStatus === "") {
      issues.push({
        code: "missing-ingest-status",
        field: "ingest_status",
        message: `${type} objects must declare ingest_status.`,
        path: relativePath
      });
    } else if (typeof ingestStatus !== "string" || !schema.ingestStatus.has(ingestStatus as IngestStatus)) {
      issues.push({
        code: "invalid-ingest-status",
        field: "ingest_status",
        message: `Invalid ingest status: ${String(ingestStatus)}.`,
        path: relativePath
      });
    }
  }

  return {
    id: typeof frontmatter.id === "string" && frontmatter.id.trim() ? frontmatter.id.trim() : null,
    type,
    issues
  };
}

function admissionFor(
  relativePath: string,
  type: CapabilityObjectType | null,
  frontmatter: Record<string, unknown>,
  issues: readonly AdapterIssue[],
  schema: CapabilitySchema,
  excludedDirectoryNames: ReadonlySet<string>
): AdmissionDecision {
  if (issues.length || !type) {
    return { lane: "invalid", reason: "Schema validation failed; record is isolated from every index." };
  }

  const directorySegments = relativePath.split("/").slice(0, -1);
  if (directorySegments.some((segment) => excludedDirectoryNames.has(segment))) {
    return { lane: "excluded", reason: "Template or explicitly excluded directory." };
  }

  if (frontmatter.status === "archived") {
    return { lane: "excluded", reason: "Archived objects are not part of the default private index." };
  }

  if (!schema.ingestControlledTypes.has(type)) {
    return { lane: "searchable", reason: "Canonical business/system object; ingest_status is not required for this type." };
  }

  switch (frontmatter.ingest_status) {
    case "accepted":
      return { lane: "searchable", reason: "Accepted content object." };
    case "raw":
    case "pending":
      return { lane: "review-only", reason: `${String(frontmatter.ingest_status)} content is visible only in the review lane.` };
    case "rejected":
      return { lane: "excluded", reason: "Rejected content is excluded from retrieval and recommendations." };
    default:
      return { lane: "invalid", reason: "Controlled content has no valid ingest_status." };
  }
}

async function parseRecord(
  absolutePath: string,
  scopeRoot: string,
  schema: CapabilitySchema,
  excludedDirectoryNames: ReadonlySet<string>
): Promise<CapabilityRecord> {
  const relativePath = toPosix(path.relative(scopeRoot, absolutePath));
  const raw = await fs.readFile(absolutePath, "utf8");
  try {
    const parsed = matter(raw);
    const frontmatter = normalizedFrontmatter(parsed.data);
    const validation = validateFrontmatter(relativePath, frontmatter, schema);
    return {
      id: validation.id,
      type: validation.type,
      title: titleFor(relativePath, frontmatter, parsed.content),
      relativePath,
      contentHash: sha256(raw),
      frontmatter,
      body: parsed.content,
      wikilinks: extractWikilinks(parsed.content),
      relations: extractRelations(frontmatter, schema),
      admission: admissionFor(relativePath, validation.type, frontmatter, validation.issues, schema, excludedDirectoryNames),
      issues: validation.issues
    };
  } catch (error) {
    const issue: AdapterIssue = {
      code: "frontmatter-parse-error",
      message: error instanceof Error ? error.message : String(error),
      path: relativePath
    };
    return {
      id: null,
      type: null,
      title: path.basename(relativePath, path.extname(relativePath)),
      relativePath,
      contentHash: sha256(raw),
      frontmatter: {},
      body: "",
      wikilinks: [],
      relations: [],
      admission: { lane: "invalid", reason: "Markdown frontmatter could not be parsed." },
      issues: [issue]
    };
  }
}

function markDuplicateIds(records: CapabilityRecord[]): void {
  const byId = new Map<string, CapabilityRecord[]>();
  for (const record of records) {
    if (!record.id || record.admission.lane === "excluded") continue;
    const existing = byId.get(record.id) ?? [];
    existing.push(record);
    byId.set(record.id, existing);
  }
  for (const [id, duplicates] of byId) {
    if (duplicates.length < 2) continue;
    for (const record of duplicates) {
      record.issues.push({
        code: "duplicate-id",
        field: "id",
        message: `Duplicate object id: ${id}.`,
        path: record.relativePath
      });
      record.admission = { lane: "invalid", reason: "Duplicate IDs are isolated from every index." };
    }
  }
}

function buildStats(records: readonly CapabilityRecord[]): CapabilitySnapshotStats {
  const byType: Record<string, number> = {};
  const byAdmission: Record<AdmissionLane, number> = { searchable: 0, "review-only": 0, excluded: 0, invalid: 0 };
  for (const record of records) {
    byAdmission[record.admission.lane] += 1;
    if (record.type) byType[record.type] = (byType[record.type] ?? 0) + 1;
  }
  return {
    markdownFiles: records.length,
    validObjects: records.length - byAdmission.invalid,
    invalidObjects: byAdmission.invalid,
    searchableObjects: byAdmission.searchable,
    reviewOnlyObjects: byAdmission["review-only"],
    excludedObjects: byAdmission.excluded,
    byType,
    byAdmission
  };
}

export function admissionLeakPaths(snapshot: CapabilityVaultSnapshot): string[] {
  const controlledTypes = new Set<string>(DEFAULT_INGEST_CONTROLLED_TYPES);
  return snapshot.records
    .filter(
      (record) =>
        record.admission.lane === "searchable" &&
        record.type !== null &&
        controlledTypes.has(record.type) &&
        record.frontmatter.ingest_status !== "accepted"
    )
    .map((record) => record.relativePath);
}

export function assertNoAdmissionLeaks(snapshot: CapabilityVaultSnapshot): void {
  const leakedPaths = admissionLeakPaths(snapshot);
  if (leakedPaths.length) {
    throw new Error(`Non-accepted content entered the searchable lane: ${leakedPaths.join(", ")}`);
  }
}

export async function scanCapabilityVault(options: ScanCapabilityVaultOptions): Promise<CapabilityVaultSnapshot> {
  const vaultRoot = path.resolve(options.vaultRoot);
  const scopePath = options.scopePath ?? DEFAULT_SCOPE_PATH;
  const scopeRoot = path.resolve(vaultRoot, scopePath);
  if (!isPathWithin(vaultRoot, scopeRoot)) {
    throw new Error(`Capability OS scope escapes the Vault root: ${scopePath}`);
  }

  const schemaPath = path.resolve(options.schemaPath ?? path.join(vaultRoot, ".knowledge-system", "schema.yaml"));
  const schema = await loadCapabilitySchema(schemaPath);
  const excludedDirectoryNames = new Set(options.excludedDirectoryNames ?? DEFAULT_EXCLUDED_DIRECTORY_NAMES);
  const files = await listMarkdownFiles(scopeRoot);
  const records = await Promise.all(files.map((file) => parseRecord(file, scopeRoot, schema, excludedDirectoryNames)));
  markDuplicateIds(records);
  records.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const snapshot: CapabilityVaultSnapshot = {
    snapshotVersion: "1.0",
    schemaVersion: schema.schemaVersion,
    vaultRoot,
    scopePath: toPosix(path.relative(vaultRoot, scopeRoot)),
    sourceHash: sha256(records.map((record) => `${record.relativePath}:${record.contentHash}`).join("\n")),
    records,
    issues: records.flatMap((record) => record.issues),
    stats: buildStats(records)
  };
  assertNoAdmissionLeaks(snapshot);
  return snapshot;
}
