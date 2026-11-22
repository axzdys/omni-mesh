import { useState } from 'react';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { endpoints } from '../lib/api';
import type { AuditEntry } from '@omni/shared';
import { usePoll } from '../hooks/hooks';
import { PageHeader } from '../components/bits';
import { Card, Badge, Input, Select, Spinner, EmptyState, Button } from '../components/ui/ui';
import { fmtTime } from '../lib/utils';

const PAGE_SIZE = 25;

const actionTone: Record<string, 'default' | 'success' | 'warn' | 'danger' | 'info' | 'violet'> = {
  'auth.login': 'success',
  'auth.failed': 'danger',
  'auth.change-password': 'warn',
  'node.online': 'success',
  'node.offline': 'warn',
  'node.register': 'info',
  'node.delete': 'danger',
  'exec.dispatch': 'info',
  'exec.cancel': 'warn',
  'cron.create': 'info',
  'cron.update': 'info',
  'cron.delete': 'danger',
  'cron.fire': 'violet',
  'cron.run-now': 'warn',
  'cron.toggle': 'warn',
  'workflow.create': 'info',
  'workflow.update': 'info',
  'workflow.delete': 'danger',
  'workflow.run': 'info',
  'workflow.finish': 'violet',
  'terminal.open': 'info',
  'terminal.close': 'default',
  'settings.update': 'warn',
  'key.create': 'warn',
  'key.revoke': 'danger',
  'file.upload': 'warn',
  'file.download': 'warn',
};

const actionLabel: Record<string, string> = {
  'auth.login': '登录成功',
  'auth.failed': '登录失败',
  'auth.change-password': '修改密码',
  'node.online': '节点上线',
  'node.offline': '节点离线',
  'node.register': '节点注册',
  'node.delete': '删除节点',
  'exec.dispatch': '下发命令',
  'exec.cancel': '取消任务',
  'cron.create': '创建定时任务',
  'cron.update': '更新定时任务',
  'cron.delete': '删除定时任务',
  'cron.fire': '定时触发',
  'cron.run-now': '手动触发',
  'cron.toggle': '启停定时任务',
  'workflow.create': '创建工作流',
  'workflow.update': '更新工作流',
  'workflow.delete': '删除工作流',
  'workflow.run': '运行工作流',
  'workflow.finish': '工作流完成',
  'terminal.open': '打开终端',
  'terminal.close': '关闭终端',
  'settings.update': '修改设置',
  'key.create': '签发密钥',
  'key.revoke': '吊销密钥',
  'file.upload': '上传文件',
  'file.download': '下载文件',
};

export function AuditLogs() {
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  // audit is a history viewer: no background polling (the bounded COUNT is
  // still a few-thousand-row scan), manual refresh instead
  const { data, loading, reload } = usePoll<{ total: number; entries: AuditEntry[] }>(
    () => endpoints.audit({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, ...(action ? { action } : {}), ...(search ? { search } : {}) }),
    null,
    [action, search, page],
  );

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
      <PageHeader title="审计日志" description="所有终端连接、命令下发与配置变更的完整留痕" />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-600" />
          <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} placeholder="搜索操作者 / 目标 / 详情…" className="pl-8" />
        </div>
        <Select value={action} onChange={(e) => { setAction(e.target.value); setPage(0); }} className="max-w-[180px]">
          <option value="">全部动作</option>
          {Object.keys(actionLabel).map((a) => (
            <option key={a} value={a}>{actionLabel[a]} ({a})</option>
          ))}
        </Select>
        <span className="text-xs text-zinc-500 ml-auto">
          共 {data ? (data.total >= 10000 ? '10000+' : data.total) : '—'} 条
          <button onClick={() => reload()} className="ml-3 text-cyan-400 hover:text-cyan-300">
            刷新
          </button>
        </span>
      </div>

      <Card className="overflow-hidden">
        {loading && !data ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : (data?.entries.length ?? 0) === 0 ? (
          <EmptyState title="没有匹配的审计记录" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px]">
              <thead className="border-b border-zinc-800/70">
                <tr>
                  <th className="th">时间</th>
                  <th className="th">操作者</th>
                  <th className="th">动作</th>
                  <th className="th">目标</th>
                  <th className="th">详情</th>
                  <th className="th">来源 IP</th>
                </tr>
              </thead>
              <tbody>
                {(data?.entries ?? []).map((e) => (
                  <tr key={e.id} className="border-b border-zinc-800/40 hover:bg-zinc-800/30 transition-colors align-top">
                    <td className="td whitespace-nowrap text-xs text-zinc-400 tabular-nums">{fmtTime(e.ts)}</td>
                    <td className="td text-xs">
                      <span className="text-zinc-200">{e.actor}</span>
                    </td>
                    <td className="td">
                      <Badge tone={actionTone[e.action] ?? 'default'}>{actionLabel[e.action] ?? e.action}</Badge>
                    </td>
                    <td className="td text-xs font-mono text-zinc-400 max-w-[160px] truncate">{e.target || '—'}</td>
                    <td className="td text-xs text-zinc-500 max-w-[300px]">
                      <span className="line-clamp-2 break-all">{e.detail || '—'}</span>
                    </td>
                    <td className="td text-xs font-mono text-zinc-600">{e.ip || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-800/70">
          <span className="text-xs text-zinc-500">
            第 {page + 1} / {totalPages} 页
          </span>
          <div className="flex gap-1">
            <Button size="icon" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)} title="上一页">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="ghost" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)} title="下一页">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
