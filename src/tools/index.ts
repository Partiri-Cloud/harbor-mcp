import type { z } from 'zod';
import type {
  CallToolResult,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import type { PartiriApiClient } from '../client.js';

import * as workspaces from './workspaces.js';
import * as user from './user.js';
import * as projects from './projects.js';
import * as resources from './resources.js';
import * as validate from './validate.js';
import * as storage from './storage.js';
import * as services from './services.js';
import * as deployments from './deployments.js';
import * as metrics from './metrics.js';
import * as cli from './cli.js';

/**
 * Annotation set required on every tool definition.
 *
 * @remarks
 * Directory reviewers (Anthropic Connectors, OpenAI Apps) treat missing hints
 * as spec defaults (`destructiveHint: true`, `openWorldHint: true`), so every
 * tool must state all four explicitly — making the fields required here
 * turns an omission into a compile error instead of a silent bad default.
 */
export type CompleteToolAnnotations = ToolAnnotations & {
  /** Whether the tool only reads data and performs no mutation. */
  readOnlyHint: boolean;
  /** Whether the tool can irreversibly change or remove data. */
  destructiveHint: boolean;
  /** Whether repeated calls with the same input yield the same state. */
  idempotentHint: boolean;
  /** Whether the tool interacts with state outside our own API surface. */
  openWorldHint: boolean;
};

/**
 * Metadata for a single MCP tool: its identity, description, input schema,
 * and behavioral annotations, as declared by each domain's `definitions`
 * array.
 */
export interface ToolDefinition {
  /** Unique tool name, as invoked by MCP clients. */
  name: string;
  /** Short human-readable title for the tool. */
  title: string;
  /** Full description shown to the calling agent/model. */
  description: string;
  /**
   * Zod schema validating the tool's input arguments.
   *
   * @remarks
   * Zod's `ZodObject` is invariant in its shape parameter, so a precise type
   * here would reject the specific per-tool schemas assigned to it. `any` is
   * the pragmatic choice for this shared shape.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: z.ZodObject<any>;
  /** Behavioral hints describing the tool's side effects. */
  annotations: CompleteToolAnnotations;
}

/**
 * Async handler function backing a tool definition.
 *
 * @param client - Authenticated Partiri API client for the current session.
 * @param args - Raw arguments supplied by the caller, validated against the
 *   tool's `inputSchema`.
 * @returns The MCP call result to return to the client.
 */
export type ToolHandler = (
  client: PartiriApiClient,
  args: Record<string, unknown>,
) => Promise<CallToolResult>;

/**
 * All tool domain modules, each exporting `definitions` and `handlers`.
 * Aggregated below into the flat lists the MCP server registers.
 */
const domains = [
  workspaces,
  user,
  projects,
  resources,
  validate,
  storage,
  services,
  deployments,
  metrics,
  cli,
];

/** Flattened tool definitions from every domain, in registration order. */
export const allDefinitions: ToolDefinition[] = domains.flatMap(
  (d) => d.definitions,
);

/** Flattened map of tool name to handler, merged across every domain. */
export const allHandlers: Map<string, ToolHandler> = new Map(
  domains.flatMap((d) => [...d.handlers.entries()]),
);
