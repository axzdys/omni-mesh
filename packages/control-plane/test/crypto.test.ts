import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, jwtSign, jwtVerify, signNodeToken, verifyNodeToken, aesEncrypt, aesDecrypt, randomToken } from '../src/crypto';
import { encodeBinaryFrame, decodeBinaryFrame, envelope, AgentMsg } from '@omni/shared';

const SECRET = 'test-secret-0123456789abcdef';

describe('password hashing', () => {
  it('roundtrips', async () => {
    const h = await hashPassword('s3cret-password');
    expect(await verifyPassword('s3cret-password', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });

  it('salts individually', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
  });

  it('rejects malformed hashes', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('jwt', () => {
  it('signs and verifies', async () => {
    const token = await jwtSign(SECRET, { sub: 'u1', name: 'admin', role: 'admin' }, 60);
    const claims = await jwtVerify(SECRET, token);
    expect(claims?.sub).toBe('u1');
    expect(claims?.name).toBe('admin');
  });

  it('rejects tampered payloads', async () => {
    const token = await jwtSign(SECRET, { sub: 'u1', name: 'admin', role: 'admin' }, 60);
    const parts = token.split('.');
    const json = JSON.stringify({ sub: 'attacker', name: 'x', role: 'admin', iat: 1, exp: 9999999999 });
    const forgedBody = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const forged = `${parts[0]}.${forgedBody}.${parts[2]}`;
    expect(await jwtVerify(SECRET, forged)).toBeNull();
  });

  it('rejects expired tokens', async () => {
    const token = await jwtSign(SECRET, { sub: 'u1', name: 'admin', role: 'admin' }, -10);
    expect(await jwtVerify(SECRET, token)).toBeNull();
  });

  it('rejects wrong secrets', async () => {
    const token = await jwtSign(SECRET, { sub: 'u1', name: 'admin', role: 'admin' }, 60);
    expect(await jwtVerify('other-secret', token)).toBeNull();
  });
});

describe('node tokens', () => {
  it('signs and verifies', async () => {
    const tok = await signNodeToken(SECRET, 'nd_abc123');
    expect(await verifyNodeToken(SECRET, tok)).toBe('nd_abc123');
  });

  it('rejects tampered ids', async () => {
    const tok = await signNodeToken(SECRET, 'nd_abc123');
    expect(await verifyNodeToken(SECRET, 'nd_hacked' + tok.slice(tok.indexOf('.')))).toBeNull();
  });

  it('rejects non-node ids', async () => {
    expect(await verifyNodeToken(SECRET, 'user_x.sig')).toBeNull();
  });
});

describe('aes-gcm', () => {
  it('roundtrips unicode payloads', async () => {
    const secret = JSON.stringify({ FOO: 'bar', 秘密: '值✓' });
    const enc = await aesEncrypt(SECRET, secret);
    expect(await aesDecrypt(SECRET, enc)).toBe(secret);
  });

  it('produces different ciphertexts per call', async () => {
    expect(await aesEncrypt(SECRET, 'a')).not.toBe(await aesEncrypt(SECRET, 'a'));
  });

  it('fails with a wrong key', async () => {
    const enc = await aesEncrypt(SECRET, 'a');
    await expect(aesDecrypt('other-secret', enc)).rejects.toThrow();
  });
});

describe('shared protocol codec', () => {
  it('envelopes carry type/timestamp', () => {
    const e = envelope(AgentMsg.HEARTBEAT, { uptimeSec: 10 });
    expect(e.t).toBe('HEARTBEAT');
    expect(typeof e.ts).toBe('number');
  });

  it('binary frames roundtrip', () => {
    const payload = new Uint8Array([1, 2, 3, 250, 251]);
    const frame = encodeBinaryFrame(0x01, 'term_abc', payload);
    const dec = decodeBinaryFrame(frame);
    expect(dec?.kind).toBe(0x01);
    expect(dec?.channelId).toBe('term_abc');
    expect([...(dec?.payload ?? [])]).toEqual([...payload]);
  });

  it('binary frames handle empty payloads', () => {
    const dec = decodeBinaryFrame(encodeBinaryFrame(0x02, 'ft_1', new Uint8Array(0)));
    expect(dec?.channelId).toBe('ft_1');
    expect(dec?.payload.length).toBe(0);
  });

  it('returns null on truncated frames', () => {
    expect(decodeBinaryFrame(new Uint8Array([0x01]))).toBeNull();
    expect(decodeBinaryFrame(new Uint8Array([0x01, 5, 104]))).toBeNull();
  });
});

describe('randomToken', () => {
  it('is url-safe and long enough', () => {
    const t = randomToken(24);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(20);
  });
});
