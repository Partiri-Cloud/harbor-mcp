import { z } from 'zod';
import type { PartiriApiClient, Service } from '../client.js';
import { toolResult, toolError } from '../errors.js';
import type { ToolDefinition, ToolHandler } from './index.js';
import { READ_ONLY } from './annotations.js';
import {
  type CostDelta,
  type CostEstimate,
  delta,
  findPodPrice,
  quote,
} from './cost.js';
import { firstBlockingFailure } from './service-rules.js';

/**
 * Resolve the region a service is primarily deployed in.
 *
 * @param service - The service to inspect.
 * @returns The `fk_region` of the replica flagged `is_primary`, falling back
 *   to the first replica, or `null` if the service has no replicas.
 */
function primaryRegionId(service: Service): string | null {
  const primary =
    service.replicas?.find((r) => r.is_primary) ??
    service.replicas?.[0] ??
    null;
  return primary?.fk_region ?? null;
}

/**
 * Strip secret-bearing fields from a service before returning it to a tool
 * caller.
 *
 * @param service - The full service record as fetched from the API.
 * @returns The service with `env` and `fk_service_secret` removed.
 *
 * @remarks
 * On a PaaS, env vars hold the secrets (DB URLs, JWT secrets, API keys). The
 * MCP does not expose them at all — not on writes (create/update no longer
 * accept `env`) and not on reads (this function strips `env` from the
 * response). Environment variables are managed out-of-band via the `partiri`
 * CLI (see `use_partiri_cli`), which authenticates independently and never
 * routes secret values through a third-party model provider.
 * `fk_service_secret` is likewise stripped: it is an internal secret-record
 * reference with no read-side use (it stays accepted as a request INPUT on
 * create/update). Functional IDs (workspace/project/service UUIDs) remain —
 * they are required for chaining tool calls.
 */
function sanitizeService(
  service: Service,
): Omit<Service, 'env' | 'fk_service_secret'> {
  const clone: Partial<Service> = { ...service };
  delete clone.env;
  delete clone.fk_service_secret;
  return clone as Omit<Service, 'env' | 'fk_service_secret'>;
}

/** Allowed values for a service's `deployType` field. */
const deployTypeEnum = z.enum([
  'webservice',
  'static',
  'private-service',
  'worker',
  'cronjob',
]);

/**
 * Batch-workload fields, shared by create and update.
 *
 * `scheduler` is the discriminator: set it and the service runs as a recurring
 * CronJob, omit it and it is a one-shot Job. Only meaningful when deployType is
 * 'cronjob' — the API ignores them otherwise.
 */
const cronjobFields = {
  scheduler: z
    .string()
    .optional()
    .describe(
      "5-field cron expression, e.g. '0 3 * * *'. Consecutive runs must be at least 5 minutes apart. Omit for a one-shot job.",
    ),
  cronjobTimeZone: z
    .string()
    .optional()
    .describe("IANA timezone the schedule runs in, e.g. 'Europe/Lisbon'."),
  cronjobActiveDeadlineSeconds: z
    .number()
    .int()
    .min(1)
    .max(3600)
    .optional()
    .describe(
      'Hard kill-timeout for a single run, in seconds (1-3600). REQUIRED for a cronjob: runs are billed per minute of actual duration, and this bounds the worst case.',
    ),
  cronjobBackoffLimit: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Retries before a run counts as failed.'),
  cronjobConcurrencyPolicy: z
    .enum(['Allow', 'Forbid', 'Replace'])
    .optional()
    .describe('What to do when a run is still going as the next one is due.'),
  cronjobCommand: z
    .array(z.string())
    .optional()
    .describe('Container entrypoint override, as argv.'),
  cronjobTtlSecondsAfterFinished: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Seconds a finished run's pod is kept before cleanup. Keep it long enough to read the logs of a failed run.",
    ),
  cronjobStartingDeadlineSeconds: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Grace window for starting a run that missed its slot. Past this, the run is skipped rather than fired late.',
    ),
  cronjobSuccessfulJobsHistoryLimit: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Succeeded runs kept in history.'),
  cronjobFailedJobsHistoryLimit: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Failed runs kept in history.'),
};

/**
 * camelCase tool arg -> snake_case API field, for every batch-workload
 * setting the MCP accepts.
 *
 * `cronjob_suspend` is absent by design: the API owns that flag and toggles it
 * from the pause/unpause job flow so it stays in step with the metered billing
 * assignment. Setting it here would halt the schedule while billing still
 * treated the service as live. Use `pause_service`/`unpause_service` instead.
 */
const CRONJOB_FIELD_MAP: Record<string, string> = {
  scheduler: 'scheduler',
  cronjobTimeZone: 'cronjob_time_zone',
  cronjobActiveDeadlineSeconds: 'cronjob_active_deadline_seconds',
  cronjobBackoffLimit: 'cronjob_backoff_limit',
  cronjobConcurrencyPolicy: 'cronjob_concurrency_policy',
  cronjobCommand: 'cronjob_command',
  cronjobTtlSecondsAfterFinished: 'cronjob_ttl_seconds_after_finished',
  cronjobStartingDeadlineSeconds: 'cronjob_starting_deadline_seconds',
  cronjobSuccessfulJobsHistoryLimit: 'cronjob_successful_jobs_history_limit',
  cronjobFailedJobsHistoryLimit: 'cronjob_failed_jobs_history_limit',
};

/** Maps the camelCase cronjob args onto their snake_case API fields. */
function cronjobPayload(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [arg, field] of Object.entries(CRONJOB_FIELD_MAP)) {
    if (args[arg] !== undefined) out[field] = args[arg];
  }
  return out;
}

/** Allowed values for a service's `runtime` field. */
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

/**
 * Tool definitions for the services domain: `list_services`, `get_service`,
 * `create_service`, and `update_service`.
 */
export const definitions: ToolDefinition[] = [
  {
    name: 'list_services',
    title: 'List Services',
    description:
      'List all services in a project. Returns a summary (id, name, runtime, deploy_type, deploy_tag, active) for each service — call get_service for full configuration. Get a project id from list_projects first. Returns at most `limit` services (default 50); when `has_more` is true, raise `limit` to fetch the rest.',
    inputSchema: z.object({
      projectId: z.string().uuid().describe('The project UUID'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Maximum number of services to return (default 50, max 200)'),
    }),
    annotations: READ_ONLY,
  },
  {
    name: 'get_service',
    title: 'Get Service',
    description:
      'Get full configuration of a service including repository, build commands, region, pod, and deploy tag. Environment variables are omitted from the response — they hold secrets and are managed out-of-band via the partiri CLI (see use_partiri_cli). Use list_services to find service IDs.',
    inputSchema: z.object({
      serviceId: z.string().uuid().describe('The service UUID'),
    }),
    annotations: READ_ONLY,
  },
  {
    name: 'create_service',
    title: 'Create Service',
    description:
      'Create a new service in a project. Requires exactly one source (repository URL or registry URL), a size (fkPod OR customPod), and a region. Get IDs from list_projects, list_pods, and list_regions. Returns the created service with its id. Supported deploy types: webservice, static, private-service, worker (long-running background process with no inbound network — no port, no URL, no health check), and cronjob (a batch workload: set scheduler for a recurring CronJob, omit it for a one-shot Job; needs run_command or registryUrl, requires cronjobActiveDeadlineSeconds, and always runs a single replica in one region). For static the runtime is forced to "static" server-side. BILLING DIFFERS BY TYPE: every type except cronjob is charged a flat pod month up front per replica per region, while a cronjob is metered — nothing at creation, each run debited on its actual duration. Environment variables are NOT set here — manage them with the partiri CLI (see use_partiri_cli).',
    inputSchema: z.object({
      name: z.string().max(16).describe('Service name (max 16 characters)'),
      deployType: deployTypeEnum.describe('Deployment type'),
      ...cronjobFields,
      runtime: runtimeEnum.describe('Application runtime'),
      rootPath: z
        .string()
        .max(512)
        .describe('Application root path in the repository'),
      fkProject: z
        .string()
        .uuid()
        .describe('Project UUID to create the service in'),
      fkRegion: z
        .string()
        .uuid()
        .describe('Region UUID (use list_regions to find available regions)'),
      fkPod: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Compute pod UUID (use list_pods to find available pods). Provide EITHER this or customPod, not both.',
        ),
      customPod: z
        .object({
          vcpuMillicores: z
            .number()
            .int()
            .positive()
            .describe('CPU in millicores, e.g. 1000 for one core'),
          memoryMib: z
            .number()
            .int()
            .positive()
            .describe('Memory in MiB, e.g. 1024 for one GB'),
        })
        .optional()
        .describe(
          'A custom size instead of a catalogue pod. Must sit on the step grid returned by get_custom_pod_options; the server rejects anything off it. Requests equal limits, so this is what the service is guaranteed AND billed for.',
        ),
      replicaCount: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Pods to run IN EACH region (default 1). Total pods, and the monthly bill, is this times the number of regions. Always 1 for cronjob and database services.',
        ),
      fkServiceSecret: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Repository or registry secret UUID. Secrets are managed outside the MCP (dashboard, or run the `partiri` CLI yourself — use_partiri_cli returns guidance); obtain the UUID there.',
        ),
      repositoryUrl: z
        .string()
        .url()
        .max(2048)
        .optional()
        .describe('Git repository URL'),
      repositoryBranch: z
        .string()
        .max(255)
        .optional()
        .describe('Git branch to deploy from'),
      registryUrl: z
        .string()
        .max(2048)
        .optional()
        .describe(
          'Full container image reference (e.g. `ghcr.io/owner/image:tag`). The API splits host, repository, and tag server-side.',
        ),
      buildCommand: z.string().max(1000).optional().describe('Build command'),
      buildPath: z.string().max(512).optional().describe('Build output path'),
      preDeployCommand: z
        .string()
        .max(1000)
        .optional()
        .describe('Command to run before deployment'),
      runCommand: z
        .string()
        .max(1000)
        .optional()
        .describe('Command to start the service'),
      healthCheckPath: z
        .string()
        .max(512)
        .optional()
        .describe('Health check endpoint path (GET)'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false, // creates a new resource, overwrites nothing
      idempotentHint: false, // repeat calls create additional services
      openWorldHint: false,
    },
  },
  {
    name: 'update_service',
    title: 'Update Service',
    description:
      'Update an existing service configuration. Only include fields you want to change. Use get_service to see current values first. Environment variables are NOT managed here — use the partiri CLI (see use_partiri_cli).',
    inputSchema: z.object({
      serviceId: z.string().uuid().describe('The service UUID'),
      name: z
        .string()
        .max(16)
        .optional()
        .describe('Service name (max 16 characters)'),
      deployType: deployTypeEnum.optional().describe('Deployment type'),
      ...cronjobFields,
      runtime: runtimeEnum.optional().describe('Application runtime'),
      rootPath: z
        .string()
        .max(512)
        .optional()
        .describe('Application root path'),
      fkRegion: z
        .string()
        .uuid()
        .optional()
        .describe('Region UUID to move the service to'),
      fkPod: z
        .string()
        .uuid()
        .optional()
        .describe('Compute pod UUID to change the service to'),
      customPod: z
        .object({
          vcpuMillicores: z.number().int().positive(),
          memoryMib: z.number().int().positive(),
        })
        .optional()
        .describe(
          'Resize onto a custom size instead of a catalogue pod. Re-send this whenever you change the region set of a service that already runs a custom pod, so the added region gets priced.',
        ),
      replicaCount: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'New per-region pod count. Billing changes immediately and a deploy is enqueued, so this restarts the workload.',
        ),
      fkServiceSecret: z
        .string()
        .uuid()
        .optional()
        .describe('Repository or registry secret UUID'),
      repositoryUrl: z
        .string()
        .url()
        .max(2048)
        .optional()
        .describe('Git repository URL'),
      repositoryBranch: z.string().max(255).optional().describe('Git branch'),
      registryUrl: z
        .string()
        .max(2048)
        .optional()
        .describe(
          'Full container image reference (e.g. `ghcr.io/owner/image:tag`). The API splits host, repository, and tag server-side.',
        ),
      buildCommand: z.string().max(1000).optional().describe('Build command'),
      buildPath: z.string().max(512).optional().describe('Build output path'),
      preDeployCommand: z
        .string()
        .max(1000)
        .optional()
        .describe('Pre-deploy command'),
      runCommand: z.string().max(1000).optional().describe('Run command'),
      healthCheckPath: z
        .string()
        .max(512)
        .optional()
        .describe('Health check endpoint path'),
      maintenanceMode: z
        .boolean()
        .optional()
        .describe('Enable/disable maintenance mode'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true, // overwrites existing config; prior values are not recoverable
      idempotentHint: true, // same update applied twice yields the same state
      openWorldHint: false,
    },
  },
];

/**
 * Handler implementations for the services domain tools.
 *
 * @remarks
 * Service teardown is intentionally not an MCP tool — you do it by running
 * the `partiri` CLI yourself (`use_partiri_cli` returns guidance, e.g.
 * `partiri service kill`).
 */
export const handlers: Map<string, ToolHandler> = new Map([
  /**
   * Lists services in a project as a non-sensitive summary, capped at
   * `args.limit` (default 50), and flags `has_more` when the page is full.
   */
  [
    'list_services',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      try {
        const limit = (args.limit as number | undefined) ?? 50;
        const services = await client.listServices(
          args.projectId as string,
          limit,
        );
        // Project to a non-sensitive summary — never forward env (or any other
        // full-object field) here; get_service is the deliberate full-config path.
        const summary = services.map((s) => ({
          id: s.id,
          name: s.name,
          runtime: s.runtime,
          deploy_type: s.deploy_type,
          deploy_tag: s.deploy_tag,
          active: s.active,
        }));
        // The API caps the result set (default 10, here `limit`); flag a full
        // page so callers know to raise `limit` instead of silently seeing a
        // truncated list.
        return toolResult({
          count: summary.length,
          has_more: summary.length >= limit,
          services: summary,
        });
      } catch (e) {
        return toolError(
          (e as Error).message,
          'Verify the project ID is correct. Use list_projects with a workspace ID to find valid project IDs.',
        );
      }
    },
  ],
  /**
   * Fetches a service's full configuration, sanitized of secret-bearing
   * fields, with `fk_region` resolved to its primary replica's region.
   */
  [
    'get_service',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      try {
        const service = await client.getService(args.serviceId as string);
        const result = {
          ...sanitizeService(service),
          fk_region: primaryRegionId(service),
        };
        return toolResult(result);
      } catch (e) {
        return toolError(
          (e as Error).message,
          'Verify the service ID exists. Use list_services with a project ID to find valid service IDs.',
        );
      }
    },
  ],
  /**
   * Creates a service after verifying exactly one source (repository or
   * registry URL) is given, then attaches a best-effort monthly cost
   * estimate to the sanitized created service.
   */
  [
    'create_service',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      try {
        // Every rule the API would reject, evaluated from the same list
        // validate_service renders. Sharing the list is what keeps the two
        // tools from disagreeing about whether a config is acceptable.
        const failure = firstBlockingFailure(args);
        if (failure) {
          return toolError(
            failure.message,
            failure.hint ??
              'Use validate_service to preflight the full configuration.',
          );
        }

        const service = await client.createService({
          name: args.name as string,
          deploy_type: args.deployType as string,
          runtime: args.runtime as string,
          root_path: args.rootPath as string,
          fk_project: args.fkProject as string,
          fk_region: args.fkRegion as string,
          fk_pod: args.fkPod as string | undefined,
          ...(args.customPod
            ? {
                custom_pod: {
                  vcpu_millicores: (
                    args.customPod as { vcpuMillicores: number }
                  ).vcpuMillicores,
                  memory_mib: (args.customPod as { memoryMib: number })
                    .memoryMib,
                },
              }
            : {}),
          ...(args.replicaCount !== undefined
            ? { replica_count: args.replicaCount as number }
            : {}),
          ...cronjobPayload(args),
          fk_service_secret: args.fkServiceSecret as string | undefined,
          repository_url: args.repositoryUrl as string | undefined,
          repository_branch: args.repositoryBranch as string | undefined,
          registry_url: args.registryUrl as string | undefined,
          build_command: args.buildCommand as string | undefined,
          build_path: args.buildPath as string | undefined,
          pre_deploy_command: args.preDeployCommand as string | undefined,
          run_command: args.runCommand as string | undefined,
          health_check_path: args.healthCheckPath as string | undefined,
        });

        // Attach a cost estimate — non-critical, never blocks creation
        let costEstimate: CostEstimate | null = null;
        try {
          // Price the pod the service ACTUALLY ended up on. For a custom size
          // that id only exists after creation (the server mints it), and it is
          // absent from the catalogue response, so it has to be named.
          const podId = service.fk_pod ?? (args.fkPod as string | undefined);
          const pricing = await client.getPricing(
            args.fkRegion as string,
            podId ? [podId] : [],
          );
          // A missing price row means the pod could not be resolved, and quote()
          // turns that into no estimate at all — absent means unknown, never
          // free.
          const price = findPodPrice(pricing.pods, podId);
          costEstimate = quote({
            deployType: args.deployType as string | undefined,
            podMonthly: price ? Number(price.price) : null,
            perMinute: price?.perMinute,
            replicaCount: args.replicaCount as number | undefined,
            regionCount: service.replicas?.length,
            activeDeadlineSeconds: args.cronjobActiveDeadlineSeconds as
              | number
              | undefined,
          });
        } catch {
          // Pricing fetch is non-critical
        }

        return toolResult({
          ...sanitizeService(service),
          ...(costEstimate ? { cost_estimate: costEstimate } : {}),
        });
      } catch (e) {
        return toolError(
          (e as Error).message,
          'Verify the required fields: name, deployType, runtime, rootPath, fkProject, fkRegion, and a size (fkPod or customPod). Get IDs from list_projects, list_pods, and list_regions; get the custom size range from get_custom_pod_options.',
        );
      }
    },
  ],
  /**
   * Applies a partial update to a service, rejecting a dual-source update,
   * mapping camelCase args to snake_case API fields, and computing a
   * best-effort monthly cost delta when the pod or region changes.
   */
  [
    'update_service',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      try {
        const { serviceId, maintenanceMode, ...rest } = args as Record<
          string,
          unknown
        >;
        const updates: Record<string, unknown> = {};

        // Reject a dual-source update (mirrors create_service). Switching to a
        // single source is fine on a partial update, so only block both-present.
        if (
          (rest.repositoryUrl as string | undefined)?.trim() &&
          (rest.registryUrl as string | undefined)?.trim()
        ) {
          return toolError(
            'Provide only one source: repositoryUrl OR registryUrl, not both.',
          );
        }

        // Map camelCase args to snake_case API fields
        if (rest.name !== undefined) updates.name = rest.name;
        if (rest.deployType !== undefined)
          updates.deploy_type = rest.deployType;
        if (rest.runtime !== undefined) updates.runtime = rest.runtime;
        if (rest.rootPath !== undefined) updates.root_path = rest.rootPath;
        if (rest.fkRegion !== undefined) updates.fk_region = rest.fkRegion;
        if (rest.fkPod !== undefined) updates.fk_pod = rest.fkPod;
        if (rest.customPod !== undefined) {
          const cp = rest.customPod as {
            vcpuMillicores: number;
            memoryMib: number;
          };
          updates.custom_pod = {
            vcpu_millicores: cp.vcpuMillicores,
            memory_mib: cp.memoryMib,
          };
        }
        if (rest.replicaCount !== undefined)
          updates.replica_count = rest.replicaCount;
        Object.assign(updates, cronjobPayload(rest));
        if (rest.fkServiceSecret !== undefined)
          updates.fk_service_secret = rest.fkServiceSecret;
        if (rest.repositoryUrl !== undefined)
          updates.repository_url = rest.repositoryUrl;
        if (rest.repositoryBranch !== undefined)
          updates.repository_branch = rest.repositoryBranch;
        if (rest.registryUrl !== undefined)
          updates.registry_url = rest.registryUrl;
        if (rest.buildCommand !== undefined)
          updates.build_command = rest.buildCommand;
        if (rest.buildPath !== undefined) updates.build_path = rest.buildPath;
        if (rest.preDeployCommand !== undefined)
          updates.pre_deploy_command = rest.preDeployCommand;
        if (rest.runCommand !== undefined)
          updates.run_command = rest.runCommand;
        if (rest.healthCheckPath !== undefined)
          updates.health_check_path = rest.healthCheckPath;
        if (maintenanceMode !== undefined)
          updates.maintenance_mode = maintenanceMode;

        // Compute cost delta before updating — non-critical
        let costDelta: CostDelta | null = null;

        const newPodId = rest.fkPod as string | undefined;
        const newRegionId = rest.fkRegion as string | undefined;
        const newReplicaCount = rest.replicaCount as number | undefined;
        const newDeployType = rest.deployType as string | undefined;

        // deployType belongs here alongside the others: switching to or from a
        // cronjob flips the whole billing model, which is the largest change
        // this tool can make and used to go unreported entirely.
        //
        // A custom resize is still deliberately NOT quoted: the new pod class
        // does not exist until the update runs, so there is no id to price. The
        // caller gets the change without a delta rather than a fabricated one.
        if (
          (newPodId ||
            newRegionId ||
            newReplicaCount !== undefined ||
            newDeployType !== undefined) &&
          rest.customPod === undefined
        ) {
          try {
            const service = await client.getService(serviceId as string);
            const currentRegionId = primaryRegionId(service);
            const currentPodId = service.fk_pod;
            const effectiveNewRegionId = newRegionId ?? currentRegionId;
            const effectiveNewPodId = newPodId ?? currentPodId;
            const currentReplicas = Math.max(1, service.replica_count ?? 1);
            const effectiveReplicas = Math.max(
              1,
              newReplicaCount ?? currentReplicas,
            );
            // Region count is unchanged by this tool — it only moves the
            // primary — so it scales both sides equally.
            const regionCount = Math.max(1, service.replicas?.length ?? 1);

            if (
              currentRegionId &&
              currentPodId &&
              effectiveNewRegionId &&
              effectiveNewPodId
            ) {
              // Both ids are named so a service already on a custom pod is
              // priced rather than falling through to 0.
              const [currentPricing, newPricing] = await Promise.all([
                client.getPricing(currentRegionId, [currentPodId]),
                currentRegionId === effectiveNewRegionId
                  ? Promise.resolve(null)
                  : client.getPricing(effectiveNewRegionId, [
                      effectiveNewPodId,
                    ]),
              ]);
              const resolvedNewPricing = newPricing ?? currentPricing;
              const currentPrice = findPodPrice(
                currentPricing.pods,
                currentPodId,
              );
              const newPrice = findPodPrice(
                resolvedNewPricing.pods,
                effectiveNewPodId,
              );

              // Each side is quoted from ITS OWN deploy type, then diffed.
              // Deriving the current side from the NEW type is what reported a
              // cronjob as already paying a month it never paid.
              costDelta = delta(
                quote({
                  deployType: service.deploy_type,
                  podMonthly: currentPrice ? Number(currentPrice.price) : null,
                  perMinute: currentPrice?.perMinute,
                  replicaCount: currentReplicas,
                  regionCount,
                }),
                quote({
                  deployType: newDeployType ?? service.deploy_type,
                  podMonthly: newPrice ? Number(newPrice.price) : null,
                  perMinute: newPrice?.perMinute,
                  replicaCount: effectiveReplicas,
                  regionCount,
                }),
              );
            }
          } catch {
            // Cost delta is non-critical — skip on any error
          }
        }

        await client.updateService(serviceId as string, updates);
        return toolResult({
          serviceId,
          status: 'updated',
          ...(costDelta ? { cost_delta: costDelta } : {}),
        });
      } catch (e) {
        return toolError(
          (e as Error).message,
          'Verify the service ID exists and the update values are valid. Use get_service to see current configuration.',
        );
      }
    },
  ],
]);
