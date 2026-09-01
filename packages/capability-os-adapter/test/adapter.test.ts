import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admissionLeakPaths, CAPABILITY_OS_OBJECT_TYPES, loadCapabilitySchema, scanCapabilityVault } from "../src/index.js";
import { writeSearchableProjection } from "../src/projection.js";

const tempDirs: string[] = [];

const schema = `schema_version: "1.0"
object_types:
${CAPABILITY_OS_OBJECT_TYPES.map((type) => `  - ${type}`).join("\n")}
lifecycle_status:
  - inbox
  - draft
  - active
  - validated
  - archived
ingest_status:
  - raw
  - pending
  - accepted
  - rejected
visibility:
  - private
  - public-ready
  - public
required_common:
  - id
  - type
  - status
  - visibility
  - publish
  - created
  - updated
  - version
ingest_controlled_types:
  - source
  - learning
  - knowledge
  - playbook
  - artifact
relation_fields:
  derived_from: derived-from
  grounded_in: grounded-in
  used_in: used-in
`;

async function createVault(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "capability-os-adapter-"));
  tempDirs.push(root);
  await fs.mkdir(path.join(root, ".knowledge-system"), { recursive: true });
  await fs.mkdir(path.join(root, "能力操作系统"), { recursive: true });
  await fs.writeFile(path.join(root, ".knowledge-system", "schema.yaml"), schema, "utf8");
  return root;
}

function note(
  id: string,
  type: string,
  options: { ingestStatus?: string; status?: string; title?: string; relations?: string } = {}
): string {
  const ingest = options.ingestStatus ? `ingest_status: ${options.ingestStatus}\n` : "";
  const relations = options.relations ?? "";
  return `---
id: ${id}
type: ${type}
status: ${options.status ?? "active"}
${ingest}visibility: private
publish: false
created: 2026-09-01
updated: 2026-09-01
version: "1.0"
${relations}---

# ${options.title ?? id}

Body links to [[Target Note|target]].
`;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Capability OS schema", () => {
  it("loads the exact 13-object contract", async () => {
    const root = await createVault();
    const loaded = await loadCapabilitySchema(path.join(root, ".knowledge-system", "schema.yaml"));
    expect(loaded.objectTypes).toEqual(CAPABILITY_OS_OBJECT_TYPES);
    expect([...loaded.ingestControlledTypes]).toEqual(["source", "learning", "knowledge", "playbook", "artifact"]);
  });

  it("rejects object-type drift instead of silently coercing it", async () => {
    const root = await createVault();
    const schemaPath = path.join(root, ".knowledge-system", "schema.yaml");
    await fs.writeFile(schemaPath, schema.replace("  - system\n", "  - fleeting\n"), "utf8");
    await expect(loadCapabilitySchema(schemaPath)).rejects.toThrow(/object type contract drifted/i);
  });
});

describe("read-only Vault scan", () => {
  it("separates accepted content, review candidates, business objects, rejected content, and templates", async () => {
    const root = await createVault();
    const scope = path.join(root, "能力操作系统");
    await fs.mkdir(path.join(scope, "模板"), { recursive: true });
    await fs.writeFile(
      path.join(scope, "accepted.md"),
      note("kb-accepted", "knowledge", { ingestStatus: "accepted", relations: "grounded_in:\n  - '[[Method One]]'\n" }),
      "utf8"
    );
    await fs.writeFile(path.join(scope, "pending.md"), note("kb-pending", "learning", { ingestStatus: "pending" }), "utf8");
    await fs.writeFile(path.join(scope, "rejected.md"), note("kb-rejected", "playbook", { ingestStatus: "rejected" }), "utf8");
    await fs.writeFile(path.join(scope, "project.md"), note("project-live", "project"), "utf8");
    await fs.writeFile(path.join(scope, "模板", "project-template.md"), note("{{id}}", "project"), "utf8");
    await fs.writeFile(path.join(scope, "模板", "review-template.md"), note("{{id}}", "review"), "utf8");

    const before = await fs.readFile(path.join(scope, "accepted.md"), "utf8");
    const snapshot = await scanCapabilityVault({ vaultRoot: root });
    const after = await fs.readFile(path.join(scope, "accepted.md"), "utf8");

    expect(after).toBe(before);
    expect(snapshot.stats).toMatchObject({
      markdownFiles: 6,
      validObjects: 6,
      invalidObjects: 0,
      searchableObjects: 2,
      reviewOnlyObjects: 1,
      excludedObjects: 3
    });
    expect(snapshot.records.find((record) => record.id === "kb-accepted")?.admission.lane).toBe("searchable");
    expect(snapshot.records.find((record) => record.id === "kb-pending")?.admission.lane).toBe("review-only");
    expect(snapshot.records.find((record) => record.id === "project-live")?.admission.lane).toBe("searchable");
    expect(snapshot.records.find((record) => record.relativePath === "模板/project-template.md")?.admission.lane).toBe("excluded");
    expect(snapshot.records.find((record) => record.id === "kb-accepted")?.wikilinks).toEqual(["Target Note"]);
    expect(snapshot.records.find((record) => record.id === "kb-accepted")?.relations).toEqual([
      { field: "grounded_in", kind: "grounded-in", target: "Method One" }
    ]);
    expect(admissionLeakPaths(snapshot)).toEqual([]);
  });

  it("isolates unknown types, missing ingest state, and duplicate IDs", async () => {
    const root = await createVault();
    const scope = path.join(root, "能力操作系统");
    await fs.writeFile(path.join(scope, "unknown.md"), note("unknown", "fleeting"), "utf8");
    await fs.writeFile(path.join(scope, "missing.md"), note("missing-ingest", "knowledge"), "utf8");
    await fs.writeFile(path.join(scope, "duplicate-a.md"), note("duplicate", "project"), "utf8");
    await fs.writeFile(path.join(scope, "duplicate-b.md"), note("duplicate", "review"), "utf8");

    const snapshot = await scanCapabilityVault({ vaultRoot: root });
    expect(snapshot.stats.invalidObjects).toBe(4);
    expect(snapshot.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["unknown-object-type", "missing-ingest-status", "duplicate-id"])
    );
    expect(snapshot.records.every((record) => record.admission.lane === "invalid")).toBe(true);
  });

  it("writes only searchable objects to a derived directory outside the Vault", async () => {
    const root = await createVault();
    const scope = path.join(root, "能力操作系统");
    await fs.writeFile(path.join(scope, "accepted.md"), note("kb-accepted", "knowledge", { ingestStatus: "accepted" }), "utf8");
    await fs.writeFile(path.join(scope, "pending.md"), note("kb-pending", "learning", { ingestStatus: "pending" }), "utf8");
    const snapshot = await scanCapabilityVault({ vaultRoot: root });
    const projectionContainer = await fs.mkdtemp(path.join(os.tmpdir(), "capability-os-projection-"));
    tempDirs.push(projectionContainer);
    const projectionRoot = path.join(projectionContainer, "projection");

    const projection = await writeSearchableProjection(snapshot, projectionRoot);
    expect(projection.records.map((record) => record.id)).toEqual(["kb-accepted"]);
    expect(await fs.readdir(path.join(projectionRoot, "knowledge"))).toHaveLength(1);
    await expect(fs.access(path.join(projectionRoot, "learning"))).rejects.toThrow();
    await expect(writeSearchableProjection(snapshot, path.join(root, "derived"))).rejects.toThrow(/outside the canonical Vault/i);

    const unmarked = path.join(projectionContainer, "unmarked");
    await fs.mkdir(unmarked);
    await fs.writeFile(path.join(unmarked, "keep.txt"), "do not replace", "utf8");
    await expect(writeSearchableProjection(snapshot, unmarked)).rejects.toThrow(/unmarked projection directory/i);
  });
});
