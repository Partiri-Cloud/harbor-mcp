import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  createAccessToken,
  createRefreshToken,
  createAuthCode,
  verifyAndDecrypt,
  type DecryptedPayload,
} from './crypto.js';

/**
 * Canonical form of a resource identifier for RFC 8707 comparisons:
 * origin + pathname with trailing slashes stripped; query/fragment ignored.
 * Keeps `https://mcp.partiri.cloud/mcp` and `.../mcp/` equal.
 */
export function normalizeResource(u: string | URL): string {
  const url = new URL(u);
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/** Lifetime of a minted access token, in seconds (1 hour). */
const ACCESS_TOKEN_TTL = 3600; // 1 hour
/** Lifetime of a minted refresh token, in seconds (30 days). */
const REFRESH_TOKEN_TTL = 30 * 24 * 3600; // 30 days
/** Lifetime of a minted authorization code, in seconds (5 minutes). */
const AUTH_CODE_TTL = 300; // 5 minutes
/** Window, in milliseconds, a pending browser sign-in stays valid (10 min). */
const LOGIN_TTL_MS = 10 * 60_000; // pending browser sign-in window

/**
 * Maximum number of in-flight pending logins held server-side.
 *
 * @remarks
 * When full, the OLDEST entry is evicted (see {@link stashPendingLogin})
 * rather than rejecting new sign-ins, so a flood cannot lock every user out
 * of starting a new sign-in.
 */
const MAX_PENDING_LOGINS = 1_000;

/**
 * Maximum number of consumed auth-code ids kept for replay detection.
 *
 * @remarks
 * Auth codes have a 5-min TTL, so entries never need to live longer than
 * that. The set is bounded so a burst of invalid redemption attempts cannot
 * exhaust memory — once full, new entries replace the oldest consumed ids
 * (FIFO via insertion-order iteration on the underlying Set).
 */
const MAX_CONSUMED_CODES = 10_000;

/**
 * In-flight OAuth authorization params held server-side while the user
 * signs in on the hosted Partiri page.
 *
 * @remarks
 * That page only round-trips a short hex `state` — it can't carry our
 * client_id / redirect_uri / code_challenge — so these are keyed by the
 * state here and the flow is resumed when the page redirects the minted key
 * to our public `GET /callback`.
 */
interface PendingLogin {
  /** The registered OAuth client id that initiated the flow. */
  clientId: string;
  /** The redirect URI the client requested for the completed flow. */
  redirectUri: string;
  /** PKCE code challenge supplied by the client. */
  codeChallenge: string;
  /** The OAuth client's own `state`, echoed back on completion. */
  state?: string;
  /** Expiry of this pending login, in epoch milliseconds. */
  expiresAt: number;
}

/** Construction options for {@link PartiriOAuthProvider}. */
export interface ProviderOptions {
  /** Symmetric secret used to encrypt/decrypt all minted tokens. */
  secret: Buffer;
  /** Base URL of the hosted Partiri web app (used for the sign-in page). */
  webBaseUrl: string;
  /** Public base URL of this MCP server (used to build the callback URL). */
  mcpBaseUrl: string;
  /** Backing store for dynamically registered OAuth clients. */
  clientStore: OAuthRegisteredClientsStore;
}

/**
 * OAuth 2.1 authorization server provider that bridges MCP clients to
 * Partiri API keys.
 *
 * @remarks
 * Implements {@link OAuthServerProvider} from the MCP SDK. Authorization is
 * delegated to a hosted Partiri sign-in page rather than a local consent
 * screen, and all issued tokens (access, refresh, authorization code) are
 * stateless — encrypted with AES-256-GCM (see `./crypto.js`) rather than
 * stored server-side.
 */
export class PartiriOAuthProvider implements OAuthServerProvider {
  /** Symmetric secret used to encrypt/decrypt all minted tokens. */
  private readonly secret: Buffer;
  /** Base URL of the hosted Partiri web app. */
  private readonly webBaseUrl: string;
  /** Public base URL of this MCP server. */
  private readonly mcpBaseUrl: string;
  /** RFC 8707 audience: the one resource this server issues tokens for. */
  private readonly canonicalResource: string;
  /** Backing store for dynamically registered OAuth clients. */
  private readonly _clientStore: OAuthRegisteredClientsStore;
  /** Pending browser sign-ins, keyed by the hex `state` handed to the page. */
  private readonly pendingLogins = new Map<string, PendingLogin>();
  /**
   * Replay guard: tracks auth-code ids that have already been redeemed
   * within their TTL window. Bounded to {@link MAX_CONSUMED_CODES} (FIFO
   * eviction).
   */
  private readonly consumedCodes = new Set<string>();

  /**
   * Builds the provider and derives the canonical RFC 8707 resource
   * identifier from `mcpBaseUrl`.
   *
   * @param opts - Provider configuration; see {@link ProviderOptions}.
   */
  constructor(opts: ProviderOptions) {
    this.secret = opts.secret;
    this.webBaseUrl = opts.webBaseUrl;
    this.mcpBaseUrl = opts.mcpBaseUrl;
    this.canonicalResource = normalizeResource(
      new URL('/mcp', opts.mcpBaseUrl),
    );
    this._clientStore = opts.clientStore;
  }

  /**
   * RFC 8707: a `resource` parameter, when supplied, must name this server.
   * The SDK forwards it verbatim from `/authorize` and `/token` without
   * validating — that is the provider's job.
   *
   * @param resource - The resource URL requested by the client, if any.
   * @throws {InvalidTargetError} If `resource` is present and does not
   *   match {@link PartiriOAuthProvider.canonicalResource}.
   */
  private assertResourceAllowed(resource?: URL): void {
    if (resource && normalizeResource(resource) !== this.canonicalResource) {
      throw new InvalidTargetError(
        `Requested resource does not match this server (expected ${this.canonicalResource})`,
      );
    }
  }

  /** Backing store for dynamically registered OAuth clients. */
  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientStore;
  }

  // ── Authorization ─────────────────────────────────────────────────────────

  /**
   * Handles the OAuth 2.1 `/authorize` step by redirecting the browser to
   * the hosted Partiri sign-in page instead of rendering a local consent
   * screen.
   *
   * @param client - The registered OAuth client initiating the flow.
   * @param params - Authorization request parameters (redirect URI, PKCE
   *   code challenge, resource, and the client's own `state`).
   * @param res - Express response used to issue the 302 redirect.
   * @throws {InvalidTargetError} If `params.resource` names a server other
   *   than this one (RFC 8707).
   * @remarks
   * Browser sign-in mirrors the CLI's `auth login`: bounce to the hosted
   * page with a short hex `state` and the address it should return the key
   * to. The CLI passes a loopback `port` because its listener runs on the
   * user's own machine; this server is remote, so a public `callback` URL
   * is passed instead. The page mints a key and redirects to
   * `<callback>?state=…&key=…`; the in-flight OAuth params are held
   * server-side under that state and resumed in `GET /callback`.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // Reject a foreign `resource` up front (302 error redirect with
    // error=invalid_target) before stashing any sign-in state.
    this.assertResourceAllowed(params.resource);

    const state = this.stashPendingLogin({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
    });

    const callbackUrl = new URL('/callback', this.mcpBaseUrl).toString();

    const loginUrl = new URL('/cli-auth', this.webBaseUrl);
    loginUrl.searchParams.set('state', state);
    loginUrl.searchParams.set('callback', callbackUrl);
    res.redirect(302, loginUrl.toString());
  }

  // ── Pending browser sign-in (server-side round-trip state) ────────────────

  /**
   * Stores a pending login's OAuth params under a freshly minted `state`
   * and returns that state for the caller to hand to the sign-in page.
   *
   * @param login - Pending login fields, minus the expiry (set here).
   * @returns A 64-character hex `state` identifying the stashed entry.
   * @remarks
   * Bounds the map by evicting the OLDEST entry (insertion-ordered `Map`)
   * when at capacity, rather than rejecting. Rejecting would let a flood
   * lock every user out of starting a new sign-in; with eviction a
   * displaced user's `/callback` simply fails and they retry. The flood
   * rate itself is bounded by the per-IP rate limiter on `/authorize`.
   */
  private stashPendingLogin(login: Omit<PendingLogin, 'expiresAt'>): string {
    const now = Date.now();
    for (const [key, entry] of this.pendingLogins) {
      if (entry.expiresAt <= now) this.pendingLogins.delete(key);
    }
    while (this.pendingLogins.size >= MAX_PENDING_LOGINS) {
      const oldest = this.pendingLogins.keys().next().value;
      if (oldest === undefined) break;
      this.pendingLogins.delete(oldest);
    }
    // 64 hex chars — within the hosted page's accepted `state` format.
    const state = randomBytes(32).toString('hex');
    this.pendingLogins.set(state, { ...login, expiresAt: now + LOGIN_TTL_MS });
    return state;
  }

  /**
   * Looks up and removes (one-shot) the OAuth params for a pending sign-in.
   *
   * @param state - The hex `state` returned by {@link stashPendingLogin}.
   * @returns The stashed {@link PendingLogin}, or `null` if the state is
   *   unknown or its entry has already expired.
   */
  consumePendingLogin(state: string): PendingLogin | null {
    const entry = this.pendingLogins.get(state);
    if (!entry) return null;
    this.pendingLogins.delete(state);
    if (entry.expiresAt <= Date.now()) return null;
    return entry;
  }

  // ── PKCE challenge retrieval ──────────────────────────────────────────────

  /**
   * Recovers the PKCE code challenge bound to an authorization code, so the
   * SDK's token handler can verify it against the client's `code_verifier`
   * before this provider ever sees the exchange request.
   *
   * @param _client - Unused; the code itself carries the issuing context.
   * @param authorizationCode - The encrypted authorization code string.
   * @returns The stored PKCE `code_challenge`.
   * @throws If the code fails decryption, has the wrong type, or is
   *   expired (see {@link verifyAndDecrypt}).
   */
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const payload = verifyAndDecrypt(authorizationCode, 'c', this.secret);
    return payload.c!;
  }

  // ── Token exchange ────────────────────────────────────────────────────────

  /**
   * Exchanges a one-time authorization code for a fresh access/refresh
   * token pair.
   *
   * @param _client - Unused; the code itself carries the issuing context.
   * @param authorizationCode - The encrypted authorization code string.
   * @param _codeVerifier - Unused here; PKCE is verified by the SDK via
   *   {@link challengeForAuthorizationCode} before this method runs.
   * @param redirectUri - Redirect URI presented at the token endpoint; must
   *   match the one bound into the code, if the code carries one.
   * @param resource - RFC 8707 resource parameter, if supplied.
   * @returns A new `Bearer` access/refresh token pair.
   * @throws {InvalidTargetError} If `resource` names a foreign server.
   * @throws If the code fails decryption/type/expiry checks, the redirect
   *   URI mismatches, or the code has already been redeemed.
   * @remarks
   * OAuth 2.1 §4.1.3 requires authorization codes to be single-use. Every
   * code carries a unique id (`i`); if the id is absent the code was issued
   * before this guard was added and is rejected to fail closed rather than
   * silently skipping the check. The consumed-code set is bounded: it
   * evicts the oldest entry at capacity (FIFO, since `Set` iteration
   * preserves insertion order). Evicting rather than rejecting is safe
   * ONLY because the SDK token handler validates PKCE — via
   * {@link challengeForAuthorizationCode} + `verifyChallenge` — BEFORE
   * calling this method. A replayed id whose entry was evicted still
   * requires the original `code_verifier`, which an interceptor does not
   * have. Do not consume the code ahead of PKCE validation, and do not set
   * `skipLocalPkceValidation`.
   */
  async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.assertResourceAllowed(resource);
    const payload = verifyAndDecrypt(authorizationCode, 'c', this.secret);

    if (redirectUri && payload.r !== redirectUri) {
      throw new Error('redirect_uri mismatch');
    }

    const codeId = payload.i;
    if (!codeId || this.consumedCodes.has(codeId)) {
      throw new Error('Authorization code already used');
    }
    if (this.consumedCodes.size >= MAX_CONSUMED_CODES) {
      const oldest = this.consumedCodes.values().next().value;
      if (oldest !== undefined) this.consumedCodes.delete(oldest);
    }
    this.consumedCodes.add(codeId);

    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: createAccessToken(
        payload.k,
        now + ACCESS_TOKEN_TTL,
        this.secret,
        this.canonicalResource,
      ),
      refresh_token: createRefreshToken(
        payload.k,
        now + REFRESH_TOKEN_TTL,
        this.secret,
        this.canonicalResource,
      ),
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL,
    };
  }

  /**
   * Rotates a refresh token for a fresh access/refresh token pair.
   *
   * @param _client - Unused; the token itself carries the issuing context.
   * @param refreshToken - The encrypted refresh token string.
   * @param _scopes - Unused; this provider does not support scope narrowing.
   * @param resource - RFC 8707 resource parameter, if supplied.
   * @returns A new `Bearer` access/refresh token pair.
   * @throws {InvalidTargetError} If `resource` names a foreign server.
   * @throws If the token fails decryption, type, or expiry checks.
   * @remarks
   * Always mints with the canonical audience: a legacy (pre-audience)
   * refresh token is upgraded here on its next rotation.
   */
  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.assertResourceAllowed(resource);
    const payload = verifyAndDecrypt(refreshToken, 'r', this.secret);
    const now = Math.floor(Date.now() / 1000);

    return {
      access_token: createAccessToken(
        payload.k,
        now + ACCESS_TOKEN_TTL,
        this.secret,
        this.canonicalResource,
      ),
      refresh_token: createRefreshToken(
        payload.k,
        now + REFRESH_TOKEN_TTL,
        this.secret,
        this.canonicalResource,
      ),
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL,
    };
  }

  // ── Token verification ────────────────────────────────────────────────────

  /**
   * Decrypts and validates a bearer access token for an incoming request.
   *
   * @param token - The encrypted access token string from the
   *   `Authorization` header.
   * @returns Auth info for the request, carrying the resolved Partiri API
   *   key in `extra.apiKey`.
   * @throws {InvalidTokenError} If the token fails decryption/type/expiry
   *   checks, or if its RFC 8707 audience does not match this server.
   * @remarks
   * Decryption/type/expiry errors are re-thrown as the SDK's
   * `InvalidTokenError` so `bearerAuth` answers 401 with a
   * `WWW-Authenticate` header — a plain `Error` would surface as a 500 and
   * break the client's re-auth flow. Tokens minted before the audience
   * claim (`a`) was introduced lack it and are accepted until natural
   * expiry (≤30 days) — rejecting them would force every existing user to
   * re-authenticate.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload: DecryptedPayload;
    try {
      payload = verifyAndDecrypt(token, 'a', this.secret);
    } catch (e) {
      throw new InvalidTokenError((e as Error).message);
    }
    if (
      payload.a !== undefined &&
      normalizeResource(payload.a) !== this.canonicalResource
    ) {
      throw new InvalidTokenError(
        'Token audience does not match this resource server',
      );
    }
    return {
      token,
      clientId: 'oauth',
      scopes: [],
      expiresAt: payload.e,
      extra: { apiKey: payload.k },
    };
  }

  // ── Auth code creation (called from GET /callback) ────────────────────────

  /**
   * Mints a one-time authorization code binding an API key to a PKCE
   * challenge and redirect URI.
   *
   * @param apiKey - The Partiri API key obtained from the hosted sign-in
   *   page.
   * @param codeChallenge - PKCE code challenge from the original
   *   `/authorize` request.
   * @param redirectUri - Redirect URI the code must be redeemed against.
   * @returns The encrypted authorization code string.
   */
  createAuthorizationCode(
    apiKey: string,
    codeChallenge: string,
    redirectUri: string,
  ): string {
    const now = Math.floor(Date.now() / 1000);
    const id = randomBytes(16).toString('hex');
    return createAuthCode(
      apiKey,
      codeChallenge,
      redirectUri,
      now + AUTH_CODE_TTL,
      this.secret,
      id,
    );
  }
}
