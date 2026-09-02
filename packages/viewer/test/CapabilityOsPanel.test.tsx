import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityOsPanel } from "../src/components/CapabilityOsPanel";
import type { ViewerCapabilityBlindArtifact, ViewerCapabilityOsArtifact, ViewerCapabilityRecord } from "../src/lib";

const objectTypes = [
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
];

function record(overrides: Partial<ViewerCapabilityRecord> = {}): ViewerCapabilityRecord {
  return {
    id: "kb-accepted",
    type: "knowledge",
    title: "Accepted Knowledge",
    sourcePath: "知识/accepted.md",
    canonicalPath: "能力操作系统/知识/accepted.md",
    obsidianUri: "obsidian://open?vault=Vault&file=accepted",
    lifecycleStatus: "active",
    ingestStatus: "accepted",
    visibility: "private",
    updatedAt: "2026-09-01",
    projectIds: ["project-alpha"],
    admission: "searchable",
    admissionReason: "Accepted content object.",
    relations: [{ field: "used_in", kind: "used-in", target: "Pending Learning", targetId: "kb-pending", targetTitle: "Pending Learning" }],
    issues: [],
    ...overrides
  };
}

function artifact(): ViewerCapabilityOsArtifact {
  return {
    kind: "capability-os-viewer",
    version: 1,
    generatedAt: "2026-09-01T00:00:00.000Z",
    sourceHash: "1234567890abcdef",
    canonicalAuthority: "obsidian-vault",
    derived: true,
    vaultName: "Vault",
    scopePath: "能力操作系统",
    objectTypes,
    admissionLanes: ["searchable", "review-only", "excluded", "invalid"],
    stats: {
      markdownFiles: 2,
      validObjects: 2,
      invalidObjects: 0,
      searchableObjects: 1,
      reviewOnlyObjects: 1,
      excludedObjects: 0,
      byType: { knowledge: 1, learning: 1 },
      byAdmission: { searchable: 1, "review-only": 1, excluded: 0, invalid: 0 }
    },
    projects: [{ id: "project-alpha", title: "Project Alpha", count: 2 }],
    records: [
      record(),
      record({
        id: "kb-pending",
        type: "learning",
        title: "Pending Learning",
        sourcePath: "收藏激活/内容模块/pending.md",
        canonicalPath: "能力操作系统/收藏激活/内容模块/pending.md",
        admission: "review-only",
        relations: []
      })
    ],
    evaluation: {
      questionCount: 30,
      expectedQuestionCount: 30,
      expectedReferenceCount: 90,
      traceableQuestions: 30,
      traceabilityRate: 1,
      questionsWithExpectedHit: 24,
      questionExpectedHitRate: 0.8,
      expectedReferencesHit: 40,
      expectedReferenceHitRate: 0.4444,
      pendingLeakCount: 0,
      missingExpectedReferenceCount: 0,
      averageDurationMs: 8,
      automatedGatePassed: true,
      relevanceState: "requires-user-rating"
    }
  };
}

function blindArtifact(): ViewerCapabilityBlindArtifact {
  return {
    kind: "capability-os-blind-evaluation",
    version: 1,
    generatedAt: "2026-09-02T00:00:00.000Z",
    sourceHash: "1234567890abcdef",
    questionCount: 1,
    choices: ["left", "right", "both", "neither"],
    questions: [
      {
        id: "Q03",
        question: "Which result group is more useful?",
        left: [
          {
            id: "kb-left",
            title: "Left Result",
            type: "learning",
            sourcePath: "知识/left.md",
            obsidianUri: "obsidian://open?vault=Vault&file=left"
          }
        ],
        right: [
          {
            id: "kb-right",
            title: "Right Result",
            type: "playbook",
            sourcePath: "方法/right.md",
            obsidianUri: "obsidian://open?vault=Vault&file=right"
          }
        ]
      }
    ]
  };
}

function render(artifactValue = artifact(), blindArtifactValue: ViewerCapabilityBlindArtifact | null = null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<CapabilityOsPanel artifact={artifactValue} blindArtifact={blindArtifactValue} />));
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    }
  };
}

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.body.replaceChildren();
});

describe("CapabilityOsPanel", () => {
  it("exposes all 13 object types, four admission lanes, canonical source, and evaluation safety metrics", () => {
    const handle = render();
    const typeOptions = handle.container.querySelectorAll('select[aria-label="Filter object type"] option');
    const laneButtons = handle.container.querySelectorAll("button[aria-pressed]");
    expect(typeOptions).toHaveLength(14);
    expect(handle.container.querySelectorAll('select[aria-label="Filter lifecycle status"] option')).toHaveLength(2);
    expect(handle.container.querySelectorAll('select[aria-label="Filter related project"] option')).toHaveLength(2);
    expect(laneButtons).toHaveLength(4);
    expect(handle.container.textContent).toContain("Golden 30");
    expect(handle.container.textContent).toContain("traceable 100%");
    const canonical = handle.container.querySelector('a[href^="obsidian://open"]');
    expect(canonical?.textContent).toBe("能力操作系统/知识/accepted.md");
    handle.cleanup();
  });

  it("filters the review lane and follows a resolved typed relation", () => {
    const handle = render();
    const reviewLane = Array.from(handle.container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")).find((button) =>
      button.textContent?.includes("Review only")
    );
    act(() => reviewLane?.click());
    expect(handle.container.textContent).toContain("Showing 1 of 2");
    expect(handle.container.textContent).toContain("Pending Learning");

    act(() => reviewLane?.click());
    const relation = Array.from(handle.container.querySelectorAll<HTMLButtonElement>(".link-button")).find(
      (button) => button.textContent === "Pending Learning"
    );
    act(() => relation?.click());
    expect(handle.container.querySelector(".capability-detail")?.textContent).toContain("kb-pending");
    handle.cleanup();
  });

  it("removes duplicate-id templates cleanly when a project filter is applied", () => {
    const value = artifact();
    value.records.push(
      record({
        id: "{{id}}",
        title: "{{title}}",
        sourcePath: "模板/a.md",
        canonicalPath: "能力操作系统/模板/a.md",
        projectIds: [],
        admission: "excluded",
        relations: []
      }),
      record({
        id: "{{id}}",
        title: "{{title}}",
        sourcePath: "模板/b.md",
        canonicalPath: "能力操作系统/模板/b.md",
        projectIds: [],
        admission: "excluded",
        relations: []
      })
    );
    const handle = render(value);
    expect(handle.container.querySelectorAll('[role="listbox"] [role="option"]')).toHaveLength(4);

    const project = handle.container.querySelector<HTMLSelectElement>('select[aria-label="Filter related project"]');
    act(() => {
      if (!project) return;
      project.value = "project-alpha";
      project.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(handle.container.textContent).toContain("Showing 2 of 4");
    expect(handle.container.querySelectorAll('[role="listbox"] [role="option"]')).toHaveLength(2);
    expect(handle.container.textContent).not.toContain("{{title}}");
    handle.cleanup();
  });

  it("offers a blinded comparison and stores only the local choice", () => {
    const handle = render(artifact(), blindArtifact());
    const blindTab = Array.from(handle.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((button) =>
      button.textContent?.includes("盲测")
    );
    act(() => blindTab?.click());

    expect(handle.container.textContent).toContain("Which result group is more useful?");
    expect(handle.container.textContent).toContain("Left Result");
    expect(handle.container.textContent).toContain("Right Result");
    const neither = Array.from(handle.container.querySelectorAll<HTMLButtonElement>(".blind-choice-grid button")).find(
      (button) => button.textContent === "两边都不好"
    );
    act(() => neither?.click());

    expect(handle.container.textContent).toContain("1/1");
    expect(handle.container.textContent).toContain("1 题已完成");
    const persisted = JSON.parse(window.localStorage.getItem("swarmvault:capability-blind:v1:1234567890abcdef") ?? "{}");
    expect(persisted.answers).toEqual({ Q03: "neither" });
    expect(JSON.stringify(persisted)).not.toContain("candidate");
    handle.cleanup();
  });
});
