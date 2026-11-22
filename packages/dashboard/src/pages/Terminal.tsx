import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Plus, X, Minus, ZoomIn, Trash2, Search } from 'lucide-react';
import type { NodeInfo } from '@omni/shared';
import { endpoints, wsUrl } from '../lib/api';
import { usePoll } from '../hooks/hooks';
import { PageHeader } from '../components/bits';
import { Badge, Button, Input, Spinner, EmptyState } from '../components/ui/ui';
import { cn } from '../lib/utils';

interface Session {
  id: string;
  nodeId: string;
  nodeName: string;
  term: XTerm;
  fit: FitAddon;
  ws: WebSocket;
  container: HTMLDivElement;
  status: 'connecting' | 'open' | 'closed';
  seq: number;
  openedTerminal?: boolean;
  lineBuf?: string;
}

let sessionSeq = 0;
const enc = new TextEncoder();
const dec = new TextDecoder();

function makeTheme() {
  return {
    background: '#0b0d12',
    foreground: '#d4d4d8',
    cursor: '#22d3ee',
    cursorAccent: '#0b0d12',
    selectionBackground: '#164e63aa',
    black: '#18181b', red: '#fb7185', green: '#34d399', yellow: '#fbbf24',
    blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e4e4e7',
    brightBlack: '#52525b', brightRed: '#fda4af', brightGreen: '#86efac', brightYellow: '#fcd34d',
    brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#fafafa',
  };
}

export function Terminal() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: nodes } = usePoll<NodeInfo[]>(() => endpoints.nodes(), 15000);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(14);
  const [query, setQuery] = useState('');
  const [lineMode, setLineMode] = useState(false);
  const [lineBufDisplay, setLineBufDisplay] = useState('');
  const lineModeRef = useRef(false);
  const areaRef = useRef<HTMLDivElement>(null);
  const creatingRef = useRef(false);

  const toggleLineMode = () => {
    lineModeRef.current = !lineModeRef.current;
    setLineMode(lineModeRef.current);
  };

  const onlineNodes = useMemo(() => (nodes ?? []).filter((n) => n.status === 'online'), [nodes]);
  const filteredNodes = onlineNodes.filter((n) => !query || n.name.toLowerCase().includes(query.toLowerCase()));

  const active = sessions.find((s) => s.id === activeId) ?? null;

  const openSession = useCallback(
    (node: { id: string; name: string }) => {
      // reuse existing tab for the node
      const existing = sessions.find((s) => s.nodeId === node.id && s.status !== 'closed');
      if (existing) {
        setActiveId(existing.id);
        return;
      }
      const sid = `t${++sessionSeq}`;
      const term = new XTerm({
        theme: makeTheme(),
        fontFamily: '"JetBrains Mono", ui-monospace, Consolas, monospace',
        fontSize,
        cursorBlink: true,
        scrollback: 8000,
        allowProposedApi: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);

      const container = document.createElement('div');
      container.className = 'absolute inset-0';
      container.dataset.sid = sid;

      const cols = 80;
      const rows = 24;
      const ws = new WebSocket(wsUrl(`/api/ws/terminal/${node.id}`, { cols: String(cols), rows: String(rows) }));
      ws.binaryType = 'arraybuffer';

      const session: Session = { id: sid, nodeId: node.id, nodeName: node.name, term, fit, ws, container, status: 'connecting', seq: 0 };
      session.seq = sessionSeq;

      // NOTE: term.open() + onData wiring happen in the mount effect AFTER the
      // container is appended to the document — opening a terminal on a
      // detached element leaves the keyboard pipeline dead (textarea receives
      // keys but xterm never emits onData).
      ws.onopen = () => {};

      const dec = new TextDecoder();
      (window as unknown as { __termText?: string }).__termText = '';
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const ctl = JSON.parse(ev.data) as { type: string; ok?: boolean; reason?: string };
            (window as unknown as { __omniBridgeMsg?: unknown }).__omniBridgeMsg = ctl;
            if (ctl.type === 'open') {
              if (ctl.ok) {
                session.status = 'open';
                setSessions((s) => [...s]);
              } else {
                session.status = 'closed';
                term.writeln(`\r\n\x1b[31m✗ 无法打开终端: ${ctl.reason ?? '未知原因'}\x1b[0m`);
                setSessions((s) => [...s]);
              }
            } else if (ctl.type === 'closed') {
              session.status = 'closed';
              term.writeln(`\r\n\x1b[33m⟐ 连接已断开${ctl.reason ? ` (${ctl.reason})` : ''}\x1b[0m`);
              setSessions((s) => [...s]);
            } else if (ctl.type === 'pong') {
              /* keepalive */
            }
          } catch {
            /* ignore */
          }
        } else {
          const bytes = new Uint8Array(ev.data as ArrayBuffer);
          // diagnostic mirror of the downstream byte stream (data-layer proof)
          const w = window as unknown as { __termText?: string };
          const decoded = dec.decode(bytes);
          w.__termText = (w.__termText ?? '') + decoded;
          if (w.__termText && w.__termText.length > 20000) w.__termText = w.__termText.slice(-10000);
          // auto-enable line mode when the agent signals a pipe-degraded terminal
          if (!lineModeRef.current && decoded.includes('[omni] pipe terminal')) {
            lineModeRef.current = true;
            setLineMode(true);
          }
          term.write(bytes);
        }
      };

      ws.onclose = () => {
        if (session.status === 'open') {
          session.status = 'closed';
          term.writeln('\r\n\x1b[33m⟐ WebSocket 已关闭\x1b[0m');
          setSessions((s) => [...s]);
        }
      };

      term.attachCustomKeyEventHandler((e) => {
        // Ctrl+Shift+C copy, Ctrl+Shift+V paste (browser native)
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') {
          const sel = term.getSelection();
          if (sel) {
            void navigator.clipboard.writeText(sel);
            return false;
          }
        }
        return true;
      });

      setSessions((s) => [...s, session]);
      setActiveId(sid);
    },
    [sessions, fontSize],
  );

  // auto-open node from query param (?node=<id>)
  useEffect(() => {
    const nodeId = searchParams.get('node');
    if (nodeId && onlineNodes.length && sessions.length === 0 && !creatingRef.current) {
      const node = onlineNodes.find((n) => n.id === nodeId);
      if (node) {
        creatingRef.current = true;
        openSession(node);
        setSearchParams({}, { replace: true });
        creatingRef.current = false;
      }
    }
  }, [searchParams, onlineNodes, sessions.length, openSession, setSearchParams]);

  // mount/unmount session containers + resize handling
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    for (const s of sessions) {
      if (s.container.parentElement !== area) area.appendChild(s.container);
      s.container.style.display = s.id === activeId ? 'block' : 'none';
      // open the terminal only once its container is attached to the document
      // and has layout — this is what keeps the keyboard pipeline alive.
      // Keyboard wiring (onData) MUST run even if open()/fit() throw, so each
      // step gets its own guard and failures land in __omniOpenError.
      if (!s.openedTerminal) {
        const w = window as unknown as { __omniOpenError?: string; __omniSend?: (t: string) => void };
        const doOpen = () => {
          try {
            s.term.open(s.container);
          } catch (e) {
            w.__omniOpenError = 'open: ' + (e instanceof Error ? e.message : String(e));
          }
          try {
            s.fit.fit();
          } catch {
            /* container not laid out yet */
          }
          s.term.onData((d) => {
            const w = window as unknown as { __omniDataFired?: number };
            w.__omniDataFired = (w.__omniDataFired ?? 0) + 1;
            if (s.ws.readyState !== WebSocket.OPEN) return;
            if (lineModeRef.current) {
              // line mode: local line editing — pipe shells have no PTY line
              // discipline, so backspace/erase must happen dashboard-side and
              // the finished line is sent whole on Enter
              if (d === '\r') {
                const line = s.lineBuf ?? '';
                s.lineBuf = '';
                setLineBufDisplay('');
                s.ws.send(enc.encode(line + '\r\n'));
              } else if (d === '\b' || d === '\x7f') {
                s.lineBuf = (s.lineBuf ?? '').slice(0, -1);
                setLineBufDisplay(s.lineBuf ?? '');
              } else if (d === '\x03') {
                s.lineBuf = '';
                setLineBufDisplay('');
              } else if (d >= ' ' || d === '\t') {
                s.lineBuf = (s.lineBuf ?? '') + d;
                setLineBufDisplay(s.lineBuf ?? '');
              }
              return;
            }
            s.ws.send(enc.encode(d));
          });
          // automation bridge: inject keystrokes through the same upstream
          // pipeline as onData (used by test drivers)
          w.__omniSend = (t: string) => {
            if (s.ws.readyState === WebSocket.OPEN) s.ws.send(enc.encode(t));
          };
          s.term.onResize(({ cols: c, rows: r }) => {
            if (s.ws.readyState === WebSocket.OPEN) {
              s.ws.send(JSON.stringify({ type: 'resize', cols: c, rows: r }));
            }
          });
          s.term.focus();
          s.openedTerminal = true;
          // diagnostics: count raw keydowns arriving at the textarea vs onData
          const ta = s.container.querySelector('.xterm-helper-textarea');
          if (ta) {
            (window as unknown as { __kdSeen?: number; __lastKey?: string }).__kdSeen = 0;
            ta.addEventListener(
              'keydown',
              (ev) => {
                const w = window as unknown as { __kdSeen?: number; __lastKey?: string };
                w.__kdSeen = (w.__kdSeen ?? 0) + 1;
                w.__lastKey = (ev as KeyboardEvent).key;
              },
              true,
            );
          }
        };
        if (s.container.clientWidth > 0) {
          doOpen();
        } else {
          // not laid out yet — wait one frame, then try
          requestAnimationFrame(() => {
            if (s.container.clientWidth > 0) doOpen();
            else setTimeout(doOpen, 120);
          });
        }
      }
    }
    const act = sessions.find((s) => s.id === activeId);
    if (act && act.status !== 'connecting' && act.openedTerminal) {
      try {
        act.fit.fit();
        act.term.focus();
      } catch {
        /* noop */
      }
    }
  }, [sessions, activeId]);

  // observe container resizes for the active session
  useEffect(() => {
    const area = areaRef.current;
    if (!area || !active) return;
    const ro = new ResizeObserver(() => {
      if (active.status !== 'connecting') {
        try {
          active.fit.fit();
        } catch {
          /* noop */
        }
      }
    });
    ro.observe(area);
    return () => ro.disconnect();
  }, [active]);

  const closeSession = (sid: string) => {
    const s = sessions.find((x) => x.id === sid);
    if (!s) return;
    try {
      s.ws.send(JSON.stringify({ type: 'close' }));
    } catch {
      /* noop */
    }
    s.ws.close();
    s.term.dispose();
    s.container.remove();
    setSessions((list) => list.filter((x) => x.id !== sid));
    if (activeId === sid) {
      const rest = sessions.filter((x) => x.id !== sid);
      setActiveId(rest.length ? rest[rest.length - 1].id : null);
    }
  };

  const changeFont = (delta: number) => {
    const next = Math.min(24, Math.max(10, fontSize + delta));
    setFontSize(next);
    for (const s of sessions) {
      s.term.options.fontSize = next;
      if (s.id === activeId) {
        try {
          s.fit.fit();
        } catch {
          /* noop */
        }
      }
    }
  };

  return (
    <div className="flex h-full">
      {/* node list */}
      <aside className="hidden lg:flex w-56 shrink-0 flex-col border-r border-zinc-800/70 bg-surface-raised/50">
        <div className="p-3 border-b border-zinc-800/70">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-600" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索在线节点…" className="pl-7 h-8 text-xs" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {filteredNodes.map((n) => (
            <button
              key={n.id}
              onClick={() => openSession(n)}
              className="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800/60 transition-colors"
            >
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse-dot shrink-0" />
              <span className="truncate">{n.name}</span>
              <Plus className="ml-auto h-3.5 w-3.5 text-zinc-600" />
            </button>
          ))}
          {filteredNodes.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-zinc-600">
              {nodes?.length ? '没有在线节点' : '等待节点接入…'}
            </div>
          )}
        </div>
      </aside>

      {/* terminal area */}
      <div className="flex-1 flex flex-col min-w-0">
        <PageHeader title="WebSSH 终端" description="多标签并行远程终端 · Ctrl+Shift+C 复制选中内容" />
        <div className="px-4 sm:px-6">
          <div className="flex items-center gap-2 flex-wrap">
            {/* tabs */}
            <div className="flex items-center gap-1 overflow-x-auto flex-1 min-w-0 pb-0.5">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  onClick={() => setActiveId(s.id)}
                  className={cn(
                    'group flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs cursor-pointer transition-colors whitespace-nowrap',
                    s.id === activeId
                      ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200'
                      : 'border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-zinc-200',
                  )}
                >
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      s.status === 'open' && 'bg-emerald-400',
                      s.status === 'connecting' && 'bg-amber-400 animate-pulse-dot',
                      s.status === 'closed' && 'bg-zinc-600',
                    )}
                  />
                  <span className="max-w-[140px] truncate">{s.nodeName}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeSession(s.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 hover:text-rose-300 transition-opacity"
                    title="关闭标签"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              <div className="relative group">
                <Button size="icon" variant="ghost" title="新建连接（选择在线节点）">
                  <Plus className="h-4 w-4" />
                </Button>
                {onlineNodes.length > 0 && (
                  <div className="absolute left-0 top-full mt-1 hidden group-hover:block z-20 w-44 rounded-lg border border-zinc-700 bg-surface-overlay shadow-panel py-1 max-h-56 overflow-y-auto">
                    {onlineNodes.map((n) => (
                      <button
                        key={n.id}
                        onClick={() => openSession(n)}
                        className="w-full px-3 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800"
                      >
                        {n.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {/* toolbar */}
            <div className="flex items-center gap-1 pb-0.5">
              <Button
                size="sm"
                variant={lineMode ? 'primary' : 'ghost'}
                title="行模式：输入在本地编辑，回车后整行发送（管道降级终端建议开启）"
                onClick={toggleLineMode}
                className={cn('whitespace-nowrap', lineMode && 'font-medium')}
              >
                行模式
              </Button>
              {lineMode && (
                <span className="hidden md:inline-flex items-center max-w-[240px] rounded border border-cyan-500/30 bg-cyan-500/5 px-2 py-1 text-[11px] font-mono text-cyan-200 truncate">
                  {lineBufDisplay || '…'}
                </span>
              )}
              <Button size="icon" variant="ghost" title="减小字号" onClick={() => changeFont(-1)}>
                <Minus className="h-3.5 w-3.5" />
              </Button>
              <span className="text-[11px] text-zinc-500 w-6 text-center tabular-nums">{fontSize}</span>
              <Button size="icon" variant="ghost" title="增大字号" onClick={() => changeFont(1)}>
                <ZoomIn className="h-3.5 w-3.5" />
              </Button>
              {active && (
                <Button size="icon" variant="ghost" title="关闭当前标签" onClick={() => closeSession(active.id)}>
                  <Trash2 className="h-3.5 w-3.5 text-rose-400/70" />
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* terminal surface */}
        <div className="flex-1 min-h-0 px-4 sm:px-6 pb-4">
          <div className="relative h-full rounded-xl border border-zinc-800/80 overflow-hidden bg-[#0b0d12] shadow-panel">
            {sessions.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center">
                {nodes === null ? (
                  <Spinner />
                ) : onlineNodes.length === 0 ? (
                  <EmptyState title="没有在线节点" description="接入节点后即可建立 WebSSH 会话" />
                ) : (
                  <EmptyState
                    icon={<span className="text-3xl font-mono text-zinc-700">&gt;_</span>}
                    title="从左侧选择一个节点"
                    description="每个标签页对应一个独立的 PTY 会话，互不干扰"
                    actions={
                      <div className="flex gap-2">
                        {onlineNodes.slice(0, 3).map((n) => (
                          <Button key={n.id} size="sm" variant="outline" onClick={() => openSession(n)}>
                            连接 {n.name}
                          </Button>
                        ))}
                      </div>
                    }
                  />
                )}
              </div>
            ) : null}
            {/* session containers (kept mounted; hidden per tab) */}
            <div ref={areaRef} className="absolute inset-0" />
            {active?.status === 'connecting' && (
              <div className="absolute right-3 top-3">
                <Badge tone="warn">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse-dot" /> 连接中…
                </Badge>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
