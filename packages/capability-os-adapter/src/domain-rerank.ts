import path from "node:path";
import type { CapabilityObjectType, CapabilityRecord, CapabilityVaultSnapshot } from "./index.js";

export interface CapabilityBaselineMatch {
  sourcePath: string;
}

export interface CapabilityDomainRankedMatch {
  id: string;
  title: string;
  sourcePath: string;
  type: CapabilityObjectType;
  score: number;
  reasons: string[];
}

export interface CapabilityDomainRerankOptions {
  topK?: number;
  baseline?: readonly CapabilityBaselineMatch[];
  excludedPaths?: ReadonlySet<string>;
  asOfDate?: string;
}

interface SearchDocument {
  record: CapabilityRecord & { id: string; type: CapabilityObjectType };
  title: Set<string>;
  path: Set<string>;
  frontmatter: Set<string>;
  body: Set<string>;
  relations: Set<string>;
  all: Set<string>;
}

interface TypeIntentRule {
  pattern: RegExp;
  weights: Partial<Record<CapabilityObjectType, number>>;
  label: string;
}

const TYPE_INTENT_RULES: readonly TypeIntentRule[] = [
  { pattern: /项目|试点|活跃/, weights: { project: 9 }, label: "project intent" },
  { pattern: /方法论|方法|框架|步骤|怎么|如何|组合/, weights: { playbook: 9, learning: 2 }, label: "method intent" },
  { pattern: /主题|核心结论|共同|关系|冲突|边界|体系/, weights: { topic: 8 }, label: "topic intent" },
  { pattern: /看过|保存|资料|内容|知识|观点|看懂|学过/, weights: { learning: 6, knowledge: 4 }, label: "learning intent" },
  { pattern: /模板|提示词|指南|资产|白模/, weights: { artifact: 8, learning: 3 }, label: "artifact intent" },
  { pattern: /应用|采用|调用|实际结果|用过|落地/, weights: { application: 9, feedback: 3 }, label: "application intent" },
  { pattern: /证据|证明|案例/, weights: { evidence: 8, project: 2 }, label: "evidence intent" },
  { pattern: /反馈|纠错|错误|模糊|修正/, weights: { feedback: 9, application: 3 }, label: "feedback intent" },
  { pattern: /复习|复盘|回顾/, weights: { review: 6, learning: 5 }, label: "review intent" },
  { pattern: /能力|擅长|职业/, weights: { capability: 8, evidence: 4 }, label: "capability intent" },
  { pattern: /系统|协议|看板|工作台|驾驶舱|准入|审核/, weights: { system: 7 }, label: "system intent" }
];

const QUERY_EXPANSIONS: ReadonlyArray<{ pattern: RegExp; terms: readonly string[] }> = [
  { pattern: /使用|采用|应用|落地/, terms: ["使用", "采用", "应用", "落地"] },
  { pattern: /买点|购买理由/, terms: ["买点", "购买理由"] },
  { pattern: /方法论|方法|原则|框架/, terms: ["方法", "原则", "框架"] },
  { pattern: /纠错|反馈|修正/, terms: ["纠错", "反馈", "修正"] },
  { pattern: /证据|验证|结果/, terms: ["证据", "验证", "结果"] },
  { pattern: /复习|回顾/, terms: ["复习", "回顾", "联合复习"] }
];

const COMMON_QUERY_TERMS = new Set([
  "哪些",
  "哪个",
  "什么",
  "怎么",
  "怎样",
  "为什么",
  "之间",
  "可以",
  "适合",
  "当前",
  "最近",
  "过去",
  "之前",
  "今天",
  "分别",
  "我有",
  "我的",
  "是否"
]);

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap((entry) => stringValues(entry));
  if (value && typeof value === "object") return Object.values(value).flatMap((entry) => stringValues(entry));
  return [];
}

function normalizedText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/\[\[|\]\]/g, " ")
    .replace(/[“”‘’'"`]/g, " ")
    .replace(/[\s_—–\-/：:，,。！？!?；;（）()【】[\]{}<>]+/g, " ")
    .trim();
}

function textTerms(value: string): Set<string> {
  const normalized = normalizedText(value);
  const terms = new Set<string>();
  for (const ascii of normalized.match(/[a-z0-9][a-z0-9-]{1,}/g) ?? []) terms.add(ascii);
  for (const block of normalized.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? []) {
    if (block.length <= 4) terms.add(block);
    for (const size of [2, 3, 4]) {
      if (block.length < size) continue;
      for (let index = 0; index <= block.length - size; index += 1) {
        terms.add(block.slice(index, index + size));
      }
    }
  }
  return terms;
}

function queryTerms(query: string): Set<string> {
  const terms = textTerms(query);
  for (const stopword of COMMON_QUERY_TERMS) terms.delete(stopword);
  for (const expansion of QUERY_EXPANSIONS) {
    if (!expansion.pattern.test(query)) continue;
    for (const term of expansion.terms) {
      for (const token of textTerms(term)) terms.add(token);
    }
  }
  return terms;
}

function searchableRecords(snapshot: CapabilityVaultSnapshot, excludedPaths: ReadonlySet<string>): SearchDocument[] {
  return snapshot.records
    .filter(
      (record): record is CapabilityRecord & { id: string; type: CapabilityObjectType } =>
        record.admission.lane === "searchable" && Boolean(record.id) && Boolean(record.type) && !excludedPaths.has(record.relativePath)
    )
    .map((record) => {
      const title = textTerms(record.title);
      const recordPath = textTerms(record.relativePath);
      const frontmatter = textTerms(
        Object.entries(record.frontmatter)
          .filter(([key]) => !["id", "visibility", "publish", "created", "updated", "version", "tags"].includes(key))
          .flatMap(([key, value]) => [key, ...stringValues(value)])
          .join(" ")
      );
      const body = textTerms(record.body);
      const relations = textTerms(record.relations.flatMap((relation) => [relation.kind, relation.target]).join(" "));
      return {
        record,
        title,
        path: recordPath,
        frontmatter,
        body,
        relations,
        all: new Set([...title, ...recordPath, ...frontmatter, ...body, ...relations])
      } satisfies SearchDocument;
    });
}

function inverseDocumentFrequency(documents: readonly SearchDocument[]): Map<string, number> {
  const frequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of document.all) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  }
  return new Map([...frequency.entries()].map(([term, count]) => [term, Math.log(1 + (documents.length + 1) / (count + 1))] as const));
}

function lookupKeys(record: CapabilityRecord): string[] {
  return [record.title, record.relativePath, path.basename(record.relativePath, path.extname(record.relativePath))]
    .map(normalizedText)
    .filter(Boolean);
}

function relationGraph(documents: readonly SearchDocument[]): Map<string, Set<string>> {
  const byKey = new Map<string, string>();
  for (const document of documents) {
    for (const key of lookupKeys(document.record)) byKey.set(key, document.record.relativePath);
  }
  const graph = new Map<string, Set<string>>();
  for (const document of documents) {
    const neighbors = graph.get(document.record.relativePath) ?? new Set<string>();
    for (const relation of document.record.relations) {
      const target = byKey.get(normalizedText(relation.target));
      if (!target || target === document.record.relativePath) continue;
      neighbors.add(target);
      const reverse = graph.get(target) ?? new Set<string>();
      reverse.add(document.record.relativePath);
      graph.set(target, reverse);
    }
    graph.set(document.record.relativePath, neighbors);
  }
  return graph;
}

function lifecycleScore(record: CapabilityRecord, query: string, asOfDate: string): { score: number; reason?: string } {
  let score = 0;
  const status = typeof record.frontmatter.status === "string" ? record.frontmatter.status : "";
  if (/当前|活跃/.test(query) && status === "active") score += 3;

  if (/复习/.test(query) && record.type === "learning") {
    const nextReview = typeof record.frontmatter.next_review === "string" ? record.frontmatter.next_review : "";
    if (nextReview && nextReview <= asOfDate) score += 5;
  }

  if (/还没有.*(?:用|应用)|未.*(?:用|应用)/.test(query) && record.type === "learning") {
    const stage = typeof record.frontmatter.learning_stage === "string" ? record.frontmatter.learning_stage : "";
    if (stage === "understood" || stage === "recall-ready") score += 5;
    if (!record.relations.some((relation) => relation.field === "used_in")) score += 3;
  }

  return score > 0 ? { score, reason: "lifecycle fit" } : { score };
}

function typeIntentScore(type: CapabilityObjectType, query: string): { score: number; reasons: string[]; systemIntended: boolean } {
  let score = 0;
  let systemIntended = false;
  const reasons: string[] = [];
  for (const rule of TYPE_INTENT_RULES) {
    if (!rule.pattern.test(query)) continue;
    if (rule.weights.system) systemIntended = true;
    const weight = rule.weights[type] ?? 0;
    if (weight > 0) {
      score += weight;
      reasons.push(rule.label);
    }
  }
  return { score, reasons, systemIntended };
}

function lexicalScore(document: SearchDocument, terms: ReadonlySet<string>, idf: ReadonlyMap<string, number>): number {
  let score = 0;
  for (const term of terms) {
    const weight = idf.get(term) ?? 1;
    if (document.title.has(term)) score += weight * 7;
    if (document.path.has(term)) score += weight * 4;
    if (document.frontmatter.has(term)) score += weight * 3;
    if (document.relations.has(term)) score += weight * 3;
    if (document.body.has(term)) score += weight * 1.25;
  }
  return score;
}

export function rerankCapabilityRecords(
  query: string,
  snapshot: CapabilityVaultSnapshot,
  options: CapabilityDomainRerankOptions = {}
): CapabilityDomainRankedMatch[] {
  const topK = options.topK ?? 3;
  const excludedPaths = options.excludedPaths ?? new Set<string>();
  const documents = searchableRecords(snapshot, excludedPaths);
  const terms = queryTerms(query);
  const idf = inverseDocumentFrequency(documents);
  const graph = relationGraph(documents);
  const baselinePosition = new Map((options.baseline ?? []).map((entry, index) => [entry.sourcePath, index]));
  const directScores = new Map<string, number>();
  const scoreDetails = new Map<string, { score: number; reasons: string[]; systemIntended: boolean }>();
  const asOfDate = options.asOfDate ?? new Date().toISOString().slice(0, 10);

  for (const document of documents) {
    const lexical = lexicalScore(document, terms, idf);
    const intent = typeIntentScore(document.record.type, query);
    const lifecycle = lifecycleScore(document.record, query, asOfDate);
    const baselineRank = baselinePosition.get(document.record.relativePath);
    const baselineBoost = baselineRank === undefined ? 0 : 3 / (baselineRank + 1);
    let score = lexical + intent.score + lifecycle.score + baselineBoost;
    const reasons: string[] = [];
    if (lexical > 0) reasons.push("query overlap");
    reasons.push(...intent.reasons);
    if (lifecycle.reason) reasons.push(lifecycle.reason);
    if (baselineBoost > 0) reasons.push("baseline support");
    if (document.record.type === "system" && !intent.systemIntended) score -= 8;
    directScores.set(document.record.relativePath, score);
    scoreDetails.set(document.record.relativePath, { score, reasons, systemIntended: intent.systemIntended });
  }

  return documents
    .map((document) => {
      const detail = scoreDetails.get(document.record.relativePath)!;
      const neighborScores = [...(graph.get(document.record.relativePath) ?? [])]
        .map((neighbor) => Math.max(0, directScores.get(neighbor) ?? 0))
        .sort((left, right) => right - left)
        .slice(0, 2);
      const relationBoost = neighborScores.reduce((total, score) => total + score * 0.12, 0);
      const score = detail.score + relationBoost;
      const reasons = relationBoost > 0 ? [...detail.reasons, "one-hop relation"] : detail.reasons;
      return {
        id: document.record.id,
        title: document.record.title,
        sourcePath: document.record.relativePath,
        type: document.record.type,
        score: Number(score.toFixed(4)),
        reasons: [...new Set(reasons)]
      } satisfies CapabilityDomainRankedMatch;
    })
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, topK);
}
