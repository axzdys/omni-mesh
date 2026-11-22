/**
 * First-boot bootstrap: creates the default admin user, a default
 * registration key and default settings so a fresh deployment is usable
 * immediately. Idempotent.
 */

import { hashPassword, randomToken } from './crypto';
import { sha256Hex } from './util';
import { countUsers, getUserByName, insertRegKey, insertUser, putSetting } from './db';
import type { DB } from './db';

export interface BootstrapResult {
  createdAdmin: boolean;
  createdRegKey: boolean;
}

export async function ensureBootstrap(db: DB, env: { ADMIN_PASSWORD?: string; DEFAULT_REG_KEY?: string }): Promise<BootstrapResult> {
  const result: BootstrapResult = { createdAdmin: false, createdRegKey: false };

  if ((await countUsers(db)) === 0) {
    const password = env.ADMIN_PASSWORD || 'admin123';
    await insertUser(db, {
      id: crypto.randomUUID(),
      username: 'admin',
      password_hash: await hashPassword(password),
      role: 'admin',
    });
    result.createdAdmin = true;
  } else if (!(await getUserByName(db, 'admin'))) {
    // ensure the canonical admin account exists even if other users do
    const password = env.ADMIN_PASSWORD || 'admin123';
    await insertUser(db, {
      id: crypto.randomUUID(),
      username: 'admin',
      password_hash: await hashPassword(password),
      role: 'admin',
    });
    result.createdAdmin = true;
  }

  const keys = await db.prepare('SELECT COUNT(*) AS c FROM reg_keys').all<{ c: number }>();
  if ((keys.results?.[0]?.c as number | undefined) === 0) {
    const rawKey = env.DEFAULT_REG_KEY || `omni-${randomToken(12)}`;
    await insertRegKey(db, {
      id: crypto.randomUUID(),
      name: 'default',
      key_hash: await sha256Hex(rawKey),
      prefix: rawKey.slice(0, 8),
      enabled: 1,
      created_at: Date.now(),
      last_used_at: null,
    });
    await putSetting(db, 'default_reg_key_hint', { note: 'initial registration key created at bootstrap' });
    result.createdRegKey = true;
  }

  return result;
}
