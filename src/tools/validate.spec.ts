import { describe, it, expect, vi } from 'vitest';
import { handlers } from './validate.js';
import type { PartiriApiClient } from '../client.js';

const handler = handlers.get('validate_service')!;

function mockClient(): PartiriApiClient {
  return {
    probeGitRepository: vi.fn().mockResolvedValue({}),
    probeRegistry: vi.fn().mockResolvedValue({}),
    // Stubbed so the cost/balance tail of the handler stays silent: an
    // unstubbed method throws a TypeError that the handler swallows into
    // `balance_note`, which would mask what these tests are asserting.
    getPricing: vi.fn().mockResolvedValue({ pods: [], volume_price_per_gb: 0 }),
    getBalance: vi.fn().mockResolvedValue({ amount: 100, currency: 'EUR' }),
  } as unknown as PartiriApiClient;
}

/** Parse the `validate_service` payload back into its structured result. */
function payload(result: unknown): {
  valid: boolean;
  checks: Array<{ field: string; ok: boolean; message: string }>;
  balance_note?: string;
} {
  return (result as { structuredContent: ReturnType<typeof payload> })
    .structuredContent;
}

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

const base = {
  name: 'svc',
  deployType: 'webservice',
  runtime: 'node',
  rootPath: '/',
  probeReachability: true,
  workspaceId: WORKSPACE_ID,
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

  it('sends the workspace the API authorizes the probe against', async () => {
    const client = mockClient();
    await handler(client, { ...base, repositoryUrl: 'https://github.com/o/r' });
    expect(client.probeGitRepository).toHaveBeenCalledWith({
      workspace: WORKSPACE_ID,
      url: 'https://github.com/o/r',
    });

    await handler(client, { ...base, registryUrl: 'ghcr.io/o/i:v1' });
    expect(client.probeRegistry).toHaveBeenCalledWith({
      workspace: WORKSPACE_ID,
      registry_url: 'ghcr.io/o/i:v1',
    });
  });

  it('reports the missing workspaceId on each source instead of calling the API', async () => {
    const client = mockClient();
    const result = payload(
      await handler(client, {
        ...base,
        workspaceId: undefined,
        repositoryUrl: 'https://github.com/o/r',
        registryUrl: 'ghcr.io/o/i:v1',
      }),
    );

    expect(client.probeGitRepository).not.toHaveBeenCalled();
    expect(client.probeRegistry).not.toHaveBeenCalled();
    expect(result.valid).toBe(false);
    for (const field of ['repository_reachability', 'registry_reachability']) {
      const check = result.checks.find((c) => c.field === field);
      expect(check).toBeDefined();
      expect(check!.ok).toBe(false);
      expect(check!.message).toContain('workspaceId is required');
    }
  });

  it('emits no reachability check when there is no URL to probe', async () => {
    const client = mockClient();
    const result = payload(
      await handler(client, { ...base, workspaceId: undefined }),
    );

    expect(result.checks.some((c) => c.field.endsWith('_reachability'))).toBe(
      false,
    );
  });

  it('reports the SSRF verdict, not the missing workspaceId, for a private host', async () => {
    const client = mockClient();
    const result = payload(
      await handler(client, {
        ...base,
        workspaceId: undefined,
        repositoryUrl: 'http://127.0.0.1/x',
      }),
    );

    const check = result.checks.find(
      (c) => c.field === 'repository_reachability',
    );
    expect(check!.ok).toBe(false);
    expect(check!.message).toContain('must be a public http(s) address');
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

describe('validate_service GitHub source', () => {
  const github = { repo: 'acme/widget', branch: 'main' };
  const cfg = {
    name: 'svc',
    deployType: 'webservice',
    runtime: 'node',
    rootPath: '.',
    fkRegion: WORKSPACE_ID,
    fkPod: WORKSPACE_ID,
    buildCommand: 'b',
    runCommand: 'r',
    github,
  };

  function ghClient(): PartiriApiClient {
    return {
      ...(mockClient() as object),
      getGithubConfig: vi.fn().mockResolvedValue({ enabled: true }),
      getProject: vi.fn().mockResolvedValue({ fk_workspace: WORKSPACE_ID }),
      getGithubIdentity: vi.fn().mockResolvedValue({ connected: true }),
      listGithubInstallations: vi.fn().mockResolvedValue([
        {
          link_id: 'l1',
          account_login: 'acme',
          suspended: false,
          settings_url: 'u',
        },
      ]),
      listGithubRepositories: vi.fn().mockResolvedValue({
        items: [{ id: 5, full_name: 'acme/widget', archived: false }],
      }),
      listGithubBranches: vi
        .fn()
        .mockResolvedValue([{ name: 'main', default: true }]),
    } as unknown as PartiriApiClient;
  }

  it('is valid when the App reaches the repository and branch', async () => {
    const result = payload(
      await handler(ghClient(), { ...cfg, workspaceId: WORKSPACE_ID }),
    );
    expect(result.valid).toBe(true);
    expect(result.checks.map((c) => c.field)).toEqual(
      expect.arrayContaining(['github_repository', 'github_branch']),
    );
  });

  it('fails on a missing branch', async () => {
    const result = payload(
      await handler(ghClient(), {
        ...cfg,
        github: { ...github, branch: 'nope' },
        workspaceId: WORKSPACE_ID,
      }),
    );
    const check = result.checks.find((c) => c.field === 'github_branch')!;
    expect(check.ok).toBe(false);
    expect(check.message).toContain('main');
    expect(result.valid).toBe(false);
  });

  it('requires workspaceId or fkProject for the GitHub check', async () => {
    const result = payload(await handler(ghClient(), cfg));
    const check = result.checks.find((c) => c.field === 'github_repository')!;
    expect(check.ok).toBe(false);
    expect(check.message).toContain('workspaceId or fkProject is required');
  });

  it('derives the workspace from fkProject when workspaceId is absent', async () => {
    const client = ghClient();
    const result = payload(
      await handler(client, { ...cfg, fkProject: WORKSPACE_ID }),
    );
    expect(result.valid).toBe(true);
    expect(client.getProject).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(client.getGithubConfig).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it('is invalid when the workspace has the GitHub App disabled', async () => {
    const client = {
      ...(ghClient() as object),
      getGithubConfig: vi.fn().mockResolvedValue({ enabled: false }),
    } as unknown as PartiriApiClient;
    const result = payload(
      await handler(client, { ...cfg, workspaceId: WORKSPACE_ID }),
    );
    expect(result.valid).toBe(false);
    expect(result.checks.find((c) => c.field === 'github_repository')!.ok).toBe(
      false,
    );
  });

  it('is invalid for an archived repository', async () => {
    const client = {
      ...(ghClient() as object),
      listGithubRepositories: vi.fn().mockResolvedValue({
        items: [{ id: 5, full_name: 'acme/widget', archived: true }],
      }),
    } as unknown as PartiriApiClient;
    const result = payload(
      await handler(client, { ...cfg, workspaceId: WORKSPACE_ID }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.checks.find((c) => c.field === 'github_repository')!.message,
    ).toContain('archived');
  });

  it('flags github combined with repositoryBranch', async () => {
    const result = payload(
      await handler(ghClient(), {
        ...cfg,
        repositoryBranch: 'dev',
        workspaceId: WORKSPACE_ID,
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.checks.find((c) => c.field === 'github_branch_field')!.ok,
    ).toBe(false);
  });

  it('flags github combined with repositoryUrl', async () => {
    const result = payload(
      await handler(ghClient(), {
        ...cfg,
        repositoryUrl: 'https://github.com/acme/widget',
        workspaceId: WORKSPACE_ID,
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.checks.find((c) => c.field === 'source')!.ok).toBe(false);
  });
});
