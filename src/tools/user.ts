import { z } from 'zod';
import type { PartiriApiClient } from '../client.js';
import { toolResult, toolError } from '../errors.js';
import type { ToolDefinition, ToolHandler } from './index.js';
import { READ_ONLY } from './annotations.js';

/**
 * Tool definitions for the user domain: `get_current_user`, a read-only
 * lookup of the authenticated user's profile.
 */
export const definitions: ToolDefinition[] = [
  {
    name: 'get_current_user',
    title: 'Get Current User',
    description:
      'Get the profile of the currently authenticated user. Returns id, email, and name.',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
  },
];

/**
 * Handler map for the user domain, keyed by tool name.
 */
export const handlers: Map<string, ToolHandler> = new Map([
  /** Fetches the profile of the currently authenticated user. */
  [
    'get_current_user',
    async (client: PartiriApiClient) => {
      try {
        const user = await client.getCurrentUser();
        return toolResult(user);
      } catch (e) {
        return toolError(
          (e as Error).message,
          'Verify your API key is valid. Run partiri auth to refresh it.',
        );
      }
    },
  ],
]);
