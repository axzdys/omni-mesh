import { describe, expect, it } from 'vitest';
import { validateGraph, advance, type StepState } from '../src/dag';
import type { WorkflowGraph } from '@omni/shared';

function scriptNode(id: string, label = id): WorkflowGraph['nodes'][number] {
  return {
    id,
    position: { x: 0, y: 0 },
    data: { label, type: 'script', targetType: 'all', script: `echo ${id}` },
  };
}

function webNode(id: string): WorkflowGraph['nodes'][number] {
  return { id, position: { x: 0, y: 0 }, data: { label: id, type: 'webhook', url: 'https://example.com/hook' } };
}

function states(pairs: [string, StepState['status']][]): StepState[] {
  return pairs.map(([stepId, status]) => ({
    stepId,
    status,
    allTasksDone: true,
    allTasksSuccess: status === 'success',
    anyTimeout: false,
    error: null,
    exitCode: null,
  }));
}

describe('graph validation', () => {
  it('accepts a valid DAG', () => {
    const g: WorkflowGraph = {
      nodes: [scriptNode('a'), scriptNode('b'), webNode('c')],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'c' },
      ],
    };
    const v = validateGraph(g);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.roots).toEqual(['a']);
      expect(v.order).toEqual(['a', 'b', 'c']);
    }
  });

  it('detects cycles', () => {
    const g: WorkflowGraph = {
      nodes: [scriptNode('a'), scriptNode('b')],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'a' },
      ],
    };
    const v = validateGraph(g);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.issues.some((i) => i.message.includes('cycle'))).toBe(true);
  });

  it('rejects script nodes without script', () => {
    const g: WorkflowGraph = {
      nodes: [{ id: 'a', position: { x: 0, y: 0 }, data: { label: 'a', type: 'script', targetType: 'all' } }],
      edges: [],
    };
    const v = validateGraph(g);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.issues.length).toBeGreaterThan(0);
  });

  it('rejects webhook nodes with bad urls', () => {
    const v = validateGraph({ nodes: [{ id: 'a', position: { x: 0, y: 0 }, data: { label: 'a', type: 'webhook', url: 'ftp://x' } }], edges: [] });
    expect(v.ok).toBe(false);
  });

  it('rejects edges to unknown nodes', () => {
    const v = validateGraph({ nodes: [scriptNode('a')], edges: [{ id: 'e', source: 'a', target: 'ghost' }] });
    expect(v.ok).toBe(false);
  });
});

describe('DAG advancement', () => {
  function build(nodes: WorkflowGraph['nodes'], edges: { id: string; source: string; target: string }[]) {
    const v = validateGraph({ nodes, edges });
    if (!v.ok) throw new Error(v.issues.map((i) => i.message).join('; '));
    return v;
  }

  it('dispatches roots initially', () => {
    const v = build([scriptNode('a'), scriptNode('b')], [{ id: 'e1', source: 'a', target: 'b' }]);
    const res = advance(v, states([['a', 'pending'], ['b', 'pending']]));
    expect(res.dispatch).toEqual(['a']);
    expect(res.finished).toBe(false);
  });

  it('advances after root success', () => {
    const v = build([scriptNode('a'), scriptNode('b')], [{ id: 'e1', source: 'a', target: 'b' }]);
    const res = advance(v, states([['a', 'success'], ['b', 'pending']]));
    expect(res.dispatch).toEqual(['b']);
  });

  it('stops downstream on failure by default (transitively)', () => {
    const v = build(
      [scriptNode('a'), scriptNode('b'), scriptNode('c')],
      [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'c' },
      ],
    );
    const res = advance(v, states([['a', 'failed'], ['b', 'pending'], ['c', 'pending']]));
    // b skipped and c transitively skipped in the same pass
    expect(res.skip).toEqual(['b', 'c']);
    expect(res.finished).toBe(false); // caller still has to persist the skip marks
    const res2 = advance(v, states([['a', 'failed'], ['b', 'skipped'], ['c', 'skipped']]));
    expect(res2.finished).toBe(true);
    expect(res2.runStatus).toBe('failed');
  });

  it('continues downstream when onFailure=continue', () => {
    const a = scriptNode('a');
    (a.data as { onFailure?: string }).onFailure = 'continue';
    const v = build([a, scriptNode('b')], [{ id: 'e1', source: 'a', target: 'b' }]);
    const res = advance(v, states([['a', 'failed'], ['b', 'pending']]));
    expect(res.dispatch).toEqual(['b']);
  });

  it('runs parallel branches and waits at joins', () => {
    const v = build(
      [scriptNode('a'), scriptNode('b'), scriptNode('join')],
      [
        { id: 'e1', source: 'a', target: 'join' },
        { id: 'e2', source: 'b', target: 'join' },
      ],
    );
    const r1 = advance(v, states([['a', 'pending'], ['b', 'pending'], ['join', 'pending']]));
    expect(r1.dispatch.sort()).toEqual(['a', 'b']);
    const r2 = advance(v, states([['a', 'success'], ['b', 'running'], ['join', 'pending']]));
    expect(r2.dispatch).toEqual([]);
    const r3 = advance(v, states([['a', 'success'], ['b', 'success'], ['join', 'pending']]));
    expect(r3.dispatch).toEqual(['join']);
    const r4 = advance(v, states([['a', 'success'], ['b', 'success'], ['join', 'success']]));
    expect(r4.finished).toBe(true);
    expect(r4.runStatus).toBe('success');
  });

  it('marks a run successful when only skipped leaves remain', () => {
    const v = build([scriptNode('a'), scriptNode('b')], [{ id: 'e1', source: 'a', target: 'b' }]);
    const res = advance(v, states([['a', 'success'], ['b', 'skipped']]));
    expect(res.finished).toBe(true);
    expect(res.runStatus).toBe('success');
  });
});
