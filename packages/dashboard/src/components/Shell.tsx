import { NavLink, Outlet, useNavigate, Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import type { DashEvent } from '@omni/shared';
import {
  LayoutDashboard, Server, Workflow, Clock, ScrollText, Settings, TerminalSquare,
  PanelLeftClose, PanelLeftOpen, Menu, X, LogOut, Network,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { getToken, endpoints } from '../lib/api';
import { useEvents } from '../hooks/hooks';
import { ToastProvider, useToast } from './ui/toast';

const nav = [
  { to: '/', label: '总览大屏', icon: LayoutDashboard, end: true },
  { to: '/nodes', label: '节点管理', icon: Server, end: false },
  { to: '/terminal', label: 'WebSSH 终端', icon: TerminalSquare, end: false },
  { to: '/workflows', label: '工作流编排', icon: Workflow, end: false },
  { to: '/cron', label: '定时任务', icon: Clock, end: false },
  { to: '/audit', label: '审计日志', icon: ScrollText, end: false },
  { to: '/settings', label: '系统设置', icon: Settings, end: false },
];

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="8" fill="#0c0c10" />
      <g stroke="url(#lg)" strokeWidth="1.6" fill="none">
        <defs>
          <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#22d3ee" />
            <stop offset="1" stopColor="#818cf8" />
          </linearGradient>
        </defs>
        <circle cx="16" cy="9" r="3" />
        <circle cx="8" cy="21" r="3" />
        <circle cx="24" cy="21" r="3" />
        <path d="M14 11.4 9.5 18.6M18 11.4l4.5 7.2M11 21h10" />
      </g>
    </svg>
  );
}

export function Shell() {
  if (!getToken()) return <Navigate to="/login" replace />;
  return (
    <ToastProvider>
      <ShellInner />
    </ToastProvider>
  );
}

function ShellInner() {
  const navigate = useNavigate();
  const toast = useToast();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { connected } = useEvents((ev: DashEvent) => {
    if (ev.type === 'node_status') {
      if (ev.data.status === 'offline') {
        toast(`节点离线: ${ev.data.name}`, 'error');
      } else {
        toast(`节点上线: ${ev.data.name}`, 'success');
      }
    }
  });
  const [username, setUsername] = useState('');

  useEffect(() => {
    endpoints.me().then((me) => setUsername(me.username)).catch(() => {});
  }, []);

  const sidebar = (
    <div className={cn('flex h-full flex-col bg-surface-raised/80 border-r border-zinc-800/70', collapsed ? 'w-16' : 'w-60')}>
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-zinc-800/70">
        <Logo />
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-sm font-bold text-zinc-100 tracking-wide truncate">OmniMesh</div>
            <div className="text-[10px] text-zinc-500 -mt-0.5">边缘节点指挥中枢</div>
          </div>
        )}
      </div>
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={() => setMobileOpen(false)}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                collapsed && 'justify-center px-2',
                isActive
                  ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20'
                  : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50 border border-transparent',
              )
            }
            title={collapsed ? item.label : undefined}
          >
            <item.icon className="h-4.5 w-4.5 h-[18px] w-[18px] shrink-0" />
            {!collapsed && <span className="truncate">{item.label}</span>}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-zinc-800/70 px-2 py-3 space-y-0.5">
        {!collapsed && username && (
          <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-500">
            <div className="h-6 w-6 rounded-full bg-gradient-to-br from-cyan-500/40 to-violet-500/40 flex items-center justify-center text-[10px] font-bold text-zinc-100">
              {username.slice(0, 2).toUpperCase()}
            </div>
            <span className="truncate">{username}</span>
          </div>
        )}
        <button
          onClick={() => {
            localStorage.removeItem('omni_token');
            navigate('/login');
          }}
          className={cn(
            'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-400 hover:text-rose-300 hover:bg-rose-500/5 transition-colors',
            collapsed && 'justify-center px-2',
          )}
          title="退出登录"
        >
          <LogOut className="h-[18px] w-[18px] shrink-0" />
          {!collapsed && '退出登录'}
        </button>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={cn(
            'hidden md:flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/50 transition-colors',
            collapsed && 'justify-center px-2',
          )}
        >
          {collapsed ? <PanelLeftOpen className="h-[18px] w-[18px]" /> : <PanelLeftClose className="h-[18px] w-[18px]" />}
          {!collapsed && '收起侧栏'}
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden">
      {/* desktop sidebar */}
      <aside className="hidden md:block h-full shrink-0">{sidebar}</aside>
      {/* mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <aside className="absolute left-0 top-0 h-full w-60 animate-fade-up">{sidebar}</aside>
        </div>
      )}
      <div className="flex-1 flex flex-col min-w-0">
        {/* topbar (mobile) */}
        <div className="md:hidden flex items-center justify-between h-12 px-3 border-b border-zinc-800/70 bg-surface-raised/60">
          <button onClick={() => setMobileOpen(true)} className="p-2 text-zinc-300 hover:text-white" aria-label="菜单">
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <Logo size={20} /> OmniMesh
          </div>
          <div
            className={cn(
              'flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full border',
              connected ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/5' : 'text-zinc-500 border-zinc-700',
            )}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', connected ? 'bg-emerald-400 animate-pulse-dot' : 'bg-zinc-500')} />
            {connected ? '实时' : '离线'}
          </div>
        </div>
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      {/* live connection pill (desktop) */}
      <div className="fixed right-4 top-3.5 hidden md:flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border bg-surface-raised/80 backdrop-blur z-30"
        style={{ borderColor: connected ? 'rgba(16,185,129,0.3)' : 'rgba(63,63,70,0.8)', color: connected ? '#34d399' : '#71717a' }}
      >
        <Network className="h-3 w-3" />
        <span className={cn('h-1.5 w-1.5 rounded-full', connected ? 'bg-emerald-400 animate-pulse-dot' : 'bg-zinc-500')} />
        {connected ? '实时连接' : '未连接'}
      </div>
    </div>
  );
}
