import { z } from 'zod';
import type { PartiriApiClient } from '../client.js';
import { toolResult, toolError } from '../errors.js';
import type { ToolDefinition, ToolHandler } from './index.js';
import { READ_ONLY } from './annotations.js';

/**
 * Tool definitions for the storage domain: `list_volumes` and `get_volume`.
 * Both are read-only; volume mutations are deliberately excluded from the
 * MCP tool surface (see the note below `handlers`).
 */
export const definitions: ToolDefinition[] = [
  {
    name: 'list_volumes',
    title: 'List Volumes',
    description:
      'List persistent volumes in a project. Returns id, name, size, mount_path, status, and attached service for each volume. Status can be: pending, provisioning, available, attached, deleting, or failed.',
    inputSchema: z.object({
      projectId: z.string().uuid().describe('The project UUID'),
    }),
    annotations: READ_ONLY,
  },
  {
    name: 'get_volume',
    title: 'Get Volume',
    description: 'Get details of a single persistent volume by ID.',
    inputSchema: z.object({
      volumeId: z.string().uuid().describe('The volume UUID'),
    }),
    annotations: READ_ONLY,
  },
];

/**
 * Shared error hint returned alongside volume lookup failures, pointing
 * callers at `list_volumes` to discover valid volume IDs.
 *
 * @remarks
 * Volume mutations (create / attach / detach / delete / retry) are
 * intentionally not exposed as MCP tools — they are irreversible or
 * data-affecting, so the user runs them with the `partiri` CLI under the
 * `storage` namespace. The `use_partiri_cli` tool returns guidance (e.g.
 * `partiri storage <subcommand> ...`) rather than executing them.
 */
const VOLUME_HINT =
  'Verify the volume ID exists. Use list_volumes with a project ID to find valid volume IDs.';

/**
 * Handler map for the storage domain, keyed by tool name.
 */
export const handlers: Map<string, ToolHandler> = new Map([
  /** Lists persistent volumes belonging to a project. */
  [
    'list_volumes',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      try {
        const volumes = await client.listVolumes(args.projectId as string);
        return toolResult({ count: volumes.length, volumes });
      } catch (e) {
        return toolError(
          (e as Error).message,
          'Verify the project ID is correct. Use list_projects with a workspace ID to find valid project IDs.',
        );
      }
    },
  ],
  /** Fetches details of a single persistent volume by ID. */
  [
    'get_volume',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      try {
        const volume = await client.getVolume(args.volumeId as string);
        return toolResult(volume);
      } catch (e) {
        return toolError((e as Error).message, VOLUME_HINT);
      }
    },
  ],
]);
