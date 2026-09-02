import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type SearchResult, searchVault } from "@swarmvaultai/engine";
import { rerankCapabilityRecords } from "./domain-rerank.js";
import { type CapabilityRecord, type CapabilityVaultSnapshot, scanCapabilityVault } from "./index.js";
import type { ProjectionManifest, ProjectionRecord } from "./projection.js";

export const CAPABILITY_OS_EVALUATION_ARTIFACT = "capability-os-evaluation.json";
export const CAPABILITY_OS_BLIND_EVALUATION_ARTIFACT = "capability-os-blind-evaluation.json";
export const CAPABILITY_OS_BLIND_KEY_ARTIFACT = "capability-os-blind-key.json";
export const M1C_HOLDOUT_QUESTION_IDS = ["Q03", "Q06", "Q09", "Q12", "Q15", "Q18", "Q21", "Q24", "Q27", "Q30"] as const;

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
  candidateActual: GoldenEvaluationMatch[];
  candidateExpectedHits: string[];
  candidateTraceable: boolean;
  candidatePendingLeakCount: number;
  candidateDurationMs: number;
}

export interface GoldenHoldoutSummary {
  questionIds: string[];
  baselineQuestionsWithExpectedHit: number;
  candidateQuestionsWithExpectedHit: number;
  questionLift: number;
  requiredQuestionLift: number;
  passed: boolean;
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
  candidateQuestionsWithExpectedHit: number;
  candidateQuestionExpectedHitRate: number;
  candidateExpectedReferencesHit: number;
  candidateExpectedReferenceHitRate: number;
  candidatePendingLeakCount: number;
  candidateAverageDurationMs: number;
  holdout: GoldenHoldoutSummary;
  automatedGatePassed: boolean;
  candidateGatePassed: boolean;
  relevanceState: "requires-user-rating";
}

export interface GoldenEvaluationReport {
  kind: "capability-os-golden-evaluation";
  version: 2;
  generatedAt: string;
  sourceHash: string;
  questionSetPath: string;
  topK: number;
  summary: GoldenEvaluationSummary;
  questions: GoldenQuestionEvaluation[];
}

export interface BlindEvaluationResult {
  id: string;
  title: string;
  type: string;
  sourcePath: string;
  obsidianUri: string;
}

export interface BlindEvaluationQuestion {
  id: string;
  question: string;
  left: BlindEvaluationResult[];
  right: BlindEvaluationResult[];
}

export interface BlindEvaluationArtifact {
  kind: "capability-os-blind-evaluation";
  version: 1;
  generatedAt: string;
  sourceHash: string;
  questionCount: number;
  choices: ["left", "right", "both", "neither"];
  questions: BlindEvaluationQuestion[];
}

interface BlindEvaluationKey {
  kind: "capability-os-blind-key";
  version: 1;
  sourceHash: string;
  assignments: Array<{ id: string; left: "baseline" | "candidate"; right: "baseline" | "candidate" }>;
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

function capabilityObsidianUri(vaultName: string, scopePath: string, sourcePath: string): string {
  const filePath = path.posix.join(scopePath, withoutMarkdownExtension(sourcePath));
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filePath)}`;
}

function blindResults(matches: readonly GoldenEvaluationMatch[], vaultName: string, scopePath: string): BlindEvaluationResult[] {
  return matches.map((match) => ({
    id: match.id,
    title: match.title,
    type: match.type,
    sourcePath: match.sourcePath,
    obsidianUri: capabilityObsidianUri(vaultName, scopePath, match.sourcePath)
  }));
}

function candidateOnLeft(sourceHash: string, questionId: string): boolean {
  const digest = crypto.createHash("sha256").update(`${sourceHash}:${questionId}:m1c-blind-v1`).digest();
  return digest[0] % 2 === 0;
}

async function writeBlindEvaluation(
  swarmRoot: string,
  snapshot: CapabilityVaultSnapshot,
  questions: readonly GoldenQuestionEvaluation[],
  generatedAt: string
): Promise<void> {
  const holdoutIds = new Set<string>(M1C_HOLDOUT_QUESTION_IDS);
  const vaultName = path.basename(snapshot.vaultRoot);
  const assignments: BlindEvaluationKey["assignments"] = [];
  const blindQuestions = questions
    .filter((question) => holdoutIds.has(question.id))
    .map((question) => {
      const candidateLeft = candidateOnLeft(snapshot.sourceHash, question.id);
      assignments.push({
        id: question.id,
        left: candidateLeft ? "candidate" : "baseline",
        right: candidateLeft ? "baseline" : "candidate"
      });
      const baseline = blindResults(question.actual, vaultName, snapshot.scopePath);
      const candidate = blindResults(question.candidateActual, vaultName, snapshot.scopePath);
      return {
        id: question.id,
        question: question.question,
        left: candidateLeft ? candidate : baseline,
        right: candidateLeft ? baseline : candidate
      } satisfies BlindEvaluationQuestion;
    });
  const artifact: BlindEvaluationArtifact = {
    kind: "capability-os-blind-evaluation",
    version: 1,
    generatedAt,
    sourceHash: snapshot.sourceHash,
    questionCount: blindQuestions.length,
    choices: ["left", "right", "both", "neither"],
    questions: blindQuestions
  };
  const key: BlindEvaluationKey = {
    kind: "capability-os-blind-key",
    version: 1,
    sourceHash: snapshot.sourceHash,
    assignments
  };
  await Promise.all([
    fs.writeFile(path.join(swarmRoot, "state", CAPABILITY_OS_BLIND_EVALUATION_ARTIFACT), `${JSON.stringify(artifact, null, 2)}\n`, "utf8"),
    fs.writeFile(path.join(swarmRoot, "state", CAPABILITY_OS_BLIND_KEY_ARTIFACT), `${JSON.stringify(key, null, 2)}\n`, "utf8")
  ]);
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
    const baselineDurationMs = Number((performance.now() - startedAt).toFixed(2));
    const actualPaths = new Set(actual.map((entry) => normalizedCanonicalPath(entry.sourcePath, snapshot.scopePath)));
    const expectedHits = question.expectedPaths.filter((expected) => actualPaths.has(expected));
    const missingExpectedPaths = question.expectedPaths.filter((expected) => !expectedExistence.get(expected));
    const pendingLeakCount = actual.filter((entry) => {
      const record = records.get(normalizedCanonicalPath(entry.sourcePath, snapshot.scopePath));
      return record?.admission.lane !== "searchable";
    }).length;
    const candidateStartedAt = performance.now();
    const candidateActual = rerankCapabilityRecords(question.question, snapshot, {
      topK,
      baseline: actual,
      excludedPaths: new Set([`${questionSetCanonicalPath}.md`]),
      asOfDate: new Date().toISOString().slice(0, 10)
    }).map(
      (entry) =>
        ({
          id: entry.id,
          title: entry.title,
          sourcePath: entry.sourcePath,
          type: entry.type,
          rank: -entry.score
        }) satisfies GoldenEvaluationMatch
    );
    const candidateDurationMs = Number((performance.now() - candidateStartedAt).toFixed(2));
    const candidatePaths = new Set(candidateActual.map((entry) => normalizedCanonicalPath(entry.sourcePath, snapshot.scopePath)));
    const candidateExpectedHits = question.expectedPaths.filter((expected) => candidatePaths.has(expected));
    const candidatePendingLeakCount = candidateActual.filter((entry) => {
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
      durationMs: baselineDurationMs,
      candidateActual,
      candidateExpectedHits,
      candidateTraceable: candidateActual.length > 0,
      candidatePendingLeakCount,
      candidateDurationMs
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
  const candidateQuestionsWithExpectedHit = evaluated.filter((question) => question.candidateExpectedHits.length > 0).length;
  const candidateExpectedReferencesHit = evaluated.reduce((total, question) => total + question.candidateExpectedHits.length, 0);
  const candidatePendingLeakCount = evaluated.reduce((total, question) => total + question.candidatePendingLeakCount, 0);
  const candidateAverageDurationMs = evaluated.length
    ? Number((evaluated.reduce((total, question) => total + question.candidateDurationMs, 0) / evaluated.length).toFixed(2))
    : 0;
  const holdoutIds = new Set<string>(M1C_HOLDOUT_QUESTION_IDS);
  const holdoutQuestions = evaluated.filter((question) => holdoutIds.has(question.id));
  const baselineHoldoutHits = holdoutQuestions.filter((question) => question.expectedHits.length > 0).length;
  const candidateHoldoutHits = holdoutQuestions.filter((question) => question.candidateExpectedHits.length > 0).length;
  const holdout: GoldenHoldoutSummary = {
    questionIds: [...M1C_HOLDOUT_QUESTION_IDS],
    baselineQuestionsWithExpectedHit: baselineHoldoutHits,
    candidateQuestionsWithExpectedHit: candidateHoldoutHits,
    questionLift: candidateHoldoutHits - baselineHoldoutHits,
    requiredQuestionLift: 3,
    passed: candidateHoldoutHits - baselineHoldoutHits >= 3
  };
  const automatedGatePassed =
    evaluated.length === expectedQuestionCount &&
    traceableQuestions === evaluated.length &&
    pendingLeakCount === 0 &&
    missingExpectedReferenceCount === 0;
  const candidateGatePassed =
    automatedGatePassed &&
    evaluated.every((question) => question.candidateTraceable) &&
    candidatePendingLeakCount === 0 &&
    candidateQuestionsWithExpectedHit >= questionsWithExpectedHit &&
    holdout.passed &&
    candidateAverageDurationMs <= 100;
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
    candidateQuestionsWithExpectedHit,
    candidateQuestionExpectedHitRate: roundRate(candidateQuestionsWithExpectedHit, evaluated.length),
    candidateExpectedReferencesHit,
    candidateExpectedReferenceHitRate: roundRate(candidateExpectedReferencesHit, expectedReferenceCount),
    candidatePendingLeakCount,
    candidateAverageDurationMs,
    holdout,
    automatedGatePassed,
    candidateGatePassed,
    relevanceState: "requires-user-rating"
  };
  const generatedAt = new Date().toISOString();
  const report: GoldenEvaluationReport = {
    kind: "capability-os-golden-evaluation",
    version: 2,
    generatedAt,
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
  await Promise.all([
    fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeBlindEvaluation(swarmRoot, snapshot, evaluated, generatedAt)
  ]);
  return report;
}
