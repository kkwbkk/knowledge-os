import { useState } from "react";
import type {
  ViewerCapabilityBlindArtifact,
  ViewerCapabilityBlindChoice,
  ViewerCapabilityBlindQuestion,
  ViewerCapabilityBlindResult
} from "../lib";

type CapabilityBlindTestProps = {
  artifact: ViewerCapabilityBlindArtifact | null;
  error?: string;
};

type BlindAnswers = Partial<Record<string, ViewerCapabilityBlindChoice>>;

const CHOICE_LABELS: Record<ViewerCapabilityBlindChoice, string> = {
  left: "左边更有用",
  right: "右边更有用",
  both: "两边都有用",
  neither: "两边都不好"
};

function storageKey(sourceHash: string): string {
  return `swarmvault:capability-blind:v1:${sourceHash}`;
}

function readAnswers(sourceHash: string): BlindAnswers {
  try {
    const raw = window.localStorage.getItem(storageKey(sourceHash));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { version?: unknown; sourceHash?: unknown; answers?: unknown };
    if (parsed.version !== 1 || parsed.sourceHash !== sourceHash || !parsed.answers || typeof parsed.answers !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed.answers).filter(
        (entry): entry is [string, ViewerCapabilityBlindChoice] =>
          typeof entry[1] === "string" && ["left", "right", "both", "neither"].includes(entry[1])
      )
    );
  } catch {
    return {};
  }
}

function writeAnswers(sourceHash: string, answers: BlindAnswers): void {
  try {
    window.localStorage.setItem(storageKey(sourceHash), JSON.stringify({ version: 1, sourceHash, answers }));
  } catch {
    // Keep the current session usable when local browser storage is unavailable.
  }
}

function ResultList({ side, results }: { side: "left" | "right"; results: ViewerCapabilityBlindResult[] }) {
  return (
    <section className="blind-result-group" aria-label={`${side === "left" ? "Left" : "Right"} result group`}>
      <h4>{side === "left" ? "左边" : "右边"}</h4>
      <ol>
        {results.map((result) => (
          <li key={result.sourcePath}>
            <span className="label">{result.type}</span>
            <a href={result.obsidianUri}>{result.title}</a>
            <span className="text-mono text-xs">{result.sourcePath}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function QuestionComparison({ question }: { question: ViewerCapabilityBlindQuestion }) {
  return (
    <>
      <header className="blind-question-heading">
        <span className="text-mono text-xs">{question.id}</span>
        <h3>{question.question}</h3>
      </header>
      <div className="blind-comparison">
        <ResultList side="left" results={question.left} />
        <ResultList side="right" results={question.right} />
      </div>
    </>
  );
}

export function CapabilityBlindTest({ artifact, error }: CapabilityBlindTestProps) {
  const [answers, setAnswers] = useState<BlindAnswers>(() => (artifact ? readAnswers(artifact.sourceHash) : {}));
  const [activeIndex, setActiveIndex] = useState(0);

  if (error) return <p className="text-error">{error}</p>;
  if (!artifact?.questions.length) return <p className="text-muted text-sm">尚未生成本地盲测材料。</p>;

  const completed = artifact.questions.filter((question) => Boolean(answers[question.id])).length;
  const question = artifact.questions[Math.min(activeIndex, artifact.questions.length - 1)];
  const answer = answers[question.id];

  const choose = (choice: ViewerCapabilityBlindChoice) => {
    const next = { ...answers, [question.id]: choice };
    setAnswers(next);
    writeAnswers(artifact.sourceHash, next);
    const nextUnanswered = artifact.questions.findIndex((candidate, index) => index > activeIndex && !next[candidate.id]);
    if (nextUnanswered >= 0) setActiveIndex(nextUnanswered);
  };

  const reset = () => {
    setAnswers({});
    writeAnswers(artifact.sourceHash, {});
    setActiveIndex(0);
  };

  return (
    <section className="capability-blind-test" aria-label="Capability OS blind comparison">
      <div className="blind-test-intro">
        <div>
          <strong>只判断哪组来源更有用</strong>
          <p className="text-muted text-xs">左右身份已隐藏；允许选择“两边都不好”。选择只保存在这台电脑的浏览器里。</p>
        </div>
        <span className="text-mono text-xs">
          {completed}/{artifact.questionCount}
        </span>
      </div>

      <nav className="blind-question-nav" aria-label="Blind test questions">
        {artifact.questions.map((candidate, index) => (
          <button
            type="button"
            key={candidate.id}
            className={`btn${index === activeIndex ? " is-active" : ""}${answers[candidate.id] ? " is-complete" : ""}`}
            onClick={() => setActiveIndex(index)}
            aria-current={index === activeIndex ? "step" : undefined}
            aria-label={`${candidate.id}${answers[candidate.id] ? `, ${CHOICE_LABELS[answers[candidate.id]!]}` : ", unanswered"}`}
          >
            {candidate.id.replace("Q", "")}
          </button>
        ))}
      </nav>

      <QuestionComparison question={question} />

      <fieldset className="blind-choice-grid">
        <legend className="sr-only">Choose the more useful results for {question.id}</legend>
        {artifact.choices.map((choice) => (
          <button
            type="button"
            key={choice}
            className={`btn${answer === choice ? " btn-primary" : ""}`}
            onClick={() => choose(choice)}
            aria-pressed={answer === choice}
          >
            {CHOICE_LABELS[choice]}
          </button>
        ))}
      </fieldset>

      <footer className="blind-test-footer">
        <div className="card-row">
          <button
            type="button"
            className="btn"
            onClick={() => setActiveIndex((index) => Math.max(0, index - 1))}
            disabled={activeIndex === 0}
          >
            上一题
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setActiveIndex((index) => Math.min(artifact.questions.length - 1, index + 1))}
            disabled={activeIndex === artifact.questions.length - 1}
          >
            下一题
          </button>
        </div>
        {completed === artifact.questionCount ? (
          <p className="text-success text-xs">{artifact.questionCount} 题已完成。回到 Codex 告诉我“盲测已完成”即可。</p>
        ) : (
          <p className="text-muted text-xs">还剩 {artifact.questionCount - completed} 题。</p>
        )}
        <button type="button" className="btn btn-ghost" onClick={reset} disabled={completed === 0}>
          清空本机选择
        </button>
      </footer>
    </section>
  );
}
