import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveApiKey, resolveBaseUrl, resolveApiKeyOrLogin } from './auth.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: () => '/home/testuser',
}));

vi.mock('./auth-login.js', () => ({
  browserLogin: vi.fn(),
}));

import { readFileSync } from 'node:fs';
import { browserLogin } from './auth-login.js';

const mockedReadFileSync = vi.mocked(readFileSync);

describe('resolveApiKey', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PARTIRI_API_KEY;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns PARTIRI_API_KEY env var when set', () => {
    process.env.PARTIRI_API_KEY = 'env-key-123';
    expect(resolveApiKey()).toBe('env-key-123');
  });

  it('trims whitespace from env var', () => {
    process.env.PARTIRI_API_KEY = '  env-key-123  ';
    expect(resolveApiKey()).toBe('env-key-123');
  });

  it('falls back to config file when env var is empty', () => {
    process.env.PARTIRI_API_KEY = '';
    mockedReadFileSync.mockReturnValue('file-key-456');
    expect(resolveApiKey()).toBe('file-key-456');
  });

  it('reads from default config path', () => {
    mockedReadFileSync.mockReturnValue('file-key');
    resolveApiKey();
    expect(mockedReadFileSync).toHaveBeenCalledWith(
      '/home/testuser/.config/partiri/key',
      'utf-8',
    );
  });

  it('respects XDG_CONFIG_HOME', () => {
    process.env.XDG_CONFIG_HOME = '/custom/config';
    mockedReadFileSync.mockReturnValue('file-key');
    resolveApiKey();
    expect(mockedReadFileSync).toHaveBeenCalledWith(
      '/custom/config/partiri/key',
      'utf-8',
    );
  });

  it('throws when no key found', () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(() => resolveApiKey()).toThrow('No API key found');
  });

  it('throws when file exists but is empty', () => {
    mockedReadFileSync.mockReturnValue('   ');
    expect(() => resolveApiKey()).toThrow('No API key found');
  });
});

describe('resolveApiKeyOrLogin', () => {
  const originalEnv = { ...process.env };
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PARTIRI_API_KEY;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.CI;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
    }
  });

  it('throws without calling browserLogin in CI/non-TTY with no key', async () => {
    process.env.CI = 'true';
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    await expect(resolveApiKeyOrLogin()).rejects.toThrow('PARTIRI_API_KEY');
    expect(browserLogin).not.toHaveBeenCalled();
  });

  it('calls browserLogin in interactive mode when no key found', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.mocked(browserLogin).mockResolvedValue('browser-login-key');

    const result = await resolveApiKeyOrLogin();
    expect(result).toBe('browser-login-key');
    expect(browserLogin).toHaveBeenCalledOnce();
  });

  it('returns file key without calling browserLogin even when interactive', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });
    mockedReadFileSync.mockReturnValue('file-key-789');

    const result = await resolveApiKeyOrLogin();
    expect(result).toBe('file-key-789');
    expect(browserLogin).not.toHaveBeenCalled();
  });
});

describe('resolveBaseUrl', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PARTIRI_API_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('defaults to https://api.partiri.cloud', () => {
    expect(resolveBaseUrl()).toBe('https://api.partiri.cloud');
  });

  it('uses PARTIRI_API_URL env var', () => {
    process.env.PARTIRI_API_URL = 'https://custom.api.example.com';
    expect(resolveBaseUrl()).toBe('https://custom.api.example.com');
  });

  it('strips trailing slashes', () => {
    process.env.PARTIRI_API_URL = 'https://api.example.com///';
    expect(resolveBaseUrl()).toBe('https://api.example.com');
  });

  it('throws on non-HTTPS URL', () => {
    process.env.PARTIRI_API_URL = 'http://api.example.com';
    expect(() => resolveBaseUrl()).toThrow('PARTIRI_API_URL must use HTTPS');
  });
});
