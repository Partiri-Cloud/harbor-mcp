import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express, {
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from 'express';
import rateLimit from 'express-rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { PartiriApiClient } from './client.js';
import { resolveBaseUrl } from './auth.js';
import { createServer } from './server.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { PartiriOAuthProvider } from './oauth/provider.js';
import { FileClientStore, InMemoryClientStore } from './oauth/client-store.js';
import { isAllowedRedirectUri, normalizeHost } from './net-guard.js';

// ── Session types ────────────────────────────────────────────────────────────

/**
 * An active MCP client connection: the live transport plus enough state to
 * authorize subsequent requests and expire the session on inactivity.
 */
export interface Session {
  /** The live Streamable HTTP transport bound to this session. */
  transport: StreamableHTTPServerTransport;
  /**
   * SHA-256 hash of the API key that created this session (see
   * {@link hashApiKey}), used to re-validate the caller on every request
   * without storing the raw key.
   */
  apiKeyHash: string;
  /** Epoch ms when the session was created. */
  createdAt: number;
  /** Epoch ms of the most recent request handled on this session. */
  lastActivity: number;
}

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * Runtime limits for session lifecycle management, sourced from environment
 * variables via {@link loadConfig}.
 */
export interface AppConfig {
  /** Maximum number of concurrent sessions across all API keys. */
  maxSessions: number;
  /** Maximum number of concurrent sessions for a single API key. */
  maxSessionsPerKey: number;
  /**
   * Idle timeout in milliseconds after which a session is closed and
   * removed.
   */
  sessionTtlMs: number;
}

/**
 * Build the {@link AppConfig} from environment variables, applying defaults
 * when unset: 1000 total sessions, 5 sessions per API key, and a 30-minute
 * idle timeout.
 * @returns The resolved session-lifecycle configuration.
 */
function loadConfig(): AppConfig {
  return {
    maxSessions: parseInt(process.env.MCP_MAX_SESSIONS || '1000', 10),
    maxSessionsPerKey: parseInt(
      process.env.MCP_MAX_SESSIONS_PER_KEY || '5',
      10,
    ),
    sessionTtlMs:
      parseInt(process.env.MCP_SESSION_TTL_MINUTES || '30', 10) * 60_000,
  };
}

/**
 * Parse a comma-separated host list (e.g. MCP_ALLOWED_REDIRECT_HOSTS) into a
 * lowercased Set. Loopback redirects are always allowed regardless of this
 * list.
 * @param value - Raw comma-separated host string, or undefined if the
 *   environment variable is not set.
 * @returns The normalized, lowercased set of allowed hosts.
 */
function parseHostSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((h) => normalizeHost(h))
      .filter(Boolean),
  );
}

/**
 * Resolve the Express `trust proxy` setting from MCP_TRUSTED_PROXIES. Set it to
 * the ingress/proxy IP or CIDR (e.g. "10.0.0.0/8") so the real client IP is
 * derived from X-Forwarded-For ONLY for requests that actually came through the
 * proxy. A bare integer is treated as a trusted-hop count. When unset we fall
 * back to 'loopback' (trust only a loopback proxy) and warn — we never trust an
 * arbitrary X-Forwarded-For, which would let a direct/off-proxy attacker spoof
 * their IP and bypass every per-IP rate limit.
 * @param value - Raw MCP_TRUSTED_PROXIES value (IP, CIDR, integer hop count,
 *   or unset).
 * @returns An Express-compatible trust-proxy value: a parsed integer hop
 *   count, the trimmed IP/CIDR string, or `'loopback'` when unset.
 */
function resolveTrustProxy(value: string | undefined): number | string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) {
    console.warn(
      'WARNING: MCP_TRUSTED_PROXIES not set — trusting only a loopback proxy. ' +
        'Set it to your ingress IP/CIDR (e.g. "10.0.0.0/8") so per-client rate ' +
        'limiting works; until then clients behind a non-loopback proxy share ' +
        'one rate-limit bucket, but X-Forwarded-For cannot be spoofed.',
    );
    return 'loopback';
  }
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  return trimmed;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Hash an API key with SHA-256 so it can be stored and compared without
 * keeping the raw key in memory.
 * @param apiKey - The raw API key.
 * @returns The hex-encoded SHA-256 digest of the key.
 */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Write a JSON-RPC 2.0 error response with a null id, matching the error
 * shape expected by MCP clients for transport-level failures.
 * @param res - The Express response to write to.
 * @param status - The HTTP status code to send.
 * @param message - The human-readable error message.
 */
function jsonRpcError(res: Response, status: number, message: string) {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  });
}

/**
 * Resolve the API key from the request. Checks:
 * 1. OAuth Bearer token (req.auth.extra.apiKey, set by bearerAuth middleware)
 * 2. Legacy x-api-key header
 * @param req - The incoming Express request.
 * @returns The resolved API key, or undefined if neither source is present.
 */
function resolveApiKey(req: Request): string | undefined {
  const authInfo = (req as Request & { auth?: { extra?: { apiKey?: string } } })
    .auth;
  if (authInfo?.extra?.apiKey) return authInfo.extra.apiKey as string;
  return req.headers['x-api-key'] as string | undefined;
}

/**
 * Validate an incoming /mcp request against an existing session: checks the
 * mcp-session-id header is present and known, resolves the caller's API key,
 * and confirms its hash matches the key that created the session.
 * @remarks Replies with the appropriate JSON-RPC error (400/404/401/403) and
 *   returns null on any failure, so callers can `return` immediately without
 *   writing their own error response. A 404 for an unknown session id is
 *   deliberate: it lets the client transparently re-initialize instead of
 *   treating a server restart as a fatal error.
 * @param req - The incoming Express request.
 * @param res - The Express response, written to on validation failure.
 * @param sessions - The active session map keyed by session id.
 * @returns The matching {@link Session} with `lastActivity` refreshed, or
 *   null if validation failed (and a response was already sent).
 */
function validateSession(
  req: Request,
  res: Response,
  sessions: Map<string, Session>,
): Session | null {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId) {
    jsonRpcError(res, 400, 'Missing session ID');
    return null;
  }
  if (!sessions.has(sessionId)) {
    // Unknown/expired session — almost always the server restarted (a redeploy)
    // and wiped the in-memory session map. Per the Streamable HTTP spec, reply
    // 404 so the client transparently re-initializes a new session with its
    // existing Bearer token, instead of treating it as fatal and forcing a
    // fresh OAuth sign-in.
    jsonRpcError(res, 404, 'Session not found');
    return null;
  }

  const apiKey = resolveApiKey(req);
  if (!apiKey) {
    jsonRpcError(res, 401, 'Missing authentication');
    return null;
  }

  const session = sessions.get(sessionId)!;
  if (hashApiKey(apiKey) !== session.apiKeyHash) {
    jsonRpcError(res, 403, 'Invalid API key for this session');
    return null;
  }

  session.lastActivity = Date.now();
  return session;
}

// ── Session cleanup ──────────────────────────────────────────────────────────

/**
 * Start a periodic sweep (every 60s) that closes and removes sessions whose
 * `lastActivity` exceeds the configured TTL.
 * @param sessions - The active session map to sweep.
 * @param config - Provides the idle-timeout threshold (`sessionTtlMs`).
 * @returns The interval handle, so the caller can `clearInterval` it on
 *   shutdown.
 */
export function startSessionCleanup(
  sessions: Map<string, Session>,
  config: AppConfig,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const now = Date.now();
    for (const [sid, session] of sessions) {
      if (now - session.lastActivity > config.sessionTtlMs) {
        session.transport.close().catch(() => {});
        sessions.delete(sid);
      }
    }
  }, 60_000);
}

// ── App factory ──────────────────────────────────────────────────────────────

/**
 * Configuration required to build the Express app returned by
 * {@link createApp}.
 */
export interface CreateAppOptions {
  /** Base URL of the Partiri API, used to validate API keys. */
  apiBaseUrl: string;
  /** Base URL of the hosted Partiri web sign-in page. */
  webBaseUrl: string;
  /** Public base URL of this MCP server (issuer/resource identifiers). */
  mcpBaseUrl: string;
  /** 32-byte key used to encrypt/decrypt stateless OAuth tokens. */
  tokenSecret: Buffer;
  /** Active session store; defaults to a fresh in-memory Map. */
  sessions?: Map<string, Session>;
  /** Session-lifecycle limits; defaults to {@link loadConfig}'s result. */
  config?: AppConfig;
  /** Hosts allowed for non-loopback OAuth redirect URIs. */
  allowedRedirectHosts?: ReadonlySet<string>;
  /**
   * Browser Origins permitted to call /mcp; see
   * {@link resolveAllowedOrigins}.
   */
  allowedOrigins?: ReadonlySet<string>;
  /** Express `trust proxy` setting; see {@link resolveTrustProxy}. */
  trustProxy?: number | string | boolean;
  /** Dynamic OAuth client registration store; defaults to in-memory. */
  clientStore?: OAuthRegisteredClientsStore;
}

/**
 * Resolve the browser Origins allowed to reach /mcp from MCP_ALLOWED_ORIGINS
 * (comma-separated), defaulting to the Claude and ChatGPT web origins. The
 * server's own origin is always included. Requests without an Origin header
 * (non-browser MCP clients) bypass the check entirely.
 * @param env - Raw MCP_ALLOWED_ORIGINS value, or undefined to use the
 *   Claude/ChatGPT defaults.
 * @param mcpBaseUrl - This server's public base URL, always added to the
 *   set.
 * @returns The set of allowed Origin values (scheme + host, no path).
 */
export function resolveAllowedOrigins(
  env: string | undefined,
  mcpBaseUrl: string,
): Set<string> {
  const defaults = [
    'https://claude.ai',
    'https://claude.com',
    'https://chatgpt.com',
    'https://chat.openai.com',
  ];
  const entries = env?.trim() ? env.split(',') : defaults;
  const origins = new Set<string>();
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      console.warn(
        `WARNING: invalid origin in MCP_ALLOWED_ORIGINS: "${trimmed}" — ignored`,
      );
    }
  }
  origins.add(new URL(mcpBaseUrl).origin);
  return origins;
}

/**
 * Build the Express application: OAuth 2.1 endpoints, the hosted sign-in
 * callback, and the /mcp Streamable HTTP endpoints (POST/GET/DELETE) with
 * dual auth, rate limiting, origin validation, and session management wired
 * in.
 * @param opts - App configuration; see {@link CreateAppOptions}.
 * @returns The configured Express app, not yet listening.
 */
export function createApp(opts: CreateAppOptions) {
  const {
    apiBaseUrl,
    webBaseUrl,
    mcpBaseUrl,
    tokenSecret,
    sessions = new Map(),
    config = loadConfig(),
    allowedRedirectHosts = new Set<string>(),
    allowedOrigins = resolveAllowedOrigins(undefined, opts.mcpBaseUrl),
    trustProxy = 'loopback',
    clientStore = new InMemoryClientStore(allowedRedirectHosts),
  } = opts;

  const app = express();
  // Trust only the configured proxy (default loopback) so X-Forwarded-For from a
  // direct/off-proxy connection cannot spoof the client IP used for rate limits.
  // proxy-addr compiles the value eagerly and throws on a malformed IP/CIDR;
  // fall back to the safe loopback default rather than crashing on a typo.
  try {
    app.set('trust proxy', trustProxy);
  } catch (e) {
    console.warn(
      `WARNING: invalid trust proxy setting (${String(trustProxy)}) — ` +
        `falling back to 'loopback': ${(e as Error).message}`,
    );
    app.set('trust proxy', 'loopback');
  }

  // ── Request logging ────────────────────────────────────────────────────────
  /**
   * Log a concise access line for every request: method, path, status,
   * duration, and whether a session id / auth was presented.
   * @remarks Without this, client-side failures (a client giving up after a
   *   404/401, a refused reconnect) are invisible on the server — exactly
   *   what made the redeploy auth-loss issue impossible to diagnose. No
   *   headers, tokens, or request bodies are logged.
   * @param req - The incoming request.
   * @param res - The response; logging happens on its `finish` event.
   * @param next - Passes control to the next middleware immediately.
   */
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const session = req.headers['mcp-session-id'] ? ' session' : '';
      const auth =
        req.headers['authorization'] || req.headers['x-api-key'] ? ' auth' : '';
      console.log(
        `${req.method} ${req.path} -> ${res.statusCode} ${Date.now() - start}ms${session}${auth}`,
      );
    });
    next();
  });

  // ── Security headers ───────────────────────────────────────────────────────
  /**
   * Attach baseline security headers to every response: no MIME sniffing, no
   * framing, a strict deny-all CSP, and no caching.
   * @remarks Mounted before the OAuth router and /callback so every endpoint
   *   gets them. The server renders no HTML UI (sign-in is a 302 to the
   *   hosted Partiri page), so the strictest CSP applies everywhere.
   * @param _req - The incoming request (unused).
   * @param res - The response to attach headers to.
   * @param next - Passes control to the next middleware.
   */
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'",
    );
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // ── OAuth provider ──────────────────────────────────────────────────────────
  /**
   * Bridges the MCP SDK's OAuth 2.1 flows to Partiri API keys: mints
   * stateless encrypted tokens and validates them on each request.
   */
  const oauthProvider = new PartiriOAuthProvider({
    secret: tokenSecret,
    webBaseUrl,
    mcpBaseUrl,
    clientStore,
  });

  // ── Rate limit the OAuth endpoints ─────────────────────────────────────────
  /**
   * Rate limiter for the OAuth surface (max 20 requests/minute per client).
   * @remarks Registered before the router and the /callback handler so it
   *   actually covers them (the general /mcp limiter does not). /callback
   *   validates the API key against the upstream API on every call, so
   *   leaving it unthrottled turns it into a credential brute-force oracle
   *   and a DoS amplifier against the Partiri API. /token and /register are
   *   throttled against abuse too.
   */
  const oauthLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many authentication requests, please try again later.',
  });
  app.use(['/authorize', '/token', '/register', '/callback'], oauthLimiter);

  // ── OAuth endpoints (must be mounted before other middleware) ──────────────
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(mcpBaseUrl),
      resourceServerUrl: new URL('/mcp', mcpBaseUrl),
    }),
  );

  // ── Root-path Protected Resource Metadata (RFC 9728) ──────────────────────
  /**
   * Serve the RFC 9728 Protected Resource Metadata document at the root
   * well-known path too.
   * @remarks mcpAuthRouter serves the PRM only at the path-specific
   *   /.well-known/oauth-protected-resource/mcp; some clients probe the root
   *   path without the /mcp suffix, so the identical document is served
   *   there as well.
   */
  app.use(
    '/.well-known/oauth-protected-resource',
    metadataHandler({
      resource: new URL('/mcp', mcpBaseUrl).href,
      authorization_servers: [new URL(mcpBaseUrl).href],
    }),
  );

  // ── Hosted sign-in callback handler ───────────────────────────────────────
  /**
   * Handle the redirect from the hosted Partiri sign-in page and resume the
   * OAuth flow by issuing an authorization code.
   * @remarks The hosted Partiri sign-in page redirects here — to this
   *   server's public `callback` URL (the one provider.authorize() handed
   *   it) — with the short `state` and the user's `key`. This handler looks
   *   up the in-flight OAuth params stashed under that state, re-validates
   *   the client and redirect_uri, verifies the key against the API, then
   *   resumes the flow by issuing the auth code.
   * @param req - The incoming request; expects `state` and `key` query
   *   parameters.
   * @param res - The response: a 4xx with an error message on failure, or a
   *   302 redirect back to the client's redirect_uri with the auth code.
   */
  app.get('/callback', async (req: Request, res: Response) => {
    const { state, key } = req.query as Record<string, string | undefined>;

    if (!state || !key) {
      res.status(400).send('Missing sign-in parameters.');
      return;
    }

    // One-shot lookup. An unknown, replayed, or expired state fails here — the
    // OAuth params (client_id, redirect_uri, code_challenge) live server-side,
    // never in the round-trip, so the callback can't be forged to redirect a
    // victim's key to an attacker-controlled target.
    const login = oauthProvider.consumePendingLogin(state);
    if (!login) {
      res.status(400).send('Invalid or expired sign-in session.');
      return;
    }

    // Defense in depth: never forward a minted key to a redirect that isn't a
    // loopback address or an allowlisted host, even if a client somehow holds
    // one. Second checkpoint behind registration-time validation.
    if (!isAllowedRedirectUri(login.redirectUri, allowedRedirectHosts)) {
      res.status(400).send('Invalid redirect URI.');
      return;
    }

    const client = await clientStore.getClient(login.clientId);
    if (
      !client ||
      !client.redirect_uris.some((uri) =>
        redirectUriMatches(login.redirectUri, uri),
      )
    ) {
      res.status(400).send('Invalid client or redirect URI.');
      return;
    }

    // Validate the API key by calling the Partiri API
    try {
      const apiClient = new PartiriApiClient(key, apiBaseUrl);
      await apiClient.getCurrentUser();
    } catch {
      res.status(401).send('Invalid API key.');
      return;
    }

    const code = oauthProvider.createAuthorizationCode(
      key,
      login.codeChallenge,
      login.redirectUri,
    );

    const redirectUrl = new URL(login.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (login.state) redirectUrl.searchParams.set('state', login.state);
    res.redirect(302, redirectUrl.toString());
  });

  // ── Body size limit ──────────────────────────────────────────────────────────
  app.use(express.json({ limit: '100kb' }));

  // ── Rate limiting ──────────────────────────────────────────────────────────
  /** Rate limiter applied to all /mcp requests (max 200 requests/minute). */
  const generalLimiter = rateLimit({
    windowMs: 60_000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Rate limit exceeded' },
      id: null,
    },
  });

  /**
   * Rate limiter applied to session-creating (initialize) requests only, to
   * cap how many sessions a client can spin up (max 10 requests/minute).
   */
  const initLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Too many sessions created' },
      id: null,
    },
  });

  app.use('/mcp', generalLimiter);

  // ── Origin validation on /mcp ──────────────────────────────────────────────
  /**
   * Reject browser requests to /mcp whose Origin header is not on the
   * allowlist (DNS-rebinding / cross-site defense).
   * @remarks Non-browser MCP clients (Claude, ChatGPT backends, CLIs) send no
   *   Origin header and pass through unchecked.
   * @param req - The incoming request.
   * @param res - The response; a 403 JSON-RPC error is written when the
   *   Origin is disallowed or malformed.
   * @param next - Passes control to the next middleware when the Origin is
   *   absent or allowed.
   */
  const originGuard: RequestHandler = (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    const origin = req.headers.origin;
    if (!origin) return next();
    let normalized: string;
    try {
      normalized = new URL(origin).origin;
    } catch {
      // Covers the literal `Origin: null` (sandboxed iframes, redirects).
      return jsonRpcError(res, 403, 'Origin not allowed');
    }
    if (!allowedOrigins.has(normalized)) {
      return jsonRpcError(res, 403, 'Origin not allowed');
    }
    next();
  };
  app.use('/mcp', originGuard);

  // ── Dual auth middleware on /mcp (Bearer OR x-api-key) ────────────────────
  /**
   * OAuth Bearer token verifier/middleware for /mcp.
   * @remarks `resourceMetadataUrl` puts the RFC 9728 pointer in the 401's
   *   WWW-Authenticate header so clients can discover the authorization
   *   server.
   */
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    resourceMetadataUrl: new URL(
      '/.well-known/oauth-protected-resource/mcp',
      mcpBaseUrl,
    ).href,
  });
  /**
   * Accept either an OAuth Bearer token or a legacy `x-api-key` header on
   * /mcp requests.
   * @remarks The `Authorization` header is checked first, and its presence —
   *   not its validity — decides the path. A client that has completed the
   *   OAuth flow keeps sending whatever `x-api-key` its config holds, so
   *   branching on that header instead would skip token validation entirely
   *   and let a stale key veto a valid token on every reconnect.
   * @param req - The incoming request.
   * @param res - The response, delegated to `bearerAuth` for Bearer
   *   validation.
   * @param next - Passes control on the legacy `x-api-key` path.
   * @returns The result of `next()` (legacy path) or of invoking
   *   `bearerAuth`.
   */
  const dualAuth: RequestHandler = (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    if (req.headers['authorization']) return bearerAuth(req, res, next);
    if (req.headers['x-api-key']) return next(); // legacy path
    return bearerAuth(req, res, next); // returns 401 with WWW-Authenticate
  };

  app.use('/mcp', dualAuth);

  // ── Health check ────────────────────────────────────────────────────────────
  /**
   * Liveness probe endpoint.
   * @param _req - The incoming request (unused).
   * @param res - Always responds 200 with `{ status: 'ok' }`.
   */
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  // ── POST /mcp ──────────────────────────────────────────────────────────────
  /**
   * Handle a JSON-RPC request on /mcp: routes it to an existing session's
   * transport, or — for an `initialize` request with no session id —
   * validates the API key, enforces session limits, and creates a new
   * session and transport.
   * @param req - The incoming request. `mcp-session-id` header selects an
   *   existing session; otherwise the body must be an MCP `initialize`
   *   request.
   * @param res - The response, handled by the session's transport or written
   *   directly with a JSON-RPC error (400/401/404/429/500).
   */
  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      // ── Existing session ───────────────────────────────────────────────────
      if (sessionId && sessions.has(sessionId)) {
        const session = validateSession(req, res, sessions);
        if (!session) return;
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      // ── New session (initialize) ───────────────────────────────────────────
      if (!sessionId && isInitializeRequest(req.body)) {
        // Apply init rate limiter inline
        await new Promise<void>((resolve, reject) => {
          initLimiter(req, res, (err?: unknown) => {
            if (err) reject(err);
            else resolve();
          });
        });
        if (res.headersSent) return; // Rate limiter already responded

        const apiKey = resolveApiKey(req);
        if (!apiKey) {
          jsonRpcError(res, 401, 'Missing authentication');
          return;
        }

        const keyHash = hashApiKey(apiKey);

        // Check total session limit
        if (sessions.size >= config.maxSessions) {
          jsonRpcError(res, 429, 'Server session limit reached');
          return;
        }

        // Check per-key session limit
        let keySessionCount = 0;
        for (const session of sessions.values()) {
          if (session.apiKeyHash === keyHash) keySessionCount++;
        }
        if (keySessionCount >= config.maxSessionsPerKey) {
          jsonRpcError(res, 429, 'Session limit per API key reached');
          return;
        }

        const apiClient = new PartiriApiClient(apiKey, apiBaseUrl);
        // Validate the API key against the upstream API BEFORE allocating a
        // session, so unauthenticated/garbage keys cannot fill the session pool
        // (a cheap DoS). Mirrors what GET /callback already does.
        try {
          await apiClient.getCurrentUser();
        } catch {
          jsonRpcError(res, 401, 'Invalid API key');
          return;
        }
        const server = createServer(apiClient);
        const now = Date.now();

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, {
              transport,
              apiKeyHash: keyHash,
              createdAt: now,
              lastActivity: now,
            });
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) sessions.delete(sid);
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // A session id was supplied but is unknown (server restarted / expired).
      // 404 tells the client to re-initialize (same rationale as
      // validateSession). With no session id and no initialize, it's a genuine
      // bad request.
      if (sessionId) {
        jsonRpcError(res, 404, 'Session not found');
        return;
      }
      jsonRpcError(res, 400, 'Bad request: no valid session ID');
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // ── GET /mcp ───────────────────────────────────────────────────────────────
  /**
   * Handle the Streamable HTTP GET on /mcp (SSE stream resumption), after
   * validating the session.
   * @param req - The incoming request; requires a valid `mcp-session-id`.
   * @param res - The response, handled by the session's transport or written
   *   with a JSON-RPC error on validation/internal failure.
   */
  app.get('/mcp', async (req: Request, res: Response) => {
    try {
      const session = validateSession(req, res, sessions);
      if (!session) return;
      await session.transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // ── DELETE /mcp ─────────────────────────────────────────────────────────────
  /**
   * Handle a client-initiated session termination on /mcp, after validating
   * the session.
   * @param req - The incoming request; requires a valid `mcp-session-id`.
   * @param res - The response, handled by the session's transport or written
   *   with a JSON-RPC error on validation/internal failure.
   */
  app.delete('/mcp', async (req: Request, res: Response) => {
    try {
      const session = validateSession(req, res, sessions);
      if (!session) return;
      await session.transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  return app;
}

/**
 * Probe whether `dir` actually exists and is writable.
 * @remarks Returns false instead of throwing when no persistent volume is
 *   mounted (or the root filesystem is read-only), so the server can fall
 *   back to in-memory state and keep running.
 * @param dir - The directory to probe; created if missing.
 * @returns True if a probe file could be written to and removed from `dir`.
 */
function isWritableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.write-probe-${process.pid}`);
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the 32-byte token-encryption secret. Tokens are stateless and
 * encrypted with this key, so it MUST stay stable across restarts or every
 * user is forced to re-authenticate. Precedence:
 *   1. MCP_TOKEN_SECRET env var (preferred — manage via a K8s Secret)
 *   2. `<MCP_DATA_DIR>/token-secret` file (auto-generated once, then reused)
 *   3. random ephemeral key (dev only — does NOT survive restarts)
 * @param dataDir - Writable persistent directory to read/persist the
 *   generated secret file, or undefined to skip file-based persistence.
 * @returns The 32-byte secret key.
 * @throws {Error} If MCP_TOKEN_SECRET is set but is not exactly 64 hex
 *   characters (32 bytes).
 */
function resolveTokenSecret(dataDir?: string): Buffer {
  const secretHex = process.env.MCP_TOKEN_SECRET;
  if (secretHex) {
    const secret = Buffer.from(secretHex, 'hex');
    if (secret.length !== 32) {
      throw new Error(
        'MCP_TOKEN_SECRET must be exactly 64 hex characters (32 bytes)',
      );
    }
    return secret;
  }

  if (dataDir) {
    const secretPath = join(dataDir, 'token-secret');
    try {
      const secret = Buffer.from(
        readFileSync(secretPath, 'utf-8').trim(),
        'hex',
      );
      if (secret.length === 32) return secret;
      console.warn(
        `WARNING: ${secretPath} is malformed — regenerating token secret`,
      );
    } catch {
      // No secret persisted yet — generate and store one below.
    }
    const secret = randomBytes(32);
    try {
      writeFileSync(secretPath, secret.toString('hex'), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      console.warn(
        `MCP_TOKEN_SECRET not set — persisted a generated key to ${secretPath}`,
      );
    } catch {
      console.warn(
        'WARNING: MCP_TOKEN_SECRET not set and data dir unwritable — using random key (tokens will not survive restarts)',
      );
    }
    return secret;
  }

  console.warn(
    'WARNING: MCP_TOKEN_SECRET not set — using random key (tokens will not survive restarts)',
  );
  return randomBytes(32);
}

// ── Server entrypoint ────────────────────────────────────────────────────────

/**
 * Server entrypoint for HTTP (Streamable HTTP) transport: resolves runtime
 * config from the environment, builds the Express app, starts listening, and
 * wires up graceful shutdown.
 * @remarks The data directory is only used if it is actually present and
 *   writable — when no persistent volume is mounted (or the root filesystem
 *   is read-only), state falls back to in-memory so the server still starts;
 *   users just re-authenticate after a restart. When available, the data
 *   directory also persists dynamic client registrations so cached
 *   client_ids stay valid across restarts (single-replica deployments only).
 * @returns Resolves once the server is listening; shutdown itself exits the
 *   process rather than resolving this promise.
 */
export async function startHttp(): Promise<void> {
  const apiBaseUrl = resolveBaseUrl();
  const port = parseInt(process.env.PORT || '3000', 10);
  const config = loadConfig();
  const sessions = new Map<string, Session>();

  const requestedDataDir = process.env.MCP_DATA_DIR;
  const dataDir =
    requestedDataDir && isWritableDir(requestedDataDir)
      ? requestedDataDir
      : undefined;
  if (requestedDataDir && !dataDir) {
    console.warn(
      `WARNING: MCP_DATA_DIR=${requestedDataDir} is not writable — using in-memory state (users will re-authenticate after restarts)`,
    );
  }

  const tokenSecret = resolveTokenSecret(dataDir);

  const allowedRedirectHosts = parseHostSet(
    process.env.MCP_ALLOWED_REDIRECT_HOSTS,
  );
  const clientStore = dataDir
    ? new FileClientStore(join(dataDir, 'clients.json'), allowedRedirectHosts)
    : new InMemoryClientStore(allowedRedirectHosts);

  const mcpBaseUrl = process.env.MCP_BASE_URL || `http://localhost:${port}`;
  const webBaseUrl = (
    process.env.PARTIRI_WEB_URL || 'https://partiri.cloud'
  ).replace(/\/+$/, '');
  const trustProxy = resolveTrustProxy(process.env.MCP_TRUSTED_PROXIES);
  const allowedOrigins = resolveAllowedOrigins(
    process.env.MCP_ALLOWED_ORIGINS,
    mcpBaseUrl,
  );

  const app = createApp({
    apiBaseUrl,
    webBaseUrl,
    mcpBaseUrl,
    tokenSecret,
    sessions,
    config,
    allowedRedirectHosts,
    allowedOrigins,
    trustProxy,
    clientStore,
  });
  const cleanupTimer = startSessionCleanup(sessions, config);

  app.listen(port, () => {
    console.log(`Partiri MCP server listening on port ${port}`);
  });

  /**
   * Gracefully shut down: stop the session-cleanup timer, close every active
   * session's transport, then exit the process.
   */
  const shutdown = async () => {
    clearInterval(cleanupTimer);
    for (const [sid, session] of sessions) {
      await session.transport.close().catch(() => {});
      sessions.delete(sid);
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
