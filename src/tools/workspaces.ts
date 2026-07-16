import { z } from 'zod';
import type { PartiriApiClient } from '../client.js';
import { toolResult, toolError } from '../errors.js';
import type { ToolDefinition, ToolHandler } from './index.js';
import { READ_ONLY } from './annotations.js';

/**
 * Tool definitions for the workspaces domain: `list_workspaces`, a
 * read-only lookup of the workspaces the authenticated user can access.
 */
export const definitions: ToolDefinition[] = [
  {
    name: 'list_workspaces',
    title: 'List Workspaces',
    description:
      'List all workspaces the authenticated user has access to. Returns id, name, and email for each workspace. Use a workspace id with list_projects, list_pods, or list_regions.',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
  },
];

/**
 * Handler map for the workspaces domain, keyed by tool name.
 */
export const handlers: Map<string, ToolHandler> = new Map([
  /** Lists all workspaces the authenticated user has access to. */
  [
    'list_workspaces',
    async (client: PartiriApiClient) => {
      try {
        const workspaces = await client.listWorkspaces();
        return toolResult({ count: workspaces.length, workspaces });
      } catch (e) {
        return toolError(
          (e as Error).message,
          'Verify your API key is valid. Run partiri auth to refresh it.',
        );
      }
    },
  ],
]);
