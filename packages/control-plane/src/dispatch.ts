/**
 * Shared task-dispatch logic used by REST routes and the Scheduler DO.
 */

import { AgentMsg, envelope, type ExecReqPayload } from '@omni/shared';
// note: EXEC_CANCEL is delivered via the AgentSession /cancel endpoint
import type { Env } from './env';
import { agentStub } from './util';
import { decryptEnv, finishTask, type TaskRow } from './db';

export type DispatchOutcome = 'sent' | 'offline';

/**
 * Send EXEC_REQ to the agent session DO for the task's node.
 * The AgentSession DO marks the task running when it actually hands the
 * message to the agent socket (single source of truth for attempts).
 */
export async function dispatchTask(
  env: Env,
  task: Pick<TaskRow, 'id' | 'node_id' | 'script' | 'lang' | 'timeout_ms' | 'env_enc'>,
  secret: string,
): Promise<DispatchOutcome> {
  const envVars = await decryptEnv(secret, task.env_enc);
  const payload: ExecReqPayload = {
    taskId: task.id,
    script: task.script,
    lang: (task.lang as 'shell' | 'python') ?? 'shell',
    env: envVars,
    timeoutMs: task.timeout_ms,
  };
  try {
    const res = await agentStub(env, task.node_id).fetch('https://agent.internal/dispatch', {
      method: 'POST',
      body: JSON.stringify({ message: envelope(AgentMsg.EXEC_REQ, payload) }),
    });
    if (!res.ok) {
      return 'offline';
    }
    return 'sent';
  } catch {
    return 'offline';
  }
}

/** Mark a task failed with an explanatory error. */
export async function failTask(env: Env, taskId: string, error: string, status: 'failed' | 'cancelled' = 'failed'): Promise<void> {
  await finishTask(env.DB, taskId, { status, exitCode: null, error });
}

/** Best-effort cancel: tells the agent to kill the running command. */
export async function cancelExecTask(env: Env, taskId: string): Promise<void> {
  const task = await getTaskRow(env, taskId);
  if (!task) return;
  try {
    await agentStub(env, task.node_id).fetch('https://agent.internal/cancel', {
      method: 'POST',
      body: JSON.stringify({ taskId }),
    });
  } catch {
    /* agent offline; task will be marked cancelled by caller if queued */
  }
}

async function getTaskRow(env: Env, taskId: string): Promise<{ node_id: string } | null> {
  const { getTask } = await import('./db');
  const t = await getTask(env.DB, taskId);
  return t ? { node_id: t.node_id } : null;
}
