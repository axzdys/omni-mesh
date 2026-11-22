import type { NodeInfo, ExecTask, CronJob, WorkflowDef, WorkflowRun, AuditEntry, RegKey, MetricsPoint } from '@omni/shared';

export interface ApiError extends Error {
  status?: number;
}

const TOKEN_KEY = 'omni_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    setToken(null);
    window.location.href = '/login';
    throw new Error('unauthorized');
  }
  const body = (await res.json().catch(() => ({ ok: false, error: 'invalid response' }))) as { ok: boolean; data?: T; error?: string };
  if (!res.ok || !body.ok) {
    const err = new Error(body.error ?? `HTTP ${res.status}`) as ApiError;
    err.status = res.status;
    throw err;
  }
  return body.data as T;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T,>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ─── Typed endpoints ─────────────────────────────────────────────────────

export interface OverviewData {
  stats: { nodesTotal: number; nodesOnline: number; nodesOffline: number; runningTasks: number; labels: string[] };
  live: { nodeId: string; name: string; labels: string[]; metrics: LatestMetrics | null }[];
  recentTasks: ExecTask[];
  alerts: { id: string; ts: number; level: string; title: string; message: string; nodeId: string | null; notified: boolean }[];
}

export interface LatestMetrics {
  ts: number;
  cpu: number | null;
  memUsed: number | null;
  memTotal: number | null;
  diskTotal: number | null;
  diskUsed: number | null;
  diskReadBps: number | null;
  diskWriteBps: number | null;
  netInBps: number | null;
  netOutBps: number | null;
  load1: number | null;
  procs: number | null;
  uptime: number | null;
}

export interface MetricsData {
  range: '1h' | '24h' | '7d';
  points: MetricsPoint[];
  latest: LatestMetrics | null;
}

export interface TaskListData {
  total: number;
  tasks: ExecTask[];
}

export const endpoints = {
  login: (username: string, password: string) =>
    api.post<{ token: string; username: string; role: string }>('/api/auth/login', { username, password }),
  me: () => api.get<{ userId: string; username: string; role: string }>('/api/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<null>('/api/auth/change-password', { currentPassword, newPassword }),
  overview: () => api.get<OverviewData>('/api/overview'),
  overviewHistory: () => api.get<{ points: Record<string, number | null>[] }>('/api/overview/history'),
  nodes: () => api.get<NodeInfo[]>('/api/nodes'),
  node: (id: string) => api.get<NodeInfo>(`/api/nodes/${id}`),
  deleteNode: (id: string) => api.del<null>(`/api/nodes/${id}`),
  metrics: (nodeId: string, range: '1h' | '24h' | '7d') => api.get<MetricsData>(`/api/metrics/${nodeId}?range=${range}`),
  exec: (body: { targetType: string; targetValue?: string; script: string; lang: string; timeoutMs: number; env?: Record<string, string> }) =>
    api.post<{ tasks: { taskId: string; nodeId: string }[] }>('/api/exec', body),
  tasks: (params: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    return api.get<TaskListData>(`/api/tasks?${qs.toString()}`);
  },
  task: (id: string) => api.get<ExecTask>(`/api/tasks/${id}`),
  cancelTask: (id: string) => api.post<null>(`/api/tasks/${id}/cancel`),
  taskLogUrl: (id: string) => `/api/tasks/${id}/log`,
  cronList: () => api.get<CronJob[]>('/api/cron'),
  cronCreate: (body: Record<string, unknown>) => api.post<{ id: string }>('/api/cron', body),
  cronUpdate: (id: string, body: Record<string, unknown>) => api.put<null>(`/api/cron/${id}`, body),
  cronDelete: (id: string) => api.del<null>(`/api/cron/${id}`),
  cronToggle: (id: string) => api.post<{ enabled: boolean }>(`/api/cron/${id}/toggle`),
  cronRun: (id: string) => api.post<{ taskIds: string[] }>(`/api/cron/${id}/run`),
  cronPreview: (expr: string) => api.post<{ next: number[] }>('/api/cron/preview', { expr }),
  cronHistory: (id: string) => api.get<TaskListData>(`/api/tasks?refId=${id}&kind=cron&limit=30`),
  workflows: () => api.get<WorkflowDef[]>('/api/workflows'),
  workflowCreate: (name: string, graph: unknown) => api.post<{ id: string }>('/api/workflows', { name, graph }),
  workflowUpdate: (id: string, name: string, graph: unknown) => api.put<null>(`/api/workflows/${id}`, { name, graph }),
  workflowDelete: (id: string) => api.del<null>(`/api/workflows/${id}`),
  workflowRun: (id: string) => api.post<{ runId: string }>(`/api/workflows/${id}/run`),
  workflowValidate: (graph: unknown) => api.post<{ valid: boolean; issues: { stepId: string; message: string }[] }>('/api/workflows/validate', graph),
  runs: (defId?: string) => api.get<{ id: string; defId: string; defName: string; status: string; createdAt: number; finishedAt: number | null }[]>('/api/workflows/runs' + (defId ? `?defId=${defId}` : '')),
  run: (id: string) => api.get<WorkflowRun>(`/api/workflows/runs/${id}`),
  audit: (params: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    return api.get<{ total: number; entries: AuditEntry[] }>(`/api/audit?${qs.toString()}`);
  },
  keys: () => api.get<RegKey[]>('/api/keys'),
  createKey: (name: string) => api.post<{ id: string; key: string }>('/api/keys', { name }),
  revokeKey: (id: string) => api.del<null>(`/api/keys/${id}`),
  webhookSettings: () => api.get<{ type: string; telegramChatId: string; genericUrl: string; hasBotToken: boolean; hasSecret: boolean }>('/api/settings/webhook'),
  saveWebhook: (body: Record<string, unknown>) => api.put<null>('/api/settings/webhook', body),
  testWebhook: () => api.post<{ ok: boolean; error?: string }>('/api/settings/webhook/test'),
  uploadFile: (nodeId: string, path: string, dataB64: string) => api.post<{ received: number }>(`/api/nodes/${nodeId}/files`, { path, dataB64 }),
  downloadFile: async (nodeId: string, path: string): Promise<void> => {
    const qs = new URLSearchParams({ path, token: getToken() ?? '' });
    const res = await fetch(`/api/nodes/${nodeId}/files?${qs.toString()}`);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = path.split(/[\\/]/).pop() || 'file';
    a.click();
  },
};

/** Build an authenticated WebSocket URL. */
export function wsUrl(path: string, params: Record<string, string> = {}): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = getToken() ?? '';
  const qs = new URLSearchParams({ token, ...params });
  return `${proto}//${window.location.host}${path}?${qs.toString()}`;
}
