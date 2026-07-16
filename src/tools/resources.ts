import { z } from 'zod';
import type { PartiriApiClient } from '../client.js';
import { toolResult, toolError } from '../errors.js';
import type { ToolDefinition, ToolHandler } from './index.js';
import { READ_ONLY } from './annotations.js';

/**
 * Tool definitions for the resources domain: `list_pods`, `list_regions`,
 * `get_pricing`, and `get_balance`. All are read-only lookups used to
 * discover valid inputs (pod/region IDs) and cost information before
 * creating a service.
 */
export const definitions: ToolDefinition[] = [
  {
    name: 'list_pods',
    title: 'List Compute Pods',
    description:
      'List available compute pods (instance types) for a workspace. Returns id, name, label, cpu, and ram for each pod. Use a pod id when creating a service with create_service.',
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
      'Get pod and volume pricing for a region. Returns pod prices (monthly, per-minute) and volume price per GB per month. Use a region id from list_regions. Useful for estimating monthly cost before creating a service.',
    inputSchema: z.object({
      regionId: z.string().uuid().describe('The region UUID'),
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
        const pricing = await client.getPricing(args.regionId as string);
        return toolResult(pricing);
      } catch (e) {
        return toolError(
          (e as Error).message,
          'Verify the region ID is correct. Use list_regions with a workspace ID to find valid region IDs.',
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
