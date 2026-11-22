/**
 * DAG workflow graph validation & state machine advancement (pure logic).
 *
 * A workflow run stores one `run_steps` row per graph node. The Scheduler
 * dispatches every "root" step at start; whenever all tasks of a step finish,
 * `advance()` decides which successors become runnable and whether the run
 * is complete.
 */

import type { WorkflowGraph, WorkflowStepData, RunStepStatus } from '@omni/shared';

export interface GraphIssue {
  stepId: string;
  message: string;
}

export interface ValidatedGraph {
  ok: true;
  graph: WorkflowGraph;
  /** stepId -> list of downstream stepIds */
  successors: Map<string, string[]>;
  /** stepId -> list of upstream stepIds */
  predecessors: Map<string, string[]>;
  roots: string[];
  /** deterministic topological order (roots first) */
  order: string[];
}

export type ValidationResult = ValidatedGraph | { ok: false; issues: GraphIssue[] };

export function validateGraph(input: unknown): ValidationResult {
  const issues: GraphIssue[] = [];
  const g = input as WorkflowGraph;
  if (!g || typeof g !== 'object') return { ok: false, issues: [{ stepId: '*', message: 'graph must be an object' }] };
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
    return { ok: false, issues: [{ stepId: '*', message: 'graph.nodes and graph.edges are required arrays' }] };
  }
  if (g.nodes.length === 0) {
    return { ok: false, issues: [{ stepId: '*', message: 'workflow must contain at least one node' }] };
  }
  const ids = new Set<string>();
  for (const n of g.nodes) {
    if (!n.id || typeof n.id !== 'string') return { ok: false, issues: [{ stepId: '*', message: 'every node needs a string id' }] };
    if (ids.has(n.id)) issues.push({ stepId: n.id, message: `duplicate node id "${n.id}"` });
    ids.add(n.id);
    const d = n.data;
    if (!d || typeof d !== 'object') {
      issues.push({ stepId: n.id, message: 'node.data is required' });
      continue;
    }
    if (d.type === 'script') {
      if (!d.script || typeof d.script !== 'string') issues.push({ stepId: n.id, message: 'script node needs a script' });
      if (!['node', 'tag', 'all'].includes(d.targetType ?? 'node')) {
        issues.push({ stepId: n.id, message: 'script node targetType must be node|tag|all' });
      }
      if (d.targetType === 'node' && !d.targetValue) {
        issues.push({ stepId: n.id, message: 'script node with targetType=node needs targetValue (node id)' });
      }
      if (d.targetType === 'tag' && !d.targetValue) {
        issues.push({ stepId: n.id, message: 'script node with targetType=tag needs targetValue (label)' });
      }
    } else if (d.type === 'webhook') {
      if (!d.url || !/^https?:\/\//.test(d.url)) issues.push({ stepId: n.id, message: 'webhook node needs a valid http(s) url' });
    } else {
      issues.push({ stepId: n.id, message: `unknown node type "${(d as { type?: string }).type}"` });
    }
  }
  const successors = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  for (const id of ids) {
    successors.set(id, []);
    predecessors.set(id, []);
  }
  for (const e of g.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) {
      issues.push({ stepId: e.source ?? '*', message: `edge references unknown node (${e.source} -> ${e.target})` });
      continue;
    }
    if (e.source === e.target) {
      issues.push({ stepId: e.source, message: 'self-edge is not allowed' });
      continue;
    }
    successors.get(e.source)!.push(e.target);
    predecessors.get(e.target)!.push(e.source);
  }
  // cycle detection (Kahn)
  const indeg = new Map<string, number>();
  for (const [k, v] of predecessors) indeg.set(k, v.length);
  const queue = [...indeg.entries()].filter(([, v]) => v === 0).map(([k]) => k);
  let visited = 0;
  const roots: string[] = [];
  const indegCopy = new Map(indeg);
  while (queue.length) {
    const cur = queue.shift()!;
    visited++;
    for (const succ of successors.get(cur) ?? []) {
      const left = (indegCopy.get(succ) ?? 0) - 1;
      indegCopy.set(succ, left);
      if (left === 0) queue.push(succ);
    }
  }
  if (visited !== ids.size) {
    issues.push({ stepId: '*', message: 'workflow graph contains a cycle' });
  }
  for (const [k, v] of predecessors) if (v.length === 0) roots.push(k);
  if (issues.length) return { ok: false, issues };

  // deterministic topological order: predecessors before successors, roots first
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const p of predecessors.get(id) ?? []) visit(p);
    order.push(id);
  };
  for (const r of roots) visit(r);
  for (const id of ids) visit(id);

  return { ok: true, graph: g, successors, predecessors, roots, order };
}

export interface StepState {
  stepId: string;
  status: RunStepStatus;
  allTasksDone: boolean;
  allTasksSuccess: boolean;
  anyTimeout: boolean;
  error: string | null;
  exitCode: number | null;
}

export interface AdvanceResult {
  /** steps that should be dispatched now */
  dispatch: string[];
  /** mark these steps skipped (upstream failed, onFailure=stop) */
  skip: string[];
  finished: boolean;
  runStatus: 'running' | 'success' | 'failed' | 'cancelled';
}

/**
 * Decide the next wave. `states` covers every step of the run.
 * A failed step with onFailure='continue' lets successors run.
 */
export function advance(vg: ValidatedGraph, states: StepState[]): AdvanceResult {
  const byId = new Map(states.map((s) => [s.stepId, s]));
  const dispatch: string[] = [];
  const skip: string[] = [];

  for (const stepId of vg.successors.keys()) {
    const st = byId.get(stepId);
    if (!st || st.status !== 'pending') continue;
    const preds = vg.predecessors.get(stepId) ?? [];
    if (preds.length === 0) {
      dispatch.push(stepId);
      continue;
    }
    const allDone = preds.every((p) => {
      const ps = byId.get(p);
      return ps && ps.status !== 'pending' && ps.status !== 'running';
    });
    if (!allDone) continue;
    const failedPreds = preds.filter((p) => {
      const ps = byId.get(p)!;
      return ps.status === 'failed' || ps.status === 'timeout' || ps.status === 'cancelled';
    });
    const stopOnFailure = failedPreds.some((p) => {
      const node = vg.graph.nodes.find((n) => n.id === p);
      return (node?.data as WorkflowStepData | undefined)?.onFailure !== 'continue';
    });
    if (stopOnFailure) {
      skip.push(stepId);
    } else {
      dispatch.push(stepId);
    }
  }

  // transitively skip downstream of skipped steps
  const blocked = new Set(skip);
  let grew = true;
  while (grew) {
    grew = false;
    for (const stepId of vg.successors.keys()) {
      if (blocked.has(stepId)) continue;
      const st = byId.get(stepId);
      if (st && st.status !== 'pending') continue;
      const preds = vg.predecessors.get(stepId) ?? [];
      if (preds.length > 0 && preds.every((p) => blocked.has(p))) {
        skip.push(stepId);
        blocked.add(stepId);
        grew = true;
      }
    }
  }

  const finished = states.every((s) => s.status !== 'pending' && s.status !== 'running');
  const runStatus: AdvanceResult['runStatus'] = !finished
    ? 'running'
    : states.every((s) => s.status === 'success' || s.status === 'skipped')
      ? 'success'
      : 'failed';
  return { dispatch, skip, finished, runStatus };
}
