import { z } from 'zod';
import type { PartiriApiClient, Service } from '../client.js';
import { toolResult, toolError } from '../errors.js';
import type { ToolDefinition, ToolHandler } from './index.js';
import { READ_ONLY } from './annotations.js';

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
]);
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
      'Create a new service in a project. Requires exactly one source (repository URL or registry URL), a compute pod, and a region. Get IDs from list_projects, list_pods, and list_regions. Returns the created service with its id. Supported deploy types: webservice, static, private-service, worker (long-running background process with no inbound network — no port, no URL, no health check); for static the runtime is forced to "static" server-side. Environment variables are NOT set here — manage them with the partiri CLI (see use_partiri_cli).',
    inputSchema: z.object({
      name: z.string().max(16).describe('Service name (max 16 characters)'),
      deployType: deployTypeEnum.describe('Deployment type'),
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
        .describe('Compute pod UUID (use list_pods to find available pods)'),
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
        // Exactly one source is required (mirrors validate_service). The API
        // accepts a sourceless or dual-source body and only fails later at
        // deploy time, so guard it here.
        const hasRepo = !!(args.repositoryUrl as string | undefined)?.trim();
        const hasReg = !!(args.registryUrl as string | undefined)?.trim();
        if (hasRepo === hasReg) {
          return toolError(
            hasRepo
              ? 'Provide only one source: repositoryUrl OR registryUrl, not both.'
              : 'A source is required: provide repositoryUrl (git) or registryUrl (container image).',
            'Use validate_service to preflight the configuration.',
          );
        }

        const service = await client.createService({
          name: args.name as string,
          deploy_type: args.deployType as string,
          runtime: args.runtime as string,
          root_path: args.rootPath as string,
          fk_project: args.fkProject as string,
          fk_region: args.fkRegion as string,
          fk_pod: args.fkPod as string,
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

        // Attach monthly cost estimate — non-critical, never blocks creation
        let costEstimate: {
          pod_monthly: number;
          total_monthly: number;
          currency: string;
        } | null = null;
        try {
          const pricing = await client.getPricing(args.fkRegion as string);
          const podPrice =
            pricing.pods.find((p) => p.fk_pod === (args.fkPod as string))
              ?.price ?? 0;
          costEstimate = {
            pod_monthly: podPrice,
            total_monthly: podPrice,
            currency: 'EUR',
          };
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
          'Verify the required fields: name, deployType, runtime, rootPath, fkProject, fkRegion, fkPod. Get IDs from list_projects, list_pods, and list_regions.',
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
        let costDelta: {
          current_monthly: number;
          new_monthly: number;
          delta_monthly: number;
          currency: string;
        } | null = null;

        const newPodId = rest.fkPod as string | undefined;
        const newRegionId = rest.fkRegion as string | undefined;

        if (newPodId || newRegionId) {
          try {
            const service = await client.getService(serviceId as string);
            const currentRegionId = primaryRegionId(service);
            const currentPodId = service.fk_pod;
            const effectiveNewRegionId = newRegionId ?? currentRegionId;
            const effectiveNewPodId = newPodId ?? currentPodId;

            if (
              currentRegionId &&
              currentPodId &&
              effectiveNewRegionId &&
              effectiveNewPodId
            ) {
              const [currentPricing, newPricing] = await Promise.all([
                client.getPricing(currentRegionId),
                currentRegionId === effectiveNewRegionId
                  ? Promise.resolve(null)
                  : client.getPricing(effectiveNewRegionId),
              ]);
              const resolvedNewPricing = newPricing ?? currentPricing;
              const currentPodPrice =
                currentPricing.pods.find((p) => p.fk_pod === currentPodId)
                  ?.price ?? 0;
              const newPodPrice =
                resolvedNewPricing.pods.find(
                  (p) => p.fk_pod === effectiveNewPodId,
                )?.price ?? 0;
              costDelta = {
                current_monthly: currentPodPrice,
                new_monthly: newPodPrice,
                delta_monthly: newPodPrice - currentPodPrice,
                currency: 'EUR',
              };
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
