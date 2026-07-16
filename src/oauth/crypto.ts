/**
 * @fileoverview Stateless OAuth token encryption. All MCP-issued access
 * tokens, refresh tokens, and authorization codes are AES-256-GCM-encrypted
 * JSON blobs rather than server-stored records — the ciphertext itself
 * carries the token's claims (API key, expiry, type, and, for
 * authorization codes, PKCE/redirect/replay-guard data).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AEAD cipher used for all token encryption/decryption. */
const ALGORITHM = 'aes-256-gcm';
/** Length, in bytes, of the random initialization vector prefixed to each token. */
const IV_LENGTH = 12;
/** Length, in bytes, of the GCM authentication tag suffixed to each token. */
const TAG_LENGTH = 16;

// ── Core encrypt / decrypt ──────────────────────────────────────────────────

/**
 * Encrypts an arbitrary JSON-serializable payload into an opaque token
 * string.
 *
 * @param payload - The claims to encrypt (JSON-serialized before
 *   encryption).
 * @param secret - 32-byte AES-256 key.
 * @returns A base64url string of `iv || ciphertext || authTag`.
 */
export function encryptToken(
  payload: Record<string, unknown>,
  secret: Buffer,
): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, secret, iv);
  const plaintext = JSON.stringify(payload);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]).toString('base64url');
}

/**
 * Decrypts a token string produced by {@link encryptToken} back into its
 * JSON payload.
 *
 * @param token - The base64url token string (`iv || ciphertext || authTag`).
 * @param secret - 32-byte AES-256 key; must match the key used to encrypt.
 * @returns The decrypted JSON payload.
 * @throws If the token is too short to contain an IV and auth tag, or if
 *   GCM authentication/decryption fails (wrong key, tampered ciphertext).
 */
export function decryptToken(
  token: string,
  secret: Buffer,
): Record<string, unknown> {
  const combined = Buffer.from(token, 'base64url');
  if (combined.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('Invalid token');
  }
  const iv = combined.subarray(0, IV_LENGTH);
  const tag = combined.subarray(combined.length - TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH, combined.length - TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, secret, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

// ── Typed token helpers ─────────────────────────────────────────────────────

/**
 * Mints an encrypted access token (`t: 'a'`).
 *
 * @param apiKey - The Partiri API key to embed as the token's identity.
 * @param expiresAt - Expiry, in epoch seconds.
 * @param secret - 32-byte AES-256 key used to encrypt the token.
 * @param audience - RFC 8707 canonical resource URL to bind as the token's
 *   audience; omitted from the payload when not supplied.
 * @returns The encrypted access token string.
 */
export function createAccessToken(
  apiKey: string,
  expiresAt: number,
  secret: Buffer,
  audience?: string,
): string {
  return encryptToken(
    { k: apiKey, e: expiresAt, t: 'a', ...(audience ? { a: audience } : {}) },
    secret,
  );
}

/**
 * Mints an encrypted refresh token (`t: 'r'`).
 *
 * @param apiKey - The Partiri API key to embed as the token's identity.
 * @param expiresAt - Expiry, in epoch seconds.
 * @param secret - 32-byte AES-256 key used to encrypt the token.
 * @param audience - RFC 8707 canonical resource URL to bind as the token's
 *   audience; omitted from the payload when not supplied.
 * @returns The encrypted refresh token string.
 */
export function createRefreshToken(
  apiKey: string,
  expiresAt: number,
  secret: Buffer,
  audience?: string,
): string {
  return encryptToken(
    { k: apiKey, e: expiresAt, t: 'r', ...(audience ? { a: audience } : {}) },
    secret,
  );
}

/**
 * Mints an encrypted authorization code (`t: 'c'`).
 *
 * @param apiKey - The Partiri API key to embed as the code's identity.
 * @param codeChallenge - PKCE code challenge from the authorization
 *   request.
 * @param redirectUri - Redirect URI the code must be redeemed against.
 * @param expiresAt - Expiry, in epoch seconds.
 * @param secret - 32-byte AES-256 key used to encrypt the code.
 * @param id - Unique id used as a single-use replay guard when the code is
 *   redeemed.
 * @returns The encrypted authorization code string.
 */
export function createAuthCode(
  apiKey: string,
  codeChallenge: string,
  redirectUri: string,
  expiresAt: number,
  secret: Buffer,
  id: string,
): string {
  return encryptToken(
    {
      k: apiKey,
      c: codeChallenge,
      r: redirectUri,
      e: expiresAt,
      t: 'c',
      i: id,
    },
    secret,
  );
}

/**
 * Shape of the JSON claims embedded in every encrypted token/code minted by
 * this module.
 */
export interface DecryptedPayload {
  /** API key. */
  k: string;
  /** Expires at (epoch seconds). */
  e: number;
  /** Token type: `'a'` (access) | `'r'` (refresh) | `'c'` (auth code). */
  t: string;
  /**
   * Audience — canonical resource URL (RFC 8707); absent on legacy tokens
   * minted before audience binding was introduced.
   */
  a?: string;
  /** Code challenge (auth codes only). */
  c?: string;
  /** Redirect URI (auth codes only). */
  r?: string;
  /** Unique id (auth codes only) — replay guard. */
  i?: string;
}

/**
 * Decrypts a token and validates its type, expiry, and API key shape.
 *
 * @param token - The base64url encrypted token string.
 * @param expectedType - The `t` claim the token must carry (`'a'`, `'r'`,
 *   or `'c'`).
 * @param secret - 32-byte AES-256 key; must match the key used to encrypt.
 * @returns The validated {@link DecryptedPayload}.
 * @throws If decryption fails, the token type does not match
 *   `expectedType`, the token is expired (or missing a numeric expiry), or
 *   the embedded API key is not a non-empty string.
 */
export function verifyAndDecrypt(
  token: string,
  expectedType: string,
  secret: Buffer,
): DecryptedPayload {
  const payload = decryptToken(token, secret) as unknown as DecryptedPayload;
  if (payload.t !== expectedType) {
    throw new Error('Invalid token type');
  }
  // Fail closed: a missing or non-numeric `e` is treated as expired so a
  // crafted token that omits the expiry field cannot bypass this check.
  if (
    typeof payload.e !== 'number' ||
    payload.e < Math.floor(Date.now() / 1000)
  ) {
    throw new Error('Token expired');
  }
  // Fail closed: the decrypted payload is otherwise untyped JSON. The API key
  // must be a non-empty string before it flows on to the Partiri API client.
  if (typeof payload.k !== 'string' || payload.k.length === 0) {
    throw new Error('Invalid token');
  }
  return payload;
}
