import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  statSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  constantTimeEq,
  isValidHost,
  handleCallback,
  writeCredentials,
} from './auth-login.js';

describe('constantTimeEq', () => {
  it('matches when equal', () => {
    expect(constantTimeEq('abc', 'abc')).toBe(true);
    expect(constantTimeEq('', '')).toBe(true);
  });

  it('rejects different lengths', () => {
    expect(constantTimeEq('abc', 'abcd')).toBe(false);
    expect(constantTimeEq('', 'a')).toBe(false);
  });

  it('rejects differing content of same length', () => {
    expect(constantTimeEq('abc', 'abd')).toBe(false);
    expect(constantTimeEq('xxxxxxxxxxxxxxxx', 'yxxxxxxxxxxxxxxx')).toBe(false);
  });
});

describe('isValidHost', () => {
  it('accepts 127.0.0.1:<port>', () => {
    expect(isValidHost('127.0.0.1:1234', 1234)).toBe(true);
  });

  it('accepts localhost:<port>', () => {
    expect(isValidHost('localhost:1234', 1234)).toBe(true);
  });

  it('rejects undefined / empty', () => {
    expect(isValidHost(undefined, 1234)).toBe(false);
    expect(isValidHost('', 1234)).toBe(false);
  });

  it('rejects wrong host', () => {
    expect(isValidHost('evil.example.com', 1234)).toBe(false);
    expect(isValidHost('127.0.0.2:1234', 1234)).toBe(false);
  });

  it('rejects wrong port', () => {
    expect(isValidHost('127.0.0.1:9999', 1234)).toBe(false);
  });

  it('rejects IPv6 literals (listener binds 127.0.0.1 only)', () => {
    expect(isValidHost('[::1]:1234', 1234)).toBe(false);
  });

  it('trims surrounding whitespace', () => {
    expect(isValidHost(' 127.0.0.1:1234 ', 1234)).toBe(true);
  });
});

describe('handleCallback', () => {
  const port = 1234;
  const state = 'a'.repeat(64);

  it('returns the key on the happy path', () => {
    const result = handleCallback(
      'GET',
      `/callback?state=${state}&key=secret-api-key`,
      `127.0.0.1:${port}`,
      port,
      state,
    );
    expect(result).toEqual({ ok: true, key: 'secret-api-key' });
  });

  it('accepts localhost host header', () => {
    const result = handleCallback(
      'GET',
      `/callback?state=${state}&key=k`,
      `localhost:${port}`,
      port,
      state,
    );
    expect(result).toEqual({ ok: true, key: 'k' });
  });

  it('rejects non-GET with 405', () => {
    const result = handleCallback(
      'POST',
      `/callback?state=${state}&key=k`,
      `127.0.0.1:${port}`,
      port,
      state,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(405);
  });

  it('rejects bad Host header with 400', () => {
    const result = handleCallback(
      'GET',
      `/callback?state=${state}&key=k`,
      'evil.example.com',
      port,
      state,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it('rejects wrong path with 404', () => {
    const result = handleCallback(
      'GET',
      `/not-callback?state=${state}&key=k`,
      `127.0.0.1:${port}`,
      port,
      state,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it('rejects missing state with 400', () => {
    const result = handleCallback(
      'GET',
      '/callback?key=k',
      `127.0.0.1:${port}`,
      port,
      state,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.reason).toMatch(/state/);
    }
  });

  it('rejects missing key with 400', () => {
    const result = handleCallback(
      'GET',
      `/callback?state=${state}`,
      `127.0.0.1:${port}`,
      port,
      state,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.reason).toMatch(/key/);
    }
  });

  it('rejects state mismatch with 400', () => {
    const result = handleCallback(
      'GET',
      '/callback?state=evil&key=k',
      `127.0.0.1:${port}`,
      port,
      state,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.reason).toMatch(/State mismatch/);
    }
  });
});

describe('writeCredentials', () => {
  let tmpHome: string;
  const origHome = process.env.XDG_CONFIG_HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'partiri-mcp-test-'));
    process.env.XDG_CONFIG_HOME = tmpHome;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('creates parent directory and writes the key', () => {
    const path = writeCredentials('my-secret-key');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe('my-secret-key');
  });

  it('writes the key with mode 0600', () => {
    const path = writeCredentials('my-secret-key');
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('overwrites an existing file', () => {
    writeCredentials('old-key');
    const path = writeCredentials('new-key');
    expect(readFileSync(path, 'utf-8')).toBe('new-key');
  });

  it('tightens mode on an existing looser file', () => {
    const path = writeCredentials('old-key');
    // Manually loosen and rewrite
    chmodSync(path, 0o644);
    writeCredentials('new-key');
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('credentialsPath', () => {
  const origHome = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    if (origHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origHome;
    vi.resetModules();
  });

  it('uses XDG_CONFIG_HOME when set', async () => {
    process.env.XDG_CONFIG_HOME = '/tmp/some-xdg-dir';
    vi.resetModules();
    const { credentialsPath } = await import('./auth.js');
    expect(credentialsPath()).toBe('/tmp/some-xdg-dir/partiri/key');
  });

  it('falls back to ~/.config when XDG_CONFIG_HOME is unset', async () => {
    delete process.env.XDG_CONFIG_HOME;
    vi.resetModules();
    const { credentialsPath } = await import('./auth.js');
    expect(credentialsPath()).toMatch(/\/\.config\/partiri\/key$/);
  });
});
