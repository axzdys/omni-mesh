import type { AgentMsgType, ExecLang } from '@omni/shared';

export interface Env {
  DB: D1Database;
  LOGS: R2Bucket;
  ASSETS: Fetcher;
  AGENT_SESSION: DurableObjectNamespace;
  TERMINAL: DurableObjectNamespace;
  LOGHUB: DurableObjectNamespace;
  EVENTS: DurableObjectNamespace;
  SCHEDULER: DurableObjectNamespace;
  AUTH_SECRET: string;
  ADMIN_PASSWORD?: string;
  DEFAULT_REG_KEY?: string;
}

/** Authenticated dashboard session (JWT claims). */
export interface Session {
  sub: string;
  name: string;
  role: string;
  exp: number;
}

/** Authenticated agent identity (node token). */
export interface AgentIdentity {
  nodeId: string;
}

export interface HonoEnv {
  Bindings: Env;
  Variables: {
    session?: Session;
    agent?: AgentIdentity;
  };
}

export interface LogMeta {
  totalChunks: number;
  bytes: number;
  startedAt: number;
}

export interface AgentTaskSnapshot {
  taskId: string;
  chunks: number;
  bytes: number;
  log: string[];
}
