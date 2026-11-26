import { z } from 'zod';
import type {
  GithubBranch,
  GithubInstallation,
  GithubRepo,
  PartiriApiClient,
} from '../client.js';
import {
  PartiriApiError,
  githubCodeHint,
  toolError,
  toolResult,
  webBaseUrl,
} from '../errors.js';
import type { ToolDefinition, ToolHandler } from './index.js';
import { READ_ONLY } from './annotations.js';

/** A repository named by its owner and name. */
export interface RepoRef {
  /** Owner login as written by the caller. */
  owner: string;
  /** Repository name as written by the caller. */
  repo: string;
  /** `owner/repo` as written by the caller. */
  fullName: string;
}

const NAME = '[A-Za-z0-9_.-]+';
const REPO_FORMS = [
  new RegExp(
    `^https://(?:[^@/\\s]+@)?github\\.com/(${NAME})/(${NAME}?)(?:\\.git)?/?$`,
    'i',
  ),
  new RegExp(`^git@github\\.com:(${NAME})/(${NAME}?)(?:\\.git)?/?$`, 'i'),
  new RegExp(`^ssh://git@github\\.com/(${NAME})/(${NAME}?)(?:\\.git)?/?$`, 'i'),
];
const SLUG = new RegExp(`^(${NAME})/(${NAME}?)(?:\\.git)?$`);

function toRef(owner: string, repo: string): RepoRef | null {
  if (/^\.+$/.test(owner) || /^\.+$/.test(repo)) return null;
  return { owner, repo, fullName: `${owner}/${repo}` };
}

/**
 * Parse a GitHub repository URL (https, optionally with userinfo, scp-style
 * `git@github.com:o/r`, or `ssh://git@github.com/o/r`).
 *
 * @returns The owner and repo, or `null` for any other host or extra path.
 */
export function parseGithubRepo(url: string): RepoRef | null {
  const input = url.trim();
  for (const form of REPO_FORMS) {
    const m = form.exec(input);
    if (m) return toRef(m[1], m[2]);
  }
  return null;
}

/** Parse a tool's `repo` input: either `owner/repo` or a GitHub URL. */
export function parseRepoInput(input: string): RepoRef | null {
  const slug = SLUG.exec(input.trim());
  if (slug) return toRef(slug[1], slug[2]);
  return parseGithubRepo(input);
}

/** Dashboard link where GitHub is connected and the App installed. */
export function dashboardUrl(workspaceId: string): string {
  return `${webBaseUrl()}/workspace-settings/${workspaceId}`;
}

/** A failure of the resolver, with the API-style code it corresponds to. */
export class GithubResolveError extends Error {
  /** Code from the shared error table, when one applies. */
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'GithubResolveError';
    this.code = code;
  }
}

/** Outcome of resolving `owner/repo` inside a workspace. */
export interface ResolvedRepo {
  /** Installation link the repository is reachable through. */
  linkId: string;
  /** The installation. */
  installation: GithubInstallation;
  /** The repository, with its canonical name and id. */
  repo: GithubRepo;
}

function fail(code: string, workspaceId?: string): GithubResolveError {
  return new GithubResolveError(
    githubCodeHint(code, workspaceId) ?? code,
    code,
  );
}

async function requireEnabled(
  client: PartiriApiClient,
  workspaceId: string,
): Promise<void> {
  let config: { enabled: boolean };
  try {
    config = await client.getGithubConfig(workspaceId);
  } catch (e) {
    // A plain 404 is an API without the GitHub routes: not available. Any
    // other failure (5xx, network) surfaces as itself, so a transient outage
    // is never reported as "the GitHub App is disabled".
    if (e instanceof PartiriApiError && e.status === 404) {
      throw fail('github_app_disabled');
    }
    throw e;
  }
  if (!config.enabled) throw fail('github_app_disabled');
}

async function requireIdentity(
  client: PartiriApiClient,
  workspaceId: string,
): Promise<void> {
  let me;
  try {
    me = await client.getGithubIdentity();
  } catch (e) {
    if (e instanceof PartiriApiError && e.code === 'github_app_disabled') {
      throw fail('github_app_disabled');
    }
    throw e;
  }
  if (!me.connected || me.reauth_required === true) {
    throw fail('github_identity_required', workspaceId);
  }
}

/** Codes that mean "the repository is not reachable through this installation". */
const SEARCH_PER_PAGE = 100;
// The API caps a user's repository list at 2000 (REPO_LIST_CAP), i.e. 20
// pages of 100: never page beyond it.
const MAX_SEARCH_PAGES = 20;

const SKIPPABLE_CODES = new Set([
  'github_installation_forbidden',
  'installation_suspended',
  'installation_link_inactive',
]);

function skipCode(e: unknown): string | undefined {
  return e instanceof PartiriApiError && e.code && SKIPPABLE_CODES.has(e.code)
    ? e.code
    : undefined;
}

async function findInInstallation(
  client: PartiriApiClient,
  inst: GithubInstallation,
  fullName: string,
  refresh: boolean,
  skipped: Map<string, string>,
): Promise<GithubRepo | null> {
  const wanted = fullName.toLowerCase();
  try {
    // `q` is a substring match, so the exact repo can sit past page 1 when
    // many names contain it: keep paging while the API reports more.
    for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
      const res = await client.listGithubRepositories(inst.link_id, {
        q: fullName,
        page,
        perPage: SEARCH_PER_PAGE,
        // Bypassing the cache once (page 1) refreshes the whole list.
        refresh: refresh && page === 1,
      });
      const hit = res.items.find((r) => r.full_name.toLowerCase() === wanted);
      if (hit) return hit;
      if (res.items.length === 0 || page * res.per_page >= res.total) break;
    }
    return null;
  } catch (e) {
    const code = skipCode(e);
    if (!code) throw e;
    skipped.set(inst.link_id, code);
    return null;
  }
}

function orderInstallations(
  installations: GithubInstallation[],
  owner: string,
): GithubInstallation[] {
  const o = owner.toLowerCase();
  return [...installations].sort(
    (a, b) =>
      Number(b.account_login.toLowerCase() === o) -
      Number(a.account_login.toLowerCase() === o),
  );
}

async function search(
  client: PartiriApiClient,
  installations: GithubInstallation[],
  fullName: string,
  refresh: boolean,
  skipped: Map<string, string>,
): Promise<{ inst: GithubInstallation; repo: GithubRepo } | null> {
  for (const inst of installations) {
    const repo = await findInInstallation(
      client,
      inst,
      fullName,
      refresh,
      skipped,
    );
    if (repo) return { inst, repo };
  }
  return null;
}

function notAccessible(
  ref: RepoRef,
  installations: GithubInstallation[],
  workspaceId: string,
): GithubResolveError {
  const lines = installations.map(
    (i) => `  - ${i.account_login} → ${i.settings_url}`,
  );
  const hasOwner = installations.some(
    (i) => i.account_login.toLowerCase() === ref.owner.toLowerCase(),
  );
  const hint = hasOwner
    ? ''
    : ` No installation is on "${ref.owner}": install the App there from ${dashboardUrl(workspaceId)} (GitHub card).`;
  return new GithubResolveError(
    `${githubCodeHint('github_repo_not_accessible')}\nRepository: ${ref.fullName}\nLinked installations (repository access settings):\n${lines.join('\n')}${hint}`,
    'github_repo_not_accessible',
  );
}

/**
 * Resolve `owner/repo` to an installation link and repository in a workspace.
 *
 * @throws GithubResolveError with a code from the shared error table.
 */
export async function resolveRepo(
  client: PartiriApiClient,
  workspaceId: string,
  ref: RepoRef,
): Promise<ResolvedRepo> {
  await requireEnabled(client, workspaceId);
  await requireIdentity(client, workspaceId);
  const installations = await client.listGithubInstallations(workspaceId);
  if (installations.length === 0) {
    throw new GithubResolveError(
      `No GitHub account is linked to this workspace. Link one at ${dashboardUrl(workspaceId)} (GitHub card).`,
      'no_installation',
    );
  }
  const ordered = orderInstallations(installations, ref.owner);
  const skipped = new Map<string, string>();
  // A second pass bypasses the 5-minute repository cache, which covers access
  // the user granted moments ago.
  const found =
    (await search(client, ordered, ref.fullName, false, skipped)) ??
    (await search(client, ordered, ref.fullName, true, skipped));
  if (!found) {
    const ownerSuspended = ordered.some(
      (i) =>
        i.account_login.toLowerCase() === ref.owner.toLowerCase() &&
        (i.suspended || skipped.get(i.link_id) === 'installation_suspended'),
    );
    if (ownerSuspended) throw fail('installation_suspended');
    throw notAccessible(ref, installations, workspaceId);
  }
  if (found.inst.suspended) throw fail('installation_suspended');
  if (found.repo.archived) {
    throw new GithubResolveError(
      `${found.repo.full_name} is archived on GitHub, and archived repositories can't be deployed.`,
      'repo_archived',
    );
  }
  return {
    linkId: found.inst.link_id,
    installation: found.inst,
    repo: found.repo,
  };
}

const MAX_BRANCHES_IN_ERROR = 50;

/**
 * Check that a branch exists in a repository.
 *
 * @throws GithubResolveError `github_branch_not_found`, listing the branches
 * with the default first.
 */
export async function checkBranch(
  client: PartiriApiClient,
  linkId: string,
  repoId: number,
  branch: string,
): Promise<GithubBranch[]> {
  const branches = await client.listGithubBranches(repoId, linkId);
  if (branches.some((b) => b.name === branch)) return branches;
  const names = branches.slice(0, MAX_BRANCHES_IN_ERROR).map((b) => b.name);
  const more =
    branches.length > names.length
      ? ` (+${branches.length - names.length} more)`
      : '';
  throw new GithubResolveError(
    `${githubCodeHint('github_branch_not_found')} Branch "${branch}" not found. Branches (default first): ${names.join(', ')}${more}.`,
    'github_branch_not_found',
  );
}

/** Resolve a repo input and verify its branch, as `create_service` does. */
export async function resolveRepoAndBranch(
  client: PartiriApiClient,
  workspaceId: string,
  repoInput: string,
  branch: string,
): Promise<ResolvedRepo> {
  const ref = parseRepoInput(repoInput);
  if (!ref) {
    throw new GithubResolveError(
      `"${repoInput}" is not a GitHub repository. Use the form owner/repo.`,
      'invalid_repo',
    );
  }
  const resolved = await resolveRepo(client, workspaceId, ref);
  await checkBranch(client, resolved.linkId, resolved.repo.id, branch);
  return resolved;
}

function resolveFailure(e: unknown): ReturnType<typeof toolError> {
  return toolError((e as Error).message);
}

function compactRepo(inst: GithubInstallation, r: GithubRepo) {
  return {
    account: inst.account_login,
    full_name: r.full_name,
    private: r.private,
    archived: r.archived,
    default_branch: r.default_branch,
    pushed_at: r.pushed_at,
  };
}

/** Tool definitions: read-only GitHub App discovery and detection. */
export const definitions: ToolDefinition[] = [
  {
    name: 'github_status',
    title: 'GitHub App Status',
    description:
      "Whether the GitHub App is available in a workspace, whether the API key owner's GitHub account is connected (or the authorization expired and needs reconnecting), and the GitHub accounts the App is installed on. Connecting GitHub and installing the App happen in the dashboard (or `partiri github setup`), never through the MCP.",
    inputSchema: z.object({
      workspaceId: z.string().uuid().describe('The workspace UUID'),
    }),
    annotations: READ_ONLY,
  },
  {
    name: 'list_github_repos',
    title: 'List GitHub Repositories',
    description:
      'List repositories the Partiri GitHub App can reach in a workspace, across its linked installations or for one account. Use the returned full_name as `github.repo` in create_service.',
    inputSchema: z.object({
      workspaceId: z.string().uuid().describe('The workspace UUID'),
      search: z
        .string()
        .max(100)
        .optional()
        .describe('Case-insensitive substring of owner/repo'),
      account: z
        .string()
        .max(100)
        .optional()
        .describe('Only this GitHub account (installation), e.g. an org login'),
      page: z.number().int().min(1).optional().describe('Page (default 1)'),
    }),
    annotations: READ_ONLY,
  },
  {
    name: 'list_github_branches',
    title: 'List GitHub Branches',
    description:
      'List the branches of a repository reachable through the GitHub App, default branch first.',
    inputSchema: z.object({
      workspaceId: z.string().uuid().describe('The workspace UUID'),
      repo: z.string().max(200).describe('Repository as owner/repo'),
    }),
    annotations: READ_ONLY,
  },
  {
    name: 'detect_service_config',
    title: 'Detect Service Configuration',
    description:
      'Inspect a GitHub repository and suggest runtime, build command, run command and port, as ranked candidates. Dockerfile builds cannot be created through the MCP, so a `dockerfile` block is informational only and must not be turned into a service here.',
    inputSchema: z.object({
      workspaceId: z.string().uuid().describe('The workspace UUID'),
      repo: z.string().max(200).describe('Repository as owner/repo'),
      branch: z
        .string()
        .max(255)
        .optional()
        .describe("Branch to inspect (default: the repository's default)"),
      rootPath: z
        .string()
        .max(512)
        .optional()
        .describe('Sub-directory to inspect, for monorepos'),
    }),
    annotations: READ_ONLY,
  },
  {
    name: 'get_service_previews',
    title: 'Get Service Previews',
    description:
      'Pull-request preview settings of a service, whether previews are available (and why not), live previews used against the workspace limit, and each preview (PR number, URL, last job status). Enabling or disabling previews is CLI-only (`partiri service previews enable|disable`).',
    inputSchema: z.object({
      serviceId: z.string().uuid().describe('The service UUID'),
    }),
    annotations: READ_ONLY,
  },
];

async function githubStatus(
  client: PartiriApiClient,
  workspaceId: string,
): Promise<unknown> {
  const config = await client
    .getGithubConfig(workspaceId)
    .catch(() => ({ enabled: false }));
  const base = { workspace_id: workspaceId, config };
  if (!config.enabled) {
    return { ...base, note: githubCodeHint('github_app_disabled') };
  }
  const me = await client.getGithubIdentity();
  const connected = me.connected && me.reauth_required !== true;
  const installations = (await client.listGithubInstallations(workspaceId)).map(
    (i) => ({
      account: i.account_login,
      account_type: i.account_type,
      repository_selection: i.repository_selection,
      suspended: i.suspended,
      settings_url: i.settings_url,
    }),
  );
  return {
    ...base,
    identity: {
      connected: me.connected,
      github_login: me.github_login,
      reauth_required: me.reauth_required === true,
    },
    installations,
    ...(connected
      ? {}
      : {
          connect_at: dashboardUrl(workspaceId),
          note: githubCodeHint('github_identity_required', workspaceId),
        }),
  };
}

async function listRepos(
  client: PartiriApiClient,
  args: Record<string, unknown>,
): Promise<unknown> {
  const workspaceId = args.workspaceId as string;
  await requireEnabled(client, workspaceId);
  await requireIdentity(client, workspaceId);
  const account = (args.account as string | undefined)?.toLowerCase();
  const all = await client.listGithubInstallations(workspaceId);
  const installations = account
    ? all.filter((i) => i.account_login.toLowerCase() === account)
    : all;
  if (installations.length === 0) {
    throw new GithubResolveError(
      account
        ? `No installation for account "${args.account as string}" in this workspace.`
        : `No GitHub account is linked to this workspace. Link one at ${dashboardUrl(workspaceId)} (GitHub card).`,
      'no_installation',
    );
  }
  const repos: ReturnType<typeof compactRepo>[] = [];
  const summaries: object[] = [];
  const skipped: { account: string; reason: string }[] = [];
  let truncated = false;
  for (const inst of installations) {
    try {
      const page = await client.listGithubRepositories(inst.link_id, {
        q: args.search as string | undefined,
        page: args.page as number | undefined,
        perPage: 100,
      });
      truncated ||= page.truncated;
      repos.push(...page.items.map((r) => compactRepo(inst, r)));
      summaries.push({
        account: inst.account_login,
        total: page.total,
        page: page.page,
        per_page: page.per_page,
        has_more: page.page * page.per_page < page.total,
        truncated: page.truncated,
      });
    } catch (e) {
      const code = skipCode(e);
      if (!code || account) throw e;
      skipped.push({ account: inst.account_login, reason: code });
    }
  }
  return {
    count: repos.length,
    truncated,
    installations: summaries,
    ...(skipped.length ? { skipped } : {}),
    repositories: repos,
  };
}

async function listBranches(
  client: PartiriApiClient,
  args: Record<string, unknown>,
): Promise<unknown> {
  const workspaceId = args.workspaceId as string;
  const ref = parseRepoInput(args.repo as string);
  if (!ref) throw new GithubResolveError('repo must be owner/repo.');
  const resolved = await resolveRepo(client, workspaceId, ref);
  const branches = await client.listGithubBranches(
    resolved.repo.id,
    resolved.linkId,
  );
  return {
    repo: resolved.repo.full_name,
    branches: branches.map((b) => ({
      name: b.name,
      default: b.default,
      protected: b.protected,
    })),
  };
}

async function detect(
  client: PartiriApiClient,
  args: Record<string, unknown>,
): Promise<unknown> {
  const ref = parseRepoInput(args.repo as string);
  if (!ref) throw new GithubResolveError('repo must be owner/repo.');
  const resolved = await resolveRepo(client, args.workspaceId as string, ref);
  const branch =
    (args.branch as string | undefined) ?? resolved.repo.default_branch;
  const result = await client.detectGithubRepository(
    resolved.repo.id,
    resolved.linkId,
    { ref: branch, rootPath: args.rootPath as string | undefined },
  );
  return {
    repo: resolved.repo.full_name,
    branch,
    sha: result.sha,
    root_path: result.root_path,
    truncated: result.truncated,
    candidates: result.candidates
      .filter((c) => c.runtime !== 'dockerfile')
      .map((c) => ({
        root_path: c.root_path,
        runtime: c.runtime,
        build_command: c.build_command,
        run_command: c.run_command,
        build_path: c.build_path,
        port_hint: c.port_hint,
        confidence: c.confidence,
        evidence: c.evidence,
      })),
    ...(result.dockerfile
      ? {
          dockerfile_note:
            'A Dockerfile was found, but Dockerfile builds cannot be created through the MCP. Use one of the candidates above.',
        }
      : {}),
  };
}

async function previews(
  client: PartiriApiClient,
  serviceId: string,
): Promise<unknown> {
  const p = await client.getServicePreviews(serviceId);
  return {
    service_id: serviceId,
    settings: p.settings,
    available: p.available,
    unavailable_reason: p.unavailable_reason,
    limit: p.limit,
    used: p.used,
    previews: p.data.map((d) => ({
      id: d.id,
      name: d.name,
      pr_number: d.pr_number,
      pr_url: d.pr_url,
      url: d.url,
      is_fork: d.is_fork,
      last_job: d.last_job
        ? { type: d.last_job.type, status: d.last_job.status }
        : null,
      created_at: d.created_at,
    })),
  };
}

function wrap(
  run: (
    client: PartiriApiClient,
    args: Record<string, unknown>,
  ) => Promise<unknown>,
): ToolHandler {
  return async (client, args) => {
    try {
      return toolResult(await run(client, args));
    } catch (e) {
      return resolveFailure(e);
    }
  };
}

/** Handler implementations for the tools declared in `definitions`. */
export const handlers: Map<string, ToolHandler> = new Map([
  [
    'github_status',
    wrap((client, args) => githubStatus(client, args.workspaceId as string)),
  ],
  ['list_github_repos', wrap(listRepos)],
  ['list_github_branches', wrap(listBranches)],
  ['detect_service_config', wrap(detect)],
  [
    'get_service_previews',
    wrap((client, args) => previews(client, args.serviceId as string)),
  ],
]);
