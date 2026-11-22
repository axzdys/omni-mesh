import { type ReactNode } from 'react';
import { cn } from '../lib/utils';

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
      <div>
        <h1 className="text-lg font-bold text-zinc-100 tracking-tight">{title}</h1>
        {description && <p className="text-xs text-zinc-500 mt-0.5">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  icon,
  tone = 'cyan',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon: ReactNode;
  tone?: 'cyan' | 'emerald' | 'violet' | 'rose' | 'amber';
}) {
  const tones = {
    cyan: 'text-cyan-400 bg-cyan-500/10',
    emerald: 'text-emerald-400 bg-emerald-500/10',
    violet: 'text-violet-300 bg-violet-500/10',
    rose: 'text-rose-400 bg-rose-500/10',
    amber: 'text-amber-400 bg-amber-500/10',
  } as const;
  return (
    <div className="panel p-4 flex items-start gap-3">
      <div className={cn('rounded-lg p-2.5', tones[tone])}>{icon}</div>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</div>
        <div className="text-xl font-bold text-zinc-100 mt-0.5 tabular-nums truncate">{value}</div>
        {sub && <div className="text-[11px] text-zinc-500 mt-0.5 truncate">{sub}</div>}
      </div>
    </div>
  );
}

export function StatusDot({ status }: { status: 'online' | 'offline' }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          'h-2 w-2 rounded-full',
          status === 'online' ? 'bg-emerald-400 animate-pulse-dot shadow-[0_0_6px_rgba(52,211,153,0.7)]' : 'bg-zinc-600',
        )}
      />
      <span className={cn('text-xs', status === 'online' ? 'text-emerald-400' : 'text-zinc-500')}>
        {status === 'online' ? '在线' : '离线'}
      </span>
    </span>
  );
}

export function LabelChips({ labels, max = 4 }: { labels: string[]; max?: number }) {
  const shown = labels.slice(0, max);
  const rest = labels.length - shown.length;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {shown.map((l) => (
        <span key={l} className="rounded-md border border-violet-500/25 bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-300">
          {l}
        </span>
      ))}
      {rest > 0 && <span className="rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-[10px] text-zinc-500">+{rest}</span>}
    </span>
  );
}
