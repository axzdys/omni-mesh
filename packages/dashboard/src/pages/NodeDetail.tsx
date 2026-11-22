import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, TerminalSquare, Cpu, MemoryStick, HardDrive, Wifi, Play, RefreshCw } from 'lucide-react';
import { endpoints, type MetricsData } from '../lib/api';
import type { NodeInfo, ExecTask } from '@omni/shared';
import { usePoll } from '../hooks/hooks';
import { PageHeader, StatusDot, LabelChips } from '../components/bits';
import { Card, CardHeader, Badge, Button, Select, Textarea, StatusBadge, Spinner, Label, EmptyState } from '../components/ui/ui';
import { Dialog } from '../components/ui/dialog';
import { MetricChart, ChartLegend } from '../components/MetricChart';
import { useToast } from '../components/ui/toast';
import { cn, fmtBps, fmtBytes, fmtDuration, fmtPct, fmtRelative, fmtUptime } from '../lib/utils';

type Range = '1h' | '24h' | '7d';

export function NodeDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [range, setRange] = useState<Range>('1h');
  const { data: node, reload: reloadNode } = usePoll<NodeInfo | null>(() => endpoints.node(id!), 15000);
  const { data: metrics } = usePoll<MetricsData | null>(() => endpoints.metrics(id!, range), 10000, [range]);
  const [execOpen, setExecOpen] = useState(false);
  const [script, setScript] = useState('echo hello-omnimesh && uname -a');
  const [running, setRunning] = useState(false);
  const [lastTask, setLastTask] = useState<ExecTask | null>(null);

  const m = metrics?.latest;
  const hasDiskIO = (metrics?.points ?? []).some((p) => p.diskReadBps != null || p.diskWriteBps != null);

  const quickExec = async () => {
    setRunning(true);
    try {
      const res = await endpoints.exec({ targetType: 'node', targetValue: id, script, lang: 'shell', timeoutMs: 60_000 });
      const taskId = res.tasks[0]?.taskId;
      // wait briefly and pull the task to show result
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const t = await endpoints.task(taskId);
        if (t.status !== 'queued' && t.status !== 'running') {
          setLastTask(t);
          setExecOpen(false);
          toast(`任务完成: ${t.status}`, t.status === 'success' ? 'success' : 'error');
          break;
        }
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : '执行失败', 'error');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
      <button onClick={() => navigate('/nodes')} className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 mb-3">
        <ArrowLeft className="h-3.5 w-3.5" /> 返回节点列表
      </button>
      <PageHeader
        title={node?.name ?? '…'}
        description={<span className="font-mono">{id}</span>}
        actions={
          <>
            <Badge tone={node?.status === 'online' ? 'success' : 'danger'}>
              <StatusDot status={node?.status ?? 'offline'} />
            </Badge>
            <Button size="sm" variant="primary" onClick={() => navigate(`/terminal?node=${id}`)}>
              <TerminalSquare className="h-3.5 w-3.5" /> WebSSH 终端
            </Button>
            <Button size="sm" onClick={() => setExecOpen(true)}>
              <Play className="h-3.5 w-3.5" /> 快速执行
            </Button>
          </>
        }
      />

      {!node ? (
        <div className="flex justify-center py-20"><Spinner /></div>
      ) : (
        <div className="space-y-5">
          {/* info grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
            <InfoTile icon={<Cpu className="h-4 w-4" />} label="CPU 使用率" value={fmtPct(m?.cpu)} sub={m?.load1 != null ? `load ${m.load1.toFixed(2)}` : undefined} tone="cyan" />
            <InfoTile icon={<MemoryStick className="h-4 w-4" />} label="内存" value={fmtBytes(m?.memUsed)} sub={m?.memTotal ? `共 ${fmtBytes(m.memTotal)}` : undefined} tone="violet" />
            <InfoTile icon={<HardDrive className="h-4 w-4" />} label="磁盘" value={fmtBytes(m?.diskUsed)} sub={m?.diskTotal ? `共 ${fmtBytes(m.diskTotal)}` : undefined} tone="emerald" />
            <InfoTile icon={<Wifi className="h-4 w-4" />} label="网络 ↓/↑" value={`${fmtBps(m?.netInBps)}`} sub={`↑ ${fmtBps(m?.netOutBps)}`} tone="amber" />
            <InfoTile icon={<RefreshCw className="h-4 w-4" />} label="运行时长" value={fmtUptime(m?.uptime)} sub={`心跳 ${fmtRelative(node.lastSeen)}`} />
            <InfoTile label="系统" value={`${node.os || '—'} ${node.arch || ''}`} sub={`Agent ${node.version || '未知'}`} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <LabelChips labels={node.labels} max={8} />
            <span className="text-xs text-zinc-600">·</span>
            <span className="text-xs text-zinc-500">主机名 {node.hostname || '—'}</span>
            <span className="text-xs text-zinc-600">·</span>
            <span className="text-xs text-zinc-500">IP {node.ip || '—'}</span>
          </div>

          {/* charts */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-200">监控曲线</h2>
            <div className="flex gap-1 rounded-lg border border-zinc-800 p-0.5">
              {(['1h', '24h', '7d'] as Range[]).map((r) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={cn(
                    'rounded-md px-3 py-1 text-xs transition-colors',
                    range === r ? 'bg-cyan-500/15 text-cyan-300' : 'text-zinc-500 hover:text-zinc-300',
                  )}
                >
                  {r === '1h' ? '1 小时' : r === '24h' ? '24 小时' : '7 天'}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <Card>
              <CardHeader title="CPU 使用率" subtitle="%" />
              <div className="p-3 pt-2">
                <MetricChart points={(metrics?.points ?? []) as unknown as Record<string, number | null>[]} series={[{ key: 'cpu', label: 'CPU', color: 'cyan', format: 'pct' }]} />
              </div>
            </Card>
            <Card>
              <CardHeader title="内存使用" subtitle="bytes" />
              <div className="p-3 pt-2">
                <MetricChart
                  points={(metrics?.points ?? []) as unknown as Record<string, number | null>[]}
                  series={[{ key: 'memUsed', label: '已用内存', color: 'violet', format: 'bytes' }]}
                  yMax="auto"
                />
              </div>
            </Card>
            <Card>
              <CardHeader title="磁盘 I/O" subtitle="读写速率" />
              <div className="p-3 pt-2">
                {hasDiskIO ? (
                  <>
                    <MetricChart
                      points={(metrics?.points ?? []) as unknown as Record<string, number | null>[]}
                      series={[
                        { key: 'diskReadBps', label: '读', color: 'emerald', format: 'bps' },
                        { key: 'diskWriteBps', label: '写', color: 'amber', format: 'bps' },
                      ]}
                      yMax="auto"
                    />
                    <ChartLegend items={[{ label: '读', color: 'emerald' }, { label: '写', color: 'amber' }]} />
                  </>
                ) : (
                  <EmptyState title="暂无磁盘 I/O 数据" description="该平台暂不支持磁盘 IO 计数采集（Linux 完整支持），CPU / 内存 / 网络曲线不受影响" />
                )}
              </div>
            </Card>
            <Card>
              <CardHeader title="网络上下行" subtitle="bytes/s" />
              <div className="p-3 pt-2">
                <MetricChart
                  points={(metrics?.points ?? []) as unknown as Record<string, number | null>[]}
                  series={[
                    { key: 'netInBps', label: '下行', color: 'cyan', format: 'bps' },
                    { key: 'netOutBps', label: '上行', color: 'rose', format: 'bps' },
                  ]}
                  yMax="auto"
                />
                <ChartLegend items={[{ label: '下行', color: 'cyan' }, { label: '上行', color: 'rose' }]} />
              </div>
            </Card>
          </div>

          {/* quick exec result */}
          {lastTask && (
            <Card>
              <CardHeader
                title="最近快速执行结果"
                subtitle={`状态: ${lastTask.status} · 退出码: ${lastTask.exitCode ?? '—'} · 耗时 ${fmtDuration(lastTask.finishedAt && lastTask.startedAt ? lastTask.finishedAt - lastTask.startedAt : null)}`}
                actions={<Button size="icon" variant="ghost" onClick={() => setLastTask(null)} title="关闭"><RefreshCw className="h-3.5 w-3.5" /></Button>}
              />
              <pre className="p-4 text-xs font-mono text-zinc-300 whitespace-pre-wrap max-h-72 overflow-y-auto bg-zinc-950/60 rounded-b-xl">
                {lastTask.logTail || '(无输出)'}
              </pre>
            </Card>
          )}
        </div>
      )}

      <Dialog
        open={execOpen}
        onClose={() => setExecOpen(false)}
        title={`在 ${node?.name ?? ''} 上执行命令`}
        footer={
          <>
            <Button size="sm" onClick={() => setExecOpen(false)}>取消</Button>
            <Button size="sm" variant="primary" loading={running} onClick={quickExec}>执行</Button>
          </>
        }
      >
        <Label>Shell 脚本</Label>
        <Textarea rows={6} value={script} onChange={(e) => setScript(e.target.value)} />
        <p className="text-[11px] text-zinc-600 mt-2">超时 60 秒自动终止；执行会记录审计日志。</p>
      </Dialog>
    </div>
  );
}

function InfoTile({ icon, label, value, sub, tone }: { icon?: React.ReactNode; label: string; value: string; sub?: string; tone?: 'cyan' | 'violet' | 'emerald' | 'amber' }) {
  const tones = { cyan: 'text-cyan-400', violet: 'text-violet-300', emerald: 'text-emerald-400', amber: 'text-amber-400' } as const;
  return (
    <div className="panel p-3.5">
      <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
        {icon && <span className={tone ? tones[tone] : 'text-zinc-500'}>{icon}</span>}
        {label}
      </div>
      <div className="text-base font-semibold text-zinc-100 mt-1 truncate">{value}</div>
      {sub && <div className="text-[10px] text-zinc-500 truncate">{sub}</div>}
    </div>
  );
}
