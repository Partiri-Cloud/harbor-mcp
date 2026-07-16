import { z } from 'zod';
import type { PartiriApiClient } from '../client.js';
import { toolResult, toolError } from '../errors.js';
import type { ToolDefinition, ToolHandler } from './index.js';
import { READ_ONLY } from './annotations.js';

/**
 * Tool definitions declared by this module: `deploy_service`,
 * `pause_service`, `unpause_service`, and `list_jobs`, covering deployment
 * triggering and lifecycle control for a service, plus read-only job
 * status listing.
 */
export const definitions: ToolDefinition[] = [
  {
    name: 'deploy_service',
    title: 'Deploy Service',
    description:
      'Trigger a new deployment. Checks workspace balance and enforces a 10-minute cooldown. Use list_jobs to check deployment status afterward.',
    inputSchema: z.object({
      serviceId: z.string().uuid().describe('The service UUID'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true, // replaces the currently running version
      idempotentHint: false, // each call triggers a new deployment job
      openWorldHint: false,
    },
  },
  {
    name: 'pause_service',
    title: 'Pause Service',
    description:
      'Pause a running service. The service will stop receiving traffic but can be unpaused later.',
    inputSchema: z.object({
      serviceId: z.string().uuid().describe('The service UUID'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false, // fully reversible via unpause_service
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'unpause_service',
    title: 'Unpause Service',
    description: 'Resume a paused service.',
    inputSchema: z.object({
      serviceId: z.string().uuid().describe('The service UUID'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false, // fully reversible via pause_service
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'list_jobs',
    title: 'List Deployment Jobs',
    description:
      'List deployment jobs for a service. Returns job id, type, status (open, in_progress, succeeded, failed, canceled, timed_out), and timestamps. Use after deploy_service to track progress.',
    inputSchema: z.object({
      serviceId: z.string().uuid().describe('The service UUID'),
    }),
    annotations: READ_ONLY,
  },
];

/** Error hint appended to failures on service-scoped handlers in this file. */
const SERVICE_HINT =
  'Verify the service ID exists. Use list_services with a project ID to find valid service IDs.';

/** Handler implementations for the tools declared in `definitions`. */
export const handlers: Map<string, ToolHandler> = new Map([
  /** Trigger a new deployment job for a service. */
  [
    'deploy_service',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      try {
        const serviceId = args.serviceId as string;
        await client.deployService(serviceId);
        return toolResult({ serviceId, status: 'deployment_triggered' });
      } catch (e) {
        return toolError(
          (e as Error).message,
          'Check that the service exists and is not already deploying. Use list_jobs to check current deployment status.',
        );
      }
    },
  ],
  /** Pause a running service, reversible via `unpause_service`. */
  [
    'pause_service',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      try {
        const serviceId = args.serviceId as string;
        await client.pauseService(serviceId);
        return toolResult({ serviceId, status: 'pause_requested' });
      } catch (e) {
        return toolError((e as Error).message, SERVICE_HINT);
      }
    },
  ],
  /** Resume a previously paused service, reversible via `pause_service`. */
  [
    'unpause_service',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      try {
        const serviceId = args.serviceId as string;
        await client.unpauseService(serviceId);
        return toolResult({ serviceId, status: 'unpause_requested' });
      } catch (e) {
        return toolError((e as Error).message, SERVICE_HINT);
      }
    },
  ],
  /** List deployment jobs for a service (read-only). */
  [
    'list_jobs',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      try {
        const result = await client.listJobs(args.serviceId as string);
        return toolResult({
          count: result.data.length,
          total: result.total,
          jobs: result.data,
        });
      } catch (e) {
        return toolError((e as Error).message, SERVICE_HINT);
      }
    },
  ],
]);
