import { describe, it, expect } from 'vitest';
import {
  isLoopbackHost,
  isPrivateOrSpecialHost,
  isPublicHttpUrl,
  isAllowedRedirectUri,
} from './net-guard.js';

describe('isLoopbackHost', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.5.6.7', '::1', '[::1]'])(
    'treats %s as loopback',
    (h) => expect(isLoopbackHost(h)).toBe(true),
  );
  it.each([
    '10.0.0.1',
    '8.8.8.8',
    'example.com',
    '127.0.0.1.evil.com',
    '0.0.0.0',
  ])('treats %s as NOT loopback', (h) => expect(isLoopbackHost(h)).toBe(false));
});

describe('isPrivateOrSpecialHost', () => {
  it.each([
    'localhost',
    '127.0.0.1',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '0.0.0.0',
    '100.64.0.1', // CGNAT
    '::1',
    'fe80::1',
    'febf::1',
    'fc00::1',
    'fd12:3456::1',
    'fec0::1', // site-local (deprecated)
    'ff02::1', // multicast
    '::ffff:127.0.0.1', // IPv4-mapped IPv6
    'metadata.google.internal',
    '2130706433', // 127.0.0.1 as decimal
    '0x7f000001', // 127.0.0.1 as hex
    '', // empty host
  ])('blocks private/special %s', (h) =>
    expect(isPrivateOrSpecialHost(h)).toBe(true),
  );

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1', // just below the 172.16/12 range
    '172.32.0.1', // just above it
    '192.169.0.1',
    'example.com',
    'api.github.com',
  ])('allows public %s', (h) => expect(isPrivateOrSpecialHost(h)).toBe(false));
});

describe('isPublicHttpUrl', () => {
  it.each([
    'https://8.8.8.8/x',
    'http://example.com/repo.git',
    'https://api.github.com/repos/a/b',
    'https://[::ffff:8.8.8.8]/', // IPv4-mapped public address stays public
  ])('accepts public %s', (u) => expect(isPublicHttpUrl(u)).toBe(true));

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1/',
    'https://10.0.0.5:6443/',
    'http://localhost:8080/',
    'http://0x7f000001/', // encoded IPv4 (hex)
    'http://2130706433/', // encoded IPv4 (decimal)
    'http://0177.0.0.1/', // encoded IPv4 (dotted octal) — URL-normalized
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', // IPv4-mapped loopback (URL-normalized to hex)
    'http://[::ffff:10.0.0.1]/', // IPv4-mapped private
    'http://[::ffff:169.254.169.254]/', // IPv4-mapped metadata
    'http://metadata.google.internal/computeMetadata/v1/',
    'https://user@169.254.169.254/', // userinfo smuggling
    'ftp://8.8.8.8/', // non-http scheme
    'file:///etc/passwd',
    'gopher://8.8.8.8/',
    'not a url',
    '',
  ])('rejects %s', (u) => expect(isPublicHttpUrl(u)).toBe(false));
});

describe('isAllowedRedirectUri', () => {
  const allow = new Set(['claude.ai', 'app.partiri.cloud']);

  it.each([
    'http://localhost:4321/cb',
    'http://127.0.0.1:5000/callback',
    'https://[::1]/cb',
    'https://claude.ai/api/mcp/auth_callback',
    'https://app.partiri.cloud/cb',
  ])('allows safe redirect %s', (u) =>
    expect(isAllowedRedirectUri(u, allow)).toBe(true),
  );

  it.each([
    'http://attacker.example/cb', // external http
    'https://attacker.example/cb', // external https, not allowlisted
    'https://claude.ai.attacker.com/cb', // lookalike host
    'http://127.0.0.1.attacker.com/cb', // loopback-lookalike DNS name
    'https://user@127.0.0.1@attacker.example/cb', // userinfo confusion
    'javascript:alert(1)',
    'data:text/html,x',
    'not a url',
    '',
  ])('rejects unsafe redirect %s', (u) =>
    expect(isAllowedRedirectUri(u, allow)).toBe(false),
  );
});
