import type { MiddlewareHandler } from 'hono';
import type { HonoEnv } from './env';
import { fail } from './util';
import { jwtVerify } from './crypto';

/** Dashboard JWT auth (Authorization: Bearer … or ?token= for websockets). */
export function requireAuth(): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : c.req.query('token');
    if (!token) return fail('unauthorized', 401);
    const claims = await jwtVerify(c.env.AUTH_SECRET, token);
    if (!claims) return fail('invalid or expired token', 401);
    c.set('session', { sub: claims.sub, name: claims.name, role: claims.role, exp: claims.exp });
    await next();
  };
}
