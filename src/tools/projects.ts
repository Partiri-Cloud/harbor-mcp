import { z } from 'zod';
import type { PartiriApiClient } from '../client.js';
import { toolResult, toolError } from '../errors.js';
import type { ToolDefinition, ToolHandler } from './index.js';
import { READ_ONLY } from './annotations.js';

/**
 * Tool definitions for the projects domain: `list_projects` (read-only) and
 * `create_project` (mutating, non-destructive, non-idempotent).
 */
export const definitions: ToolDefinition[] = [
  {
    name: 'list_projects',
    title: 'List Projects',
    description:
      'List all projects in a workspace. Returns id, name, and environment for each project. Get a workspace id from list_workspaces first. Use a project id with list_services.',
    inputSchema: z.object({
      workspaceId: z.string().uuid().describe('The workspace UUID'),
    }),
    annotations: READ_ONLY,
  },
  {
    name: 'create_project',
    title: 'Create Project',
    description:
      'Create a new project in a workspace. Returns the created project with its id. Get a workspace id from list_workspaces first.',
    inputSchema: z.object({
      name: z.string().max(255).describe('Project name'),
      environment: z
        .string()
        .max(255)
        .describe('Environment name (e.g. production, staging)'),
      workspaceId: z.string().uuid().describe('The workspace UUID'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false, // creates a new resource, overwrites nothing
      idempotentHint: false, // repeat calls create additional projects
      openWorldHint: false,
    },
  },
];

/**
 * Handler map for the projects domain, keyed by tool name.
 */
export const handlers: Map<string, ToolHandler> = new Map([
  /** Lists all projects belonging to a workspace. */
  [
    'list_projects',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      try {
        const projects = await client.listProjects(args.workspaceId as string);
        return toolResult({ count: projects.length, projects });
      } catch (e) {
        return toolError(
          (e as Error).message,
          'Verify the workspace ID is correct. Use list_workspaces to find valid workspace IDs.',
        );
      }
    },
  ],
  /** Creates a new project in a workspace and returns it, including its ID. */
  [
    'create_project',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      try {
        const project = await client.createProject(
          args.name as string,
          args.environment as string,
          args.workspaceId as string,
        );
        return toolResult(project);
      } catch (e) {
        return toolError(
          (e as Error).message,
          'Verify the workspace ID is correct and you have permission to create projects.',
        );
      }
    },
  ],
]);
