import { z } from 'zod';
import type { PartiriApiClient } from '../client.js';
import { toolResult } from '../errors.js';
import type { ToolDefinition, ToolHandler } from './index.js';
import { isPublicHttpUrl, isPrivateOrSpecialHost } from '../net-guard.js';

/** Allowed `deploy_type` values for a service. */
const deployTypeEnum = z.enum([
  'webservice',
  'static',
  'private-service',
  'worker',
]);

/** Allowed `runtime` values for a service. */
const runtimeEnum = z.enum([
  'node',
  'deno',
  'rust',
  'python',
  'go',
  'ruby',
  'elixir',
  'php',
  'jvm',
  'dotnet',
  'cpp',
  'static',
  'registry',
]);

/** Result of a single preflight validation check performed by `validateConfig`. */
interface ValidationCheck {
  /** Identifier of the field or aspect being checked (e.g. `'name'`). */
  field: string;
  /** Whether the check passed. */
  ok: boolean;
  /** Human-readable explanation of the check result. */
  message: string;
}

/**
 * Reported instead of running a reachability probe when `workspaceId` is
 * absent: `GET /resources/utils/git` and `/resources/utils/reg` both require a
 * `workspace` query param and answer 403 without one.
 */
const MISSING_WORKSPACE_MESSAGE =
  'workspaceId is required to probe reachability (the API authorizes the probe against that workspace)';

/**
 * Tool definitions declared by this module: `validate_service`, a preflight
 * checker for service configuration (source XOR rule, deploy_type/runtime
 * compatibility, name length) with optional reachability probing and cost
 * estimation.
 *
 * @remarks
 * `validate_service` is NOT read-only: when `probeReachability` is set, the
 * handler makes the API fetch a caller-supplied URL (an outbound,
 * SSRF-shaped call). `openWorldHint` marks the external interaction, and
 * `readOnlyHint: false` makes clients prompt rather than auto-approve and
 * keeps the tool off the MCP_READONLY surface.
 */
export const definitions: ToolDefinition[] = [
  {
    name: 'validate_service',
    title: 'Validate Service Configuration',
    description:
      'Preflight-validate a service configuration before creating or updating it. ' +
      'Checks source XOR rule (repository vs registry), deploy_type/runtime compatibility, ' +
      'and name length (≤16). When probeReachability is set, performs an OUTBOUND network ' +
      'probe of the supplied git repository or registry URL (not side-effect-free). ' +
      'Returns a list of checks with ok/fail status.',
    inputSchema: z.object({
      name: z.string().describe('Service name to validate'),
      deployType: deployTypeEnum.describe('Deployment type'),
      runtime: runtimeEnum.describe('Application runtime'),
      rootPath: z.string().describe('Application root path'),
      fkRegion: z.string().uuid().describe('Region UUID'),
      fkPod: z.string().uuid().describe('Compute pod UUID'),
      workspaceId: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Workspace UUID — used to check balance (billing:r permission required) and required when probeReachability is set (the probes are authorized against it)',
        ),
      repositoryUrl: z
        .string()
        .max(2048)
        .optional()
        .describe('Git repository URL (mutually exclusive with registryUrl)'),
      repositoryBranch: z.string().optional().describe('Git branch'),
      registryUrl: z
        .string()
        .max(2048)
        .optional()
        .describe(
          'Container image reference (mutually exclusive with repositoryUrl)',
        ),
      fkServiceSecret: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Service secret UUID for authenticated repository/registry access',
        ),
      buildCommand: z.string().optional().describe('Build command'),
      runCommand: z.string().optional().describe('Run command'),
      diskSizeGb: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Disk size in GB for cost estimate (1–10)'),
      probeReachability: z
        .boolean()
        .optional()
        .describe(
          'When true, probe the git repository or registry for reachability (probed whenever repositoryUrl or registryUrl is present; requires workspaceId)',
        ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false, // validation never mutates platform state
      idempotentHint: true,
      openWorldHint: true,
    },
  },
];

/**
 * Run the synchronous, local preflight checks for a service configuration:
 * required fields, name length, source XOR rule (repository vs registry),
 * deploy_type/runtime compatibility, and build/run command requirements.
 *
 * @param args - Raw tool input arguments (unvalidated beyond the Zod schema).
 * @returns The list of validation checks with their pass/fail status.
 * @remarks
 * `build_command` / `run_command` checks here are MCP-side guidance and are
 * STRICTER than the API — the backend does not require them for
 * webservice/static/private-service (cronjobs and workers require
 * `run_command || registry_url`). They are surfaced because a repo-sourced
 * service that omits them generally won't build or start; treat a failure
 * here as advisory, not an API rejection.
 */
function validateConfig(args: Record<string, unknown>): ValidationCheck[] {
  const checks: ValidationCheck[] = [];

  /** Push a single validation result onto `checks`. */
  const check = (field: string, ok: boolean, message: string) => {
    checks.push({ field, ok, message });
  };

  const name = (args.name as string) ?? '';
  const deployType = (args.deployType as string) ?? '';
  const rootPath = (args.rootPath as string) ?? '';
  const repositoryUrl = args.repositoryUrl as string | undefined;
  const registryUrl = args.registryUrl as string | undefined;
  const buildCommand = args.buildCommand as string | undefined;
  const runCommand = args.runCommand as string | undefined;

  check('name', name.length > 0, 'Service name is required');
  check(
    'name_length',
    name.length <= 16,
    'Service name must be 16 characters or fewer',
  );
  check('fk_region', !!(args.fkRegion as string), 'Region is required');
  check('fk_pod', !!(args.fkPod as string), 'Compute pod is required');
  check('root_path', rootPath.length > 0, 'root_path is required');

  const hasRepo = !!repositoryUrl?.trim();
  const hasReg = !!registryUrl?.trim();
  check(
    'source',
    hasRepo !== hasReg,
    hasRepo && hasReg
      ? 'Cannot have both repository_url and registry_url'
      : 'Either repository_url or registry_url is required',
  );

  if (deployType === 'static' && hasReg) {
    check(
      'deploy_type/static',
      false,
      "deploy_type 'static' only supports repository source (not registry)",
    );
  }

  if (hasRepo) {
    check(
      'build_command',
      !!buildCommand?.trim(),
      'build_command is required for repository-sourced services',
    );

    if (
      deployType === 'webservice' ||
      deployType === 'private-service' ||
      deployType === 'worker'
    ) {
      check(
        'run_command',
        !!runCommand?.trim(),
        'run_command is required for webservice, private-service, and worker deploy types',
      );
    }
  }

  return checks;
}

/**
 * Defense-in-depth SSRF guard for the registry probe: the registry portion of
 * an image reference (the first path segment, when it looks like a host)
 * must be a public address. Docker Hub short forms (no explicit registry
 * host) are allowed.
 *
 * @param ref - The container image reference to check (e.g.
 *   `registry.example.com/org/image:tag` or a Docker Hub short form).
 * @returns `true` when the registry host is public (or absent), `false`
 *   when it resolves to a private/special/loopback host.
 * @remarks
 * This is defense-in-depth only — the authoritative resolve-and-block guard
 * lives in the upstream probe endpoint.
 */
function registryHostIsPublic(ref: string): boolean {
  const cleaned = ref
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^hub\.docker\.com\/r\//, '');
  const first = cleaned.split('/')[0];
  const looksLikeHost =
    first.includes('.') || first.includes(':') || first === 'localhost';
  if (!looksLikeHost) {
    // No registry host (Docker Hub short form) — allowed, UNLESS it's a bare
    // encoded-IP token (e.g. 0x7f000001, 2130706433), never a Hub namespace.
    return !/^(0x[0-9a-f]+|\d+)$/i.test(first);
  }
  // Strip a trailing :port for hostname/IPv4; keep a bare IPv6 literal (>1 colon).
  const host =
    (first.match(/:/g) || []).length === 1 ? first.split(':')[0] : first;
  return !isPrivateOrSpecialHost(host);
}

/** Handler implementations for the tools declared in `definitions`. */
export const handlers: Map<string, ToolHandler> = new Map([
  /**
   * Run local config checks, optionally probe repository/registry
   * reachability, and estimate monthly cost (with an informational
   * workspace-balance warning).
   *
   * @remarks
   * Reachability probing only runs when `probeReachability` is set, and
   * each URL is first checked against the SSRF guards
   * (`isPublicHttpUrl` / `registryHostIsPublic`) before the outbound probe
   * call is made. Pricing and balance lookups are best-effort and never
   * block or fail the overall result.
   */
  [
    'validate_service',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      const checks = validateConfig(args);
      const reachabilityChecks: ValidationCheck[] = [];

      // Read once: the probes are authorized against this workspace, and the
      // balance check below reports on it.
      const workspaceId = args.workspaceId as string | undefined;

      if (args.probeReachability) {
        const repositoryUrl = args.repositoryUrl as string | undefined;
        const registryUrl = args.registryUrl as string | undefined;
        const secretId = args.fkServiceSecret as string | undefined;

        if (repositoryUrl && !isPublicHttpUrl(repositoryUrl)) {
          // SSRF guard: never probe a non-public host (private, loopback,
          // link-local/metadata). The authoritative guard is upstream (#4b).
          reachabilityChecks.push({
            field: 'repository_reachability',
            ok: false,
            message:
              'Git repository URL must be a public http(s) address (private, loopback, and link-local hosts are not probed)',
          });
        } else if (repositoryUrl && !workspaceId) {
          // Both probe endpoints require `workspace` — it is what the API
          // checks `workspace:r` against. Without it the probe comes back 403,
          // so name the missing argument instead of calling the URL unreachable.
          reachabilityChecks.push({
            field: 'repository_reachability',
            ok: false,
            message: MISSING_WORKSPACE_MESSAGE,
          });
        } else if (repositoryUrl && workspaceId) {
          try {
            const query: Record<string, string> = {
              workspace: workspaceId,
              url: repositoryUrl,
            };
            if (secretId) query.id = secretId;
            await client.probeGitRepository(query);
            reachabilityChecks.push({
              field: 'repository_reachability',
              ok: true,
              message: 'Git repository is reachable',
            });
          } catch (e) {
            reachabilityChecks.push({
              field: 'repository_reachability',
              ok: false,
              message: `Git repository probe failed: ${(e as Error).message}`,
            });
          }
        }

        if (registryUrl && !registryHostIsPublic(registryUrl)) {
          reachabilityChecks.push({
            field: 'registry_reachability',
            ok: false,
            message:
              'Container registry host must be a public address (private, loopback, and link-local hosts are not probed)',
          });
        } else if (registryUrl && !workspaceId) {
          reachabilityChecks.push({
            field: 'registry_reachability',
            ok: false,
            message: MISSING_WORKSPACE_MESSAGE,
          });
        } else if (registryUrl && workspaceId) {
          try {
            const query: Record<string, string> = {
              workspace: workspaceId,
              registry_url: registryUrl,
            };
            if (secretId) query.id = secretId;
            await client.probeRegistry(query);
            reachabilityChecks.push({
              field: 'registry_reachability',
              ok: true,
              message: 'Container registry is reachable',
            });
          } catch (e) {
            reachabilityChecks.push({
              field: 'registry_reachability',
              ok: false,
              message: `Registry probe failed: ${(e as Error).message}`,
            });
          }
        }
      }

      const allChecks = [...checks, ...reachabilityChecks];
      const passed = allChecks.filter((c) => c.ok).length;
      const failed = allChecks.filter((c) => !c.ok).length;

      // Cost estimate — fetch pricing for the region
      let costEstimate: {
        pod_monthly: number;
        disk_monthly: number;
        total_monthly: number;
        currency: string;
      } | null = null;
      let balanceNote: string | null = null;

      const fkRegion = args.fkRegion as string | undefined;
      const fkPod = args.fkPod as string | undefined;

      if (fkRegion && fkPod) {
        try {
          const pricing = await client.getPricing(fkRegion);
          const podPrice =
            pricing.pods.find((p) => p.fk_pod === fkPod)?.price ?? 0;
          const diskSizeGb = (args.diskSizeGb as number | undefined) ?? 0;
          const diskMonthly = pricing.volume_price_per_gb * diskSizeGb;
          costEstimate = {
            pod_monthly: podPrice,
            disk_monthly: diskMonthly,
            total_monthly: podPrice + diskMonthly,
            currency: 'EUR',
          };
        } catch {
          // Pricing fetch is non-critical — skip silently
        }
      }

      // Balance check — informational only, never blocks
      if (workspaceId) {
        try {
          const balance = await client.getBalance(workspaceId);
          if (costEstimate && balance.amount < costEstimate.total_monthly) {
            balanceNote = `Warning: workspace balance (${balance.amount} ${balance.currency}) may be insufficient for estimated monthly cost (${costEstimate.total_monthly.toFixed(2)} EUR).`;
          }
        } catch (e) {
          const msg = (e as Error).message;
          if (!msg.includes('403') && !msg.includes('permission')) {
            balanceNote = `Balance check skipped: ${msg}`;
          }
        }
      }

      return toolResult({
        valid: failed === 0,
        summary: `${passed} passed, ${failed} failed`,
        checks: allChecks,
        ...(costEstimate ? { cost_estimate: costEstimate } : {}),
        ...(balanceNote ? { balance_note: balanceNote } : {}),
      });
    },
  ],
]);
