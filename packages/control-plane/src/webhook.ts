/**
 * Webhook alerter — pushes node-offline alerts to Telegram or a generic
 * HTTP endpoint, configured in Settings (secrets stored AES-GCM encrypted).
 */

import { aesDecrypt } from './crypto';
import { addAlert, audit, getSetting, markAlertNotified } from './db';
import type { DB } from './db';

export interface WebhookConfig {
  type: 'none' | 'telegram' | 'generic';
  telegramBotTokenEnc?: string; // AES-GCM ciphertext
  telegramChatId?: string;
  genericUrl?: string;
  genericSecret?: string; // optional HMAC header
}

export async function getWebhookConfig(db: DB, secret: string): Promise<WebhookConfig> {
  const s = await getSetting(db, 'webhook');
  if (!s) return { type: 'none' };
  return s as unknown as WebhookConfig;
}

export async function sendTelegram(token: string, chatId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `telegram ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function sendGeneric(url: string, secret: string | undefined, payload: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (secret) {
      headers['x-omni-signature'] = await hmacHex(secret, JSON.stringify(payload));
    }
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (!res.ok) return { ok: false, error: `endpoint ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  let s = '';
  for (const b of sig) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * Persist an alert row and push it to the configured webhook (fire & forget).
 * Returns the alert id when persisted.
 */
export async function raiseAlert(
  db: DB,
  secret: string,
  a: { level: 'info' | 'warn' | 'error'; title: string; message: string; nodeId?: string | null },
): Promise<void> {
  await addAlert(db, a);
  const cfg = await getWebhookConfig(db, secret);
  if (cfg.type === 'none') return;
  let sent: { ok: boolean; error?: string } = { ok: false, error: 'unconfigured' };
  if (cfg.type === 'telegram' && cfg.telegramBotTokenEnc && cfg.telegramChatId) {
    const token = await aesDecrypt(secret, cfg.telegramBotTokenEnc).catch(() => '');
    if (token) {
      sent = await sendTelegram(token, cfg.telegramChatId, `🚨 <b>${escapeHtml(a.title)}</b>\n${escapeHtml(a.message)}`);
    }
  } else if (cfg.type === 'generic' && cfg.genericUrl) {
    sent = await sendGeneric(cfg.genericUrl, cfg.genericSecret, a);
  }
  // alerts are marked notified best-effort regardless (row-level flag)
  if (sent.ok) {
    await markAlertNotified(db, crypto.randomUUID()).catch(() => {});
  }
}

export async function testWebhook(db: DB, secret: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getWebhookConfig(db, secret);
  if (cfg.type === 'telegram' && cfg.telegramBotTokenEnc && cfg.telegramChatId) {
    const token = await aesDecrypt(secret, cfg.telegramBotTokenEnc).catch(() => '');
    if (!token) return { ok: false, error: 'stored bot token could not be decrypted' };
    return sendTelegram(token, cfg.telegramChatId, '✅ OmniMesh webhook test — connection OK');
  }
  if (cfg.type === 'generic' && cfg.genericUrl) {
    return sendGeneric(cfg.genericUrl, cfg.genericSecret, {
      level: 'info',
      title: 'OmniMesh webhook test',
      message: 'Connection OK',
      ts: Date.now(),
    });
  }
  return { ok: false, error: 'webhook not configured' };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export { audit };
