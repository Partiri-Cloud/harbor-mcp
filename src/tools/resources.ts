import { z } from 'zod';
import type { PartiriApiClient } from '../client.js';
import { toolResult, toolError } from '../errors.js';
import type { ToolDefinition, ToolHandler } from './index.js';
import { READ_ONLY } from './annotations.js';

/**
 * Tool definitions for the resources domain: `list_pods`, `list_regions`,
 * `get_pricing`, `get_custom_pod_options`, and `get_balance`. All are read-only lookups used to
 * discover valid inputs (pod/region IDs) and cost information before
 * creating a service.
 */
export const definitions: ToolDefinition[] = [
  {
    name: 'list_pods',
    title: 'List Compute Pods',
    description:
      'List available compute pods (instance types) for a workspace. Returns id, name, label, and both the guaranteed (request) and burst (limit) cpu/ram for each pod. Use a pod id when creating a service with create_service. Custom-sized pods are deliberately NOT listed here — use get_custom_pod_options for those.',
    inputSchema: z.object({
      workspaceId: z.string().uuid().describe('The workspace UUID'),
    }),
    annotations: READ_ONLY,
  },
  {
    name: 'list_regions',
    title: 'List Regions',
    description:
      'List available deployment regions for a workspace. Returns id, name, label, and country_code for each region. Use a region id when creating a service with create_service.',
    inputSchema: z.object({
      workspaceId: z.string().uuid().describe('The workspace UUID'),
    }),
    annotations: READ_ONLY,
  },
  {
    name: 'get_pricing',
    title: 'Get Pricing',
    description:
      'Get pod and volume pricing for a region. Returns CATALOGUE pod prices (monthly, per-minute) and volume price per GB per month. A custom-sized pod is not included unless its id is passed in podIds. Use a region id from list_regions.',
    inputSchema: z.object({
      regionId: z.string().uuid().describe('The region UUID'),
      podIds: z
        .array(z.string().uuid())
        .optional()
        .describe(
          'Extra pod UUIDs to price on top of the catalogue — needed to quote a service already running a custom-sized pod.',
        ),
    }),
    annotations: READ_ONLY,
  },
  {
    name: 'get_custom_pod_options',
    title: 'Get Custom Pod Options',
    description:
      'Get the CPU and memory range a custom-sized pod may use across a set of regions, plus the rate it is priced at. Price is vCPU x price_per_vcpu_month + GB x price_per_gb_ram_month. Values must sit on the returned step grid or create_service rejects them. `available: false` means custom pods cannot be offered for that region set — use a catalogue pod from list_pods instead.',
    inputSchema: z.object({
      regionIds: z
        .array(z.string().uuid())
        .min(1)
        .describe(
          'Every region the service will run in. The offered range is the intersection across all of them, since one pod size covers every region.',
        ),
    }),
    annotations: READ_ONLY,
  },
  {
    name: 'get_balance',
    title: 'Get Workspace Balance',
    description:
      'Get the current workspace balance. Returns currency, amount, and last-updated timestamp. Requires billing:r permission — degrades gracefully (returns null) on a 403. Use this to warn the user before creating services.',
    inputSchema: z.object({
      workspaceId: z.string().uuid().describe('The workspace UUID'),
    }),
    annotations: READ_ONLY,
  },
];

/**
 * Handler map for the resources domain, keyed by tool name.
 */
export const handlers: Map<string, ToolHandler> = new Map([
  /** Lists available compute pods (instance types) for a workspace. */
  [
    'list_pods',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      try {
        const pods = await client.listPods(args.workspaceId as string);
        return toolResult({ count: pods.length, pods });
      } catch (e) {
        return toolError(
          (e as Error).message,
          'Verify the workspace ID is correct. Use list_workspaces to find valid workspace IDs.',
        );
      }
    },
  ],
  /** Lists available deployment regions for a workspace. */
  [
    'list_regions',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      try {
        const regions = await client.listRegions(args.workspaceId as string);
        return toolResult({ count: regions.length, regions });
      } catch (e) {
        return toolError(
          (e as Error).message,
          'Verify the workspace ID is correct. Use list_workspaces to find valid workspace IDs.',
        );
      }
    },
  ],
  /** Fetches pod and volume pricing for a region. */
  [
    'get_pricing',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      try {
        const pricing = await client.getPricing(
          args.regionId as string,
          (args.podIds as string[] | undefined) ?? [],
        );
        return toolResult(pricing);
      } catch (e) {
        return toolError(
          (e as Error).message,
          'Verify the region ID is correct. Use list_regions with a workspace ID to find valid region IDs.',
        );
      }
    },
  ],
  /** Fetches the size range and rate card for a custom-sized pod. */
  [
    'get_custom_pod_options',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      try {
        const options = await client.getCustomPodOptions(
          args.regionIds as string[],
        );
        return toolResult(options);
      } catch (e) {
        return toolError(
          (e as Error).message,
          'Verify the region IDs are correct. Use list_regions with a workspace ID to find valid region IDs.',
        );
      }
    },
  ],
  /**
   * Fetches the current workspace balance.
   *
   * @remarks
   * Requires the `billing:r` permission. On a 403 response this degrades
   * gracefully, returning `{ balance: null }` with an explanatory note
   * instead of an error, so callers can warn the user without failing the
   * whole operation.
   */
  [
    'get_balance',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      try {
        const balance = await client.getBalance(args.workspaceId as string);
        return toolResult({ balance });
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('403')) {
          return toolResult({
            balance: null,
            note: 'Balance not available: insufficient permissions (billing:r required).',
          });
        }
        return toolError(
          msg,
          'Verify the workspace ID is correct. Use list_workspaces to find valid workspace IDs.',
        );
      }
    },
  ],
]);
