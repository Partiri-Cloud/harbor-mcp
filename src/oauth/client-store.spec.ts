import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { FileClientStore, InMemoryClientStore } from './client-store.js';

function makeClient(
  id: string,
  overrides: Partial<OAuthClientInformationFull> = {},
): OAuthClientInformationFull {
  return {
    client_id: id,
    client_id_issued_at: 1700000000,
    redirect_uris: ['http://127.0.0.1:8080/callback'], // loopback — always allowed
    ...overrides,
  } as OAuthClientInformationFull;
}

describe('InMemoryClientStore', () => {
  it('registers and retrieves a client', () => {
    const store = new InMemoryClientStore();
    store.registerClient(makeClient('abc'));
    expect(store.getClient('abc')?.client_id).toBe('abc');
    expect(store.getClient('missing')).toBeUndefined();
  });

  // Registration cap (shared logic with FileClientStore): RFC 7591 dynamic
  // registration is open to any caller, so the store is bounded and evicts the
  // oldest entry at capacity rather than rejecting (no registration lockout).
  it('evicts the oldest client beyond MAX_CLIENTS and allows idempotent updates', () => {
    const MAX = 10_000; // mirrors MAX_CLIENTS in client-store.ts
    const store = new InMemoryClientStore();
    for (let n = 0; n < MAX; n++) store.registerClient(makeClient(`c-${n}`));
    expect(store.getClient('c-0')?.client_id).toBe('c-0');

    // A brand-new client beyond the cap evicts the oldest (c-0), not rejected.
    expect(() => store.registerClient(makeClient('overflow'))).not.toThrow();
    expect(store.getClient('overflow')?.client_id).toBe('overflow');
    expect(store.getClient('c-0')).toBeUndefined(); // oldest evicted

    // Re-registering an existing client_id is still an in-place update.
    expect(() =>
      store.registerClient(
        makeClient('c-1', { redirect_uris: ['http://127.0.0.1:9999/cb'] }),
      ),
    ).not.toThrow();
    expect(store.getClient('c-1')?.redirect_uris).toEqual([
      'http://127.0.0.1:9999/cb',
    ]);
  });
});

describe('redirect_uri allowlist (confused-deputy guard)', () => {
  it('allows loopback redirects with no configured allowlist', () => {
    const store = new InMemoryClientStore();
    expect(() =>
      store.registerClient(
        makeClient('a', { redirect_uris: ['http://localhost:3000/cb'] }),
      ),
    ).not.toThrow();
  });

  it('rejects external redirect hosts that are not allowlisted', () => {
    const store = new InMemoryClientStore();
    expect(() =>
      store.registerClient(
        makeClient('b', { redirect_uris: ['https://attacker.example/cb'] }),
      ),
    ).toThrow('not allowed');
    expect(() =>
      store.registerClient(
        makeClient('c', { redirect_uris: ['http://attacker.example/cb'] }),
      ),
    ).toThrow('not allowed');
    expect(store.getClient('b')).toBeUndefined();
  });

  it('allows an explicitly allowlisted https host but not others', () => {
    const store = new InMemoryClientStore(new Set(['claude.ai']));
    expect(() =>
      store.registerClient(
        makeClient('d', {
          redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      store.registerClient(
        makeClient('e', { redirect_uris: ['https://evil.example/cb'] }),
      ),
    ).toThrow('not allowed');
  });

  it('rejects when ANY redirect_uri in the set is disallowed', () => {
    const store = new InMemoryClientStore();
    expect(() =>
      store.registerClient(
        makeClient('f', {
          redirect_uris: [
            'http://127.0.0.1:5000/cb',
            'https://evil.example/cb',
          ],
        }),
      ),
    ).toThrow('not allowed');
  });
});

describe('FileClientStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-clients-'));
    filePath = join(dir, 'clients.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists registrations across instances', () => {
    const store = new FileClientStore(filePath);
    store.registerClient(makeClient('persisted'));

    // A fresh instance (simulating a restart) reloads from disk.
    const reloaded = new FileClientStore(filePath);
    expect(reloaded.getClient('persisted')?.client_id).toBe('persisted');
  });

  it('starts empty when the file does not exist yet', () => {
    const store = new FileClientStore(filePath);
    expect(store.getClient('anything')).toBeUndefined();
    expect(existsSync(filePath)).toBe(false);
  });

  it('writes the file with owner-only permissions', () => {
    const store = new FileClientStore(filePath);
    store.registerClient(makeClient('x'));
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('creates the parent directory if missing', () => {
    const nested = join(dir, 'deep', 'nested', 'clients.json');
    const store = new FileClientStore(nested);
    store.registerClient(makeClient('y'));
    expect(existsSync(nested)).toBe(true);
  });

  it('keeps the registration in memory when persistence fails', () => {
    // Point at a path whose parent is a file, so mkdir/write throws.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    const store = new FileClientStore(join(blocker, 'clients.json'));
    expect(() => store.registerClient(makeClient('z'))).not.toThrow();
    expect(store.getClient('z')?.client_id).toBe('z');
  });

  it('does not warn on first boot when the file is absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new FileClientStore(filePath);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns and starts empty when the file is corrupt', () => {
    const store = new FileClientStore(filePath);
    store.registerClient(makeClient('first'));
    // Corrupt the file, then reload.
    writeFileSync(filePath, 'not json{', 'utf-8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reloaded = new FileClientStore(filePath);
    expect(reloaded.getClient('first')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt'));
    warn.mockRestore();
  });

  it('compacts expired confidential clients on reload, keeping the rest', () => {
    const store = new FileClientStore(filePath);
    store.registerClient(
      makeClient('expired', { client_secret_expires_at: 1 }),
    );
    store.registerClient(makeClient('never', { client_secret_expires_at: 0 }));
    store.registerClient(makeClient('public')); // no client_secret_expires_at
    store.registerClient(
      makeClient('future', {
        client_secret_expires_at: Math.floor(Date.now() / 1000) + 86_400,
      }),
    );

    const reloaded = new FileClientStore(filePath);
    expect(reloaded.getClient('expired')).toBeUndefined();
    expect(reloaded.getClient('never')?.client_id).toBe('never');
    expect(reloaded.getClient('public')?.client_id).toBe('public');
    expect(reloaded.getClient('future')?.client_id).toBe('future');
  });

  it('purges stored clients with disallowed redirect URIs on load', () => {
    // Hand-write a clients.json with one safe (loopback) and one unsafe client,
    // simulating an attacker registration persisted before the allowlist guard.
    const good = makeClient('good');
    const bad = {
      ...makeClient('bad'),
      redirect_uris: ['https://attacker.example/cb'],
    };
    writeFileSync(filePath, JSON.stringify([good, bad]), 'utf-8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new FileClientStore(filePath); // empty allowlist → loopback-only
    expect(store.getClient('good')?.client_id).toBe('good');
    expect(store.getClient('bad')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disallowed'));
    warn.mockRestore();
  });
});
