import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Play, Pencil, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { endpoints } from '../lib/api';
import type { WorkflowDef } from '@omni/shared';
import { usePoll, useEvents } from '../hooks/hooks';
import { PageHeader } from '../components/bits';
import { Card, Badge, Button, StatusBadge, Spinner, EmptyState } from '../components/ui/ui';
import { Dialog } from '../components/ui/dialog';
import { useToast } from '../components/ui/toast';
import { fmtRelative } from '../lib/utils';

interface RunSummary {
  id: string;
  defId: string;
  defName: string;
  status: string;
  createdAt: number;
  finishedAt: number | null;
}

export function Workflows() {
  const { data: defs, reload } = usePoll<WorkflowDef[]>(() => endpoints.workflows(), 15000);
  const { data: runs } = usePoll<RunSummary[]>(() => endpoints.runs(), 30000);
  useEvents();
  const navigate = useNavigate();
  const toast = useToast();
  const [deleting, setDeleting] = useState<WorkflowDef | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  const lastRunOf = (defId: string) => (runs ?? []).find((r) => r.defId === defId);

  const runNow = async (def: WorkflowDef) => {
    setRunning(def.id);
    try {
      const res = await endpoints.workflowRun(def.id);
      toast(`工作流已启动: ${def.name}`, 'success');
      navigate(`/workflow-runs/${res.runId}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : '启动失败', 'error');
    } finally {
      setRunning(null);
    }
  };

  const doDelete = async () => {
    if (!deleting) return;
    try {
      await endpoints.workflowDelete(deleting.id);
      toast(`已删除 ${deleting.name}`, 'success');
      setDeleting(null);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '删除失败', 'error');
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
      <PageHeader
        title="工作流编排"
        description="可视化 DAG 流水线：多节点协作、条件推进、Webhook 通知"
        actions={
          <Link to="/workflows/new">
            <Button size="sm" variant="primary">
              <Plus className="h-3.5 w-3.5" /> 新建工作流
            </Button>
          </Link>
        }
      />

      {(defs ?? []).length === 0 ? (
        <Card>
          <EmptyState
            icon={<WorkflowIcon className="h-8 w-8" />}
            title="还没有工作流"
            description="创建你的第一条 DAG 流水线，例如：节点 A 备份打包 → 节点 B 拉取归档 → Webhook 发送通知"
            actions={
              <Link to="/workflows/new">
                <Button size="sm" variant="primary">创建工作流</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {(defs ?? []).map((d) => {
            const lr = lastRunOf(d.id);
            return (
              <Card key={d.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <WorkflowIcon className="h-4 w-4 text-violet-300 shrink-0" />
                      <span className="font-semibold text-zinc-100 truncate">{d.name}</span>
                    </div>
                    <div className="text-xs text-zinc-500 mt-1">
                      {d.graph.nodes.length} 个步骤 · {d.graph.edges.length} 条依赖
                    </div>
                    {lr && (
                      <div className="flex items-center gap-2 mt-2 text-xs">
                        <StatusBadge status={lr.status} />
                        <span className="text-zinc-600">最近运行 {fmtRelative(lr.createdAt)}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="icon" variant="ghost" title="运行" onClick={() => runNow(d)} loading={running === d.id}>
                      <Play className="h-4 w-4 text-emerald-400" />
                    </Button>
                    <Link to={`/workflows/${d.id}/edit`}>
                      <Button size="icon" variant="ghost" title="编辑画布">
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </Link>
                    <Button size="icon" variant="ghost" title="删除" onClick={() => setDeleting(d)}>
                      <Trash2 className="h-4 w-4 text-rose-400/70" />
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {d.graph.nodes.slice(0, 6).map((n) => (
                    <Badge key={n.id} tone={n.data.type === 'webhook' ? 'violet' : 'info'}>
                      {n.data.label || n.id}
                    </Badge>
                  ))}
                  {d.graph.nodes.length > 6 && <Badge>+{d.graph.nodes.length - 6}</Badge>}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* run history */}
      <h2 className="text-sm font-semibold text-zinc-200 mt-8 mb-3">运行历史</h2>
      {(runs ?? []).length === 0 ? (
        <Card><EmptyState title="暂无运行记录" /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px]">
              <thead className="border-b border-zinc-800/70">
                <tr>
                  <th className="th">状态</th>
                  <th className="th">工作流</th>
                  <th className="th">开始时间</th>
                  <th className="th">结束时间</th>
                  <th className="th"></th>
                </tr>
              </thead>
              <tbody>
                {(runs ?? []).slice(0, 20).map((r) => (
                  <tr key={r.id} className="border-b border-zinc-800/40 hover:bg-zinc-800/30 transition-colors">
                    <td className="td"><StatusBadge status={r.status} /></td>
                    <td className="td text-zinc-200">{r.defName}</td>
                    <td className="td text-xs text-zinc-500">{fmtRelative(r.createdAt)}</td>
                    <td className="td text-xs text-zinc-500">{r.finishedAt ? fmtRelative(r.finishedAt) : '—'}</td>
                    <td className="td text-right">
                      <Link to={`/workflow-runs/${r.id}`} className="text-xs text-cyan-400 hover:text-cyan-300">
                        查看详情 →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="删除工作流"
        footer={
          <>
            <Button size="sm" onClick={() => setDeleting(null)}>取消</Button>
            <Button size="sm" variant="danger" onClick={doDelete}>确认删除</Button>
          </>
        }
      >
        <p className="text-sm text-zinc-300">确定要删除工作流 <span className="text-cyan-300">{deleting?.name}</span> 吗？运行历史会保留。</p>
      </Dialog>
    </div>
  );
}
