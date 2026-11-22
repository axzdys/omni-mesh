import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Server, TerminalSquare, AlertTriangle, ArrowRight } from 'lucide-react';
import { endpoints, type OverviewData, type LatestMetrics } from '../lib/api';
import { usePoll, useEvents } from '../hooks/hooks';
import { PageHeader, StatCard, StatusDot, LabelChips } from '../components/bits';
import { Card, CardHeader, Badge, StatusBadge, Spinner, EmptyState } from '../components/ui/ui';
import { MetricChart, ChartLegend } from '../components/MetricChart';
import { fmtBps, fmtBytes, fmtPct, fmtRelative, fmtUptime } from '../lib/utils';

export function Overview() {
  const { data, reload, loading } = usePoll<OverviewData>(() => endpoints.overview(), 15000);
  const { data: history } = usePoll<{ points: Record<string, number | null>[] }>(() => endpoints.overviewHistory(), 30000);
  useEvents(); // keep the live socket open (re-renders on events)
  const [tick, setTick] = useState(0);
  void tick; void setTick;

  // aggregate live metrics from online nodes
  const agg = useMemo(() => {
    const online = (data?.live ?? []).filter((l) => l.metrics);
    const avg = (fn: (m: LatestMetrics) => number | null): number | null => {
      const vals = online.map((l) => fn(l.metrics as LatestMetrics)).filter((v): v is number => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const sum = (fn: (m: LatestMetrics) => number | null): number | null => {
      const vals = online.map((l) => fn(l.metrics as LatestMetrics)).filter((v): v is number => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    };
    return {
      cpu: avg((m) => m.cpu),
      netIn: sum((m) => m.netInBps),
      netOut: sum((m) => m.netOutBps),
      memUsed: sum((m) => m.memUsed),
      memTotal: sum((m) => m.memTotal),
      count: online.length,
    };
  }, [data]);

  // cluster CPU history (15 min window, one series per node)
  const cpuPoints = history?.points ?? [];
  const cpuSeries = useMemo(
    () =>
      (data?.live ?? [])
        .filter((l) => l.metrics)
        .map((l, i) => ({
          key: l.name,
          label: l.name,
          color: (['cyan', 'violet', 'emerald', 'amber', 'rose'] as const)[i % 5],
          format: 'pct' as const,
        })),
    [data?.live],
  );

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
      <PageHeader
        title="全局总览"
        description="集群实时状态 · 每 5 秒自动刷新"
        actions={<Badge tone={agg.count > 0 ? 'success' : 'warn'}>{agg.count} 个节点实时上报</Badge>}
      />

      {loading && !data ? (
        <div className="flex justify-center py-20"><Spinner /></div>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <StatCard
              label="节点总数"
              value={data?.stats.nodesTotal ?? '—'}
              sub={`${data?.stats.nodesOnline ?? 0} 在线 · ${data?.stats.nodesOffline ?? 0} 离线`}
              icon={<Server className="h-5 w-5" />}
              tone="cyan"
            />
            <StatCard
              label="在线节点"
              value={data?.stats.nodesOnline ?? '—'}
              sub={`标签: ${data?.stats.labels.slice(0, 3).join(' / ') || '—'}`}
              icon={<Activity className="h-5 w-5" />}
              tone="emerald"
            />
            <StatCard
              label="运行中任务"
              value={data?.stats.runningTasks ?? '—'}
              sub="包含排队与执行中"
              icon={<TerminalSquare className="h-5 w-5" />}
              tone="violet"
            />
            <StatCard
              label="最近告警"
              value={data?.alerts.length ?? '—'}
              sub={data?.alerts[0] ? data.alerts[0].title : '暂无告警'}
              icon={<AlertTriangle className="h-5 w-5" />}
              tone={(data?.alerts.length ?? 0) > 0 ? 'amber' : 'emerald'}
            />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <Card className="xl:col-span-2">
              <CardHeader
                title="在线节点 CPU"
                subtitle="各节点实时 CPU 使用率 (%)"
                actions={<span className="text-xs text-zinc-500">均值 {fmtPct(agg.cpu)}</span>}
              />
              <div className="p-3 pt-2">
                {cpuPoints.length && cpuSeries.length ? (
                  <>
                    <MetricChart points={cpuPoints} series={cpuSeries} height={190} />
                    <ChartLegend items={cpuSeries.map((s) => ({ label: s.label, color: s.color }))} />
                  </>
                ) : (
                  <EmptyState title="暂无实时数据" description="等待节点上报指标（每 10 秒一次）" />
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title="集群资源" subtitle="在线节点聚合" />
              <div className="p-4 space-y-4">
                <GaugeRow label="平均 CPU" value={agg.cpu} max={100} display={fmtPct(agg.cpu)} color="bg-cyan-400" />
                <GaugeRow
                  label="内存"
                  value={agg.memTotal ? ((agg.memUsed ?? 0) / agg.memTotal) * 100 : null}
                  max={100}
                  display={`${fmtBytes(agg.memUsed)} / ${fmtBytes(agg.memTotal)}`}
                  color="bg-violet-400"
                />
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-500">网络 ↓ / ↑</span>
                  <span className="text-zinc-300 tabular-nums">
                    {fmtBps(agg.netIn)} / {fmtBps(agg.netOut)}
                  </span>
                </div>
                <div className="border-t border-zinc-800/70 pt-3">
                  <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">最近告警</div>
                  {(data?.alerts ?? []).slice(0, 4).map((a) => (
                    <div key={a.id} className="flex items-start gap-2 py-1.5 text-xs">
                      <AlertTriangle className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${a.level === 'warn' ? 'text-amber-400' : 'text-rose-400'}`} />
                      <div className="min-w-0">
                        <div className="text-zinc-300 truncate">{a.title}</div>
                        <div className="text-zinc-600 text-[10px]">{fmtRelative(a.ts)} · {a.message}</div>
                      </div>
                    </div>
                  ))}
                  {(data?.alerts.length ?? 0) === 0 && <div className="text-xs text-zinc-600 py-1">暂无告警记录</div>}
                </div>
              </div>
            </Card>
          </div>

          <Card>
            <CardHeader
              title="在线节点实时状态"
              subtitle="点击节点查看详细曲线"
              actions={
                <button onClick={() => reload()} className="text-xs text-cyan-400 hover:text-cyan-300">
                  刷新
                </button>
              }
            />
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 p-4">
              {(data?.live ?? []).map((l) => (
                <Link
                  key={l.nodeId + tick}
                  to={`/nodes/${l.nodeId}`}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3.5 hover:border-cyan-500/40 transition-colors group"
                >
                  <div className="flex items-center justify-between mb-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <StatusDot status="online" />
                      <span className="text-sm font-medium text-zinc-200 truncate">{l.name}</span>
                    </div>
                    <ArrowRight className="h-3.5 w-3.5 text-zinc-600 group-hover:text-cyan-400 transition-colors" />
                  </div>
                  <LabelChips labels={l.labels} max={3} />
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-3 text-xs">
                    <MetricRow label="CPU" value={fmtPct(l.metrics?.cpu)} />
                    <MetricRow label="内存" value={l.metrics ? fmtBytes(l.metrics.memUsed) : '—'} />
                    <MetricRow label="↓ 网络" value={fmtBps(l.metrics?.netInBps)} />
                    <MetricRow label="↑ 网络" value={fmtBps(l.metrics?.netOutBps)} />
                    <MetricRow label="运行时长" value={fmtUptime(l.metrics?.uptime)} />
                    <MetricRow label="上报" value={fmtRelative(l.metrics?.ts)} />
                  </div>
                </Link>
              ))}
              {(data?.live.length ?? 0) === 0 && (
                <div className="md:col-span-2 xl:col-span-3">
                  <EmptyState
                    title="暂无在线节点"
                    description="在目标机器上运行 OmniMesh Agent 并使用注册密钥接入，接入后即可在这里看到实时状态"
                  />
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="最近任务" subtitle="最近执行的命令与脚本" />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead className="border-b border-zinc-800/70">
                  <tr>
                    <th className="th">状态</th>
                    <th className="th">节点</th>
                    <th className="th">脚本</th>
                    <th className="th">来源</th>
                    <th className="th">耗时/时间</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.recentTasks ?? []).map((t) => (
                    <tr key={t.id} className="border-b border-zinc-800/40 hover:bg-zinc-800/30 transition-colors">
                      <td className="td"><StatusBadge status={t.status} /></td>
                      <td className="td font-mono text-xs">{t.nodeId.slice(0, 10)}</td>
                      <td className="td max-w-[280px]"><code className="text-xs text-zinc-400 truncate block">{t.script.slice(0, 90)}</code></td>
                      <td className="td text-xs text-zinc-500">{t.kind === 'cron' ? '定时' : t.kind === 'workflow' ? '工作流' : '手动'}</td>
                      <td className="td text-xs text-zinc-500">{fmtRelative(t.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(data?.recentTasks.length ?? 0) === 0 && <EmptyState title="暂无任务记录" />}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-300 tabular-nums">{value}</span>
    </div>
  );
}

function GaugeRow({ label, value, max, display, color }: { label: string; value: number | null; max: number; display: string; color: string }) {
  const pct = value != null ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1.5">
        <span className="text-zinc-500">{label}</span>
        <span className="text-zinc-300 tabular-nums">{display}</span>
      </div>
      <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
