import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Server, Plus, Trash2, TerminalSquare, Search } from 'lucide-react';
import { endpoints } from '../lib/api';
import type { NodeInfo } from '@omni/shared';
import { usePoll } from '../hooks/hooks';
import { PageHeader, StatusDot, LabelChips } from '../components/bits';
import { Card, Badge, Button, Input, Spinner, EmptyState } from '../components/ui/ui';
import { Dialog } from '../components/ui/dialog';
import { useToast } from '../components/ui/toast';
import { fmtRelative, cn } from '../lib/utils';

export function Nodes() {
  const { data, reload, loading } = usePoll<NodeInfo[]>(() => endpoints.nodes(), 15000);
  const toast = useToast();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<NodeInfo | null>(null);

  const nodes = (data ?? []).filter((n) => {
    if (labelFilter && !n.labels.includes(labelFilter)) return false;
    if (query && !(n.name.toLowerCase().includes(query.toLowerCase()) || n.id.includes(query))) return false;
    return true;
  });
  const allLabels = [...new Set((data ?? []).flatMap((n) => n.labels))];

  const doDelete = async () => {
    if (!deleting) return;
    try {
      await endpoints.deleteNode(deleting.id);
      toast(`节点 ${deleting.name} 已删除`, 'success');
      setDeleting(null);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '删除失败', 'error');
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
      <PageHeader
        title="节点管理"
        description="所有接入的受控端探针 · 每 5 秒自动刷新"
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate('/settings')}>
            <Plus className="h-3.5 w-3.5" /> 注册密钥签发
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-600" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索节点名称或 ID…" className="pl-8" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setLabelFilter(null)}
            className={cn(
              'rounded-md border px-2 py-1 text-xs transition-colors',
              !labelFilter ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300',
            )}
          >
            全部
          </button>
          {allLabels.map((l) => (
            <button
              key={l}
              onClick={() => setLabelFilter(l === labelFilter ? null : l)}
              className={cn(
                'rounded-md border px-2 py-1 text-xs transition-colors',
                l === labelFilter ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300' : 'border-violet-500/25 bg-violet-500/10 text-violet-300 hover:border-violet-400/40',
              )}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {loading && !data ? (
        <div className="flex justify-center py-20"><Spinner /></div>
      ) : nodes.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Server className="h-8 w-8" />}
            title="还没有受控节点"
            description="在目标机器上运行 OmniMesh Agent（支持 Linux / Windows），使用「系统设置」中的注册密钥即可接入"
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px]">
              <thead className="border-b border-zinc-800/70">
                <tr>
                  <th className="th">节点</th>
                  <th className="th">状态</th>
                  <th className="th">分组标签</th>
                  <th className="th">系统</th>
                  <th className="th">地址</th>
                  <th className="th">最后心跳</th>
                  <th className="th">Agent</th>
                  <th className="th text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((n) => (
                  <tr key={n.id} className="border-b border-zinc-800/40 hover:bg-zinc-800/30 transition-colors">
                    <td className="td">
                      <Link to={`/nodes/${n.id}`} className="font-medium text-zinc-200 hover:text-cyan-300 transition-colors">
                        {n.name}
                      </Link>
                      <div className="text-[10px] text-zinc-600 font-mono">{n.id}</div>
                    </td>
                    <td className="td"><StatusDot status={n.status} /></td>
                    <td className="td"><LabelChips labels={n.labels} /></td>
                    <td className="td text-xs text-zinc-400">
                      {n.os || '—'} <span className="text-zinc-600">/</span> {n.arch || '—'}
                    </td>
                    <td className="td font-mono text-xs text-zinc-400">{n.ip || '—'}</td>
                    <td className="td text-xs text-zinc-500">{fmtRelative(n.lastSeen)}</td>
                    <td className="td"><Badge tone={n.version ? 'default' : 'warn'}>{n.version || '未知'}</Badge></td>
                    <td className="td">
                      <div className="flex items-center justify-end gap-1">
                        <Button size="icon" variant="ghost" title="打开终端" onClick={() => navigate(`/terminal?node=${n.id}`)}>
                          <TerminalSquare className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" title="删除节点" onClick={() => setDeleting(n)}>
                          <Trash2 className="h-4 w-4 text-rose-400/70" />
                        </Button>
                      </div>
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
        title="删除节点"
        footer={
          <>
            <Button size="sm" onClick={() => setDeleting(null)}>取消</Button>
            <Button size="sm" variant="danger" onClick={doDelete}>确认删除</Button>
          </>
        }
      >
        <p className="text-sm text-zinc-300">
          确定要删除节点 <span className="text-cyan-300 font-medium">{deleting?.name}</span> 吗？该节点的历史指标与终端会话将被移除。
        </p>
      </Dialog>
    </div>
  );
}
