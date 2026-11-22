import { useState } from 'react';
import { Plus, Trash2, Pencil, Clock, Play } from 'lucide-react';
import { endpoints } from '../lib/api';
import type { CronJob, NodeInfo, ExecLang, ExecTask } from '@omni/shared';
import { usePoll } from '../hooks/hooks';
import { PageHeader } from '../components/bits';
import { Card, Badge, Button, Input, Textarea, Select, Label, Switch, StatusBadge, Spinner, EmptyState } from '../components/ui/ui';
import { Dialog } from '../components/ui/dialog';
import { useToast } from '../components/ui/toast';
import { fmtRelative, fmtTime, cn } from '../lib/utils';

interface FormData {
  name: string;
  expr: string;
  targetType: 'node' | 'tag' | 'all';
  targetValue: string;
  script: string;
  lang: ExecLang;
  timeoutMs: number;
  retries: number;
  envText: string;
  enabled: boolean;
}

const emptyForm: FormData = {
  name: '',
  expr: '*/5 * * * *',
  targetType: 'all',
  targetValue: '',
  script: '',
  lang: 'shell',
  timeoutMs: 600000,
  retries: 0,
  envText: '',
  enabled: true,
};

function parseEnv(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx > 0) out[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

export function CronJobs() {
  const { data: jobs, reload } = usePoll<CronJob[]>(() => endpoints.cronList(), 15000);
  const { data: nodes } = usePoll<NodeInfo[]>(() => endpoints.nodes(), 30000);
  const toast = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CronJob | null>(null);
  const [form, setForm] = useState<FormData>(emptyForm);
  const [preview, setPreview] = useState<number[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [historyFor, setHistoryFor] = useState<CronJob | null>(null);
  const { data: history } = usePoll<ExecTask[] | null>(
    () => (historyFor ? endpoints.cronHistory(historyFor.id).then((r) => r.tasks) : Promise.resolve(null)),
    5000,
    [historyFor?.id],
  );

  const allLabels = [...new Set((nodes ?? []).flatMap((n) => n.labels))];
  const set = (patch: Partial<FormData>) => setForm((f) => ({ ...f, ...patch }));

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setPreview(null);
    setDialogOpen(true);
  };

  const openEdit = (job: CronJob) => {
    setEditing(job);
    setForm({
      name: job.name,
      expr: job.expr,
      targetType: job.targetType,
      targetValue: job.targetValue ?? '',
      script: job.script,
      lang: job.lang,
      timeoutMs: job.timeoutMs,
      retries: job.retries,
      envText: '',
      enabled: job.enabled,
    });
    setPreview(null);
    setDialogOpen(true);
  };

  const doPreview = async () => {
    try {
      const res = await endpoints.cronPreview(form.expr);
      setPreview(res.next);
    } catch (e) {
      setPreview(null);
      toast(e instanceof Error ? e.message : '表达式无效', 'error');
    }
  };

  const submit = async () => {
    if (!form.name.trim() || !form.script.trim()) {
      toast('请填写名称与脚本内容', 'error');
      return;
    }
    const env = parseEnv(form.envText);
    setSaving(true);
    try {
      if (editing) {
        await endpoints.cronUpdate(editing.id, { ...form, env });
        toast('定时任务已更新', 'success');
      } else {
        await endpoints.cronCreate({ ...form, env });
        toast('定时任务已创建', 'success');
      }
      setDialogOpen(false);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (job: CronJob) => {
    try {
      await endpoints.cronToggle(job.id);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '操作失败', 'error');
    }
  };

  const runNow = async (job: CronJob) => {
    try {
      const res = await endpoints.cronRun(job.id);
      toast(`已立即执行，共 ${res.taskIds.length} 个任务`, 'success');
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '执行失败', 'error');
    }
  };

  const remove = async (job: CronJob) => {
    try {
      await endpoints.cronDelete(job.id);
      toast(`已删除 ${job.name}`, 'success');
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '删除失败', 'error');
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
      <PageHeader
        title="定时任务中心"
        description="标准 5 段 Cron 表达式（UTC）· 支持失败重试与环境变量加密注入"
        actions={
          <Button size="sm" variant="primary" onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" /> 新建定时任务
          </Button>
        }
      />

      {(jobs ?? []).length === 0 ? (
        <Card>
          <EmptyState icon={<Clock className="h-8 w-8" />} title="还没有定时任务" description="例如每 5 分钟巡检磁盘占用、每天凌晨备份数据库" />
        </Card>
      ) : (
        <div className="space-y-3">
          {(jobs ?? []).map((job) => (
            <Card key={job.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-zinc-100">{job.name}</span>
                    <Switch checked={job.enabled} onChange={() => toggle(job)} />
                    {!job.enabled && <Badge tone="warn">已停用</Badge>}
                    <code className="rounded-md bg-zinc-900 border border-zinc-800 px-2 py-0.5 text-xs text-cyan-300 font-mono">{job.expr}</code>
                    <Badge tone={job.lang === 'python' ? 'violet' : 'default'}>{job.lang === 'python' ? 'Python' : 'Shell'}</Badge>
                    {job.retries > 0 && <Badge tone="info">重试×{job.retries}</Badge>}
                  </div>
                  <div className="text-xs text-zinc-500 mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                    <span>
                      目标:{' '}
                      {job.targetType === 'all' ? '全部在线节点' : job.targetType === 'tag' ? <span className="text-violet-300">标签 {job.targetValue}</span> : <span className="text-cyan-300 font-mono">{job.targetValue}</span>}
                    </span>
                    <span>超时 {Math.round(job.timeoutMs / 1000)}s</span>
                    <span>上次运行 {fmtRelative(job.lastRun)}</span>
                    <span>
                      下次运行{' '}
                      <span className={cn(job.enabled ? 'text-emerald-400' : 'text-zinc-600')}>{job.enabled && job.nextRun ? fmtTime(job.nextRun) : '—'}</span>
                    </span>
                  </div>
                  <code className="block mt-2 text-[11px] text-zinc-500 font-mono bg-zinc-900/70 border border-zinc-800/60 rounded-md px-2.5 py-1.5 truncate max-w-3xl">
                    {job.script.slice(0, 120)}
                    {job.script.length > 120 ? '…' : ''}
                  </code>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="icon" variant="ghost" title="立即执行" onClick={() => runNow(job)}>
                    <Play className="h-4 w-4 text-emerald-400" />
                  </Button>
                  <Button size="icon" variant="ghost" title="执行历史" onClick={() => setHistoryFor(job)}>
                    <Clock className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" title="编辑" onClick={() => openEdit(job)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" title="删除" onClick={() => remove(job)}>
                    <Trash2 className="h-4 w-4 text-rose-400/70" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* create/edit dialog */}
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={editing ? `编辑定时任务 · ${editing.name}` : '新建定时任务'}
        wide
        footer={
          <>
            <Button size="sm" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button size="sm" variant="primary" loading={saving} onClick={submit}>保存</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>任务名称</Label>
              <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="例如：每5分钟磁盘巡检" />
            </div>
            <div>
              <Label>
                Cron 表达式（5 段，UTC）{' '}
                <button type="button" onClick={doPreview} className="text-cyan-400 hover:text-cyan-300 font-normal">
                  · 预览执行时间
                </button>
              </Label>
              <Input value={form.expr} onChange={(e) => set({ expr: e.target.value })} className="font-mono" placeholder="*/5 * * * *" />
              {preview && (
                <div className="mt-1.5 rounded-md border border-emerald-500/25 bg-emerald-500/5 px-2 py-1.5 text-[11px] text-emerald-300">
                  接下来: {preview.map((t) => fmtTime(t)).join(' · ')}
                </div>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label>执行目标</Label>
              <Select value={form.targetType} onChange={(e) => set({ targetType: e.target.value as FormData['targetType'], targetValue: '' })}>
                <option value="all">全部在线节点</option>
                <option value="node">指定节点</option>
                <option value="tag">标签组</option>
              </Select>
            </div>
            {form.targetType === 'node' && (
              <div className="sm:col-span-2">
                <Label>目标节点</Label>
                <Select value={form.targetValue} onChange={(e) => set({ targetValue: e.target.value })}>
                  <option value="">— 选择节点 —</option>
                  {(nodes ?? []).map((n) => (
                    <option key={n.id} value={n.id}>{n.name}（{n.status === 'online' ? '在线' : '离线'}）</option>
                  ))}
                </Select>
              </div>
            )}
            {form.targetType === 'tag' && (
              <div className="sm:col-span-2">
                <Label>目标标签</Label>
                <Select value={form.targetValue} onChange={(e) => set({ targetValue: e.target.value })}>
                  <option value="">— 选择标签 —</option>
                  {allLabels.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </Select>
              </div>
            )}
            {form.targetType === 'all' && <div className="sm:col-span-2" />}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>语言</Label>
              <Select value={form.lang} onChange={(e) => set({ lang: e.target.value as ExecLang })}>
                <option value="shell">Shell</option>
                <option value="python">Python</option>
              </Select>
            </div>
            <div>
              <Label>超时 (ms)</Label>
              <Input type="number" value={form.timeoutMs} onChange={(e) => set({ timeoutMs: Number(e.target.value) || 600000 })} />
            </div>
            <div>
              <Label>失败重试</Label>
              <Input type="number" min={0} max={10} value={form.retries} onChange={(e) => set({ retries: Math.max(0, Number(e.target.value) || 0) })} />
            </div>
          </div>
          <div>
            <Label>脚本内容</Label>
            <Textarea rows={7} value={form.script} onChange={(e) => set({ script: e.target.value })} placeholder={'df -h / \nfree -m\nuptime'} />
          </div>
          <div>
            <Label>环境变量（KEY=value，每行一条；服务器端 AES-GCM 加密存储，永不回传明文）</Label>
            <Textarea rows={3} value={form.envText} onChange={(e) => set({ envText: e.target.value })} placeholder={'API_TOKEN=xxxxx\nDB_PASSWORD=yyyyy'} />
          </div>
        </div>
      </Dialog>

      {/* history dialog */}
      <Dialog open={!!historyFor} onClose={() => setHistoryFor(null)} title={`执行历史 · ${historyFor?.name ?? ''}`} wide>
        {(history ?? []).length === 0 ? (
          <EmptyState title="暂无执行记录" />
        ) : (
          <div className="space-y-2">
            {(history ?? []).map((t) => (
              <div key={t.id} className="rounded-lg border border-zinc-800 px-3 py-2">
                <div className="flex items-center justify-between text-xs">
                  <StatusBadge status={t.status} />
                  <span className="text-zinc-500">{fmtTime(t.createdAt)} · 退出码 {t.exitCode ?? '—'}</span>
                </div>
                {t.logTail && (
                  <pre className="mt-1.5 max-h-24 overflow-y-auto rounded bg-zinc-950/70 p-2 text-[10px] font-mono text-zinc-400 whitespace-pre-wrap">
                    {t.logTail.slice(-400)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </Dialog>
    </div>
  );
}
