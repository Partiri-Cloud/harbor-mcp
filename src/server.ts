import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PartiriApiClient } from './client.js';
import {
  allDefinitions,
  allHandlers,
  type ToolDefinition,
} from './tools/index.js';
import { toolError } from './errors.js';
import { registerResources } from './resources/index.js';

/**
 * CommonJS `require` bound to this module's URL, used to load JSON that ES
 * `import` cannot handle uniformly across dev and bundled builds.
 *
 * @remarks
 * createRequire lets us load JSON from the package root at both dev-time
 * (tsx, where import.meta.url is the source file) and after bundling
 * (tsdown inlines the require call so the JSON value is embedded at build
 * time).
 */
const require = createRequire(import.meta.url);

/** Package version read from `package.json`, reported to MCP clients. */
const { version } = require('../package.json') as { version: string };

/**
 * Strips URLs and file/line references from an error message before it is
 * returned to an MCP client, and truncates the result to bound response
 * size.
 *
 * @param message - The raw error message to sanitize.
 * @returns The sanitized, truncated message.
 */
export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/https?:\/\/[^\s]+/g, '[redacted-url]')
    .replace(/\/[^\s:]+\.(ts|js)(:\d+)?/g, '[redacted-path]')
    .slice(0, 500);
}

/**
 * Parses a comma-separated environment variable value into a list of
 * trimmed, non-empty tool names.
 *
 * @param value - The raw comma-separated string, or undefined if unset.
 * @returns The parsed tool names, or an empty array if `value` is unset.
 */
function parseToolList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Determines whether MCP_READONLY is set to a truthy value (`1`, `true`,
 * `yes`, or `on`, case-insensitive).
 *
 * @returns True if read-only mode is enabled via the environment.
 */
function isReadonlyMode(): boolean {
  const v = (process.env.MCP_READONLY ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Resolves which tools to register, gated by environment so an operator can
 * hand a low-trust agent a restricted surface.
 *
 * @remarks
 * Resolution order:
 *   1. base   = MCP_READONLY truthy ? readOnlyHint tools : all tools
 *   2. +allow = MCP_TOOLS_ALLOWLIST re-enables specific tools on top of base
 *   3. -deny  = MCP_TOOLS_DENYLIST removes tools (always wins, even over
 *      allow)
 * Default (no env set) = the full surface, preserving current behavior.
 * Warnings go to stderr — stdout is the stdio transport's protocol channel.
 *
 * @param defs - The full set of available tool definitions.
 * @returns The subset of `defs` enabled under the current environment
 * configuration.
 */
export function resolveEnabledTools(defs: ToolDefinition[]): ToolDefinition[] {
  const readonly = isReadonlyMode();
  const allow = parseToolList(process.env.MCP_TOOLS_ALLOWLIST);
  const deny = parseToolList(process.env.MCP_TOOLS_DENYLIST);

  const known = new Set(defs.map((d) => d.name));
  for (const name of [...allow, ...deny]) {
    if (!known.has(name)) {
      console.error(
        `[partiri-mcp] Unknown tool name "${name}" in MCP_TOOLS_ALLOWLIST/MCP_TOOLS_DENYLIST — ignored.`,
      );
    }
  }

  const allowSet = new Set(allow);
  const denySet = new Set(deny);

  const enabled = defs.filter((tool) => {
    if (denySet.has(tool.name)) return false; // denylist always wins
    if (allowSet.has(tool.name)) return true; // allowlist adds back on top of read-only
    if (readonly) return tool.annotations?.readOnlyHint === true;
    return true;
  });

  if (enabled.length === 0) {
    console.error(
      '[partiri-mcp] Tool filtering (MCP_READONLY / MCP_TOOLS_ALLOWLIST / MCP_TOOLS_DENYLIST) ' +
        'resolved to zero tools — the server will expose no tools.',
    );
  }

  return enabled;
}

/**
 * Server-wide guidance returned in the initialize response.
 *
 * @remarks
 * Codex and other clients rely on the first 512 characters being
 * self-contained — keep the whole string within that budget when editing.
 */
export const SERVER_INSTRUCTIONS =
  'Partiri Cloud MCP: manage deployments on the Partiri PaaS. Resources are ' +
  'hierarchical: workspace -> project -> service. Start with list_workspaces, ' +
  'then list_projects and list_services / get_service; deployments, volumes, ' +
  'and metrics attach to services. Secrets, environment variables, service ' +
  'deletion, and volume mutations are intentionally not exposed as tools — ' +
  'call use_partiri_cli for guidance on running the partiri CLI locally. ' +
  'All prices are in EUR.';

/**
 * Builds the MCP server instance: registers the tools enabled under the
 * current environment (see {@link resolveEnabledTools}) and the resources,
 * wiring each tool handler to catch and sanitize errors before returning
 * them to the client.
 *
 * @param client - The Partiri API client used by tool handlers.
 * @returns The configured MCP server, ready to connect to a transport.
 */
export function createServer(client: PartiriApiClient): McpServer {
  const server = new McpServer(
    {
      name: 'partiri-cloud',
      version,
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  for (const tool of resolveEnabledTools(allDefinitions)) {
    const handler = allHandlers.get(tool.name);
    if (!handler) continue;

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema.shape,
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>) => {
        try {
          return await handler(client, args);
        } catch (e) {
          return toolError(sanitizeErrorMessage((e as Error).message));
        }
      },
    );
  }

  registerResources(server);

  return server;
}
