import { useMemo, useState } from "react";
import type { ViewerCapabilityAdmission, ViewerCapabilityOsArtifact, ViewerCapabilityRecord, ViewerCapabilityRelation } from "../lib";

type CapabilityOsPanelProps = {
  artifact: ViewerCapabilityOsArtifact | null;
  error?: string;
};

const LANE_LABELS: Record<ViewerCapabilityAdmission, string> = {
  searchable: "Searchable",
  "review-only": "Review only",
  excluded: "Excluded",
  invalid: "Invalid"
};

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function RelationList({ relations, onSelectTarget }: { relations: ViewerCapabilityRelation[]; onSelectTarget: (id: string) => void }) {
  if (!relations.length) return <p className="text-muted text-xs">No typed one-hop relations.</p>;
  return (
    <ul className="capability-relations">
      {relations.map((relation) => (
        <li key={`${relation.field}:${relation.kind}:${relation.target}:${relation.targetId ?? "unresolved"}`}>
          <span className="label">{relation.kind}</span>
          {relation.targetId ? (
            <button type="button" className="link-button" onClick={() => onSelectTarget(relation.targetId!)}>
              {relation.targetTitle ?? relation.target}
            </button>
          ) : (
            <span>{relation.target}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function CapabilityDetail({ record, onSelectTarget }: { record: ViewerCapabilityRecord; onSelectTarget: (id: string) => void }) {
  return (
    <section className="capability-detail" aria-label={`Capability object ${record.title}`}>
      <div className="card-row capability-detail-heading">
        <span className="label">{record.type}</span>
        <span className={`admission-chip admission-${record.admission}`}>{LANE_LABELS[record.admission]}</span>
      </div>
      <h4>{record.title}</h4>
      <p className="text-mono text-xs">{record.id}</p>
      <dl className="capability-metadata">
        <div>
          <dt>Canonical source</dt>
          <dd>
            <a href={record.obsidianUri}>{record.canonicalPath}</a>
          </dd>
        </div>
        <div>
          <dt>Lifecycle</dt>
          <dd>{record.lifecycleStatus ?? "—"}</dd>
        </div>
        <div>
          <dt>Ingest</dt>
          <dd>{record.ingestStatus ?? "not controlled"}</dd>
        </div>
        <div>
          <dt>Admission reason</dt>
          <dd>{record.admissionReason}</dd>
        </div>
      </dl>
      <h4 className="capability-section-title">One-hop typed relations</h4>
      <RelationList relations={record.relations} onSelectTarget={onSelectTarget} />
      {record.issues.length ? (
        <div className="capability-issues">
          {record.issues.map((issue) => (
            <p key={`${issue.code}:${issue.field ?? "record"}:${issue.message}`} className="text-error">
              {issue.code}: {issue.message}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function CapabilityOsPanel({ artifact, error }: CapabilityOsPanelProps) {
  const [textFilter, setTextFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [laneFilter, setLaneFilter] = useState<ViewerCapabilityAdmission | "all">("all");
  const [lifecycleFilter, setLifecycleFilter] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [selectedPath, setSelectedPath] = useState("");

  const recordById = useMemo(() => new Map(artifact?.records.map((record) => [record.id, record]) ?? []), [artifact]);
  const recordByPath = useMemo(() => new Map(artifact?.records.map((record) => [record.canonicalPath, record]) ?? []), [artifact]);
  const filtered = useMemo(() => {
    const normalized = textFilter.trim().toLocaleLowerCase();
    return (artifact?.records ?? []).filter((record) => {
      if (typeFilter !== "all" && record.type !== typeFilter) return false;
      if (laneFilter !== "all" && record.admission !== laneFilter) return false;
      if (lifecycleFilter !== "all" && record.lifecycleStatus !== lifecycleFilter) return false;
      if (projectFilter !== "all" && !record.projectIds.includes(projectFilter)) return false;
      if (!normalized) return true;
      return `${record.title}\n${record.id}\n${record.sourcePath}`.toLocaleLowerCase().includes(normalized);
    });
  }, [artifact, laneFilter, lifecycleFilter, projectFilter, textFilter, typeFilter]);
  const selected = recordByPath.get(selectedPath) ?? filtered[0] ?? null;
  const selectRelationTarget = (id: string) => {
    const target = recordById.get(id);
    if (target) setSelectedPath(target.canonicalPath);
  };
  const lifecycleOptions = useMemo(
    () =>
      [
        ...new Set((artifact?.records ?? []).map((record) => record.lifecycleStatus).filter((value): value is string => Boolean(value)))
      ].sort(),
    [artifact]
  );

  if (error) return <p className="text-error">{error}</p>;
  if (!artifact) return <p className="text-muted text-sm">No Capability OS runtime is connected.</p>;

  return (
    <div className="capability-os-panel">
      <div className="capability-authority">
        <div>
          <span className="eyebrow">Canonical authority</span>
          <strong>{artifact.vaultName}</strong>
        </div>
        <span className="chip chip-static">derived view</span>
      </div>

      <fieldset className="capability-lane-grid">
        <legend className="sr-only">Admission lanes</legend>
        {artifact.admissionLanes.map((lane) => (
          <button
            type="button"
            key={lane}
            className={`capability-lane${laneFilter === lane ? " is-active" : ""}`}
            onClick={() => setLaneFilter((current) => (current === lane ? "all" : lane))}
            aria-pressed={laneFilter === lane}
          >
            <span>{LANE_LABELS[lane]}</span>
            <strong>{artifact.stats.byAdmission[lane] ?? 0}</strong>
          </button>
        ))}
      </fieldset>

      {artifact.evaluation ? (
        <section className={`capability-eval${artifact.evaluation.automatedGatePassed ? " is-passing" : " is-warning"}`}>
          <div className="card-row">
            <strong>Golden {artifact.evaluation.questionCount}</strong>
            <span className="chip chip-static">traceable {percent(artifact.evaluation.traceabilityRate)}</span>
            <span className="chip chip-static">leaks {artifact.evaluation.pendingLeakCount}</span>
          </div>
          <p className="text-xs text-secondary">
            Expected-reference match {percent(artifact.evaluation.expectedReferenceHitRate)} · usefulness still requires user rating.
          </p>
        </section>
      ) : (
        <p className="text-warning">Golden evaluation has not been run for this snapshot.</p>
      )}

      <div className="list-filter-bar">
        <input
          type="search"
          className="input"
          value={textFilter}
          onChange={(event) => setTextFilter(event.target.value)}
          placeholder="Filter canonical objects…"
          aria-label="Filter Capability OS objects"
        />
        <select
          className="input"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
          aria-label="Filter object type"
        >
          <option value="all">All 13 types</option>
          {artifact.objectTypes.map((type) => (
            <option key={type} value={type}>
              {type} ({artifact.stats.byType[type] ?? 0})
            </option>
          ))}
        </select>
        <select
          className="input"
          value={lifecycleFilter}
          onChange={(event) => setLifecycleFilter(event.target.value)}
          aria-label="Filter lifecycle status"
        >
          <option value="all">All lifecycle states</option>
          {lifecycleOptions.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={projectFilter}
          onChange={(event) => setProjectFilter(event.target.value)}
          aria-label="Filter related project"
        >
          <option value="all">All projects</option>
          {artifact.projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title} ({project.count})
            </option>
          ))}
        </select>
      </div>

      <p className="text-muted text-xs">
        Showing {filtered.length} of {artifact.records.length} · source {artifact.sourceHash.slice(0, 10)}
      </p>
      <div className="capability-browser">
        <div className="capability-object-list" role="listbox" aria-label="Capability OS objects">
          {filtered.map((record) => (
            <button
              type="button"
              key={record.canonicalPath}
              className={`capability-object${selected?.canonicalPath === record.canonicalPath ? " is-selected" : ""}`}
              onClick={() => setSelectedPath(record.canonicalPath)}
              role="option"
              aria-selected={selected?.canonicalPath === record.canonicalPath}
            >
              <span className="card-row">
                <span className="label">{record.type}</span>
                <span className={`admission-dot admission-${record.admission}`} title={LANE_LABELS[record.admission]} />
              </span>
              <strong>{record.title}</strong>
              <span className="text-mono text-xs">{record.sourcePath}</span>
            </button>
          ))}
          {!filtered.length ? <p className="text-muted text-sm">No canonical objects match these filters.</p> : null}
        </div>
        {selected ? <CapabilityDetail record={selected} onSelectTarget={selectRelationTarget} /> : null}
      </div>
    </div>
  );
}
