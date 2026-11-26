import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Maximum character length for a tool result's text content.
 *
 * @remarks Anthropic imposes a ~25,000-token result limit. Using ~4
 * chars/token gives 100,000 chars maximum. We apply a 90% headroom (90,000
 * chars ≈ 22,500 tokens) to stay safely under the limit.
 */
export const TOOL_RESULT_CHAR_BUDGET = 90_000;

/** Actionable hint text keyed by HTTP status code, appended to API errors. */
const STATUS_HINTS: Record<number, string> = {
  400: 'Check that your configuration values are valid.',
  401: "Run 'partiri auth' to update your API key.",
  402: 'Your workspace balance is insufficient. Top up at https://partiri.cloud/settings/billing',
  403: 'Your account may lack permission, or a workspace limit has been reached.',
  404: 'The resource was not found. It may have been deleted.',
  409: 'A conflicting operation is in progress. Wait for it to finish, then retry.',
  422: 'The request data is invalid. Check your configuration values.',
  429: 'Rate limit exceeded. Please wait a moment and try again.',
};

/** Base URL of the web dashboard (`PARTIRI_WEB_URL`, default production). */
export function webBaseUrl(): string {
  return (process.env.PARTIRI_WEB_URL || 'https://partiri.cloud').replace(
    /\/+$/,
    '',
  );
}

/**
 * Where a user connects GitHub and installs the App: the GitHub card in the
 * workspace settings. Without a workspace id the page cannot be named, so the
 * text points at the dashboard's workspace settings instead.
 */
export function dashboardLocation(workspaceId?: string): string {
  return workspaceId
    ? `${webBaseUrl()}/workspace-settings/${workspaceId}`
    : `workspace settings (${webBaseUrl()})`;
}

/**
 * Hints for the GitHub integration error codes the API sends in the `error`
 * field. This is an allowlist: every other Nest error puts the HTTP reason
 * phrase ("Forbidden") in `error`, which is not a code and must not be read as
 * one.
 */
const GITHUB_CODE_HINTS: Record<string, (workspaceId?: string) => string> = {
  github_app_disabled: () =>
    "The GitHub integration isn't available in this workspace.",
  github_identity_required: (ws) =>
    `Connect your GitHub account first. The API key's owner has to do it, in the dashboard: ${dashboardLocation(ws)} → GitHub card (CLI: \`partiri github setup\`). If it was connected before, the authorization has expired: connect it again.`,
  github_installation_forbidden: () =>
    'Your GitHub account has no access to that GitHub App installation.',
  github_repo_not_accessible: () =>
    'The Partiri GitHub App, or your GitHub account, can\'t see this repository. Grant the App access to it on GitHub (the installation\'s "configure repository access" page), then retry.',
  github_branch_not_found: () => "That branch doesn't exist in the repository.",
  github_registry_switch_forbidden: () =>
    'This service deploys from GitHub. Disconnect it first (`partiri service github disconnect`).',
  installation_suspended: () =>
    'The GitHub App installation is suspended on GitHub. Unsuspend it there.',
  installation_link_inactive: () =>
    'That GitHub installation is no longer linked to this workspace. Link it again in workspace settings.',
  github_rate_limited: () =>
    'GitHub is rate-limiting requests. Wait a moment and retry.',
  github_unavailable: () => "GitHub didn't respond. Retry shortly.",
  dockerfile_requires_github_app: () =>
    'Dockerfile builds need a service connected to the GitHub App.',
  dockerfile_builds_disabled: () => "Dockerfile builds aren't available.",
  previews_disabled: () =>
    "Preview environments aren't available in this workspace.",
  preview_requires_github_app: () =>
    'Previews need a service connected to the GitHub App.',
  previews_unsupported_for_dockerfile: () =>
    "Dockerfile services don't get previews.",
  previews_unsupported_deploy_type: () =>
    'Previews are available for webservice and static services only.',
  preview_service_managed: () =>
    "This is a pull-request preview. It's managed by its parent service and the pull request: change the parent instead.",
  preview_forks_unsupported: () =>
    "Previews for pull requests from forks aren't supported.",
  preview_fork_unpinned: () => 'This fork preview has no approved commit.',
  github_state_invalid: () =>
    'The GitHub authorization expired. Start again from the dashboard.',
};

/**
 * Returns the hint for an allowlisted GitHub error code, or `undefined` for
 * any other value (including HTTP reason phrases).
 *
 * @param code - The `error` field of an API error body.
 * @param workspaceId - Workspace the dashboard link should point at, if known.
 */
export function githubCodeHint(
  code: unknown,
  workspaceId?: string,
): string | undefined {
  if (typeof code !== 'string') return undefined;
  if (!Object.prototype.hasOwnProperty.call(GITHUB_CODE_HINTS, code)) {
    return undefined;
  }
  return GITHUB_CODE_HINTS[code](workspaceId);
}

/** A failed API call, carrying the status and the allowlisted code if any. */
export class PartiriApiError extends Error {
  /** HTTP status of the failed response. */
  readonly status: number;
  /** Allowlisted API error code (see {@link githubCodeHint}), if any. */
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'PartiriApiError';
    this.status = status;
    this.code = code;
  }
}

/** Parsed form of a failed API response. */
export interface ParsedApiError {
  /** Formatted `API error <status> ... — <message>` text with its hint. */
  text: string;
  /** HTTP status. */
  status: number;
  /** Allowlisted API error code, if the body carried one. */
  code?: string;
}

/**
 * Parses a failed API response into its formatted text, status and code.
 *
 * @param response - The non-`ok` `fetch` `Response` to describe.
 * @returns The formatted message, status, and allowlisted code (if any).
 */
export async function readApiError(
  response: Response,
): Promise<ParsedApiError> {
  const status = response.status;
  let message = 'An unexpected error occurred.';
  let code: string | undefined;

  try {
    const body = await response.json();
    if (body?.message) {
      message = body.message;
    }
    if (githubCodeHint(body?.error) !== undefined) {
      code = body.error as string;
    }
  } catch {
    try {
      message = await response.text();
    } catch {
      // Use default message
    }
  }

  const hint =
    (code ? githubCodeHint(code) : undefined) ||
    STATUS_HINTS[status] ||
    (status >= 500
      ? 'This is a server-side error. Try again later, or contact support.'
      : '');

  const head = code
    ? `API error ${status} (${code}) — ${message}`
    : `API error ${status} — ${message}`;
  return { text: hint ? `${head}\n  ${hint}` : head, status, code };
}

/**
 * Builds a human-readable error message from a failed API response, adding
 * an actionable hint (a code-specific one for the GitHub integration codes,
 * else from {@link STATUS_HINTS}, or a generic server-error hint for 5xx).
 *
 * @param response - The non-`ok` `fetch` `Response` to describe.
 * @returns A formatted `"API error <status> — <message>"` string, with an
 * appended hint line when applicable.
 */
export async function parseApiError(response: Response): Promise<string> {
  return (await readApiError(response)).text;
}

/**
 * Builds an MCP tool error result.
 *
 * @param message - The error message to display.
 * @param hint - Optional actionable hint appended after the message.
 * @returns A `CallToolResult` with `isError: true`.
 */
export function toolError(message: string, hint?: string): CallToolResult {
  const text = hint ? `${message}\n\nHint: ${hint}` : message;
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

/**
 * Builds a successful MCP tool result from arbitrary data.
 *
 * @param data - The result payload. Strings are used as-is; other values are
 * JSON-stringified for the text content, and objects are additionally
 * attached as `structuredContent`.
 * @returns A `CallToolResult` with text content (and `structuredContent`
 * when `data` is a non-null object).
 */
export function toolResult(data: unknown): CallToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const result: CallToolResult = { content: [{ type: 'text', text }] };
  if (typeof data === 'object' && data !== null) {
    result.structuredContent = data as Record<string, unknown>;
  }
  return result;
}

/**
 * Enforces the Anthropic 25,000-token result-size limit using a char-budget
 * proxy ({@link TOOL_RESULT_CHAR_BUDGET} chars). When the text content of a
 * `CallToolResult` exceeds the budget, the text is truncated and a notice is
 * appended.
 *
 * @param result - The tool result to cap.
 * @returns `result` unchanged if under budget (or not text content);
 * otherwise a new result with truncated text and no `structuredContent`.
 * @remarks `structuredContent` is intentionally OMITTED on truncation —
 * keeping it would smuggle the oversized payload back through a different
 * field.
 */
export function capToolResult(result: CallToolResult): CallToolResult {
  const firstContent = result.content[0];
  if (!firstContent || firstContent.type !== 'text') return result;

  const { text } = firstContent;
  if (text.length <= TOOL_RESULT_CHAR_BUDGET) return result;

  const truncated =
    text.slice(0, TOOL_RESULT_CHAR_BUDGET) +
    `\n\n[truncated: showing first ${TOOL_RESULT_CHAR_BUDGET} of ${text.length} characters]`;

  return {
    content: [{ type: 'text', text: truncated }],
    // structuredContent is omitted — the full payload is too large to return.
  };
}
