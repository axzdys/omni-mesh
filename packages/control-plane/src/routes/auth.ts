import { Hono } from 'hono';
import type { HonoEnv } from '../env';
import { fail, ok, clientIp, id as newId } from '../util';
import { getUserByName, updateUserPassword, audit, countUsers, insertUser } from '../db';
import { hashPassword, jwtSign, verifyPassword } from '../crypto';
import { requireAuth } from '../middleware';

const JWT_TTL_SEC = 12 * 3600;

export const authRoutes = new Hono<HonoEnv>();

authRoutes.post('/login', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { username?: string; password?: string };
  const username = (body.username ?? '').trim();
  const password = body.password ?? '';
  if (!username || !password) return fail('username and password are required', 400);

  const user = await getUserByName(c.env.DB, username);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    await audit(c.env.DB, { actor: username || 'unknown', action: 'auth.failed', ip: clientIp(c.req.raw) });
    return fail('invalid credentials', 401);
  }
  const token = await jwtSign(c.env.AUTH_SECRET, { sub: user.id, name: user.username, role: user.role }, JWT_TTL_SEC);
  await audit(c.env.DB, { actor: username, action: 'auth.login', ip: clientIp(c.req.raw) });
  return ok({ token, username: user.username, role: user.role });
});

// everything below requires a session
authRoutes.use('*', requireAuth());

authRoutes.get('/me', async (c) => {
  const s = c.get('session')!;
  return ok({ userId: s.sub, username: s.name, role: s.role });
});

authRoutes.post('/change-password', async (c) => {
  const s = c.get('session')!;
  const body = (await c.req.json().catch(() => ({}))) as { currentPassword?: string; newPassword?: string };
  const current = body.currentPassword ?? '';
  const next = body.newPassword ?? '';
  if (next.length < 8) return fail('new password must be at least 8 characters', 400);
  const user = await getUserByName(c.env.DB, s.name);
  if (!user || !(await verifyPassword(current, user.password_hash))) {
    return fail('current password is incorrect', 403);
  }
  await updateUserPassword(c.env.DB, user.id, await hashPassword(next));
  await audit(c.env.DB, { actor: s.name, action: 'auth.change-password' });
  return ok(null);
});
