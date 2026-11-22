import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ReactFlow, Background, Controls, MiniMap, Handle, Position,
  useNodesState, useEdgesState, addEdge, MarkerType,
  type Node, type Edge, type Connection, type NodeProps,
} from '@xyflow/react';
import { ArrowLeft, Save, Play, Code2, Globe, Plus, FileJson, Zap, Trash2 } from 'lucide-react';
import { endpoints } from '../lib/api';
import type { NodeInfo, WorkflowGraph, WorkflowStepData, ExecLang } from '@omni/shared';
import { usePoll } from '../hooks/hooks';
import { PageHeader } from '../components/bits';
import { Button, Input, Textarea, Select, Label, Badge, Spinner } from '../components/ui/ui';
import { Dialog } from '../components/ui/dialog';
import { useToast } from '../components/ui/toast';
import { cn } from '../lib/utils';

// ─── Custom node renderer ────────────────────────────────────────────────

/** React Flow v12 requires node data to extend Record<string, unknown>. */
type StepData = WorkflowStepData & Record<string, unknown>;
type RFNode = Node<StepData>;
type RFEdge = Edge;

function OmniNode({ data, selected }: NodeProps) {
  const d = data as unknown as WorkflowStepData & { stepId?: string };
  const isWebhook = d.type === 'webhook';
  return (
    <div
      className={cn(
        'rounded-xl border-2 bg-surface-raised shadow-panel px-3 py-2.5 min-w-[170px] transition-colors',
        selected ? 'border-cyan-400/70' : 'border-zinc-700',
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-cyan-500 !w-2.5 !h-2.5 !border-2 !border-zinc-900" />
      <div className="flex items-center gap-2">
        <span className={cn('rounded-md p-1.5', isWebhook ? 'bg-violet-500/15 text-violet-300' : 'bg-cyan-500/15 text-cyan-300')}>
          {isWebhook ? <Globe className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />}
        </span>
        <div className="min-w-0">
          <div className="text-xs font-semibold text-zinc-100 truncate max-w-[160px]">{d.label || d.stepId || '未命名'}</div>
          <div className="text-[10px] text-zinc-500 truncate">
            {isWebhook ? `${d.method ?? 'POST'} Webhook` : `脚本 · ${d.targetType === 'all' ? '全部节点' : d.targetType === 'tag' ? `标签 ${d.targetValue}` : '单节点'}`}
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-cyan-500 !w-2.5 !h-2.5 !border-2 !border-zinc-900" />
    </div>
  );
}

const nodeTypes = { omni: OmniNode };

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(++idCounter).toString(36)}`;

// ─── Editor ──────────────────────────────────────────────────────────────

export function WorkflowEditor() {
  const { id: editId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: nodesList } = usePoll<NodeInfo[]>(() => endpoints.nodes(), 30000);

  const [name, setName] = useState('未命名工作流');
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<RFNode>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<RFEdge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [loaded, setLoaded] = useState(false);

  const selected = rfNodes.find((n) => n.id === selectedId) ?? null;
  const allLabels = [...new Set((nodesList ?? []).flatMap((n) => n.labels))];

  // load existing definition
  useEffect(() => {
    if (!editId || loaded) return;
    endpoints
      .workflows()
      .then((defs) => {
        const def = defs.find((d) => d.id === editId);
        if (!def) {
          toast('工作流不存在', 'error');
          navigate('/workflows');
          return;
        }
        setName(def.name);
        const g = def.graph as WorkflowGraph;
        setRfNodes(
          g.nodes.map((n) => ({
            id: n.id,
            type: 'omni',
            position: n.position ?? { x: 0, y: 0 },
            data: { ...n.data, stepId: n.id } as StepData,
          })),
        );
        setRfEdges(
          g.edges.map((e) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            animated: true,
            style: { stroke: '#3f6f7f' },
            markerEnd: { type: MarkerType.ArrowClosed, color: '#3f6f7f' },
          })),
        );
        setLoaded(true);
      })
      .catch((e) => toast(e instanceof Error ? e.message : '加载失败', 'error'));
  }, [editId, loaded, setRfNodes, setRfEdges, toast, navigate]);

  // blank starter graph for new workflows
  useEffect(() => {
    if (editId || loaded || rfNodes.length > 0) return;
    setRfNodes([
      { id: 'step_a', type: 'omni', position: { x: 80, y: 60 }, data: { stepId: 'step_a', label: '步骤 A · 脚本', type: 'script', targetType: 'all', script: 'echo "hello from node A"', lang: 'shell', timeoutMs: 120000, retries: 0, onFailure: 'stop'
      } as StepData },
    ]);
    setLoaded(true);
  }, [editId, loaded, rfNodes.length, setRfNodes]);

  // automation bridge: apply a graph programmatically (same pattern as the
  // terminal's __omniSend) — the JSON dialog stays fully usable by hand
  useEffect(() => {
    (window as unknown as { __omniImport?: (name: string, json: string) => void }).__omniImport = (name: string, json: string) => {
      const parsed = JSON.parse(json) as { name?: string; graph?: WorkflowGraph } | WorkflowGraph;
      // accept both {name, graph} envelopes and bare graphs
      const g = 'graph' in parsed && parsed.graph ? parsed.graph : (parsed as WorkflowGraph);
      if (name) setName(name);
      setJsonText(JSON.stringify({ name, graph: g }));
      setRfNodes(
        g.nodes.map((n) => ({ id: n.id, type: 'omni', position: n.position ?? { x: 0, y: 0 }, data: { ...n.data, stepId: n.id } as StepData })),
      );
      setRfEdges(
        g.edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          animated: true,
          style: { stroke: '#3f6f7f' },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#3f6f7f' },
        })),
      );
      setSelectedId(null);
      setLoaded(true);
    };
    return () => {
      delete (window as unknown as { __omniImport?: unknown }).__omniImport;
    };
  }, []);

  const updateNodeData = useCallback(
    (nodeId: string, patch: Partial<WorkflowStepData>) => {
      setRfNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n)));
    },
    [setRfNodes],
  );

  const addNode = (type: 'script' | 'webhook') => {
    const id = nextId('step');
    const offset = rfNodes.length * 40;
    const node: RFNode = {
      id,
      type: 'omni',
      position: { x: 120 + offset, y: 180 + offset },
      data:
        type === 'script'
          ? { stepId: id, label: `步骤 ${rfNodes.length + 1} · 脚本`, type: 'script', targetType: 'all', script: 'echo "todo"', lang: 'shell', timeoutMs: 120000, retries: 0, onFailure: 'stop' }
          : { stepId: id, label: `通知 Webhook`, type: 'webhook', url: 'https://example.com/hook', method: 'POST', body: '{"text":"OmniMesh 任务完成"}' },
    };
    setRfNodes((nds) => [...nds, node]);
    setSelectedId(id);
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setRfNodes((nds) => nds.filter((n) => n.id !== selectedId));
    setRfEdges((eds) => eds.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
  };

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source === c.target) {
        toast('不能连接到自身', 'error');
        return;
      }
      // prevent duplicate edges
      if (rfEdges.some((e) => e.source === c.source && e.target === c.target)) {
        toast('依赖关系已存在', 'info');
        return;
      }
      setRfEdges((eds) =>
        addEdge({ id: nextId('edge'), source: c.source!, target: c.target!, animated: true, style: { stroke: '#3f6f7f' }, markerEnd: { type: MarkerType.ArrowClosed, color: '#3f6f7f' } }, eds),
      );
    },
    [rfEdges, setRfEdges, toast],
  );

  const buildGraph = useCallback((): WorkflowGraph => {
    return {
      nodes: rfNodes.map((n) => ({ id: n.id, position: n.position, data: stripInternal(n.data) })),
      edges: rfEdges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    };
  }, [rfNodes, rfEdges]);

  const save = async (runAfter?: boolean) => {
    if (rfNodes.length === 0) {
      toast('画布上至少需要一个节点', 'error');
      return;
    }
    const graph = buildGraph();
    setSaving(true);
    try {
      const v = await endpoints.workflowValidate(graph);
      if (!v.valid) {
        toast(`校验失败: ${v.issues[0]?.message ?? '未知问题'}`, 'error');
        return;
      }
      let defId = editId;
      if (defId) {
        await endpoints.workflowUpdate(defId, name, graph);
        toast('工作流已保存', 'success');
      } else {
        const res = await endpoints.workflowCreate(name, graph);
        defId = res.id;
        toast('工作流已创建', 'success');
      }
      if (runAfter && defId) {
        const res = await endpoints.workflowRun(defId);
        navigate(`/workflow-runs/${res.runId}`);
      } else if (defId && !editId) {
        navigate(`/workflows/${defId}/edit`, { replace: true });
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const openJson = () => {
    setJsonText(JSON.stringify(buildGraph(), null, 2));
    setJsonOpen(true);
  };

  const importJson = () => {
    try {
      const g = JSON.parse(jsonText) as WorkflowGraph;
      if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error('缺少 nodes/edges');
      setRfNodes(g.nodes.map((n) => ({ id: n.id, type: 'omni', position: n.position ?? { x: 0, y: 0 }, data: { ...n.data, stepId: n.id } as StepData })));
      setRfEdges(
        g.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, animated: true, style: { stroke: '#3f6f7f' }, markerEnd: { type: MarkerType.ArrowClosed, color: '#3f6f7f' } })),
      );
      setSelectedId(null);
      setJsonOpen(false);
      toast('导入成功', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'JSON 解析失败', 'error');
    }
  };

  const issues = useMemo(() => {
    const out: string[] = [];
    for (const n of rfNodes) {
      const d = n.data as WorkflowStepData;
      if (d.type === 'script') {
        if (!d.script?.trim()) out.push(`「${d.label}」缺少脚本内容`);
        if (d.targetType === 'node' && !d.targetValue) out.push(`「${d.label}」未选择目标节点`);
      } else if (d.type === 'webhook' && !/^https?:\/\//.test(d.url ?? '')) {
        out.push(`「${d.label}」Webhook URL 无效`);
      }
    }
    return out;
  }, [rfNodes]);

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 sm:px-6 pt-4 sm:pt-6">
        <button onClick={() => navigate('/workflows')} className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 mb-2">
          <ArrowLeft className="h-3.5 w-3.5" /> 返回工作流列表
        </button>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-[260px] font-medium" placeholder="工作流名称" />
          <Button size="sm" onClick={addNode.bind(null, 'script')}>
            <Code2 className="h-3.5 w-3.5" /> 添加脚本节点
          </Button>
          <Button size="sm" onClick={addNode.bind(null, 'webhook')}>
            <Globe className="h-3.5 w-3.5" /> 添加 Webhook 节点
          </Button>
          <div className="flex-1" />
          <Button size="sm" variant="outline" onClick={openJson}>
            <FileJson className="h-3.5 w-3.5" /> JSON 导入/导出
          </Button>
          <Button size="sm" variant="primary" loading={saving} onClick={() => save()}>
            <Save className="h-3.5 w-3.5" /> 保存
          </Button>
          <Button size="sm" variant="outline" onClick={() => save(true)}>
            <Play className="h-3.5 w-3.5 text-emerald-400" /> 保存并运行
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex gap-4 px-4 sm:px-6 pb-4">
        {/* canvas */}
        <div className="flex-1 min-w-0 rounded-xl border border-zinc-800/80 overflow-hidden relative bg-surface-raised/40">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            deleteKeyCode={['Backspace', 'Delete']}
            onEdgeClick={(_, edge) => {
              setRfEdges((eds) => eds.filter((e) => e.id !== edge.id));
              toast('已删除连线', 'info');
            }}
            fitView
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ animated: true, style: { stroke: '#3f6f7f' } }}
          >
            <Background color="#1c1c21" gap={22} />
            <Controls className="!bg-surface-overlay !border-zinc-800 !rounded-lg" showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              className="!bg-surface-overlay !border-zinc-800 !rounded-lg"
              nodeColor={(n) => ((n.data as unknown as WorkflowStepData)?.type === 'webhook' ? '#8b5cf6' : '#22d3ee')}
            />
            {rfNodes.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="text-center text-zinc-600">
                  <Zap className="h-8 w-8 mx-auto mb-2" />
                  <div className="text-sm">点击上方按钮添加节点，拖动节点边缘的圆点建立依赖连线</div>
                </div>
              </div>
            )}
          </ReactFlow>
          {issues.length > 0 && (
            <div className="absolute left-3 bottom-3 max-w-md rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300 pointer-events-none">
              {issues.slice(0, 3).map((i, idx) => (
                <div key={idx}>⚠ {i}</div>
              ))}
            </div>
          )}
        </div>

        {/* inspector */}
        <aside className="hidden xl:block w-80 shrink-0 rounded-xl border border-zinc-800/80 bg-surface-raised/60 overflow-y-auto">
          {selected ? (
            <Inspector
              node={selected}
              nodesList={nodesList ?? []}
              labels={allLabels}
              onChange={(patch) => updateNodeData(selected.id, patch as Partial<WorkflowStepData>)}
              onDelete={deleteSelected}
              nodeCount={rfNodes.length}
            />
          ) : (
            <div className="p-6 text-center text-xs text-zinc-600 space-y-2">
              <Zap className="h-6 w-6 mx-auto text-zinc-700" />
              <p>点击画布上的节点进行配置</p>
              <p className="text-zinc-700">从节点底部的圆点拖到另一节点顶部的圆点可建立依赖（成功后触发）。点击连线可删除。</p>
            </div>
          )}
        </aside>
      </div>

      <Dialog open={jsonOpen} onClose={() => setJsonOpen(false)} title="工作流 JSON" wide
        footer={
          <>
            <Button size="sm" onClick={() => setJsonOpen(false)}>关闭</Button>
            <Button size="sm" variant="primary" onClick={importJson}>导入此 JSON</Button>
          </>
        }
      >
        <Textarea rows={16} value={jsonText} onChange={(e) => setJsonText(e.target.value)} className="!text-xs" />
      </Dialog>
    </div>
  );
}

function stripInternal(d: StepData): WorkflowStepData {
  const { stepId: _ignored, ...rest } = d;
  void _ignored;
  return rest as WorkflowStepData;
}

// ─── Inspector panel ─────────────────────────────────────────────────────

function Inspector({
  node,
  nodesList,
  labels,
  onChange,
  onDelete,
  nodeCount,
}: {
  node: RFNode;
  nodesList: NodeInfo[];
  labels: string[];
  onChange: (patch: Partial<WorkflowStepData>) => void;
  onDelete: () => void;
  nodeCount: number;
}) {
  const d = node.data as WorkflowStepData;
  const [saving, setSaving] = useState(false);
  void setSaving;

  return (
    <div className="p-4 space-y-3.5 animate-fade-up">
      <div className="flex items-center justify-between">
        <Badge tone={d.type === 'webhook' ? 'violet' : 'info'}>{d.type === 'webhook' ? 'Webhook 节点' : '脚本节点'}</Badge>
        {nodeCount > 1 && (
          <Button size="sm" variant="ghost" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5 text-rose-400/70" /> 删除节点
          </Button>
        )}
      </div>
      <div>
        <Label>步骤名称</Label>
        <Input value={d.label ?? ''} onChange={(e) => onChange({ label: e.target.value })} />
      </div>

      {d.type === 'script' ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>目标类型</Label>
              <Select value={d.targetType ?? 'all'} onChange={(e) => onChange({ targetType: e.target.value as 'node' | 'tag' | 'all', targetValue: undefined })}>
                <option value="node">单节点</option>
                <option value="tag">标签组</option>
                <option value="all">全部在线节点</option>
              </Select>
            </div>
            <div>
              <Label>脚本语言</Label>
              <Select value={d.lang ?? 'shell'} onChange={(e) => onChange({ lang: e.target.value as ExecLang })}>
                <option value="shell">Shell</option>
                <option value="python">Python</option>
              </Select>
            </div>
          </div>
          {d.targetType === 'node' && (
            <div>
              <Label>目标节点</Label>
              <Select value={d.targetValue ?? ''} onChange={(e) => onChange({ targetValue: e.target.value })}>
                <option value="">— 选择节点 —</option>
                {nodesList.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name} ({n.status === 'online' ? '在线' : '离线'})
                  </option>
                ))}
              </Select>
            </div>
          )}
          {d.targetType === 'tag' && (
            <div>
              <Label>目标标签</Label>
              <Select value={d.targetValue ?? ''} onChange={(e) => onChange({ targetValue: e.target.value })}>
                <option value="">— 选择标签 —</option>
                {labels.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </Select>
            </div>
          )}
          <div>
            <Label>脚本内容</Label>
            <Textarea rows={7} value={d.script ?? ''} onChange={(e) => onChange({ script: e.target.value })} placeholder={'tar -czf /tmp/backup.tar.gz /data\nscp /tmp/backup.tar.gz nodeB:/backups/'} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>超时 (ms)</Label>
              <Input type="number" value={d.timeoutMs ?? 120000} onChange={(e) => onChange({ timeoutMs: Number(e.target.value) || 120000 })} />
            </div>
            <div>
              <Label>失败重试次数</Label>
              <Input type="number" min={0} max={10} value={d.retries ?? 0} onChange={(e) => onChange({ retries: Math.max(0, Number(e.target.value) || 0) })} />
            </div>
          </div>
          <div>
            <Label>失败后行为</Label>
            <Select value={d.onFailure ?? 'stop'} onChange={(e) => onChange({ onFailure: e.target.value as 'stop' | 'continue' })}>
              <option value="stop">停止整条流水线</option>
              <option value="continue">继续执行后续步骤</option>
            </Select>
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-1">
              <Label>方法</Label>
              <Select value={d.method ?? 'POST'} onChange={(e) => onChange({ method: e.target.value as 'GET' | 'POST' | 'PUT' })}>
                <option value="POST">POST</option>
                <option value="GET">GET</option>
                <option value="PUT">PUT</option>
              </Select>
            </div>
            <div className="col-span-2">
              <Label>URL</Label>
              <Input value={d.url ?? ''} onChange={(e) => onChange({ url: e.target.value })} placeholder="https://…" />
            </div>
          </div>
          <div>
            <Label>请求体 (JSON)</Label>
            <Textarea rows={5} value={d.body ?? ''} onChange={(e) => onChange({ body: e.target.value })} placeholder='{"text":"任务完成通知"}' />
          </div>
        </>
      )}
      {d.type === 'script' && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-[11px] text-zinc-500 space-y-1">
          <div className="flex items-center gap-1.5 text-zinc-400 font-medium"><Plus className="h-3 w-3" /> 环境变量（AES-GCM 加密存储）</div>
          <EnvEditor env={d.env ?? {}} onChange={(env) => onChange({ env })} />
        </div>
      )}
    </div>
  );
}

function EnvEditor({ env, onChange }: { env: Record<string, string>; onChange: (env: Record<string, string>) => void }) {
  const entries = Object.entries(env);
  return (
    <div className="space-y-1.5 mt-2">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-1.5">
          <Input
            value={k}
            onChange={(e) => {
              const next: Record<string, string> = {};
              for (const [kk, vv] of entries) next[kk === k ? e.target.value : kk] = vv;
              onChange(next);
            }}
            className="!text-[11px]"
            placeholder="KEY"
          />
          <Input value={v} onChange={(e) => onChange({ ...env, [k]: e.target.value })} className="!text-[11px]" placeholder="value" />
          <Button size="icon" variant="ghost" onClick={() => onChange(Object.fromEntries(entries.filter(([kk]) => kk !== k)))}>
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => onChange({ ...env, [`ENV_${entries.length + 1}`]: '' })}>
        <Plus className="h-3 w-3" /> 添加变量
      </Button>
    </div>
  );
}
