import fs from "node:fs/promises";
import path from "node:path";
import { type SearchResult, searchVault } from "@swarmvaultai/engine";
import { type CapabilityRecord, type CapabilityVaultSnapshot, scanCapabilityVault } from "./index.js";
import type { ProjectionManifest, ProjectionRecord } from "./projection.js";

export const CAPABILITY_OS_EVALUATION_ARTIFACT = "capability-os-evaluation.json";

export interface GoldenQuestion {
  id: string;
  question: string;
  expectedPaths: string[];
}

export interface GoldenEvaluationMatch {
  id: string;
  title: string;
  sourcePath: string;
  type: string;
  rank: number;
}

export interface GoldenQuestionEvaluation {
  id: string;
  question: string;
  expectedPaths: string[];
  actual: GoldenEvaluationMatch[];
  expectedHits: string[];
  missingExpectedPaths: string[];
  traceable: boolean;
  pendingLeakCount: number;
  durationMs: number;
}

export interface GoldenEvaluationSummary {
  questionCount: number;
  expectedQuestionCount: number;
  expectedReferenceCount: number;
  traceableQuestions: number;
  traceabilityRate: number;
  questionsWithExpectedHit: number;
  questionExpectedHitRate: number;
  expectedReferencesHit: number;
  expectedReferenceHitRate: number;
  pendingLeakCount: number;
  missingExpectedReferenceCount: number;
  averageDurationMs: number;
  automatedGatePassed: boolean;
  relevanceState: "requires-user-rating";
}

export interface GoldenEvaluationReport {
  kind: "capability-os-golden-evaluation";
  version: 1;
  generatedAt: string;
  sourceHash: string;
  questionSetPath: string;
  topK: number;
  summary: GoldenEvaluationSummary;
  questions: GoldenQuestionEvaluation[];
}

export interface EvaluateGoldenQuestionsOptions {
  vaultRoot: string;
  runtimeRoot: string;
  scopePath?: string;
  schemaPath?: string;
  questionSetPath?: string;
  expectedQuestionCount?: number;
  topK?: number;
}

interface SourceManifest {
  sourceId: string;
  repoRelativePath?: string;
}

function roundRate(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function withoutMarkdownExtension(value: string): string {
  return value.replace(/\.md$/i, "");
}

function normalizedCanonicalPath(value: string, scopePath: string): string {
  const target = value.split("|")[0].split("#")[0].trim().replace(/^\/+/, "");
  const withoutScope = target.startsWith(`${scopePath}/`) ? target.slice(scopePath.length + 1) : target;
  return withoutMarkdownExtension(withoutScope);
}

function isPathWithin(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

export function parseGoldenQuestions(markdown: string, scopePath = "能力操作系统"): GoldenQuestion[] {
  const headings = [...markdown.matchAll(/^###\s+(Q\d{2})[：:]\s*(.+)$/gm)];
  return headings.map((heading, index) => {
    const sectionStart = (heading.index ?? 0) + heading[0].length;
    const sectionEnd = headings[index + 1]?.index ?? markdown.length;
    const section = markdown.slice(sectionStart, sectionEnd);
    const topThreeLine = section.match(/^\*\*Top 3\*\*[：:]\s*(.+)$/m)?.[1] ?? "";
    const expectedPaths = [...topThreeLine.matchAll(/\[\[([^\]]+)\]\]/g)]
      .map((match) => normalizedCanonicalPath(match[1], scopePath))
      .filter(Boolean);
    return {
      id: heading[1],
      question: heading[2].trim(),
      expectedPaths: [...new Set(expectedPaths)]
    };
  });
}

function recordLookup(snapshot: CapabilityVaultSnapshot): Map<string, CapabilityRecord> {
  const lookup = new Map<string, CapabilityRecord>();
  for (const record of snapshot.records) {
    lookup.set(normalizedCanonicalPath(record.relativePath, snapshot.scopePath), record);
  }
  return lookup;
}

async function expectedPathExistence(
  expectedPaths: readonly string[],
  records: ReadonlyMap<string, CapabilityRecord>,
  scopeRoot: string
): Promise<Map<string, boolean>> {
  const existence = new Map<string, boolean>();
  await Promise.all(
    [...new Set(expectedPaths)].map(async (expectedPath) => {
      if (records.has(expectedPath)) {
        existence.set(expectedPath, true);
        return;
      }
      const candidate = path.resolve(scopeRoot, path.extname(expectedPath) ? expectedPath : `${expectedPath}.md`);
      if (!isPathWithin(scopeRoot, candidate)) {
        existence.set(expectedPath, false);
        return;
      }
      const exists = await fs
        .stat(candidate)
        .then((stat) => stat.isFile())
        .catch(() => false);
      existence.set(expectedPath, exists);
    })
  );
  return existence;
}

async function loadSourceMap(swarmRoot: string, projection: ProjectionManifest): Promise<Map<string, ProjectionRecord>> {
  const byProjectedPath = new Map(projection.records.map((record) => [record.projectedPath, record]));
  const manifestsDir = path.join(swarmRoot, "state", "manifests");
  const entries = await fs.readdir(manifestsDir);
  const sourceMap = new Map<string, ProjectionRecord>();
  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        const raw = await fs.readFile(path.join(manifestsDir, entry), "utf8");
        const manifest = JSON.parse(raw) as SourceManifest;
        const projected = manifest.repoRelativePath ? byProjectedPath.get(manifest.repoRelativePath) : undefined;
        if (projected) sourceMap.set(manifest.sourceId, projected);
      })
  );
  return sourceMap;
}

function mappedSearchResults(
  results: readonly SearchResult[],
  sourceMap: ReadonlyMap<string, ProjectionRecord>,
  records: ReadonlyMap<string, CapabilityRecord>,
  scopePath: string,
  excludedPath: string,
  topK: number
): GoldenEvaluationMatch[] {
  const seen = new Set<string>();
  const mapped: GoldenEvaluationMatch[] = [];
  for (const result of results) {
    const sourceId = result.pageId.startsWith("source:") ? result.pageId.slice("source:".length) : "";
    const projected = sourceId ? sourceMap.get(sourceId) : undefined;
    if (!projected) continue;
    const normalizedPath = normalizedCanonicalPath(projected.sourcePath, scopePath);
    if (normalizedPath === excludedPath || seen.has(normalizedPath)) continue;
    const record = records.get(normalizedPath);
    if (!record) continue;
    seen.add(normalizedPath);
    mapped.push({
      id: record.id ?? `invalid:${record.contentHash.slice(0, 16)}`,
      title: record.title,
      sourcePath: record.relativePath,
      type: record.type ?? "unknown",
      rank: result.rank
    });
    if (mapped.length >= topK) break;
  }
  return mapped;
}

export async function evaluateGoldenQuestions(options: EvaluateGoldenQuestionsOptions): Promise<GoldenEvaluationReport> {
  const vaultRoot = path.resolve(options.vaultRoot);
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const swarmRoot = path.join(runtimeRoot, "swarmvault");
  const topK = options.topK ?? 3;
  const expectedQuestionCount = options.expectedQuestionCount ?? 30;
  const snapshot = await scanCapabilityVault({
    vaultRoot,
    scopePath: options.scopePath,
    schemaPath: options.schemaPath
  });
  const projectionPath = path.join(runtimeRoot, "projection", ".capability-os-projection.json");
  const projection = JSON.parse(await fs.readFile(projectionPath, "utf8")) as ProjectionManifest;
  if (projection.sourceHash !== snapshot.sourceHash) {
    throw new Error("Capability OS runtime is stale. Rebuild it before running the golden evaluation.");
  }

  const defaultQuestionPath = path.join(vaultRoot, snapshot.scopePath, "验收", "黄金问题集_P0-P1.md");
  const questionSetPath = path.resolve(options.questionSetPath ?? defaultQuestionPath);
  if (!isPathWithin(vaultRoot, questionSetPath)) {
    throw new Error("The golden question set must live inside the canonical Vault.");
  }
  const questionMarkdown = await fs.readFile(questionSetPath, "utf8");
  const questions = parseGoldenQuestions(questionMarkdown, snapshot.scopePath);
  const questionSetCanonicalPath = normalizedCanonicalPath(
    path.relative(path.join(vaultRoot, snapshot.scopePath), questionSetPath),
    snapshot.scopePath
  );
  const records = recordLookup(snapshot);
  const scopeRoot = path.join(vaultRoot, snapshot.scopePath);
  const expectedExistence = await expectedPathExistence(
    questions.flatMap((question) => question.expectedPaths),
    records,
    scopeRoot
  );
  const sourceMap = await loadSourceMap(swarmRoot, projection);

  const evaluated: GoldenQuestionEvaluation[] = [];
  for (const question of questions) {
    const startedAt = performance.now();
    const rawResults = await searchVault(swarmRoot, question.question, Math.max(30, topK * 8));
    const actual = mappedSearchResults(rawResults, sourceMap, records, snapshot.scopePath, questionSetCanonicalPath, topK);
    const actualPaths = new Set(actual.map((entry) => normalizedCanonicalPath(entry.sourcePath, snapshot.scopePath)));
    const expectedHits = question.expectedPaths.filter((expected) => actualPaths.has(expected));
    const missingExpectedPaths = question.expectedPaths.filter((expected) => !expectedExistence.get(expected));
    const pendingLeakCount = actual.filter((entry) => {
      const record = records.get(normalizedCanonicalPath(entry.sourcePath, snapshot.scopePath));
      return record?.admission.lane !== "searchable";
    }).length;
    evaluated.push({
      id: question.id,
      question: question.question,
      expectedPaths: question.expectedPaths,
      actual,
      expectedHits,
      missingExpectedPaths,
      traceable: actual.length > 0,
      pendingLeakCount,
      durationMs: Number((performance.now() - startedAt).toFixed(2))
    });
  }

  const expectedReferenceCount = evaluated.reduce((total, question) => total + question.expectedPaths.length, 0);
  const traceableQuestions = evaluated.filter((question) => question.traceable).length;
  const questionsWithExpectedHit = evaluated.filter((question) => question.expectedHits.length > 0).length;
  const expectedReferencesHit = evaluated.reduce((total, question) => total + question.expectedHits.length, 0);
  const pendingLeakCount = evaluated.reduce((total, question) => total + question.pendingLeakCount, 0);
  const missingExpectedReferenceCount = evaluated.reduce((total, question) => total + question.missingExpectedPaths.length, 0);
  const averageDurationMs = evaluated.length
    ? Number((evaluated.reduce((total, question) => total + question.durationMs, 0) / evaluated.length).toFixed(2))
    : 0;
  const automatedGatePassed =
    evaluated.length === expectedQuestionCount &&
    traceableQuestions === evaluated.length &&
    pendingLeakCount === 0 &&
    missingExpectedReferenceCount === 0;
  const summary: GoldenEvaluationSummary = {
    questionCount: evaluated.length,
    expectedQuestionCount,
    expectedReferenceCount,
    traceableQuestions,
    traceabilityRate: roundRate(traceableQuestions, evaluated.length),
    questionsWithExpectedHit,
    questionExpectedHitRate: roundRate(questionsWithExpectedHit, evaluated.length),
    expectedReferencesHit,
    expectedReferenceHitRate: roundRate(expectedReferencesHit, expectedReferenceCount),
    pendingLeakCount,
    missingExpectedReferenceCount,
    averageDurationMs,
    automatedGatePassed,
    relevanceState: "requires-user-rating"
  };
  const report: GoldenEvaluationReport = {
    kind: "capability-os-golden-evaluation",
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceHash: snapshot.sourceHash,
    questionSetPath: path.posix.join(
      snapshot.scopePath,
      path.relative(path.join(vaultRoot, snapshot.scopePath), questionSetPath).split(path.sep).join("/")
    ),
    topK,
    summary,
    questions: evaluated
  };
  const reportPath = path.join(swarmRoot, "state", CAPABILITY_OS_EVALUATION_ARTIFACT);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
