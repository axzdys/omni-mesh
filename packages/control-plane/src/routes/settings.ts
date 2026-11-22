import { Hono } from 'hono';
import type { HonoEnv } from '../env';
import { requireAuth } from '../middleware';
import { ok, fail } from '../util';
import { getSetting, putSetting, audit } from '../db';
import { aesEncrypt, aesDecrypt } from '../crypto';
import { testWebhook, type WebhookConfig } from '../webhook';
import { z } from 'zod';

export const settingsRoutes = new Hono<HonoEnv>();

settingsRoutes.use('*', requireAuth());

const webhookSchema = z.object({
  type: z.enum(['none', 'telegram', 'generic']),
  telegramBotToken: z.string().max(200).optional(), // plaintext in transit, stored encrypted
  telegramChatId: z.string().max(64).optional(),
  genericUrl: z.string().url().max(500).optional().or(z.literal('')),
  genericSecret: z.string().max(200).optional(),
});

settingsRoutes.get('/webhook', async (c) => {
  const cfg = (await getSetting(c.env.DB, 'webhook')) as unknown as WebhookConfig | null;
  if (!cfg) return ok({ type: 'none', telegramChatId: '', genericUrl: '', hasBotToken: false, hasSecret: false });
  return ok({
    type: cfg.type ?? 'none',
    telegramChatId: cfg.telegramChatId ?? '',
    genericUrl: cfg.genericUrl ?? '',
    hasBotToken: Boolean(cfg.telegramBotTokenEnc),
    hasSecret: Boolean(cfg.genericSecret),
  });
});

settingsRoutes.put('/webhook', async (c) => {
  const parsed = webhookSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'invalid body', 400);
  const prev = ((await getSetting(c.env.DB, 'webhook')) as unknown as WebhookConfig | null) ?? { type: 'none' };
  const d = parsed.data;
  const cfg: WebhookConfig = {
    type: d.type,
    telegramChatId: d.telegramChatId || undefined,
    genericUrl: d.genericUrl || undefined,
    genericSecret: d.genericSecret || prev.genericSecret,
    telegramBotTokenEnc: d.telegramBotToken
      ? await aesEncrypt(c.env.AUTH_SECRET, d.telegramBotToken)
      : prev.telegramBotTokenEnc,
  };
  if (d.type === 'telegram' && !cfg.telegramBotTokenEnc) return fail('telegram bot token required', 400);
  if (d.type === 'telegram' && !cfg.telegramChatId) return fail('telegram chat id required', 400);
  if (d.type === 'generic' && !cfg.genericUrl) return fail('generic webhook url required', 400);
  await putSetting(c.env.DB, 'webhook', cfg);
  await audit(c.env.DB, { actor: c.get('session')!.name, action: 'settings.update', target: 'webhook', detail: `type=${d.type}` });
  return ok(null);
});

settingsRoutes.post('/webhook/test', async (c) => {
  const res = await testWebhook(c.env.DB, c.env.AUTH_SECRET);
  return ok(res);
});

settingsRoutes.get('/decrypt-check', async (c) => {
  // internal sanity endpoint used by tests: verifies AES roundtrip
  const sample = c.req.query('sample') ?? 'ping';
  const enc = await aesEncrypt(c.env.AUTH_SECRET, sample);
  const dec = await aesDecrypt(c.env.AUTH_SECRET, enc);
  return ok({ matches: dec === sample });
});
