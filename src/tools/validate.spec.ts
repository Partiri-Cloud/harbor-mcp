import { describe, it, expect, vi } from 'vitest';
import { handlers } from './validate.js';
import type { PartiriApiClient } from '../client.js';

const handler = handlers.get('validate_service')!;

function mockClient(): PartiriApiClient {
  return {
    probeGitRepository: vi.fn().mockResolvedValue({}),
    probeRegistry: vi.fn().mockResolvedValue({}),
  } as unknown as PartiriApiClient;
}

const base = {
  name: 'svc',
  deployType: 'webservice',
  runtime: 'node',
  rootPath: '/',
  probeReachability: true,
};

describe('validate_service SSRF guards', () => {
  it('does not probe a private/loopback/metadata git repository URL', async () => {
    for (const repositoryUrl of [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1/x',
      'https://10.0.0.5/repo.git',
      'http://[::1]/repo.git',
    ]) {
      const client = mockClient();
      await handler(client, { ...base, repositoryUrl });
      expect(client.probeGitRepository).not.toHaveBeenCalled();
    }
  });

  it('probes a public git repository URL', async () => {
    const client = mockClient();
    await handler(client, { ...base, repositoryUrl: 'https://github.com/o/r' });
    expect(client.probeGitRepository).toHaveBeenCalledTimes(1);
  });

  it('does not probe a private/loopback registry host', async () => {
    for (const registryUrl of [
      'localhost:5000/img:latest',
      '127.0.0.1:5000/img',
      '169.254.169.254/img',
      '10.0.0.5/team/img:v1',
      '0x7f000001/img', // encoded loopback (hex)
      '2130706433/img', // encoded loopback (decimal)
      'fc00::1/img', // bare IPv6 ULA
      '[::1]/img', // bracketed IPv6 loopback
    ]) {
      const client = mockClient();
      await handler(client, { ...base, registryUrl });
      expect(client.probeRegistry).not.toHaveBeenCalled();
    }
  });

  it('probes public registry references (incl. Docker Hub short forms)', async () => {
    for (const registryUrl of [
      'ghcr.io/o/i:v1',
      'docker.io/library/nginx:latest',
      'nginx:latest',
      'nginx',
    ]) {
      const client = mockClient();
      await handler(client, { ...base, registryUrl });
      expect(client.probeRegistry).toHaveBeenCalledTimes(1);
    }
  });
});
