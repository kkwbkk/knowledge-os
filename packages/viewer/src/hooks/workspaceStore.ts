import { startTransition, useCallback, useEffect, useReducer, useRef } from "react";
import {
  fetchApprovalDetail,
  fetchApprovals,
  fetchCandidates,
  fetchCapabilityOsArtifact,
  fetchDoctorReport,
  fetchGraphArtifact,
  fetchGraphReport,
  fetchLintFindings,
  fetchMemoryTasks,
  fetchWatchStatus,
  type ViewerApprovalDetail,
  type ViewerApprovalSummary,
  type ViewerCandidateRecord,
  type ViewerCapabilityOsArtifact,
  type ViewerDoctorReport,
  type ViewerGraphArtifact,
  type ViewerGraphReport,
  type ViewerLintFinding,
  type ViewerMemoryTaskSummary,
  type ViewerWatchStatus
} from "../lib";

export type WorkspaceState = {
  graph: ViewerGraphArtifact | null;
  graphReport: ViewerGraphReport | null;
  approvals: ViewerApprovalSummary[];
  approvalDetail: ViewerApprovalDetail | null;
  candidates: ViewerCandidateRecord[];
  capabilityOs: ViewerCapabilityOsArtifact | null;
  memoryTasks: ViewerMemoryTaskSummary[];
  watchStatus: ViewerWatchStatus | null;
  lintFindings: ViewerLintFinding[];
  doctorReport: ViewerDoctorReport | null;
  loading: boolean;
  errors: {
    graph?: string;
    approval?: string;
    candidate?: string;
    capabilityOs?: string;
    memory?: string;
    watch?: string;
    lint?: string;
    doctor?: string;
  };
};

type Action =
  | { type: "snapshot"; payload: Partial<WorkspaceState> }
  | { type: "approvalDetail"; payload: { detail: ViewerApprovalDetail | null; error?: string } }
  | { type: "error"; key: keyof WorkspaceState["errors"]; message: string | undefined }
  | { type: "loading"; value: boolean };

export const emptyGraph = (): ViewerGraphArtifact => ({
  generatedAt: "",
  nodes: [],
  edges: [],
  hyperedges: [],
  communities: [],
  pages: []
});

const initialState: WorkspaceState = {
  graph: null,
  graphReport: null,
  approvals: [],
  approvalDetail: null,
  candidates: [],
  capabilityOs: null,
  memoryTasks: [],
  watchStatus: null,
  lintFindings: [],
  doctorReport: null,
  loading: true,
  errors: {}
};

function reducer(state: WorkspaceState, action: Action): WorkspaceState {
  switch (action.type) {
    case "snapshot":
      return {
        ...state,
        ...action.payload,
        errors: { ...state.errors, ...((action.payload as Partial<WorkspaceState>).errors ?? {}) },
        loading: false
      };
    case "approvalDetail":
      return {
        ...state,
        approvalDetail: action.payload.detail,
        errors: { ...state.errors, approval: action.payload.error }
      };
    case "error":
      return { ...state, errors: { ...state.errors, [action.key]: action.message } };
    case "loading":
      return { ...state, loading: action.value };
    default:
      return state;
  }
}

export function useWorkspaceStore() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const errors: WorkspaceState["errors"] = {};
      const [graph, approvals, candidates, capabilityOs, memoryTasks, watchStatus, lintFindings, doctorReport] = await Promise.all([
        fetchGraphArtifact().catch(() => emptyGraph()),
        fetchApprovals().catch((error: unknown) => {
          errors.approval = error instanceof Error ? error.message : String(error);
          return [] as ViewerApprovalSummary[];
        }),
        fetchCandidates().catch((error: unknown) => {
          errors.candidate = error instanceof Error ? error.message : String(error);
          return [] as ViewerCandidateRecord[];
        }),
        fetchCapabilityOsArtifact().catch((error: unknown) => {
          errors.capabilityOs = error instanceof Error ? error.message : String(error);
          return null;
        }),
        fetchMemoryTasks().catch((error: unknown) => {
          errors.memory = error instanceof Error ? error.message : String(error);
          return [] as ViewerMemoryTaskSummary[];
        }),
        fetchWatchStatus().catch((error: unknown) => {
          errors.watch = error instanceof Error ? error.message : String(error);
          return { generatedAt: "", watchedRepoRoots: [], pendingSemanticRefresh: [] } as ViewerWatchStatus;
        }),
        fetchLintFindings().catch((error: unknown) => {
          errors.lint = error instanceof Error ? error.message : String(error);
          return [] as ViewerLintFinding[];
        }),
        fetchDoctorReport().catch((error: unknown) => {
          errors.doctor = error instanceof Error ? error.message : String(error);
          return null;
        })
      ]);
      const graphReport = await fetchGraphReport().catch(() => null);
      startTransition(() => {
        dispatch({
          type: "snapshot",
          payload: {
            graph,
            graphReport,
            approvals,
            candidates,
            capabilityOs,
            memoryTasks,
            watchStatus,
            lintFindings,
            doctorReport,
            errors
          }
        });
      });
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadApprovalDetail = useCallback(async (approvalId: string | undefined) => {
    if (!approvalId) {
      dispatch({ type: "approvalDetail", payload: { detail: null } });
      return;
    }
    try {
      const detail = await fetchApprovalDetail(approvalId);
      dispatch({ type: "approvalDetail", payload: { detail } });
    } catch (error) {
      dispatch({
        type: "approvalDetail",
        payload: { detail: null, error: error instanceof Error ? error.message : String(error) }
      });
    }
  }, []);

  return { state, refresh, loadApprovalDetail, dispatch };
}
