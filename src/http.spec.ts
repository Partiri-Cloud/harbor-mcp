import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import {
  createApp,
  hashApiKey,
  resolveAllowedOrigins,
  startSessionCleanup,
  type Session,
  type AppConfig,
} from './http.js';
import { SERVER_INSTRUCTIONS } from './server.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createAccessToken } from './oauth/crypto.js';
import { InMemoryClientStore } from './oauth/client-store.js';

vi.stubGlobal('fetch', vi.fn());

const MCP_INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
};

const TEST_CONFIG: AppConfig = {
  maxSessions: 1000,
  maxSessionsPerKey: 5,
  sessionTtlMs: 30 * 60_000,
};

const TEST_SECRET = randomBytes(32);

function createTestApp(sessions?: Map<string, Session>, config?: AppConfig) {
  return createApp({
    apiBaseUrl: 'https://api.example.com',
    webBaseUrl: 'https://partiri.cloud',
    mcpBaseUrl: 'http://localhost:3000',
    tokenSecret: TEST_SECRET,
    sessions: sessions ?? new Map(),
    config: config ?? TEST_CONFIG,
    allowedRedirectHosts: new Set(['good.example.com']),
  });
}

/**
 * Makes the upstream API accept exactly one API key and reject every other.
 * Lets a test assert *which* credential the server resolved, by keying the
 * upstream verdict on the `x-api-key` the client forwards.
 * @param validKey - The only key `getCurrentUser` will answer 200 for.
 */
function onlyAcceptUpstream(validKey: string) {
  vi.mocked(fetch).mockReset();
  vi.mocked(fetch).mockImplementation((_url, opts) => {
    const headers = (opts?.headers ?? {}) as Record<string, string>;
    return Promise.resolve(
      headers['x-api-key'] === validKey
        ? new Response(JSON.stringify({ id: 'u1' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response('no', { status: 401 }),
    );
  });
}

describe('HTTP transport', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createTestApp();
    // A session is only created after the API key validates against the upstream
    // API (getCurrentUser); mock that OK by default. A fresh Response per call
    // avoids "body already consumed" when a test initializes more than once.
    vi.mocked(fetch).mockReset();
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 'u1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });

  // ── Health check ───────────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns 200 with status ok', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });
  });

  // ── Security headers ───────────────────────────────────────────────────────

  describe('security headers', () => {
    it('sets X-Content-Type-Options', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('sets X-Frame-Options', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['x-frame-options']).toBe('DENY');
    });

    it('sets Cache-Control', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('sets a strict Content-Security-Policy', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['content-security-policy']).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
    });

    it('covers endpoints mounted before the /mcp routes (well-known, /callback)', async () => {
      // The middleware is mounted ahead of the OAuth router so discovery and
      // callback responses get security headers too.
      const wellKnown = await request(app).get(
        '/.well-known/oauth-protected-resource/mcp',
      );
      expect(wellKnown.headers['content-security-policy']).toBeDefined();
      expect(wellKnown.headers['x-content-type-options']).toBe('nosniff');

      const callback = await request(app).get('/callback'); // missing params → 400
      expect(callback.status).toBe(400);
      expect(callback.headers['content-security-policy']).toBeDefined();
      expect(callback.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  // ── POST /mcp (legacy x-api-key) ─────────────────────────────────────────

  describe('POST /mcp', () => {
    it('returns 401 when authentication is missing on initialize', async () => {
      const res = await request(app).post('/mcp').send(MCP_INITIALIZE_BODY);

      expect(res.status).toBe(401);
    });

    it('returns 401 for non-initialize request without auth', async () => {
      const res = await request(app).post('/mcp').send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      });

      expect(res.status).toBe(401);
    });

    it('accepts initialize request with x-api-key', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('x-api-key', 'test-key-123')
        .set('Accept', 'application/json, text/event-stream')
        .send(MCP_INITIALIZE_BODY);

      expect(res.status).toBe(200);
    });

    it('returns mcp-session-id header on initialize', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('x-api-key', 'test-key-123')
        .set('Accept', 'application/json, text/event-stream')
        .send(MCP_INITIALIZE_BODY);

      expect(res.headers['mcp-session-id']).toBeDefined();
    });

    it('accepts initialize request with Bearer token', async () => {
      const futureEpoch = Math.floor(Date.now() / 1000) + 3600;
      const token = createAccessToken('test-key-123', futureEpoch, TEST_SECRET);

      const res = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .send(MCP_INITIALIZE_BODY);

      expect(res.status).toBe(200);
      expect(res.headers['mcp-session-id']).toBeDefined();
    });

    it('rejects initialize when the API key fails upstream validation', async () => {
      vi.mocked(fetch).mockReset();
      vi.mocked(fetch).mockResolvedValue(new Response('no', { status: 401 }));

      const res = await request(app)
        .post('/mcp')
        .set('x-api-key', 'bogus-key')
        .set('Accept', 'application/json, text/event-stream')
        .send(MCP_INITIALIZE_BODY);

      expect(res.status).toBe(401);
      expect(res.headers['mcp-session-id']).toBeUndefined();
    });

    it('validates the Bearer token even when a stale x-api-key is also sent', async () => {
      // A client that has completed OAuth keeps sending the x-api-key from its
      // config. Only the key inside the token is still accepted upstream, so
      // this passes only if the token — not the header — resolved the key.
      onlyAcceptUpstream('key-inside-token');

      const futureEpoch = Math.floor(Date.now() / 1000) + 3600;
      const token = createAccessToken(
        'key-inside-token',
        futureEpoch,
        TEST_SECRET,
      );

      const res = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`)
        .set('x-api-key', 'stale-revoked-key')
        .set('Accept', 'application/json, text/event-stream')
        .send(MCP_INITIALIZE_BODY);

      expect(res.status).toBe(200);
      expect(res.headers['mcp-session-id']).toBeDefined();
    });

    it('binds the session to the token key, not the stale header key', async () => {
      onlyAcceptUpstream('key-inside-token');

      const futureEpoch = Math.floor(Date.now() / 1000) + 3600;
      const token = createAccessToken(
        'key-inside-token',
        futureEpoch,
        TEST_SECRET,
      );
      const sessions = new Map<string, Session>();
      const boundApp = createTestApp(sessions);

      await request(boundApp)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`)
        .set('x-api-key', 'stale-revoked-key')
        .set('Accept', 'application/json, text/event-stream')
        .send(MCP_INITIALIZE_BODY);

      const [session] = [...sessions.values()];
      expect(session.apiKeyHash).toBe(hashApiKey('key-inside-token'));
    });

    it('still accepts x-api-key alone when no Bearer token is present', async () => {
      onlyAcceptUpstream('legacy-key');

      const res = await request(app)
        .post('/mcp')
        .set('x-api-key', 'legacy-key')
        .set('Accept', 'application/json, text/event-stream')
        .send(MCP_INITIALIZE_BODY);

      expect(res.status).toBe(200);
    });
  });

  // ── Session-to-key binding ─────────────────────────────────────────────────

  describe('session-to-key binding', () => {
    it('rejects existing session with wrong API key', async () => {
      // Initialize a session
      const initRes = await request(app)
        .post('/mcp')
        .set('x-api-key', 'correct-key')
        .set('Accept', 'application/json, text/event-stream')
        .send(MCP_INITIALIZE_BODY);

      const sessionId = initRes.headers['mcp-session-id'];

      // Try to use with wrong key
      const res = await request(app)
        .post('/mcp')
        .set('x-api-key', 'wrong-key')
        .set('mcp-session-id', sessionId)
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe('Invalid API key for this session');
    });

    it('rejects existing session without authentication', async () => {
      const initRes = await request(app)
        .post('/mcp')
        .set('x-api-key', 'correct-key')
        .set('Accept', 'application/json, text/event-stream')
        .send(MCP_INITIALIZE_BODY);

      const sessionId = initRes.headers['mcp-session-id'];

      const res = await request(app)
        .post('/mcp')
        .set('mcp-session-id', sessionId)
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

      expect(res.status).toBe(401);
    });
  });

  // ── Unknown / expired session (post-redeploy reconnect) ────────────────────
  // A returning client whose session was wiped by a server restart must get a
  // 404 so it transparently re-initializes, rather than a 400 that makes it give
  // up and re-run the full OAuth flow.

  describe('unknown session', () => {
    it('returns 404 on POST with a valid key but unknown session id', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('x-api-key', 'correct-key')
        .set('mcp-session-id', 'gone-after-redeploy')
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe('Session not found');
    });

    it('returns 404 on GET with a valid key but unknown session id', async () => {
      const res = await request(app)
        .get('/mcp')
        .set('x-api-key', 'correct-key')
        .set('mcp-session-id', 'gone-after-redeploy');

      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe('Session not found');
    });

    // End-to-end proof of the production fix: a redeploy wipes the in-memory
    // session map. A returning client must be able to recover with the SAME
    // OAuth token — no fresh sign-in. Two separate app instances (empty session
    // maps) stand in for "before" and "after" the deploy.
    it('survives a redeploy: old session 404s, same Bearer token re-initializes (no re-auth)', async () => {
      const token = createAccessToken(
        'user-key',
        Math.floor(Date.now() / 1000) + 3600,
        TEST_SECRET,
      );

      // Before deploy: establish a session.
      const before = createTestApp(new Map());
      const initRes = await request(before)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .send(MCP_INITIALIZE_BODY);
      expect(initRes.status).toBe(200);
      const oldSession = initRes.headers['mcp-session-id'];
      expect(oldSession).toBeDefined();

      // Redeploy: a brand-new instance with an empty session map.
      const after = createTestApp(new Map());

      // The client's cached session id is gone -> 404 signals "re-initialize".
      const stale = await request(after)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`)
        .set('mcp-session-id', oldSession)
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      expect(stale.status).toBe(404);

      // Re-initializing with the SAME token succeeds — the user is NOT bounced
      // back through OAuth.
      const reinit = await request(after)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .send(MCP_INITIALIZE_BODY);
      expect(reinit.status).toBe(200);
      expect(reinit.headers['mcp-session-id']).toBeDefined();
    });
  });

  // ── Session limits ─────────────────────────────────────────────────────────

  describe('session limits', () => {
    it('rejects when total session limit is reached', async () => {
      const sessions = new Map<string, Session>();
      const config: AppConfig = {
        maxSessions: 1,
        maxSessionsPerKey: 5,
        sessionTtlMs: 30 * 60_000,
      };

      // Pre-fill with a session
      sessions.set('existing-session', {
        transport: {} as StreamableHTTPServerTransport,
        apiKeyHash: hashApiKey('other-key'),
        createdAt: Date.now(),
        lastActivity: Date.now(),
      });

      const limitedApp = createTestApp(sessions, config);
      const res = await request(limitedApp)
        .post('/mcp')
        .set('x-api-key', 'test-key')
        .send(MCP_INITIALIZE_BODY);

      expect(res.status).toBe(429);
      expect(res.body.error.message).toContain('Server session limit');
    });

    it('rejects when per-key session limit is reached', async () => {
      const sessions = new Map<string, Session>();
      const config: AppConfig = {
        maxSessions: 1000,
        maxSessionsPerKey: 1,
        sessionTtlMs: 30 * 60_000,
      };

      sessions.set('existing-session', {
        transport: {} as StreamableHTTPServerTransport,
        apiKeyHash: hashApiKey('test-key'),
        createdAt: Date.now(),
        lastActivity: Date.now(),
      });

      const limitedApp = createTestApp(sessions, config);
      const res = await request(limitedApp)
        .post('/mcp')
        .set('x-api-key', 'test-key')
        .send(MCP_INITIALIZE_BODY);

      expect(res.status).toBe(429);
      expect(res.body.error.message).toContain('per API key');
    });
  });

  // ── GET /mcp ───────────────────────────────────────────────────────────────

  describe('GET /mcp', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/mcp');
      expect(res.status).toBe(401);
    });

    it('returns 401 with invalid session ID but no auth', async () => {
      const res = await request(app)
        .get('/mcp')
        .set('mcp-session-id', 'nonexistent');

      expect(res.status).toBe(401);
    });

    it('requires authentication for existing session', async () => {
      const sessions = new Map<string, Session>();
      sessions.set('test-sid', {
        transport: {
          handleRequest: vi.fn(),
        } as unknown as StreamableHTTPServerTransport,
        apiKeyHash: hashApiKey('my-key'),
        createdAt: Date.now(),
        lastActivity: Date.now(),
      });

      const appWithSession = createTestApp(sessions);
      const res = await request(appWithSession)
        .get('/mcp')
        .set('mcp-session-id', 'test-sid');

      expect(res.status).toBe(401);
    });
  });

  // ── DELETE /mcp ────────────────────────────────────────────────────────────

  describe('DELETE /mcp', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).delete('/mcp');
      expect(res.status).toBe(401);
    });

    it('returns 401 with invalid session ID but no auth', async () => {
      const res = await request(app)
        .delete('/mcp')
        .set('mcp-session-id', 'nonexistent');

      expect(res.status).toBe(401);
    });
  });

  // ── Request body size limit ────────────────────────────────────────────────

  describe('body size limit', () => {
    it('rejects payloads over 100kb', async () => {
      const largeBody = JSON.stringify({ data: 'x'.repeat(200_000) });
      const res = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .send(largeBody);

      expect(res.status).toBe(413);
    });
  });
});

// ── OAuth discovery ─────────────────────────────────────────────────────────

describe('OAuth discovery', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createTestApp();
  });

  it('serves protected resource metadata', async () => {
    const res = await request(app).get(
      '/.well-known/oauth-protected-resource/mcp',
    );
    expect(res.status).toBe(200);
    expect(res.body.resource).toBeDefined();
  });

  it('serves the identical document at the root well-known path (RFC 9728)', async () => {
    const mcpScoped = await request(app).get(
      '/.well-known/oauth-protected-resource/mcp',
    );
    const root = await request(app).get(
      '/.well-known/oauth-protected-resource',
    );
    expect(root.status).toBe(200);
    expect(root.body).toEqual(mcpScoped.body);
    expect(root.body.resource).toBe('http://localhost:3000/mcp');
    expect(root.body.authorization_servers).toEqual(['http://localhost:3000/']);
  });

  it('serves authorization server metadata', async () => {
    const res = await request(app).get(
      '/.well-known/oauth-authorization-server',
    );
    expect(res.status).toBe(200);
    expect(res.body.authorization_endpoint).toBeDefined();
    expect(res.body.token_endpoint).toBeDefined();
    expect(res.body.registration_endpoint).toBeDefined();
  });
});

// ── 401 discovery contract (RFC 9728) ────────────────────────────────────────

describe('401 discovery contract', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createTestApp();
  });

  it('points to the protected resource metadata in WWW-Authenticate on missing auth', async () => {
    const res = await request(app).post('/mcp').send(MCP_INITIALIZE_BODY);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain(
      'resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('answers 401 (not 500) with WWW-Authenticate for a garbage Bearer token', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer not-a-real-token')
      .set('Accept', 'application/json, text/event-stream')
      .send(MCP_INITIALIZE_BODY);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('resource_metadata=');
  });

  it('answers 401 for an expired Bearer token', async () => {
    const pastEpoch = Math.floor(Date.now() / 1000) - 3600;
    const expired = createAccessToken('test-key-123', pastEpoch, TEST_SECRET);
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${expired}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(MCP_INITIALIZE_BODY);
    expect(res.status).toBe(401);
  });

  it('points to the metadata on the legacy path when the API key is rejected', async () => {
    // The legacy x-api-key path builds its own 401 rather than going through
    // requireBearerAuth, so it has to carry the pointer itself.
    vi.mocked(fetch).mockReset();
    vi.mocked(fetch).mockResolvedValue(new Response('no', { status: 401 }));

    const res = await request(app)
      .post('/mcp')
      .set('x-api-key', 'bogus-key')
      .set('Accept', 'application/json, text/event-stream')
      .send(MCP_INITIALIZE_BODY);

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain(
      'resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('answers 401 for a token whose audience names another server', async () => {
    const futureEpoch = Math.floor(Date.now() / 1000) + 3600;
    const foreign = createAccessToken(
      'test-key-123',
      futureEpoch,
      TEST_SECRET,
      'https://evil.example/mcp',
    );
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${foreign}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(MCP_INITIALIZE_BODY);
    expect(res.status).toBe(401);
  });
});

// ── Origin validation on /mcp ────────────────────────────────────────────────

describe('Origin validation', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createTestApp();
    vi.mocked(fetch).mockReset();
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 'u1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });

  const initialize = (origin?: string) => {
    const req = request(app)
      .post('/mcp')
      .set('x-api-key', 'test-key-123')
      .set('Accept', 'application/json, text/event-stream');
    if (origin) req.set('Origin', origin);
    return req.send(MCP_INITIALIZE_BODY);
  };

  it('allows requests without an Origin header (non-browser clients)', async () => {
    expect((await initialize()).status).toBe(200);
  });

  it('allows the default client origins', async () => {
    expect((await initialize('https://claude.ai')).status).toBe(200);
    expect((await initialize('https://chatgpt.com')).status).toBe(200);
  });

  it("allows the server's own origin", async () => {
    expect((await initialize('http://localhost:3000')).status).toBe(200);
  });

  it('rejects an unknown origin with 403', async () => {
    const res = await initialize('https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Origin not allowed');
  });

  it('rejects the literal "null" origin', async () => {
    expect((await initialize('null')).status).toBe(403);
  });

  it('honors an MCP_ALLOWED_ORIGINS-style override', async () => {
    const restricted = createApp({
      apiBaseUrl: 'https://api.example.com',
      webBaseUrl: 'https://partiri.cloud',
      mcpBaseUrl: 'http://localhost:3000',
      tokenSecret: TEST_SECRET,
      sessions: new Map(),
      config: TEST_CONFIG,
      allowedOrigins: resolveAllowedOrigins(
        'https://only.example',
        'http://localhost:3000',
      ),
    });
    const denied = await request(restricted)
      .post('/mcp')
      .set('x-api-key', 'test-key-123')
      .set('Origin', 'https://claude.ai')
      .set('Accept', 'application/json, text/event-stream')
      .send(MCP_INITIALIZE_BODY);
    expect(denied.status).toBe(403);

    const allowed = await request(restricted)
      .post('/mcp')
      .set('x-api-key', 'test-key-123')
      .set('Origin', 'https://only.example')
      .set('Accept', 'application/json, text/event-stream')
      .send(MCP_INITIALIZE_BODY);
    expect(allowed.status).toBe(200);
  });

  it('resolveAllowedOrigins skips malformed entries and always includes the own origin', () => {
    const origins = resolveAllowedOrigins(
      'https://a.example, not a url ,https://b.example',
      'https://mcp.partiri.cloud',
    );
    expect(origins.has('https://a.example')).toBe(true);
    expect(origins.has('https://b.example')).toBe(true);
    expect(origins.has('https://mcp.partiri.cloud')).toBe(true);
    expect(origins.size).toBe(3);
  });
});

// ── Server instructions in the initialize response ───────────────────────────

describe('initialize response', () => {
  it('carries the server-wide instructions', async () => {
    const app = createTestApp();
    vi.mocked(fetch).mockReset();
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 'u1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const res = await request(app)
      .post('/mcp')
      .set('x-api-key', 'test-key-123')
      .set('Accept', 'application/json, text/event-stream')
      .send(MCP_INITIALIZE_BODY);
    expect(res.status).toBe(200);

    // The transport answers initialize as an SSE stream; extract the JSON-RPC
    // result from the first `data:` line (falls back to a plain JSON body).
    const result =
      res.type === 'application/json'
        ? res.body
        : JSON.parse(res.text.match(/^data: (.*)$/m)![1]);
    expect(result.result.instructions).toBe(SERVER_INSTRUCTIONS);
  });
});

// ── OAuth endpoint rate limiting ─────────────────────────────────────────────

describe('trust proxy (X-Forwarded-For)', () => {
  it('does not let X-Forwarded-For spoofing bypass rate limits from an untrusted peer', async () => {
    // supertest connects from 127.0.0.1, which is NOT in this trusted CIDR, so
    // the client-supplied X-Forwarded-For must be ignored and all requests share
    // one bucket — defeating per-request IP rotation.
    const dApp = createApp({
      apiBaseUrl: 'https://api.example.com',
      webBaseUrl: 'https://partiri.cloud',
      mcpBaseUrl: 'http://localhost:3000',
      tokenSecret: TEST_SECRET,
      trustProxy: '10.0.0.0/8',
    });
    let limited = 0;
    for (let i = 0; i < 25; i++) {
      const res = await request(dApp)
        .get('/authorize')
        .set('X-Forwarded-For', `1.2.3.${i}`)
        .query({
          response_type: 'code',
          client_id: 'x',
          redirect_uri: 'http://127.0.0.1/cb',
          code_challenge: 'c',
          code_challenge_method: 'S256',
        });
      if (res.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });

  it('falls back to loopback (no crash) when the trust proxy setting is malformed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      createApp({
        apiBaseUrl: 'https://api.example.com',
        webBaseUrl: 'https://partiri.cloud',
        mcpBaseUrl: 'http://localhost:3000',
        tokenSecret: TEST_SECRET,
        trustProxy: 'not-a-valid-cidr',
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('invalid trust proxy'),
    );
    warn.mockRestore();
  });
});

describe('OAuth rate limiting', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createTestApp();
  });

  it('throttles the /authorize endpoint after the limit (credential oracle protection)', async () => {
    // The limiter (max 20/min) is registered before the OAuth router, so it
    // counts every request regardless of how the router responds.
    let lastStatus = 0;
    for (let i = 0; i < 21; i++) {
      lastStatus = (await request(app).get('/authorize')).status;
    }
    expect(lastStatus).toBe(429);
  });

  it('does not rate limit OAuth discovery metadata', async () => {
    // Discovery docs are fetched by clients and live outside the limited paths.
    for (let i = 0; i < 21; i++) {
      const res = await request(app).get(
        '/.well-known/oauth-authorization-server',
      );
      expect(res.status).toBe(200);
    }
  });
});

// ── PKCE enforcement ─────────────────────────────────────────────────────────

describe('PKCE enforcement', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createTestApp();
  });

  it('rejects code_challenge_method=plain (S256 only)', async () => {
    // Register a client first so we have a valid client_id.
    const regRes = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({
        redirect_uris: ['http://localhost:0/callback'],
        client_name: 'pkce-test-client',
      });
    expect(regRes.status).toBe(201);
    const clientId = regRes.body.client_id as string;

    // Attempt the authorization flow with plain PKCE — the SDK router
    // enforces S256-only, so this must not succeed (non-2xx or error body).
    const res = await request(app).get('/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://localhost:0/callback',
      code_challenge:
        'dGhlIHF1aWNrIGJyb3duIGZveCBqdW1wcyBvdmVyIHRoZSBsYXp5IGRvZw',
      code_challenge_method: 'plain',
    });

    // The SDK must reject the plain method — either via a 4xx HTTP status or
    // by including an error in the response body/redirect.
    const isError =
      res.status >= 400 ||
      (typeof res.text === 'string' && res.text.includes('error')) ||
      (res.body && res.body.error);
    expect(isError).toBe(true);
  });
});

// ── Dynamic client registration ─────────────────────────────────────────────

describe('client registration', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createTestApp();
  });

  it('registers a new client', async () => {
    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({
        redirect_uris: ['http://localhost:0/callback'],
        client_name: 'test-client',
      });

    expect(res.status).toBe(201);
    expect(res.body.client_id).toBeDefined();
  });

  it('rejects registration of a non-allowlisted external redirect_uri', async () => {
    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({
        redirect_uris: ['https://attacker.example/cb'],
        client_name: 'evil-client',
      });

    expect(res.status).toBe(400);
    expect(res.body.client_id).toBeUndefined();
  });
});

// ── Hosted sign-in: GET /authorize → GET /callback ───────────────────────────

describe('hosted sign-in (/authorize → /callback)', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createTestApp();
    vi.mocked(fetch).mockReset();
  });

  async function registerClient(redirectUris: string[]): Promise<string> {
    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({
        redirect_uris: redirectUris,
        client_name: 'callback-test-client',
      });
    expect(res.status).toBe(201);
    return res.body.client_id as string;
  }

  function okUser() {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: 'u1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }

  // Drive GET /authorize and return the hex `state` the provider stashed,
  // recovered from the redirect to the hosted Partiri sign-in page. The page is
  // handed a hex state + the server's public `callback` URL (the remote-server
  // generalization of the CLI's loopback port).
  async function beginAuthorize(
    clientId: string,
    redirectUri: string,
    clientState?: string,
  ): Promise<string> {
    const res = await request(app)
      .get('/authorize')
      .query({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: 'challenge123',
        code_challenge_method: 'S256',
        ...(clientState ? { state: clientState } : {}),
      });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe(
      'https://partiri.cloud/cli-auth',
    );
    // Remote server hands the page its public /callback URL, not a loopback port.
    expect(location.searchParams.get('callback')).toBe(
      'http://localhost:3000/callback',
    );
    expect(location.searchParams.get('port')).toBeNull();
    const state = location.searchParams.get('state') as string;
    expect(state).toMatch(/^[0-9a-f]{16,128}$/);
    return state;
  }

  it('completes the flow: /authorize stashes state, /callback issues a code', async () => {
    const clientId = await registerClient([
      'https://good.example.com/callback',
    ]);
    const state = await beginAuthorize(
      clientId,
      'https://good.example.com/callback',
      'xyz',
    );
    okUser();

    const res = await request(app)
      .get('/callback')
      .query({ state, key: 'ptri_validkey' });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe(
      'https://good.example.com/callback',
    );
    expect(location.searchParams.get('code')).toBeTruthy();
    expect(location.searchParams.get('state')).toBe('xyz');
  });

  it('sends the auth code only to the client’s registered redirect_uri', async () => {
    const clientId = await registerClient([
      'https://good.example.com/callback',
    ]);
    const state = await beginAuthorize(
      clientId,
      'https://good.example.com/callback',
    );
    okUser();

    const res = await request(app)
      .get('/callback')
      .query({ state, key: 'ptri_validkey' });
    const location = new URL(res.headers.location as string);
    expect(location.origin).toBe('https://good.example.com');
  });

  it('rejects an unknown / forged state without calling the API', async () => {
    const res = await request(app)
      .get('/callback')
      .query({ state: 'deadbeefdeadbeefdeadbeef', key: 'ptri_victimkey' });

    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects at /callback when the stored redirect is not allowlisted (defense in depth)', async () => {
    // Simulate a client whose external redirect was accepted under a permissive
    // store allowlist, while the app's /callback check uses a stricter one — the
    // second checkpoint must still refuse to forward the key.
    const permissiveStore = new InMemoryClientStore(new Set(['evil.example']));
    const dApp = createApp({
      apiBaseUrl: 'https://api.example.com',
      webBaseUrl: 'https://partiri.cloud',
      mcpBaseUrl: 'http://localhost:3000',
      tokenSecret: TEST_SECRET,
      allowedRedirectHosts: new Set(), // loopback-only at the callback
      clientStore: permissiveStore,
    });
    const reg = await request(dApp)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ redirect_uris: ['https://evil.example/cb'], client_name: 'x' });
    expect(reg.status).toBe(201);

    const authRes = await request(dApp).get('/authorize').query({
      response_type: 'code',
      client_id: reg.body.client_id,
      redirect_uri: 'https://evil.example/cb',
      code_challenge: 'challenge123',
      code_challenge_method: 'S256',
    });
    const state = new URL(authRes.headers.location as string).searchParams.get(
      'state',
    );
    vi.mocked(fetch).mockReset();

    const res = await request(dApp)
      .get('/callback')
      .query({ state, key: 'ptri_victimkey' });

    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a replayed state (one-shot)', async () => {
    const clientId = await registerClient([
      'https://good.example.com/callback',
    ]);
    const state = await beginAuthorize(
      clientId,
      'https://good.example.com/callback',
    );
    okUser();

    const first = await request(app)
      .get('/callback')
      .query({ state, key: 'ptri_validkey' });
    expect(first.status).toBe(302);

    const second = await request(app)
      .get('/callback')
      .query({ state, key: 'ptri_validkey' });
    expect(second.status).toBe(400);
    expect(second.headers.location).toBeUndefined();
  });

  it('rejects a missing key', async () => {
    const clientId = await registerClient([
      'https://good.example.com/callback',
    ]);
    const state = await beginAuthorize(
      clientId,
      'https://good.example.com/callback',
    );

    const res = await request(app).get('/callback').query({ state });
    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns 401 when the API key is invalid', async () => {
    const clientId = await registerClient([
      'https://good.example.com/callback',
    ]);
    const state = await beginAuthorize(
      clientId,
      'https://good.example.com/callback',
    );
    vi.mocked(fetch).mockRejectedValue(new Error('unauthorized'));

    const res = await request(app)
      .get('/callback')
      .query({ state, key: 'ptri_bad' });
    expect(res.status).toBe(401);
    expect(res.headers.location).toBeUndefined();
  });
});

// ── hashApiKey ───────────────────────────────────────────────────────────────

describe('hashApiKey', () => {
  it('produces consistent hashes', () => {
    expect(hashApiKey('test')).toBe(hashApiKey('test'));
  });

  it('produces different hashes for different keys', () => {
    expect(hashApiKey('key-a')).not.toBe(hashApiKey('key-b'));
  });
});

// ── Session cleanup ──────────────────────────────────────────────────────────

describe('startSessionCleanup', () => {
  it('removes expired sessions', () => {
    vi.useFakeTimers();

    const sessions = new Map<string, Session>();
    const closeMock = vi.fn().mockResolvedValue(undefined);

    sessions.set('expired', {
      transport: {
        close: closeMock,
      } as unknown as StreamableHTTPServerTransport,
      apiKeyHash: 'hash',
      createdAt: Date.now() - 60 * 60_000,
      lastActivity: Date.now() - 60 * 60_000, // 60 min ago
    });

    sessions.set('active', {
      transport: { close: vi.fn() } as unknown as StreamableHTTPServerTransport,
      apiKeyHash: 'hash2',
      createdAt: Date.now(),
      lastActivity: Date.now(), // just now
    });

    const config: AppConfig = {
      maxSessions: 1000,
      maxSessionsPerKey: 5,
      sessionTtlMs: 30 * 60_000,
    };
    const timer = startSessionCleanup(sessions, config);

    vi.advanceTimersByTime(60_000);

    expect(sessions.has('expired')).toBe(false);
    expect(sessions.has('active')).toBe(true);
    expect(closeMock).toHaveBeenCalled();

    clearInterval(timer);
    vi.useRealTimers();
  });
});
