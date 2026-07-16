import { z } from 'zod';
import type { PartiriApiClient } from '../client.js';
import { toolResult } from '../errors.js';
import type { ToolDefinition, ToolHandler } from './index.js';

/**
 * @fileoverview Sensitive operations — managing workspace secrets, the
 * volume lifecycle (create / attach / detach / delete / retry), and
 * deleting or killing a service — are intentionally NOT exposed as
 * individual MCP tools. They either route long-lived credentials through
 * the model context or perform irreversible data loss.
 *
 * This tool is ADVISORY only: it never spawns a process or runs anything.
 * It returns guidance instructing the calling agent to run the `partiri`
 * CLI itself, in its own shell. The CLI authenticates independently of the
 * MCP session, so credentials and destructive actions stay entirely outside
 * the MCP server — which is essential for the remote (HTTP) transport,
 * where the server runs nowhere near the user's machine or identity.
 */

/**
 * CLI-only areas, surfaced verbatim in the guidance so the agent knows the
 * scope of what belongs on the command line.
 *
 * @remarks
 * Kept in sync with the real CLI: volume create/attach/retry have no CLI
 * subcommand (dashboard/API only).
 */
const CLI_ONLY_AREAS =
  'workspace secrets (secret create-repository / create-registry), ' +
  'volume detach/delete (partiri storage detach|delete), service kill, ' +
  'and service environment variables (partiri service env)';

/**
 * Build the advisory guidance text returned by the `use_partiri_cli` tool.
 *
 * @param action - What the agent wants to accomplish with the CLI, used
 *   only when no `command` is given (as a placeholder in the output).
 * @param command - The specific `partiri` CLI command to run, if known.
 * @returns Multi-line guidance instructing the caller to run the command
 *   themselves, listing CLI-only areas, dashboard/API-only operations, and
 *   discovery/secret-handling tips.
 */
function guidance(action: string, command: string | undefined): string {
  const commandBlock = command
    ? `  ${command}`
    : `  (no command given — discover the one for: ${action})`;

  return [
    'Run this in your own terminal — the MCP does NOT execute it. The partiri CLI',
    'authenticates independently of this MCP session.',
    '',
    commandBlock,
    '',
    `CLI-only areas: ${CLI_ONLY_AREAS}.`,
    '',
    'Not on the CLI — use the dashboard or API: creating, attaching, or',
    'retry-provisioning a volume.',
    '',
    'Service-scoped commands like `service kill` read the service ID from a local',
    '.partiri.jsonc — run them from the service directory (or `partiri service pull`',
    'there first). Only `service deploy` accepts `--service <UUID>`.',
    '',
    'Discover exact syntax first:',
    '  partiri llm guide',
    '  partiri llm capabilities -j',
    '  partiri <area> --help',
    '',
    'For secret VALUES, pass them on stdin (e.g. --token-stdin / --password-stdin)',
    'so they never hit your shell history or this context.',
  ].join('\n');
}

/**
 * Tool definitions declared by this module: `use_partiri_cli`, which returns
 * advisory guidance for running the `partiri` CLI for sensitive operations
 * (workspace secrets, volume detach/delete, service kill, service env) that
 * are intentionally not exposed as direct MCP tools.
 *
 * @remarks
 * `use_partiri_cli` only returns text — it neither reaches outside the MCP
 * process nor mutates anything. It is advertised as a read-only, safe
 * helper (`readOnlyHint: true`, `destructiveHint: false`).
 */
export const definitions: ToolDefinition[] = [
  {
    name: 'use_partiri_cli',
    title: 'Get Partiri CLI Guidance',
    description:
      'Guidance for running the locally-installed `partiri` CLI yourself for sensitive operations that are intentionally not exposed as direct MCP tools: ' +
      'managing workspace secrets (`partiri secret create-repository` / `create-registry`), detaching or deleting a volume (`partiri storage detach` / `delete`), killing a service (`partiri service kill`), and managing service environment variables (`partiri service env`). ' +
      'This tool does NOT execute anything — it returns instructions for you to run the command in your own shell. ' +
      'These operations are kept CLI-only because they pass long-lived credentials or cause irreversible data loss, and the CLI authenticates independently of the MCP session. ' +
      'Note: creating, attaching, or retry-provisioning a volume has no CLI subcommand — use the dashboard or API. Service-scoped commands like `service kill` read the service ID from a local `.partiri.jsonc` (only `service deploy` accepts `--service <UUID>`). ' +
      'Discover exact subcommands and flags at runtime — run `partiri llm guide`, `partiri llm capabilities -j`, or `partiri <area> --help` first; do not assume command syntax. ' +
      'For credential values prefer stdin (with the CLI flag that reads stdin, e.g. `--token-stdin` / `--password-stdin`) over an argument so the secret stays out of the command line and this context.',
    inputSchema: z.object({
      action: z
        .string()
        .min(1)
        .max(2000)
        .describe(
          'What you want to accomplish with the partiri CLI, e.g. "delete a service".',
        ),
      command: z
        .string()
        .max(4096)
        .optional()
        .describe(
          'The specific partiri CLI command to run, if known, e.g. "partiri service kill".',
        ),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

/** Handler implementations for the tools declared in `definitions`. */
export const handlers: Map<string, ToolHandler> = new Map([
  /**
   * Build and return the advisory CLI guidance text for the requested
   * action/command. Never executes anything itself.
   */
  [
    'use_partiri_cli',
    async (_client: PartiriApiClient, args: Record<string, unknown>) => {
      const action = args.action as string;
      const command = args.command as string | undefined;
      return toolResult(guidance(action, command));
    },
  ],
]);
