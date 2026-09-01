import { z } from 'zod';
import type { PartiriApiClient } from '../client.js';
import { toolResult } from '../errors.js';
import type { ToolDefinition, ToolHandler } from './index.js';
import { isPublicHttpUrl, isPrivateOrSpecialHost } from '../net-guard.js';
import {
  type CostEstimate,
  findPodPrice,
  quote,
  recurringMonthly,
} from './cost.js';
import { serviceRules } from './service-rules.js';

/** Allowed `deploy_type` values for a service. */
const deployTypeEnum = z.enum([
  'webservice',
  'static',
  'private-service',
  'worker',
  'cronjob',
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
      fkPod: z
        .string()
        .uuid()
        .optional()
        .describe('Compute pod UUID. Provide EITHER this or customPod.'),
      customPod: z
        .object({
          vcpuMillicores: z.number().int().positive(),
          memoryMib: z.number().int().positive(),
        })
        .optional()
        .describe(
          'A custom size instead of a catalogue pod. Priced from the region rate card, since no pod class exists until the service is created.',
        ),
      replicaCount: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Pods per region (default 1). Scales the cost estimate.'),
      scheduler: z
        .string()
        .optional()
        .describe(
          "Cron expression for a 'cronjob' deployType. Set means recurring, omitted means one-shot.",
        ),
      cronjobActiveDeadlineSeconds: z
        .number()
        .int()
        .min(1)
        .max(3600)
        .optional()
        .describe(
          "Hard kill-timeout for a single run (1-3600). Required for a 'cronjob'; also bounds the per-run cost estimate.",
        ),
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
 * required fields and name length, then every rule in {@link serviceRules} —
 * source XOR, size XOR, deploy_type compatibility, the cronjob constraints,
 * and the build/run command requirements.
 *
 * @param args - Raw tool input arguments (unvalidated beyond the Zod schema).
 * @returns The list of validation checks with their pass/fail status.
 * @remarks
 * The `build_command` / `run_command` rules are MCP-side guidance and are
 * STRICTER than the API — the backend does not require them for
 * webservice/static/private-service (cronjobs and workers require
 * `run_command || registry_url`). They carry `blocking: false` in the shared
 * list so `create_service` never refuses on them; treat a failure here as
 * advisory, not an API rejection. Every other rule mirrors something the API
 * itself rejects.
 */
function validateConfig(args: Record<string, unknown>): ValidationCheck[] {
  const checks: ValidationCheck[] = [];

  /** Push a single validation result onto `checks`. */
  const check = (field: string, ok: boolean, message: string) => {
    checks.push({ field, ok, message });
  };

  const name = (args.name as string) ?? '';
  const rootPath = (args.rootPath as string) ?? '';

  // Presence checks the shared rules deliberately leave out: these are shape
  // requirements the Zod schema already enforces for create_service, so they
  // are only meaningful here, where callers probe a partial config.
  check('name', name.length > 0, 'Service name is required');
  check(
    'name_length',
    name.length <= 16,
    'Service name must be 16 characters or fewer',
  );
  check('fk_region', !!(args.fkRegion as string), 'Region is required');
  check('root_path', rootPath.length > 0, 'root_path is required');

  // Everything create_service blocks on, evaluated from the same list it uses.
  // Rendering the shared rules rather than re-implementing them is what stops
  // this tool from reporting a config valid that create_service then refuses.
  for (const rule of serviceRules(args)) {
    check(rule.field, rule.ok, rule.message);
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
      let costEstimate: CostEstimate | null = null;
      let balanceNote: string | null = null;

      const fkRegion = args.fkRegion as string | undefined;
      const fkPod = args.fkPod as string | undefined;
      const customPod = args.customPod as
        | { vcpuMillicores: number; memoryMib: number }
        | undefined;

      if (fkRegion && (fkPod || customPod)) {
        try {
          // A custom size has no pod id yet -- the class is minted on create --
          // so price it from the region's rate card instead of the catalogue.
          // `null` (not 0) when it cannot be priced: quoting an unpriceable pod
          // as free is worse than returning no estimate at all.
          let podPrice: number | null = null;
          if (customPod) {
            const options = await client.getCustomPodOptions([fkRegion]);
            const rate = options.rates?.find((r) => r.fk_region === fkRegion);
            if (rate) {
              podPrice =
                Math.round(
                  ((customPod.vcpuMillicores / 1000) *
                    Number(rate.price_per_vcpu_month) +
                    (customPod.memoryMib / 1024) *
                      Number(rate.price_per_gb_ram_month)) *
                    100,
                ) / 100;
            }
          }

          // Named explicitly so a catalogue pod AND an already-minted custom
          // one both resolve; the bulk response carries catalogue pods only.
          const pricing = await client.getPricing(
            fkRegion,
            fkPod ? [fkPod] : [],
          );
          const cataloguePrice = findPodPrice(pricing.pods, fkPod);
          if (fkPod) {
            podPrice = cataloguePrice ? Number(cataloguePrice.price) : null;
          }

          const diskSizeGb = (args.diskSizeGb as number | undefined) ?? 0;
          // The disk is quoted for BOTH billing models: a volume is charged a
          // flat month on every deploy type, so dropping it for a cronjob
          // silently discarded a real recurring cost the caller asked about.
          // validate_service quotes a single region, so region_count is 1.
          costEstimate = quote({
            deployType: args.deployType as string | undefined,
            podMonthly: podPrice,
            perMinute: cataloguePrice?.perMinute,
            replicaCount: args.replicaCount as number | undefined,
            regionCount: 1,
            diskMonthly: pricing.volume_price_per_gb * diskSizeGb,
            activeDeadlineSeconds: args.cronjobActiveDeadlineSeconds as
              | number
              | undefined,
          });
        } catch {
          // Pricing fetch is non-critical — skip silently
        }
      }

      // Balance check — informational only, never blocks
      if (workspaceId) {
        try {
          const balance = await client.getBalance(workspaceId);
          // Compare against the RECURRING charge, which is the whole monthly
          // total for a flat service but only the volume for a metered one —
          // a cronjob's compute is charged nothing up front, so warning on its
          // pod price would be a false alarm, while an attached volume is a
          // genuine monthly cost that still deserves the check.
          const recurring = recurringMonthly(costEstimate);
          if (recurring > 0 && balance.amount < recurring) {
            balanceNote = `Warning: workspace balance (${balance.amount} ${balance.currency}) may be insufficient for estimated recurring monthly cost (${recurring.toFixed(2)} EUR).`;
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
