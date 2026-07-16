import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { PartiriOAuthProvider, normalizeResource } from './provider.js';
import { InMemoryClientStore } from './client-store.js';
import { encryptToken, decryptToken } from './crypto.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const secret = randomBytes(32);

function makeProvider(): PartiriOAuthProvider {
  return new PartiriOAuthProvider({
    secret,
    webBaseUrl: 'https://partiri.cloud',
    mcpBaseUrl: 'http://localhost:3000',
    clientStore: new InMemoryClientStore(),
  });
}

// Stub client — methods under test don't inspect the client object.
const stubClient = {} as OAuthClientInformationFull;

const futureEpoch = Math.floor(Date.now() / 1000) + 3600;
const pastEpoch = Math.floor(Date.now() / 1000) - 3600;

// ── exchangeAuthorizationCode ─────────────────────────────────────────────────

describe('exchangeAuthorizationCode', () => {
  let provider: PartiriOAuthProvider;

  beforeEach(() => {
    provider = makeProvider();
  });

  it('valid round-trip: returns access and refresh tokens', async () => {
    const code = provider.createAuthorizationCode(
      'test-api-key',
      'challenge',
      'https://example.com/callback',
    );
    const tokens = await provider.exchangeAuthorizationCode(
      stubClient,
      code,
      undefined,
      'https://example.com/callback',
    );
    expect(tokens.token_type).toBe('Bearer');
    expect(typeof tokens.access_token).toBe('string');
    expect(typeof tokens.refresh_token).toBe('string');
    expect(tokens.expires_in).toBe(3600);
  });

  it('rejects a token with the wrong type (access token instead of code)', async () => {
    const accessToken = encryptToken(
      { k: 'key', e: futureEpoch, t: 'a' },
      secret,
    );
    await expect(
      provider.exchangeAuthorizationCode(stubClient, accessToken),
    ).rejects.toThrow('Invalid token type');
  });

  it('rejects an expired authorization code', async () => {
    const expired = encryptToken(
      {
        k: 'key',
        c: 'challenge',
        r: 'https://example.com/callback',
        e: pastEpoch,
        t: 'c',
        i: randomBytes(16).toString('hex'),
      },
      secret,
    );
    await expect(
      provider.exchangeAuthorizationCode(stubClient, expired),
    ).rejects.toThrow('Token expired');
  });

  it('throws on redirect_uri mismatch', async () => {
    const code = provider.createAuthorizationCode(
      'key',
      'challenge',
      'https://example.com/callback',
    );
    await expect(
      provider.exchangeAuthorizationCode(
        stubClient,
        code,
        undefined,
        'https://evil.example.com/callback',
      ),
    ).rejects.toThrow('redirect_uri mismatch');
  });

  // Task #1 regression: codes must be single-use.
  it('rejects a code that has already been redeemed (replay prevention)', async () => {
    const code = provider.createAuthorizationCode(
      'key',
      'challenge',
      'https://example.com/callback',
    );
    await provider.exchangeAuthorizationCode(stubClient, code);
    await expect(
      provider.exchangeAuthorizationCode(stubClient, code),
    ).rejects.toThrow('Authorization code already used');
  });

  // Legacy codes (minted before the `i` field was added) carry no id and must
  // be rejected on first attempt — fail closed rather than skip the guard.
  it('rejects a code with no id field on first redemption (fail closed)', async () => {
    const legacyCode = encryptToken(
      {
        k: 'key',
        c: 'challenge',
        r: 'https://example.com/callback',
        e: futureEpoch,
        t: 'c',
        // intentionally no `i`
      },
      secret,
    );
    await expect(
      provider.exchangeAuthorizationCode(stubClient, legacyCode),
    ).rejects.toThrow('Authorization code already used');
  });

  // Task #1 hardening: the consumedCodes replay set is bounded (FIFO eviction)
  // so a flood of redemptions cannot exhaust memory.
  it('evicts the oldest consumed id when the replay set is at capacity', async () => {
    const MAX = 10_000; // mirrors MAX_CONSUMED_CODES in provider.ts
    const p = provider as unknown as { consumedCodes: Set<string> };
    for (let n = 0; n < MAX; n++) p.consumedCodes.add(`dummy-${n}`);
    expect(p.consumedCodes.size).toBe(MAX);

    // Redeeming a fresh code while at capacity still succeeds...
    const code = provider.createAuthorizationCode(
      'key',
      'challenge',
      'https://example.com/callback',
    );
    await expect(
      provider.exchangeAuthorizationCode(stubClient, code),
    ).resolves.toMatchObject({ token_type: 'Bearer' });

    // ...and the set stays bounded, having evicted the oldest entry (FIFO).
    expect(p.consumedCodes.size).toBe(MAX);
    expect(p.consumedCodes.has('dummy-0')).toBe(false);
  });
});

// ── exchangeRefreshToken ──────────────────────────────────────────────────────

describe('exchangeRefreshToken', () => {
  let provider: PartiriOAuthProvider;

  beforeEach(() => {
    provider = makeProvider();
  });

  it('rotation round-trip: returns new access and refresh tokens', async () => {
    const code = provider.createAuthorizationCode(
      'test-api-key',
      'challenge',
      'https://example.com/callback',
    );
    const firstTokens = await provider.exchangeAuthorizationCode(
      stubClient,
      code,
    );
    const rotated = await provider.exchangeRefreshToken(
      stubClient,
      firstTokens.refresh_token!,
    );
    expect(rotated.token_type).toBe('Bearer');
    expect(typeof rotated.access_token).toBe('string');
    expect(typeof rotated.refresh_token).toBe('string');
    // Rotated tokens are different from the originals.
    expect(rotated.access_token).not.toBe(firstTokens.access_token);
  });

  it('rejects a token with the wrong type (access token instead of refresh)', async () => {
    const accessToken = encryptToken(
      { k: 'key', e: futureEpoch, t: 'a' },
      secret,
    );
    await expect(
      provider.exchangeRefreshToken(stubClient, accessToken),
    ).rejects.toThrow('Invalid token type');
  });

  it('upgrades a legacy (no-audience) refresh token to audience-bound tokens', async () => {
    const legacyRefresh = encryptToken(
      { k: 'key', e: futureEpoch, t: 'r' }, // no `a` claim
      secret,
    );
    const rotated = await provider.exchangeRefreshToken(
      stubClient,
      legacyRefresh,
    );
    const payload = decryptToken(rotated.access_token, secret);
    expect(payload.a).toBe('http://localhost:3000/mcp');
  });
});

// ── RFC 8707 resource / audience binding ─────────────────────────────────────

describe('resource parameter validation (RFC 8707)', () => {
  let provider: PartiriOAuthProvider;

  beforeEach(() => {
    provider = makeProvider();
  });

  it('normalizeResource canonicalizes trailing slashes and drops query/fragment', () => {
    expect(normalizeResource('http://localhost:3000/mcp/')).toBe(
      'http://localhost:3000/mcp',
    );
    expect(normalizeResource('http://localhost:3000/mcp?x=1#f')).toBe(
      'http://localhost:3000/mcp',
    );
  });

  it('exchangeAuthorizationCode accepts a matching resource', async () => {
    const code = provider.createAuthorizationCode(
      'key',
      'challenge',
      'https://example.com/callback',
    );
    await expect(
      provider.exchangeAuthorizationCode(
        stubClient,
        code,
        undefined,
        'https://example.com/callback',
        new URL('http://localhost:3000/mcp/'),
      ),
    ).resolves.toMatchObject({ token_type: 'Bearer' });
  });

  it('exchangeAuthorizationCode rejects a foreign resource (invalid_target)', async () => {
    const code = provider.createAuthorizationCode(
      'key',
      'challenge',
      'https://example.com/callback',
    );
    await expect(
      provider.exchangeAuthorizationCode(
        stubClient,
        code,
        undefined,
        'https://example.com/callback',
        new URL('https://evil.example/mcp'),
      ),
    ).rejects.toMatchObject({ errorCode: 'invalid_target' });
  });

  it('exchangeRefreshToken rejects a foreign resource (invalid_target)', async () => {
    const refresh = encryptToken({ k: 'key', e: futureEpoch, t: 'r' }, secret);
    await expect(
      provider.exchangeRefreshToken(
        stubClient,
        refresh,
        undefined,
        new URL('https://evil.example/mcp'),
      ),
    ).rejects.toMatchObject({ errorCode: 'invalid_target' });
  });

  it('issued tokens carry the canonical audience', async () => {
    const code = provider.createAuthorizationCode(
      'key',
      'challenge',
      'https://example.com/callback',
    );
    const tokens = await provider.exchangeAuthorizationCode(stubClient, code);
    expect(decryptToken(tokens.access_token, secret).a).toBe(
      'http://localhost:3000/mcp',
    );
    expect(decryptToken(tokens.refresh_token!, secret).a).toBe(
      'http://localhost:3000/mcp',
    );
  });
});

// ── verifyAccessToken ─────────────────────────────────────────────────────────

describe('verifyAccessToken', () => {
  let provider: PartiriOAuthProvider;

  beforeEach(() => {
    provider = makeProvider();
  });

  it('valid token: returns AuthInfo with apiKey and expiry', async () => {
    const code = provider.createAuthorizationCode(
      'my-api-key',
      'challenge',
      'https://example.com/callback',
    );
    const { access_token } = await provider.exchangeAuthorizationCode(
      stubClient,
      code,
    );
    const info = await provider.verifyAccessToken(access_token);
    expect(info.extra?.apiKey).toBe('my-api-key');
    expect(typeof info.expiresAt).toBe('number');
    expect(info.clientId).toBe('oauth');
  });

  it('rejects an expired access token', async () => {
    const expired = encryptToken({ k: 'key', e: pastEpoch, t: 'a' }, secret);
    await expect(provider.verifyAccessToken(expired)).rejects.toThrow(
      'Token expired',
    );
  });

  it('rejects a token with the wrong type (refresh token instead of access)', async () => {
    const refresh = encryptToken({ k: 'key', e: futureEpoch, t: 'r' }, secret);
    await expect(provider.verifyAccessToken(refresh)).rejects.toThrow(
      'Invalid token type',
    );
  });

  it('surfaces failures as InvalidTokenError (401, not 500)', async () => {
    await expect(
      provider.verifyAccessToken('garbage-token'),
    ).rejects.toMatchObject({ errorCode: 'invalid_token' });
    const expired = encryptToken({ k: 'key', e: pastEpoch, t: 'a' }, secret);
    await expect(provider.verifyAccessToken(expired)).rejects.toMatchObject({
      errorCode: 'invalid_token',
    });
  });

  it('rejects a token whose audience names another server', async () => {
    const foreign = encryptToken(
      { k: 'key', e: futureEpoch, t: 'a', a: 'https://evil.example/mcp' },
      secret,
    );
    await expect(provider.verifyAccessToken(foreign)).rejects.toMatchObject({
      errorCode: 'invalid_token',
    });
  });

  it('accepts a token whose audience matches modulo trailing slash', async () => {
    const token = encryptToken(
      { k: 'key', e: futureEpoch, t: 'a', a: 'http://localhost:3000/mcp/' },
      secret,
    );
    const info = await provider.verifyAccessToken(token);
    expect(info.extra?.apiKey).toBe('key');
  });

  it('accepts a legacy token with no audience claim (backward compatibility)', async () => {
    const legacy = encryptToken({ k: 'key', e: futureEpoch, t: 'a' }, secret);
    const info = await provider.verifyAccessToken(legacy);
    expect(info.extra?.apiKey).toBe('key');
  });
});

// ── pendingLogins cap ─────────────────────────────────────────────────────────

describe('stashPendingLogin cap', () => {
  it('evicts the oldest pending login when full instead of rejecting new ones', () => {
    const provider = makeProvider();
    const p = provider as unknown as {
      stashPendingLogin: (l: object) => string;
      pendingLogins: Map<string, unknown>;
    };

    // Fill to capacity with non-expired entries (insertion-ordered).
    for (let n = 0; n < 1_000; n++) {
      p.pendingLogins.set(`state-${n}`, {
        clientId: 'test',
        redirectUri: 'http://127.0.0.1/cb',
        codeChallenge: 'ch',
        expiresAt: Date.now() + 600_000,
      });
    }
    expect(p.pendingLogins.size).toBe(1_000);
    expect(p.pendingLogins.has('state-0')).toBe(true); // oldest

    // A new sign-in must succeed (not throw) and evict the oldest entry.
    const state = p.stashPendingLogin({
      clientId: 'test',
      redirectUri: 'http://127.0.0.1/cb',
      codeChallenge: 'ch',
    });
    expect(typeof state).toBe('string');
    expect(p.pendingLogins.size).toBe(1_000); // stayed bounded
    expect(p.pendingLogins.has('state-0')).toBe(false); // oldest evicted
    expect(p.pendingLogins.has(state)).toBe(true); // new one present
  });
});
