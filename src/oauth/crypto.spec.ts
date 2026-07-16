import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';

const testCodeId = randomBytes(16).toString('hex');
import {
  encryptToken,
  decryptToken,
  createAccessToken,
  createRefreshToken,
  createAuthCode,
  verifyAndDecrypt,
} from './crypto.js';

const secret = randomBytes(32);
const futureEpoch = Math.floor(Date.now() / 1000) + 3600;
const pastEpoch = Math.floor(Date.now() / 1000) - 3600;

describe('encryptToken / decryptToken', () => {
  it('round-trips a payload', () => {
    const payload = { hello: 'world', n: 42 };
    const token = encryptToken(payload, secret);
    const result = decryptToken(token, secret);
    expect(result).toEqual(payload);
  });

  it('produces different ciphertext for the same payload (random IV)', () => {
    const payload = { x: 1 };
    const a = encryptToken(payload, secret);
    const b = encryptToken(payload, secret);
    expect(a).not.toBe(b);
  });

  it('rejects a tampered token', () => {
    const token = encryptToken({ a: 1 }, secret);
    const tampered = token.slice(0, -2) + 'XX';
    expect(() => decryptToken(tampered, secret)).toThrow();
  });

  it('rejects a token encrypted with a different secret', () => {
    const otherSecret = randomBytes(32);
    const token = encryptToken({ a: 1 }, otherSecret);
    expect(() => decryptToken(token, secret)).toThrow();
  });

  it('rejects a truncated token', () => {
    expect(() => decryptToken('abc', secret)).toThrow('Invalid token');
  });
});

describe('createAccessToken', () => {
  it('creates a verifiable access token', () => {
    const token = createAccessToken('my-api-key', futureEpoch, secret);
    const payload = verifyAndDecrypt(token, 'a', secret);
    expect(payload.k).toBe('my-api-key');
    expect(payload.e).toBe(futureEpoch);
    expect(payload.t).toBe('a');
  });

  it('round-trips the audience claim when provided', () => {
    const token = createAccessToken(
      'my-api-key',
      futureEpoch,
      secret,
      'https://mcp.partiri.cloud/mcp',
    );
    const payload = verifyAndDecrypt(token, 'a', secret);
    expect(payload.a).toBe('https://mcp.partiri.cloud/mcp');
  });

  it('omits the audience claim when not provided (legacy shape)', () => {
    const token = createAccessToken('my-api-key', futureEpoch, secret);
    const payload = verifyAndDecrypt(token, 'a', secret);
    expect(payload.a).toBeUndefined();
  });
});

describe('createRefreshToken', () => {
  it('creates a verifiable refresh token', () => {
    const token = createRefreshToken('my-api-key', futureEpoch, secret);
    const payload = verifyAndDecrypt(token, 'r', secret);
    expect(payload.k).toBe('my-api-key');
    expect(payload.t).toBe('r');
  });

  it('round-trips the audience claim when provided', () => {
    const token = createRefreshToken(
      'my-api-key',
      futureEpoch,
      secret,
      'https://mcp.partiri.cloud/mcp',
    );
    const payload = verifyAndDecrypt(token, 'r', secret);
    expect(payload.a).toBe('https://mcp.partiri.cloud/mcp');
  });
});

describe('createAuthCode', () => {
  it('creates a verifiable auth code with challenge, redirect, and id', () => {
    const token = createAuthCode(
      'my-api-key',
      'challenge123',
      'http://localhost/callback',
      futureEpoch,
      secret,
      testCodeId,
    );
    const payload = verifyAndDecrypt(token, 'c', secret);
    expect(payload.k).toBe('my-api-key');
    expect(payload.c).toBe('challenge123');
    expect(payload.r).toBe('http://localhost/callback');
    expect(payload.i).toBe(testCodeId);
  });
});

describe('verifyAndDecrypt', () => {
  it('rejects wrong token type', () => {
    const token = createAccessToken('key', futureEpoch, secret);
    expect(() => verifyAndDecrypt(token, 'r', secret)).toThrow(
      'Invalid token type',
    );
  });

  it('rejects expired tokens', () => {
    const token = createAccessToken('key', pastEpoch, secret);
    expect(() => verifyAndDecrypt(token, 'a', secret)).toThrow('Token expired');
  });

  it('accepts tokens that have not yet expired', () => {
    const token = createAccessToken('key', futureEpoch, secret);
    expect(() => verifyAndDecrypt(token, 'a', secret)).not.toThrow();
  });

  // Task #3 regression: fail closed — missing or non-numeric `e` must be
  // treated as expired, not silently skipped.
  it('rejects a token whose expiry field is missing (fail closed)', () => {
    const token = encryptToken({ k: 'key', t: 'a' }, secret);
    expect(() => verifyAndDecrypt(token, 'a', secret)).toThrow('Token expired');
  });

  it('rejects a token whose expiry field is a string (fail closed)', () => {
    const token = encryptToken({ k: 'key', t: 'a', e: 'never' }, secret);
    expect(() => verifyAndDecrypt(token, 'a', secret)).toThrow('Token expired');
  });

  it('rejects a token whose expiry field is null (fail closed)', () => {
    const token = encryptToken({ k: 'key', t: 'a', e: null }, secret);
    expect(() => verifyAndDecrypt(token, 'a', secret)).toThrow('Token expired');
  });

  // Fail closed: the decrypted API key must be a non-empty string.
  it('rejects a token whose API key is missing or not a string', () => {
    const noKey = encryptToken({ t: 'a', e: futureEpoch }, secret);
    expect(() => verifyAndDecrypt(noKey, 'a', secret)).toThrow('Invalid token');
    const numericKey = encryptToken({ k: 123, t: 'a', e: futureEpoch }, secret);
    expect(() => verifyAndDecrypt(numericKey, 'a', secret)).toThrow(
      'Invalid token',
    );
  });
});
