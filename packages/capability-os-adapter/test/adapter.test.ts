import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rerankCapabilityRecords } from "../src/domain-rerank.js";
import { parseGoldenQuestions } from "../src/golden-eval.js";
import { admissionLeakPaths, CAPABILITY_OS_OBJECT_TYPES, loadCapabilitySchema, scanCapabilityVault } from "../src/index.js";
import { writeSearchableProjection } from "../src/projection.js";
import { buildCapabilityViewerArtifact } from "../src/viewer-artifact.js";

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

describe("M1-B derived contracts", () => {
  it("parses the private golden question document as an executable contract", () => {
    const questions = parseGoldenQuestions(`
### Q01：Where is the workflow result note?

**Top 3**：[[能力操作系统/知识/Workflow result]]；[[能力操作系统/方法/Review gate|gate]]

### Q02: Which project used it?

**Top 3**: [[能力操作系统/项目/Project Alpha#Evidence]]
`);
    expect(questions).toEqual([
      { id: "Q01", question: "Where is the workflow result note?", expectedPaths: ["知识/Workflow result", "方法/Review gate"] },
      { id: "Q02", question: "Which project used it?", expectedPaths: ["项目/Project Alpha"] }
    ]);
  });

  it("builds a metadata-only Viewer artifact with canonical links and resolved one-hop relations", async () => {
    const root = await createVault();
    const scope = path.join(root, "能力操作系统");
    await fs.writeFile(
      path.join(scope, "accepted.md"),
      note("kb-accepted", "knowledge", {
        ingestStatus: "accepted",
        title: "Accepted Knowledge",
        relations: "grounded_in:\n  - '[[Method One]]'\n"
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(scope, "method.md"),
      note("kb-method", "playbook", { ingestStatus: "accepted", title: "Method One" }),
      "utf8"
    );
    await fs.writeFile(path.join(scope, "pending.md"), note("kb-pending", "learning", { ingestStatus: "pending" }), "utf8");
    await fs.mkdir(path.join(scope, "模板"), { recursive: true });
    await fs.writeFile(path.join(scope, "模板", "project.md"), note("{{id}}", "project", { title: "{{title}}" }), "utf8");

    const snapshot = await scanCapabilityVault({ vaultRoot: root });
    const artifact = buildCapabilityViewerArtifact(snapshot, "2026-09-01T00:00:00.000Z");
    const accepted = artifact.records.find((record) => record.id === "kb-accepted");

    expect(artifact.objectTypes).toEqual(CAPABILITY_OS_OBJECT_TYPES);
    expect(artifact.admissionLanes).toEqual(["searchable", "review-only", "excluded", "invalid"]);
    expect(artifact.stats.byAdmission["review-only"]).toBe(1);
    expect(artifact.projects).toEqual([]);
    expect(accepted?.canonicalPath).toBe("能力操作系统/accepted.md");
    expect(accepted?.obsidianUri).toContain("obsidian://open?");
    expect(accepted?.projectIds).toEqual([]);
    expect(accepted?.relations[0]).toMatchObject({ kind: "grounded-in", targetId: "kb-method", targetTitle: "Method One" });
    expect(JSON.stringify(artifact)).not.toContain("Body links to");
    expect(JSON.stringify(artifact)).not.toContain('"frontmatter"');
  });
});

describe("M1-C deterministic domain reranking", () => {
  it("uses object intent without allowing non-searchable records into the result", async () => {
    const root = await createVault();
    const scope = path.join(root, "能力操作系统");
    await fs.writeFile(path.join(scope, "project.md"), note("project-store", "project", { title: "门店数字工具采用项目" }), "utf8");
    await fs.writeFile(
      path.join(scope, "method.md"),
      note("method-value", "playbook", { ingestStatus: "accepted", title: "复杂技术到购买理由方法" }),
      "utf8"
    );
    await fs.writeFile(
      path.join(scope, "pending.md"),
      note("pending-perfect", "learning", { ingestStatus: "pending", title: "门店认可数字工具却不使用" }),
      "utf8"
    );
    await fs.writeFile(path.join(scope, "system.md"), note("system-noise", "system", { title: "项目与方法实施系统说明" }), "utf8");
    const snapshot = await scanCapabilityVault({ vaultRoot: root });

    const projectResults = rerankCapabilityRecords("哪个项目记录了门店数字工具不使用？", snapshot);
    const methodResults = rerankCapabilityRecords("复杂技术怎样形成购买理由，有什么方法？", snapshot);

    expect(projectResults[0]).toMatchObject({ id: "project-store", type: "project" });
    expect(methodResults[0]).toMatchObject({ id: "method-value", type: "playbook" });
    expect(projectResults.some((result) => result.id === "pending-perfect")).toBe(false);
  });

  it("uses canonical paths as stable baseline identities", async () => {
    const root = await createVault();
    const scope = path.join(root, "能力操作系统");
    await fs.writeFile(path.join(scope, "alpha.md"), note("alpha", "project", { title: "Alpha" }), "utf8");
    await fs.writeFile(path.join(scope, "beta.md"), note("beta", "project", { title: "Beta" }), "utf8");
    const snapshot = await scanCapabilityVault({ vaultRoot: root });

    const results = rerankCapabilityRecords("项目", snapshot, { baseline: [{ sourcePath: "beta.md" }], topK: 2 });

    expect(results.map((result) => result.id)).toEqual(["beta", "alpha"]);
  });
});
