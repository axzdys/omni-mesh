import { useEffect, useMemo, useRef, useState } from 'react';
import type { DashEvent } from '@omni/shared';
import { wsUrl } from '../lib/api';

/**
 * Global live-event stream from /api/ws/events. Reconnects automatically.
 */
export function useEvents(onEvent?: (ev: DashEvent) => void): { connected: boolean; lastEvent: DashEvent | null } {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<DashEvent | null>(null);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedRef = useRef(false);

  useEffect(() => {
    closedRef.current = false;
    const connect = () => {
      if (closedRef.current) return;
      const ws = new WebSocket(wsUrl('/api/ws/events'));
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data as string) as DashEvent;
          setLastEvent(ev);
          handlerRef.current?.(ev);
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closedRef.current) {
          retryRef.current = setTimeout(connect, 3000);
        }
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => {
      closedRef.current = true;
      if (retryRef.current) clearTimeout(retryRef.current);
      wsRef.current?.close();
    };
  }, []);

  return { connected, lastEvent };
}

/** Simple polling hook with interval. */
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number | null, deps: unknown[] = []): { data: T | null; error: string | null; reload: () => void; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      // pause background polling while the tab is hidden — keeps D1/API
      // quotas (free tier) from burning on invisible pages
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const d = await fnRef.current();
        if (alive) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    };
    void run();
    let timer: ReturnType<typeof setInterval> | null = null;
    if (intervalMs != null) {
      timer = setInterval(run, intervalMs);
    }
    const onVisible = () => {
      if (!document.hidden) void run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, tick, ...deps]);

  const reload = useMemo(() => () => setTick((t) => t + 1), []);
  return { data, error, reload, loading };
}
