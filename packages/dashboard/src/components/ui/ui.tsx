import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

// ─── Button ──────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type ButtonSize = 'sm' | 'md' | 'icon';

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    'bg-cyan-500/90 text-zinc-950 font-medium hover:bg-cyan-400 disabled:opacity-50 shadow-glow',
  secondary: 'bg-zinc-800/80 text-zinc-200 hover:bg-zinc-700/80 border border-zinc-700/60',
  ghost: 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60',
  danger: 'bg-rose-600/90 text-white hover:bg-rose-500 disabled:opacity-50',
  outline: 'border border-zinc-700 text-zinc-300 hover:border-cyan-500/50 hover:text-cyan-300',
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs rounded-lg gap-1.5',
  md: 'h-9 px-4 text-sm rounded-lg gap-2',
  icon: 'h-8 w-8 rounded-lg justify-center',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'secondary', size = 'md', loading, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center transition-colors select-none outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40',
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';

// ─── Inputs ──────────────────────────────────────────────────────────────

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn('input', className)} {...props} />,
);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn('input font-mono text-[13px] leading-relaxed', className)} {...props} />,
);
Textarea.displayName = 'Textarea';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select ref={ref} className={cn('input appearance-none cursor-pointer', className)} {...props}>
      {children}
    </select>
  ),
);
Select.displayName = 'Select';

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <label className={cn('block text-xs font-medium text-zinc-400 mb-1.5', className)}>{children}</label>;
}

// ─── Card ────────────────────────────────────────────────────────────────

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('panel', className)}>{children}</div>;
}

export function CardHeader({ title, subtitle, actions, icon }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-zinc-800/70">
      <div className="flex items-center gap-2.5 min-w-0">
        {icon}
        <div className="min-w-0">
          <div className="text-sm font-semibold text-zinc-100 truncate">{title}</div>
          {subtitle && <div className="text-xs text-zinc-500 truncate">{subtitle}</div>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

// ─── Badge ───────────────────────────────────────────────────────────────

export function Badge({ children, tone = 'default', className }: { children: ReactNode; tone?: 'default' | 'success' | 'warn' | 'danger' | 'info' | 'violet'; className?: string }) {
  const tones = {
    default: 'bg-zinc-800/80 text-zinc-400 border-zinc-700/50',
    success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    warn: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    danger: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
    info: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
    violet: 'bg-violet-500/10 text-violet-300 border-violet-500/30',
  } as const;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium', tones[tone], className)}>
      {children}
    </span>
  );
}

// ─── Switch ──────────────────────────────────────────────────────────────

export function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors outline-none disabled:opacity-50',
        checked ? 'bg-cyan-500/80' : 'bg-zinc-700',
      )}
    >
      <span
        className={cn(
          'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]',
        )}
      />
    </button>
  );
}

// ─── Spinner / Empty ─────────────────────────────────────────────────────

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-cyan-400', className)} />;
}

export function EmptyState({ icon, title, description, actions }: { icon?: ReactNode; title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 px-6 text-center">
      {icon && <div className="text-zinc-600 mb-1">{icon}</div>}
      <div className="text-sm font-medium text-zinc-300">{title}</div>
      {description && <div className="text-xs text-zinc-500 max-w-sm">{description}</div>}
      {actions && <div className="mt-3">{actions}</div>}
    </div>
  );
}

// ─── Status pill for tasks/steps ─────────────────────────────────────────

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

const statusLabel: Record<string, string> = {
  success: '成功',
  running: '运行中',
  queued: '排队中',
  pending: '等待',
  failed: '失败',
  timeout: '超时',
  cancelled: '已取消',
  skipped: '已跳过',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone[status] ?? 'default'}>{statusLabel[status] ?? status}</Badge>;
}
