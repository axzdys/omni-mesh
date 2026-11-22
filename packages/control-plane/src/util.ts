import type { Env } from './env';

/** Monotonic-ish random id with a 2-char type prefix. */
export function id(prefix: string): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += b.toString(36).padStart(2, '0');
  return `${prefix}_${s.slice(0, 12)}`;
}

export function now(): number {
  return Date.now();
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function ok(data: unknown = null, headers?: Record<string, string>): Response {
  return json({ ok: true, data }, 200, headers);
}

export function fail(error: string, status = 400, code?: string): Response {
  return json({ ok: false, error, code }, status);
}

/** Encode/decode helpers (URL-safe base64). */
export function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u8) s += b.toString(16).padStart(2, '0');
  return s;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return hex(digest);
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function clientIp(req: Request): string {
  return (
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'local'
  );
}

/** Fire-and-forget promise kept alive by the Workers runtime. */
export function waitUntil(ctx: { waitUntil: (p: Promise<unknown>) => void }, p: Promise<unknown>): void {
  try {
    ctx.waitUntil(p);
  } catch {
    /* contexts without waitUntil (e.g. direct fetch in tests) */
  }
}

/** Safe JSON parse. */
export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export interface WaitCtx {
  waitUntil: (p: Promise<unknown>) => void;
}

/** Standard agent session dispatch URL inside a Durable Object namespace stub. */
export function agentStub(env: Env, nodeId: string): DurableObjectStub {
  return env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(nodeId));
}

export function schedulerStub(env: Env): DurableObjectStub {
  return env.SCHEDULER.get(env.SCHEDULER.idFromName('scheduler'));
}

export function eventsStub(env: Env): DurableObjectStub {
  return env.EVENTS.get(env.EVENTS.idFromName('events'));
}

export function logHubStub(env: Env, taskId: string): DurableObjectStub {
  return env.LOGHUB.get(env.LOGHUB.idFromName(taskId));
}

export function terminalStub(env: Env, termId: string): DurableObjectStub {
  return env.TERMINAL.get(env.TERMINAL.idFromName(termId));
}

export const AGENT_VERSION = '1.0.0';
