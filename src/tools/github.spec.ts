import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  GithubInstallation,
  GithubRepo,
  PartiriApiClient,
} from '../client.js';
import { PartiriApiError } from '../errors.js';
import {
  GithubResolveError,
  checkBranch,
  dashboardUrl,
  definitions,
  handlers,
  parseGithubRepo,
  parseRepoInput,
  resolveRepo,
} from './github.js';

const WS = '11111111-1111-4111-8111-111111111111';

function inst(
  login: string,
  over: Partial<GithubInstallation> = {},
): GithubInstallation {
  return {
    id: `id-${login}`,
    link_id: `link-${login}`,
    installation_id: 1,
    account_login: login,
    account_type: 'Organization',
    repository_selection: 'selected',
    suspended: false,
    linked_at: '2026-01-01',
    settings_url: `https://github.com/settings/installations/${login}`,
    ...over,
  };
}

function repo(fullName: string, over: Partial<GithubRepo> = {}): GithubRepo {
  const [owner, name] = fullName.split('/');
  return {
    id: 42,
    name,
    full_name: fullName,
    owner_login: owner,
    private: true,
    archived: false,
    default_branch: 'main',
    html_url: `https://github.com/${fullName}`,
    pushed_at: null,
    ...over,
  };
}

function page(...items: GithubRepo[]) {
  return {
    items,
    total: items.length,
    page: 1,
    per_page: 100,
    truncated: false,
  };
}

interface Mocks {
  getGithubIdentity: ReturnType<typeof vi.fn>;
  listGithubInstallations: ReturnType<typeof vi.fn>;
  listGithubRepositories: ReturnType<typeof vi.fn>;
  listGithubBranches: ReturnType<typeof vi.fn>;
  [key: string]: ReturnType<typeof vi.fn>;
}

function mockClient(over: Partial<Mocks> = {}): PartiriApiClient & Mocks {
  return {
    getGithubConfig: vi.fn().mockResolvedValue({
      enabled: true,
      previews_enabled: false,
      dockerfile_builds_enabled: false,
    }),
    getGithubIdentity: vi
      .fn()
      .mockResolvedValue({ connected: true, github_login: 'me' }),
    listGithubInstallations: vi.fn().mockResolvedValue([inst('acme')]),
    listGithubRepositories: vi.fn().mockResolvedValue(page()),
    listGithubBranches: vi.fn().mockResolvedValue([
      { name: 'main', default: true, protected: false, commit_sha: 'a' },
      { name: 'dev', default: false, protected: false, commit_sha: 'b' },
    ]),
    ...over,
  } as unknown as PartiriApiClient & Mocks;
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content[0].text ?? '';
}

afterEach(() => {
  delete process.env.PARTIRI_WEB_URL;
});

describe('parseGithubRepo', () => {
  it.each([
    'https://github.com/Acme/Widget',
    'https://github.com/Acme/Widget.git',
    'https://github.com/Acme/Widget/',
    'https://github.com/Acme/Widget.git/',
    'https://user@github.com/Acme/Widget',
    'https://user:tok@GitHub.com/Acme/Widget.git',
    'git@github.com:Acme/Widget',
    'git@github.com:Acme/Widget.git',
    'ssh://git@github.com/Acme/Widget.git',
    'ssh://git@GITHUB.COM/Acme/Widget',
  ])('accepts %s', (url) => {
    expect(parseGithubRepo(url)).toEqual({
      owner: 'Acme',
      repo: 'Widget',
      fullName: 'Acme/Widget',
    });
  });

  it.each([
    'https://gitlab.com/Acme/Widget',
    'https://github.com/Acme',
    'https://github.com/Acme/Widget/tree/main',
    'http://github.com/Acme/Widget',
    'https://github.com.evil.com/Acme/Widget',
    'https://evil.com/github.com/Acme/Widget',
    'git@gitlab.com:Acme/Widget.git',
    'https://github.com/../Widget',
    '',
  ])('rejects %s', (url) => {
    expect(parseGithubRepo(url)).toBeNull();
  });

  it('accepts owners and repos with underscores, dots and dashes', () => {
    expect(parseGithubRepo('https://github.com/my_org-x/repo.name-1')).toEqual({
      owner: 'my_org-x',
      repo: 'repo.name-1',
      fullName: 'my_org-x/repo.name-1',
    });
  });

  it('parseRepoInput also takes the owner/repo shorthand', () => {
    expect(parseRepoInput('Acme/Widget')?.fullName).toBe('Acme/Widget');
    expect(parseRepoInput('a/b/c')).toBeNull();
  });
});

describe('dashboardUrl', () => {
  it('defaults to production and honours PARTIRI_WEB_URL', () => {
    expect(dashboardUrl(WS)).toBe(
      `https://partiri.cloud/workspace-settings/${WS}`,
    );
    process.env.PARTIRI_WEB_URL = 'https://dev.example.com/';
    expect(dashboardUrl(WS)).toBe(
      `https://dev.example.com/workspace-settings/${WS}`,
    );
  });
});

describe('resolveRepo', () => {
  const ref = { owner: 'acme', repo: 'widget', fullName: 'acme/widget' };

  it('matches full_name case-insensitively and returns the canonical repo', async () => {
    const client = mockClient({
      listGithubRepositories: vi
        .fn()
        .mockResolvedValue(page(repo('Acme/Widget'), repo('Acme/Widget-2'))),
    });
    const out = await resolveRepo(client, WS, ref);
    expect(out.repo.full_name).toBe('Acme/Widget');
    expect(out.linkId).toBe('link-acme');
    expect(client.listGithubRepositories).toHaveBeenCalledWith('link-acme', {
      q: 'acme/widget',
      page: 1,
      perPage: 100,
      refresh: false,
    });
  });

  it('pages past the first 100 substring matches to find the exact repo', async () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      repo(`acme/widget-${i}`),
    );
    const list = vi.fn((_link: string, opts: { page?: number }) =>
      Promise.resolve(
        opts.page === 1
          ? { ...page(...many), total: 150 }
          : { ...page(repo('acme/widget')), page: 2, total: 150 },
      ),
    );
    const client = mockClient({ listGithubRepositories: list });
    const out = await resolveRepo(client, WS, ref);
    expect(out.repo.full_name).toBe('acme/widget');
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1][1]).toMatchObject({ page: 2, refresh: false });
  });

  it('refreshes the cache only on the first page of the retry pass', async () => {
    const list = vi.fn(
      (_link: string, opts: { page?: number; refresh?: boolean }) =>
        Promise.resolve(
          opts.refresh || opts.page === 2
            ? opts.page === 2
              ? { ...page(repo('acme/widget')), page: 2, total: 101 }
              : { ...page(repo('acme/widget-x')), total: 101 }
            : page(),
        ),
    );
    const client = mockClient({ listGithubRepositories: list });
    const out = await resolveRepo(client, WS, ref);
    expect(out.repo.full_name).toBe('acme/widget');
    const calls = list.mock.calls.map((c) => [c[1].page, c[1].refresh]);
    expect(calls).toEqual([
      [1, false],
      [1, true],
      [2, false],
    ]);
  });

  it('queries the installation on the owner first', async () => {
    const client = mockClient({
      listGithubInstallations: vi
        .fn()
        .mockResolvedValue([inst('other'), inst('Acme')]),
      listGithubRepositories: vi
        .fn()
        .mockResolvedValue(page(repo('acme/widget'))),
    });
    const out = await resolveRepo(client, WS, ref);
    expect(out.linkId).toBe('link-Acme');
    expect(client.listGithubRepositories).toHaveBeenCalledTimes(1);
  });

  it('retries once with refresh when the repository is not listed', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page(repo('acme/widget')));
    const client = mockClient({ listGithubRepositories: list });
    const out = await resolveRepo(client, WS, ref);
    expect(out.repo.full_name).toBe('acme/widget');
    expect(list.mock.calls[0][1].refresh).toBe(false);
    expect(list.mock.calls[1][1].refresh).toBe(true);
  });

  it('lists every installation settings_url when the repository is not found', async () => {
    const client = mockClient({
      listGithubInstallations: vi.fn().mockResolvedValue([inst('someone')]),
    });
    const err = await resolveRepo(client, WS, ref).catch((e) => e);
    expect(err).toBeInstanceOf(GithubResolveError);
    expect(err.code).toBe('github_repo_not_accessible');
    expect(err.message).toContain(
      'someone → https://github.com/settings/installations/someone',
    );
    expect(err.message).toContain('No installation is on "acme"');
    expect(err.message).toContain(dashboardUrl(WS));
    expect(client.listGithubRepositories).toHaveBeenCalledTimes(2);
  });

  it('does not suggest installing when an installation is on the owner', async () => {
    const err = await resolveRepo(mockClient(), WS, ref).catch((e) => e);
    expect(err.message).not.toContain('No installation is on');
  });

  it('reports a suspended installation that holds the repository', async () => {
    const client = mockClient({
      listGithubInstallations: vi
        .fn()
        .mockResolvedValue([inst('acme', { suspended: true })]),
      listGithubRepositories: vi
        .fn()
        .mockResolvedValue(page(repo('acme/widget'))),
    });
    const err = await resolveRepo(client, WS, ref).catch((e) => e);
    expect(err.code).toBe('installation_suspended');
  });

  it('reports a suspended owner installation that cannot list', async () => {
    const client = mockClient({
      listGithubInstallations: vi
        .fn()
        .mockResolvedValue([inst('acme', { suspended: true })]),
      listGithubRepositories: vi
        .fn()
        .mockRejectedValue(
          new PartiriApiError('x', 403, 'installation_suspended'),
        ),
    });
    const err = await resolveRepo(client, WS, ref).catch((e) => e);
    expect(err.code).toBe('installation_suspended');
  });

  it('requires a GitHub identity, with the dashboard link', async () => {
    const client = mockClient({
      getGithubIdentity: vi.fn().mockResolvedValue({ connected: false }),
    });
    const err = await resolveRepo(client, WS, ref).catch((e) => e);
    expect(err.code).toBe('github_identity_required');
    expect(err.message).toContain(dashboardUrl(WS));
    expect(client.listGithubInstallations).not.toHaveBeenCalled();
  });

  it('treats reauth_required as not connected', async () => {
    const client = mockClient({
      getGithubIdentity: vi
        .fn()
        .mockResolvedValue({ connected: true, reauth_required: true }),
    });
    const err = await resolveRepo(client, WS, ref).catch((e) => e);
    expect(err.code).toBe('github_identity_required');
  });

  it('maps a disabled App to github_app_disabled', async () => {
    const client = mockClient({
      getGithubIdentity: vi
        .fn()
        .mockRejectedValue(
          new PartiriApiError('x', 404, 'github_app_disabled'),
        ),
    });
    const err = await resolveRepo(client, WS, ref).catch((e) => e);
    expect(err.code).toBe('github_app_disabled');
  });

  it('explains when no GitHub account is linked to the workspace', async () => {
    const client = mockClient({
      listGithubInstallations: vi.fn().mockResolvedValue([]),
    });
    const err = await resolveRepo(client, WS, ref).catch((e) => e);
    expect(err.message).toContain('No GitHub account is linked');
    expect(err.message).toContain(dashboardUrl(WS));
  });

  it('rejects an archived repository', async () => {
    const client = mockClient({
      listGithubRepositories: vi
        .fn()
        .mockResolvedValue(page(repo('acme/widget', { archived: true }))),
    });
    const err = await resolveRepo(client, WS, ref).catch((e) => e);
    expect(err).toBeInstanceOf(GithubResolveError);
    expect(err.code).toBe('repo_archived');
    expect(err.message).toContain('archived');
  });

  it('stops with github_app_disabled when the workspace config is not enabled', async () => {
    const client = mockClient({
      getGithubConfig: vi.fn().mockResolvedValue({ enabled: false }),
    });
    const err = await resolveRepo(client, WS, ref).catch((e) => e);
    expect(err.code).toBe('github_app_disabled');
    expect(client.getGithubIdentity).not.toHaveBeenCalled();
    expect(client.listGithubRepositories).not.toHaveBeenCalled();
  });

  it('treats a plain 404 from config as not available', async () => {
    const client = mockClient({
      getGithubConfig: vi
        .fn()
        .mockRejectedValue(new PartiriApiError('Cannot GET', 404)),
    });
    const err = await resolveRepo(client, WS, ref).catch((e) => e);
    expect(err.code).toBe('github_app_disabled');
  });

  it('surfaces a config outage as itself, not as disabled', async () => {
    const outage = new PartiriApiError('API error 503 — upstream down', 503);
    const client = mockClient({
      getGithubConfig: vi.fn().mockRejectedValue(outage),
    });
    const err = await resolveRepo(client, WS, ref).catch((e) => e);
    expect(err).toBe(outage);
    expect(client.getGithubIdentity).not.toHaveBeenCalled();
  });

  describe('installations the caller cannot access', () => {
    const forbidden = () =>
      new PartiriApiError('x', 403, 'github_installation_forbidden');
    const teammateThenAlice = () =>
      vi.fn().mockResolvedValue([inst('teammate'), inst('alice')]);

    it('keeps searching past a forbidden installation and honours the refresh pass', async () => {
      const list = vi
        .fn()
        .mockImplementation((link: string, opts: { refresh?: boolean }) => {
          if (link === 'link-teammate') return Promise.reject(forbidden());
          return Promise.resolve(
            opts.refresh ? page(repo('alice/newrepo')) : page(),
          );
        });
      const client = mockClient({
        listGithubInstallations: teammateThenAlice(),
        listGithubRepositories: list,
      });
      const out = await resolveRepo(client, WS, {
        owner: 'alice',
        repo: 'newrepo',
        fullName: 'alice/newrepo',
      });
      expect(out.linkId).toBe('link-alice');
      expect(list.mock.calls.some(([, o]) => o.refresh === true)).toBe(true);
    });

    it('also skips installation_link_inactive and installation_suspended', async () => {
      const codes: Record<string, string> = {
        'link-a': 'installation_link_inactive',
        'link-b': 'installation_suspended',
      };
      const client = mockClient({
        listGithubInstallations: vi
          .fn()
          .mockResolvedValue([inst('a'), inst('b'), inst('alice')]),
        listGithubRepositories: vi
          .fn()
          .mockImplementation((link: string) =>
            codes[link]
              ? Promise.reject(new PartiriApiError('x', 403, codes[link]))
              : Promise.resolve(page(repo('alice/x'))),
          ),
      });
      const out = await resolveRepo(client, WS, {
        owner: 'alice',
        repo: 'x',
        fullName: 'alice/x',
      });
      expect(out.linkId).toBe('link-alice');
    });

    it('ends in github_repo_not_accessible with the guidance when nothing has the repo', async () => {
      const client = mockClient({
        listGithubInstallations: teammateThenAlice(),
        listGithubRepositories: vi
          .fn()
          .mockImplementation((link: string) =>
            link === 'link-teammate'
              ? Promise.reject(forbidden())
              : Promise.resolve(page()),
          ),
      });
      const err = await resolveRepo(client, WS, {
        owner: 'bob',
        repo: 'x',
        fullName: 'bob/x',
      }).catch((e) => e);
      expect(err.code).toBe('github_repo_not_accessible');
      expect(err.message).toContain(
        'teammate → https://github.com/settings/installations/teammate',
      );
      expect(err.message).toContain('No installation is on "bob"');
    });

    it.each(['github_rate_limited', 'github_unavailable'])(
      'stops the search on %s',
      async (code) => {
        const client = mockClient({
          listGithubInstallations: teammateThenAlice(),
          listGithubRepositories: vi
            .fn()
            .mockRejectedValue(new PartiriApiError('x', 429, code)),
        });
        const err = await resolveRepo(client, WS, {
          owner: 'alice',
          repo: 'x',
          fullName: 'alice/x',
        }).catch((e) => e);
        expect(err).toBeInstanceOf(PartiriApiError);
        expect(err.code).toBe(code);
        expect(client.listGithubRepositories).toHaveBeenCalledTimes(1);
      },
    );

    it('stops the search on a 5xx', async () => {
      const client = mockClient({
        listGithubInstallations: teammateThenAlice(),
        listGithubRepositories: vi
          .fn()
          .mockRejectedValue(new PartiriApiError('boom', 500)),
      });
      const err = await resolveRepo(client, WS, ref).catch((e) => e);
      expect(err.status).toBe(500);
    });
  });
});

describe('checkBranch', () => {
  it('passes for an existing branch', async () => {
    const client = mockClient();
    await expect(checkBranch(client, 'l', 1, 'dev')).resolves.toHaveLength(2);
  });

  it('lists the branches, default first, when it is missing', async () => {
    const err = await checkBranch(mockClient(), 'l', 1, 'nope').catch((e) => e);
    expect(err.code).toBe('github_branch_not_found');
    expect(err.message).toContain('Branches (default first): main, dev');
  });
});

describe('GitHub read tools', () => {
  it('registers read-only annotations and never offers dockerfile', () => {
    for (const d of definitions) {
      expect(d.annotations.readOnlyHint).toBe(true);
      expect(d.annotations.destructiveHint).toBe(false);
    }
    const detect = definitions.find((d) => d.name === 'detect_service_config')!;
    expect(detect.description).toContain('Dockerfile builds cannot be created');
  });

  it('github_status lists installations and the connect link when the authorization expired', async () => {
    const client = mockClient({
      getGithubConfig: vi.fn().mockResolvedValue({
        enabled: true,
        previews_enabled: false,
        dockerfile_builds_enabled: false,
      }),
      getGithubIdentity: vi
        .fn()
        .mockResolvedValue({ connected: true, reauth_required: true }),
    });
    const out = await handlers.get('github_status')!(client, {
      workspaceId: WS,
    });
    const data = JSON.parse(text(out));
    expect(data.identity.reauth_required).toBe(true);
    expect(data.installations).toHaveLength(1);
    expect(data.installations[0].account).toBe('acme');
    expect(data.connect_at).toBe(dashboardUrl(WS));
    expect(data.note).toContain('Connect your GitHub account first');
  });

  it('github_status lists installations when connected', async () => {
    const client = mockClient({
      getGithubConfig: vi.fn().mockResolvedValue({
        enabled: true,
        previews_enabled: true,
        dockerfile_builds_enabled: false,
      }),
    });
    const out = await handlers.get('github_status')!(client, {
      workspaceId: WS,
    });
    const data = JSON.parse(text(out));
    expect(data.installations[0]).toMatchObject({
      account: 'acme',
      suspended: false,
    });
    expect(data.connect_at).toBeUndefined();
  });

  it('github_status lists installations when the identity is not connected', async () => {
    const client = mockClient({
      getGithubConfig: vi.fn().mockResolvedValue({
        enabled: true,
        previews_enabled: false,
        dockerfile_builds_enabled: false,
      }),
      getGithubIdentity: vi.fn().mockResolvedValue({ connected: false }),
    });
    const data = JSON.parse(
      text(await handlers.get('github_status')!(client, { workspaceId: WS })),
    );
    expect(data.installations).toHaveLength(1);
    expect(data.connect_at).toBe(dashboardUrl(WS));
  });

  it('github_status treats a config error as not available', async () => {
    const client = mockClient({
      getGithubConfig: vi.fn().mockRejectedValue(new Error('404')),
    });
    const out = await handlers.get('github_status')!(client, {
      workspaceId: WS,
    });
    const data = JSON.parse(text(out));
    expect(data.config.enabled).toBe(false);
    expect(client.getGithubIdentity).not.toHaveBeenCalled();
  });

  it('list_github_repos aggregates installations and filters by account', async () => {
    const client = mockClient({
      listGithubInstallations: vi
        .fn()
        .mockResolvedValue([inst('acme'), inst('other')]),
      listGithubRepositories: vi
        .fn()
        .mockImplementation((link: string) =>
          Promise.resolve(page(repo(`${link.slice(5)}/r`))),
        ),
    });
    const all = JSON.parse(
      text(
        await handlers.get('list_github_repos')!(client, { workspaceId: WS }),
      ),
    );
    expect(
      all.repositories.map((r: { full_name: string }) => r.full_name),
    ).toEqual(['acme/r', 'other/r']);
    const one = JSON.parse(
      text(
        await handlers.get('list_github_repos')!(client, {
          workspaceId: WS,
          account: 'OTHER',
          search: 'r',
        }),
      ),
    );
    expect(one.count).toBe(1);
    expect(client.listGithubRepositories).toHaveBeenLastCalledWith(
      'link-other',
      {
        q: 'r',
        page: undefined,
        perPage: 100,
      },
    );
  });

  it('list_github_repos skips an inaccessible installation and reports it', async () => {
    const client = mockClient({
      listGithubInstallations: vi
        .fn()
        .mockResolvedValue([inst('teammate'), inst('alice')]),
      listGithubRepositories: vi
        .fn()
        .mockImplementation((link: string) =>
          link === 'link-teammate'
            ? Promise.reject(
                new PartiriApiError('x', 403, 'github_installation_forbidden'),
              )
            : Promise.resolve(page(repo('alice/r'))),
        ),
    });
    const out = await handlers.get('list_github_repos')!(client, {
      workspaceId: WS,
    });
    expect(out.isError).toBeUndefined();
    const data = JSON.parse(text(out));
    expect(data.repositories).toHaveLength(1);
    expect(data.repositories[0].full_name).toBe('alice/r');
    expect(data.skipped).toEqual([
      { account: 'teammate', reason: 'github_installation_forbidden' },
    ]);
  });

  it('list_github_repos still fails for an explicitly requested forbidden account', async () => {
    const client = mockClient({
      listGithubInstallations: vi.fn().mockResolvedValue([inst('teammate')]),
      listGithubRepositories: vi
        .fn()
        .mockRejectedValue(
          new PartiriApiError('x', 403, 'github_installation_forbidden'),
        ),
    });
    const out = await handlers.get('list_github_repos')!(client, {
      workspaceId: WS,
      account: 'teammate',
    });
    expect(out.isError).toBe(true);
  });

  it('list_github_repos reports total and has_more per installation', async () => {
    const items = Array.from({ length: 100 }, (_, i) => repo(`acme/r${i}`));
    const client = mockClient({
      listGithubRepositories: vi.fn().mockResolvedValue({
        items,
        total: 250,
        page: 1,
        per_page: 100,
        truncated: false,
      }),
    });
    const data = JSON.parse(
      text(
        await handlers.get('list_github_repos')!(client, { workspaceId: WS }),
      ),
    );
    expect(data.installations).toEqual([
      {
        account: 'acme',
        total: 250,
        page: 1,
        per_page: 100,
        has_more: true,
        truncated: false,
      },
    ]);
    const last = JSON.parse(
      text(
        await handlers.get('list_github_repos')!(
          mockClient({
            listGithubRepositories: vi.fn().mockResolvedValue({
              items,
              total: 200,
              page: 2,
              per_page: 100,
              truncated: true,
            }),
          }),
          { workspaceId: WS, page: 2 },
        ),
      ),
    );
    expect(last.installations[0].has_more).toBe(false);
    expect(last.installations[0].truncated).toBe(true);
  });

  it('list_github_branches resolves the repo first', async () => {
    const client = mockClient({
      listGithubRepositories: vi
        .fn()
        .mockResolvedValue(page(repo('acme/widget'))),
    });
    const out = await handlers.get('list_github_branches')!(client, {
      workspaceId: WS,
      repo: 'acme/widget',
    });
    const data = JSON.parse(text(out));
    expect(data.branches[0]).toMatchObject({ name: 'main', default: true });
    expect(client.listGithubBranches).toHaveBeenCalledWith(42, 'link-acme');
  });

  it('detect_service_config drops dockerfile candidates and notes the block', async () => {
    const candidate = (runtime: string) => ({
      root_path: '.',
      runtime,
      build_command: 'b',
      run_command: 'r',
      build_path: null,
      port_hint: 3000,
      confidence: 'high',
      source: 's',
      evidence: ['package.json'],
    });
    const client = mockClient({
      listGithubRepositories: vi
        .fn()
        .mockResolvedValue(page(repo('acme/widget'))),
      detectGithubRepository: vi.fn().mockResolvedValue({
        sha: 'abc',
        root_path: '.',
        truncated: false,
        candidates: [candidate('node'), candidate('dockerfile')],
        dockerfile: { path: 'Dockerfile' },
      }),
    });
    const out = await handlers.get('detect_service_config')!(client, {
      workspaceId: WS,
      repo: 'acme/widget',
    });
    const data = JSON.parse(text(out));
    expect(data.candidates).toHaveLength(1);
    expect(data.candidates[0].runtime).toBe('node');
    expect(data.dockerfile_note).toContain('cannot be created through the MCP');
    expect(JSON.stringify(data)).not.toContain('"dockerfile"');
    expect(client.detectGithubRepository).toHaveBeenCalledWith(
      42,
      'link-acme',
      {
        ref: 'main',
        rootPath: undefined,
      },
    );
  });

  it('get_service_previews summarises settings, usage and previews', async () => {
    const client = mockClient({
      getServicePreviews: vi.fn().mockResolvedValue({
        settings: {
          enabled: true,
          fork_policy: 'off',
          share_secrets: false,
          fk_pod: null,
        },
        available: true,
        unavailable_reason: null,
        limit: null,
        used: 1,
        data: [
          {
            id: 'p1',
            name: 'pr-7',
            pr_number: 7,
            pr_url: 'https://github.com/acme/widget/pull/7',
            is_fork: false,
            url: 'https://pr-7.example.com',
            last_job: {
              id: 'j',
              type: 'deploy',
              status: 'succeeded',
              deploy_ref: 'x',
              created_at: null,
            },
            created_at: null,
          },
        ],
      }),
    });
    const out = await handlers.get('get_service_previews')!(client, {
      serviceId: 'svc',
    });
    const data = JSON.parse(text(out));
    expect(data.limit).toBeNull();
    expect(data.previews[0]).toMatchObject({
      id: 'p1',
      pr_number: 7,
      last_job: { status: 'succeeded' },
    });
  });

  it('turns resolver failures into tool errors', async () => {
    const client = mockClient({
      getGithubIdentity: vi.fn().mockResolvedValue({ connected: false }),
    });
    const out = await handlers.get('list_github_repos')!(client, {
      workspaceId: WS,
    });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('Connect your GitHub account first');
  });
});
