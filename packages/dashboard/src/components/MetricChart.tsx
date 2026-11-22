import { useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtBps, fmtBytes, fmtTime } from '../lib/utils';

const COLORS = {
  cyan: '#22d3ee',
  violet: '#a78bfa',
  emerald: '#34d399',
  amber: '#fbbf24',
  rose: '#fb7185',
} as const;

export type ChartColor = keyof typeof COLORS;

interface SeriesDef {
  key: string;
  label: string;
  color: ChartColor;
  format?: 'bytes' | 'bps' | 'pct' | 'raw';
  stacked?: boolean;
}

function fmtValue(v: number | null | undefined, format?: string): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (format === 'bytes') return fmtBytes(v);
  if (format === 'bps') return fmtBps(v);
  if (format === 'pct') return `${v.toFixed(1)}%`;
  return v.toFixed(2);
}

export function MetricChart({
  points,
  series,
  height = 180,
  yMax = 100,
}: {
  points: Record<string, number | null>[];
  series: SeriesDef[];
  height?: number;
  yMax?: number | 'auto';
}) {
  const data = useMemo(() => points.map((p) => ({ ...p, time: fmtTime(p.ts) })), [points]);

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS[s.color]} stopOpacity={0.28} />
                <stop offset="100%" stopColor={COLORS[s.color]} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="time"
            tick={{ fill: '#71717a', fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: '#3f3f46' }}
            minTickGap={48}
            tickFormatter={(t: string) => t.slice(-8)}
          />
          <YAxis
            tick={{ fill: '#71717a', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            width={44}
            domain={yMax === 'auto' ? [0, 'auto'] : [0, yMax]}
            tickFormatter={(v: number) =>
              series[0]?.format === 'bytes' || series[0]?.format === 'bps'
                ? fmtBytes(v, 0)
                : `${Math.round(v)}${series[0]?.format === 'pct' ? '%' : ''}`
            }
          />
          <Tooltip
            contentStyle={{
              background: '#18181d',
              border: '1px solid #3f3f46',
              borderRadius: 8,
              fontSize: 12,
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            }}
            labelStyle={{ color: '#a1a1aa' }}
            itemStyle={{ color: '#e4e4e7' }}
            formatter={(value: number | string, name: string) => {
              const s = series.find((x) => x.label === name || x.key === name);
              return [fmtValue(Number(value), s?.format), name];
            }}
          />
          {series.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={COLORS[s.color]}
              strokeWidth={1.8}
              fill={`url(#grad-${s.key})`}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ChartLegend({ items }: { items: { label: string; color: ChartColor }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 pt-1">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500">
          <span className="h-1.5 w-3 rounded-full" style={{ background: COLORS[i.color] }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}
