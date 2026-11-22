/**
 * Cryptography — PBKDF2 password hashing, HS256 JWT, node tokens (HMAC),
 * and AES-256-GCM encryption of sensitive settings/environment variables.
 * Pure WebCrypto: no external dependencies.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

// ─── PBKDF2 password hashing ─────────────────────────────────────────────

// 10k iterations: tuned for the Workers free-tier 10ms CPU budget (WebCrypto
// PBKDF2 is native and fast, but 120k overshoots it ~10x). Combined with a
// 16-byte random salt and an 8+ character password policy this is an
// acceptable trade-off for a self-hosted personal control plane. The
// iteration count is stored inside the hash string, so raising it later only
// affects new/changed passwords.
const PBKDF2_ITERATIONS = 10_000;

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `pbkdf2$${iterations}$${toB64(salt)}$${toB64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  const salt = fromB64(parts[2]);
  const expected = fromB64(parts[3]);
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, expected.length * 8),
  );
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ bits[i];
  return diff === 0;
}

function toB64(u8: Uint8Array): string {
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ─── HMAC-SHA256 primitives ──────────────────────────────────────────────

async function hmacKey(secret: string, usage: 'sign' | 'verify' | 'both'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usage === 'both' ? ['sign', 'verify'] : [usage],
  );
}

export async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await hmacKey(secret, 'sign');
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return toB64(new Uint8Array(sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hmacVerify(secret: string, data: string, signatureB64url: string): Promise<boolean> {
  const key = await hmacKey(secret, 'both');
  const padded = signatureB64url.replace(/-/g, '+').replace(/_/g, '/');
  const sig = Uint8Array.from(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)), (c) => c.charCodeAt(0));
  return crypto.subtle.verify('HMAC', key, sig, enc.encode(data));
}

// ─── JWT (HS256) ─────────────────────────────────────────────────────────

export interface JwtClaims {
  sub: string;
  name: string;
  role: string;
  iat: number;
  exp: number;
}

function b64urlJson(obj: unknown): string {
  return toB64(enc.encode(JSON.stringify(obj))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function jwtSign(
  secret: string,
  claims: { sub: string; name: string; role: string },
  ttlSec: number,
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtClaims = { ...claims, iat: now, exp: now + ttlSec };
  const head = b64urlJson(header);
  const body = b64urlJson(payload);
  const sig = await hmacSign(secret, `${head}.${body}`);
  return `${head}.${body}.${sig}`;
}

export async function jwtVerify(secret: string, token: string): Promise<JwtClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  if (!(await hmacVerify(secret, `${head}.${body}`, sig))) return null;
  try {
    const json = dec.decode(
      fromB64(body.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (body.length % 4)) % 4)),
    );
    const claims = JSON.parse(json) as JwtClaims;
    if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
    if (!claims.sub) return null;
    return claims;
  } catch {
    return null;
  }
}

// ─── Node tokens (stateless HMAC: nodeId.signature) ──────────────────────

export async function signNodeToken(secret: string, nodeId: string): Promise<string> {
  return `${nodeId}.${await hmacSign(secret, `node:${nodeId}`)}`;
}

export async function verifyNodeToken(secret: string, token: string): Promise<string | null> {
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const nodeId = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!nodeId.startsWith('nd_')) return null;
  if (!(await hmacVerify(secret, `node:${nodeId}`, sig))) return null;
  return nodeId;
}

// ─── AES-256-GCM (environment variables & webhook secrets at rest) ───────

async function aesKey(secret: string): Promise<CryptoKey> {
  // HKDF-SHA256 derive a dedicated encryption key from AUTH_SECRET
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('omni-mesh-enc-v1'), info: enc.encode('aes-gcm-env') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Returns base64( iv[12] || ciphertext ). */
export async function aesEncrypt(secret: string, plaintext: string): Promise<string> {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toB64(out);
}

export async function aesDecrypt(secret: string, blob: string): Promise<string> {
  const key = await aesKey(secret);
  const raw = fromB64(blob);
  const iv = raw.subarray(0, 12);
  const ct = raw.subarray(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return dec.decode(pt);
}

// ─── Random tokens ───────────────────────────────────────────────────────

export function randomToken(bytes = 24): string {
  const u8 = crypto.getRandomValues(new Uint8Array(bytes));
  return toB64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
