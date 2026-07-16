import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { isAllowedRedirectUri } from '../net-guard.js';

/**
 * Maximum number of dynamically registered OAuth clients kept in memory
 * (and on disk for the file-backed store).
 *
 * @remarks
 * RFC 7591 dynamic registration is open to any caller, so without a cap a
 * flood of registrations exhausts memory. 10 000 covers any realistic
 * deployment with room to spare.
 */
const MAX_CLIENTS = 10_000;

/**
 * Reject a registration whose redirect URIs are not all safe destinations —
 * loopback (lands on the user's own machine) or a host in the configured
 * allowlist. This is the primary defense against the OAuth confused-deputy: a
 * client cannot register an attacker-controlled redirect, so it can never
 * receive another user's minted authorization code. Throws an OAuth-typed error
 * so the SDK registration handler returns a clean 400.
 *
 * @param uris - Redirect URIs requested by the registering client.
 * @param allowed - Configured allowlist of hosts, checked via
 *   {@link isAllowedRedirectUri}.
 * @throws {InvalidClientMetadataError} If any URI is neither loopback nor
 *   on the allowlist.
 */
function assertAllowedRedirectUris(
  uris: string[] | undefined,
  allowed: ReadonlySet<string>,
): void {
  for (const uri of uris ?? []) {
    if (!isAllowedRedirectUri(uri, allowed)) {
      throw new InvalidClientMetadataError(
        `redirect_uri "${uri}" is not allowed — it must be a loopback address or an allowlisted host`,
      );
    }
  }
}

/**
 * Volatile, in-memory RFC 7591 dynamic client registration store.
 *
 * @remarks
 * Registrations are lost on restart. Suitable for stateless/multi-replica
 * deployments where clients are expected to re-register, or for tests. See
 * {@link FileClientStore} for a persisted alternative.
 */
export class InMemoryClientStore implements OAuthRegisteredClientsStore {
  /** Registered clients, keyed by `client_id`. */
  private clients = new Map<string, OAuthClientInformationFull>();

  /**
   * @param allowedRedirectHosts - Hosts, beyond loopback, that registered
   *   clients may use as redirect URIs.
   */
  constructor(
    private readonly allowedRedirectHosts: ReadonlySet<string> = new Set(),
  ) {}

  /**
   * Looks up a registered client by id.
   *
   * @param clientId - The `client_id` to look up.
   * @returns The matching client, or `undefined` if not registered.
   */
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  /**
   * Registers (or re-registers) an OAuth client.
   *
   * @param client - Client metadata submitted for registration, minus the
   *   server-assigned `client_id` and `client_id_issued_at`.
   * @returns The stored client record.
   * @throws {InvalidClientMetadataError} If any requested redirect URI is
   *   not loopback or allowlisted (see {@link assertAllowedRedirectUris}).
   * @remarks
   * Re-registering an existing `client_id` is always allowed (idempotent
   * update). Evicts the oldest registration when at capacity instead of
   * rejecting, so a registration flood cannot lock out new clients (the
   * OAuth rate limiter bounds the flood rate; stateless tokens already
   * issued are unaffected and an evicted client simply re-registers).
   */
  registerClient(
    client: Omit<
      OAuthClientInformationFull,
      'client_id' | 'client_id_issued_at'
    >,
  ): OAuthClientInformationFull {
    const full = client as OAuthClientInformationFull;
    assertAllowedRedirectUris(full.redirect_uris, this.allowedRedirectHosts);
    if (!this.clients.has(full.client_id) && this.clients.size >= MAX_CLIENTS) {
      const oldest = this.clients.keys().next().value;
      if (oldest !== undefined) this.clients.delete(oldest);
    }
    this.clients.set(full.client_id, full);
    return full;
  }
}

/**
 * Client store that persists dynamic client registrations to disk so they
 * survive restarts and redeploys. Without this, an empty store after a restart
 * makes every cached `client_id` unknown, forcing clients to re-register and
 * users to re-authorize. Intended for single-replica deployments backed by a
 * persistent volume (e.g. `/app/data`).
 */
export class FileClientStore implements OAuthRegisteredClientsStore {
  /** Registered clients, keyed by `client_id`. */
  private clients = new Map<string, OAuthClientInformationFull>();
  /** Path to the JSON file backing this store. */
  private readonly filePath: string;
  /** Hosts, beyond loopback, that registered clients may use as redirects. */
  private readonly allowedRedirectHosts: ReadonlySet<string>;

  /**
   * Builds the store and synchronously loads any existing registrations
   * from disk.
   *
   * @param filePath - Path to the JSON file used for persistence.
   * @param allowedRedirectHosts - Hosts, beyond loopback, that registered
   *   clients may use as redirect URIs.
   */
  constructor(
    filePath: string,
    allowedRedirectHosts: ReadonlySet<string> = new Set(),
  ) {
    this.filePath = filePath;
    this.allowedRedirectHosts = allowedRedirectHosts;
    this.load();
  }

  /**
   * Reads and parses `filePath`, populating {@link clients} with valid,
   * unexpired, allowlist-compliant entries.
   *
   * @remarks
   * Compacts expired confidential clients at load so the file cannot grow
   * unbounded over the deployment lifetime. Per RFC 7591,
   * `client_secret_expires_at` is Unix seconds; undefined/0 means "never
   * expires" (e.g. public clients) and such entries are kept. Eviction only
   * happens here, never in-place during a request, per the SDK's
   * `OAuthRegisteredClientsStore` guidance — it is lazy, so the on-disk
   * file is rewritten without the dropped entries on the next
   * {@link registerClient} call. A missing file (ENOENT, normal first
   * boot) is treated as an empty store silently; any other read error or a
   * corrupt/non-JSON file is logged and also starts empty, self-healing on
   * the next registration.
   */
  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      // ENOENT is the normal first boot (no file yet) — stay silent. Anything
      // else (permissions, I/O) is worth surfacing before we start empty.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `WARNING: could not read client registrations from ${this.filePath}, starting empty: ${err}`,
        );
      }
      return;
    }

    let entries: OAuthClientInformationFull[];
    try {
      entries = JSON.parse(raw) as OAuthClientInformationFull[];
    } catch (err) {
      // The file exists but is corrupt (truncated write, manual edit). Don't
      // silently drop real registrations — warn. The next registerClient call
      // overwrites the file with valid JSON, so this self-heals.
      console.warn(
        `WARNING: client registrations file ${this.filePath} is corrupt — starting empty (will be overwritten on next registration): ${err}`,
      );
      return;
    }

    const nowSec = Date.now() / 1000;
    let purged = 0;
    for (const client of entries) {
      const exp = client.client_secret_expires_at;
      if (exp && exp < nowSec) continue;
      // Drop any stored client whose redirect URIs no longer satisfy the
      // current allowlist (e.g. registered before the allowlist existed, or an
      // attacker registration from before this guard was added).
      if (
        !(client.redirect_uris ?? []).every((uri) =>
          isAllowedRedirectUri(uri, this.allowedRedirectHosts),
        )
      ) {
        purged++;
        continue;
      }
      this.clients.set(client.client_id, client);
    }
    if (purged > 0) {
      console.warn(
        `Dropped ${purged} stored client registration(s) with disallowed redirect URIs.`,
      );
    }
  }

  /**
   * Atomically writes the current in-memory client map to `filePath`.
   *
   * @remarks
   * Writes to a `.tmp` sibling file and renames it into place to avoid
   * leaving a truncated file on crash. Failures are logged, not thrown: if
   * the volume went away or turned read-only mid-run, the in-memory copy
   * still works for the current process — only persistence across a
   * restart is lost.
   */
  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.clients.values()]), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn(
        `WARNING: could not persist client registrations to ${this.filePath}: ${err}`,
      );
    }
  }

  /**
   * Looks up a registered client by id.
   *
   * @param clientId - The `client_id` to look up.
   * @returns The matching client, or `undefined` if not registered.
   */
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  /**
   * Registers (or re-registers) an OAuth client and persists the updated
   * client map to disk.
   *
   * @param client - Client metadata submitted for registration, minus the
   *   server-assigned `client_id` and `client_id_issued_at`.
   * @returns The stored client record.
   * @throws {InvalidClientMetadataError} If any requested redirect URI is
   *   not loopback or allowlisted (see {@link assertAllowedRedirectUris}).
   * @remarks
   * Re-registering an existing `client_id` is always allowed (idempotent
   * update). Evicts the oldest registration when at capacity instead of
   * rejecting, so a registration flood cannot lock out new clients (the
   * OAuth rate limiter bounds the flood rate; stateless tokens already
   * issued are unaffected and an evicted client simply re-registers).
   */
  registerClient(
    client: Omit<
      OAuthClientInformationFull,
      'client_id' | 'client_id_issued_at'
    >,
  ): OAuthClientInformationFull {
    const full = client as OAuthClientInformationFull;
    assertAllowedRedirectUris(full.redirect_uris, this.allowedRedirectHosts);
    if (!this.clients.has(full.client_id) && this.clients.size >= MAX_CLIENTS) {
      const oldest = this.clients.keys().next().value;
      if (oldest !== undefined) this.clients.delete(oldest);
    }
    this.clients.set(full.client_id, full);
    this.persist();
    return full;
  }
}
