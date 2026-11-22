import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ReactFlow, Background, MarkerType } from '@xyflow/react';
import type { Edge } from '@xyflow/react';
import { ArrowLeft, RefreshCw, Download, Link2 } from 'lucide-react';
import type { WorkflowGraph, RunStep, ExecTask } from '@omni/shared';
import { endpoints, getToken, wsUrl } from '../lib/api';
import type { TaskWsDown } from '@omni/shared';
import { usePoll, useEvents } from '../hooks/hooks';
import { Card, CardHeader, StatusBadge, Button, Spinner, Badge, EmptyState } from '../components/ui/ui';
import { useToast } from '../components/ui/toast';
import { fmtDuration, fmtRelative, downloadText, cn } from '../lib/utils';

interface RunDetail {
  id: string;
  defId: string;
  defName: string;
  status: string;
  createdAt: number;
  finishedAt: number | null;
  graph: WorkflowGraph;
  steps: RunStep[];
}

const statusTone: Record<string, 'default' | 'success' | 'warn' | 'danger' | 'info' | 'violet'> = {
  success: 'success',
  running: 'info',
  queued: 'warn',
  pending: 'default',
  failed: 'danger',
  timeout: 'danger',
  cancelled: 'default',
  skipped: 'default',
};

const statusColorMap: Record<string, string> = {
  success: '#34d399',
  running: '#22d3ee',
  queued: '#fbbf24',
  pending: '#52525b',
  failed: '#fb7185',
  timeout: '#fb923c',
  cancelled: '#71717a',
  skipped: '#52525b',
};

export function WorkflowRunPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { data: run, reload } = usePoll<RunDetail | null>(() => endpoints.run(id!) as Promise<RunDetail>, 8000);
  useEvents();
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const autoFollow = useRef(false);

  // auto-follow the first running step
  useEffect(() => {
    if (!run || autoFollow.current) return;
    const active = run.steps.find((s) => s.status === 'running');
    if (active) {
      setSelectedStep(active.stepId);
      autoFollow.current = true;
    } else if (run.steps.length) {
      setSelectedStep(run.steps[0].stepId);
      autoFollow.current = true;
    }
  }, [run]);

  const step = run?.steps.find((s) => s.stepId === selectedStep) ?? null;

  const edges: Edge[] = useMemo(() => {
    if (!run) return [];
    return run.graph.edges.map((e) => {
      const src = run.steps.find((s) => s.stepId === e.source);
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        animated: src?.status === 'running',
        style: { stroke: src ? (statusColorMap[src.status] ?? '#3f3f46') : '#3f3f46', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: src ? (statusColorMap[src.status] ?? '#3f3f46') : '#3f3f46' },
      };
    });
  }, [run]);

  const rfNodes = useMemo(() => {
    if (!run) return [];
    return run.graph.nodes.map((n) => {
      const st = run.steps.find((s) => s.stepId === n.id);
      const status = (st?.status ?? 'pending') as string;
      return {
        id: n.id,
        position: n.position ?? { x: 0, y: 0 },
        data: {
          label: `${statusColorMap[status] ?? '#52525b'}■ ${n.data.label || n.id}` as string,
          type: (n.data.type === 'webhook' ? 'webhook' : 'script') as string,
          status,
        },
        draggable: false,
        selectable: true,
        style: {
          background: '#18181d',
          color: '#e4e4e7',
          border: `1.5px solid ${statusColorMap[status] ?? '#3f3f46'}`,
          borderRadius: 10,
          fontSize: 12,
          padding: 8,
          width: 170,
        },
      };
    });
  }, [run]);

  if (!run) {
    return (
      <div className="flex justify-center py-24">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
      <button onClick={() => (window.history.length > 1 ? window.history.back() : undefined)} className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 mb-3">
        <ArrowLeft className="h-3.5 w-3.5" /> 返回
      </button>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-lg font-bold text-zinc-100">
            {run.defName}
            <span className="ml-3 align-middle"><StatusBadge status={run.status} /></span>
          </h1>
          <p className="text-xs text-zinc-500 mt-1 font-mono flex items-center gap-1">
            <Link2 className="h-3 w-3" /> {run.id}
            {run.defId && (
              <Link to={`/workflows/${run.defId}/edit`} className="ml-2 text-cyan-400 hover:text-cyan-300 no-underline">
                编辑工作流 →
              </Link>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="violet">开始 {fmtRelative(run.createdAt)}</Badge>
          {run.finishedAt && <Badge tone="default">结束 {fmtRelative(run.finishedAt)}</Badge>}
          <Button size="sm" variant="ghost" onClick={() => reload()}>
            <RefreshCw className="h-3.5 w-3.5" /> 刷新
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        {/* graph */}
        <Card className="xl:col-span-3 overflow-hidden">
          <CardHeader title="执行视图" subtitle="节点颜色 = 步骤状态" />
          <div className="h-[420px]">
            <ReactFlow
              nodes={rfNodes}
              edges={edges}
              nodeTypes={{}}
              fitView
              fitViewOptions={{ padding: 0.18 }}
              minZoom={0.3}
              maxZoom={1.4}
              proOptions={{ hideAttribution: true }}
              nodesDraggable={false}
              onNodeClick={(_, n) => setSelectedStep(n.id)}
              defaultEdgeOptions={{ animated: true }}
            >
              <Background color="#1c1c21" gap={22} />
            </ReactFlow>
          </div>
          <div className="px-4 pb-3 flex flex-wrap gap-x-4 gap-y-1">
            {Object.entries({ success: '成功', running: '运行中', queued: '排队', pending: '等待', failed: '失败', skipped: '跳过' }).map(([k, v]) => (
              <span key={k} className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500">
                <span className="h-2 w-2 rounded-full" style={{ background: statusColorMap[k] }} /> {v}
              </span>
            ))}
          </div>
        </Card>

        {/* steps + logs */}
        <div className="xl:col-span-2 space-y-4">
          <Card>
            <CardHeader title="步骤时间线" subtitle="点击查看对应日志" />
            <div className="p-3 space-y-2 max-h-56 overflow-y-auto">
              {run.steps.map((s) => (
                <button
                  key={s.stepId}
                  onClick={() => setSelectedStep(s.stepId)}
                  className={cn(
                    'w-full flex items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-colors',
                    selectedStep === s.stepId ? 'border-cyan-500/40 bg-cyan-500/10' : 'border-zinc-800 hover:border-zinc-700',
                  )}
                >
                  <div className="min-w-0">
                    <div className="text-sm text-zinc-200 truncate">
                      <span className="inline-block h-2 w-2 rounded-full mr-2" style={{ background: statusColorMap[s.status] ?? '#52525b' }} />
                      {s.label}
                    </div>
                    <div className="text-[10px] text-zinc-600 mt-0.5">
                      {s.type === 'webhook' ? 'Webhook' : `脚本 · ${s.taskIds.length} 个任务`}
                      {s.startedAt && ` · ${fmtRelative(s.startedAt)}`}
                      {s.finishedAt && s.startedAt && ` · 耗时 ${fmtDuration(s.finishedAt - s.startedAt)}`}
                    </div>
                  </div>
                  <StatusBadge status={s.status} />
                </button>
              ))}
            </div>
          </Card>

          <StepLogs step={step} />
        </div>
      </div>
    </div>
  );
}

function StepLogs({ step }: { step: RunStep | null }) {
  const toast = useToast();
  const [logs, setLogs] = useState<Record<string, { text: string; task?: ExecTask }>>({});
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const socketsRef = useRef<WebSocket[]>([]);

  const taskIds = step?.taskIds ?? [];
  const tasksKey = taskIds.join(',');

  // fetch final logs for finished tasks + open live sockets for running ones
  useEffect(() => {
    setLogs({});
    setStatus(null);
    socketsRef.current.forEach((ws) => ws.close());
    socketsRef.current = [];
    if (!step || taskIds.length === 0) return;

    const fetchTask = async (tid: string) => {
      const t = await endpoints.task(tid);
      return t;
    };

    (async () => {
      setLoadingTasks(true);
      for (const tid of taskIds) {
        try {
          const t = await fetchTask(tid);
          setLogs((prev) => ({ ...prev, [tid]: { text: t.logTail ?? '', task: t } }));
          setStatus(t.status);
          if (t.status === 'running' || t.status === 'queued') {
            const ws = new WebSocket(wsUrl(`/api/ws/task/${tid}`));
            socketsRef.current.push(ws);
            ws.onmessage = (ev) => {
              try {
                const msg = JSON.parse(ev.data as string) as TaskWsDown;
                if (msg.type === 'tail') {
                  setLogs((prev) => ({ ...prev, [tid]: { text: prev[tid]?.text || msg.data, task: prev[tid]?.task } }));
                } else if (msg.type === 'stream') {
                  const chunk = atob(msg.dataB64);
                  setLogs((prev) => ({
                    ...prev,
                    [tid]: { text: (prev[tid]?.text ?? '') + chunk, task: prev[tid]?.task },
                  }));
                } else if (msg.type === 'result') {
                  setStatus(msg.status);
                  void fetchTask(tid).then((t) => setLogs((prev) => ({ ...prev, [tid]: { text: prev[tid]?.text ?? '', task: t } })));
                }
              } catch {
                /* ignore */
              }
            };
            ws.onclose = () => {
              // refresh final state
              void fetchTask(tid).then((t) => {
                setLogs((prev) => ({ ...prev, [tid]: { text: (prev[tid]?.text ?? '') || (t.logTail ?? ''), task: t } }));
                setStatus(t.status);
              }).catch(() => {});
            };
          }
        } catch (e) {
          toast(e instanceof Error ? e.message : '获取任务失败', 'error');
        }
      }
      setLoadingTasks(false);
    })();

    return () => {
      socketsRef.current.forEach((ws) => ws.close());
      socketsRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasksKey]);

  // auto-scroll
  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [logs]);

  const combined = useMemo(() => {
    const parts: string[] = [];
    for (const tid of taskIds) {
      const entry = logs[tid];
      if (!entry) continue;
      const header = taskIds.length > 1 ? `\n── 任务 ${tid} (${entry.task?.status ?? ''}) ──\n` : '';
      parts.push(header + (entry.text || ''));
    }
    const text = parts.join('\n');
    if (!filter) return text;
    return text
      .split('\n')
      .filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
      .join('\n');
  }, [logs, taskIds, filter]);

  if (!step) {
    return (
      <Card>
        <EmptyState title="选择一个步骤查看日志" />
      </Card>
    );
  }

  const anyRunning = Object.values(logs).some((l) => l.task?.status === 'running' || l.task?.status === 'queued');

  const downloadLog = async (tid: string) => {
    try {
      const qs = new URLSearchParams({ token: getToken() ?? '' });
      const res = await fetch(`/api/tasks/${tid}/log?${qs.toString()}`);
      const text = await res.text();
      downloadText(`${tid}.log`, text);
    } catch (e) {
      toast(e instanceof Error ? e.message : '下载失败', 'error');
    }
  };

  return (
    <Card>
      <CardHeader
        title={`日志 · ${step.label}`}
        subtitle={status ? <StatusBadge status={status} /> : loadingTasks ? '加载中…' : undefined}
        actions={
          taskIds.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => taskIds.forEach((t) => downloadLog(t))}>
              <Download className="h-3.5 w-3.5" /> 下载日志
            </Button>
          )
        }
      />
      <div className="px-4 pt-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="关键词过滤日志…"
          className="input !py-1.5 !text-xs"
        />
      </div>
      <pre
        ref={preRef}
        className={cn(
          'm-3 mt-2 p-3 rounded-lg bg-zinc-950/70 border border-zinc-800/60 text-[11px] leading-relaxed font-mono text-zinc-300 whitespace-pre-wrap max-h-72 overflow-y-auto',
          anyRunning && 'animate-fade-up',
        )}
      >
        {combined || (anyRunning ? '等待输出…' : '(无日志输出)')}
        {anyRunning && <span className="inline-block w-2 h-3.5 bg-cyan-400 animate-pulse-dot align-middle ml-0.5" />}
      </pre>
    </Card>
  );
}
