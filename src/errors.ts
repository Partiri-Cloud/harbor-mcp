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

/**
 * Builds a human-readable error message from a failed API response, adding
 * an actionable hint (from {@link STATUS_HINTS}, or a generic server-error
 * hint for 5xx) when one is available.
 *
 * @param response - The non-`ok` `fetch` `Response` to describe.
 * @returns A formatted `"API error <status> — <message>"` string, with an
 * appended hint line when applicable.
 */
export async function parseApiError(response: Response): Promise<string> {
  const status = response.status;
  let message = 'An unexpected error occurred.';

  try {
    const body = await response.json();
    if (body?.message) {
      message = body.message;
    }
  } catch {
    try {
      message = await response.text();
    } catch {
      // Use default message
    }
  }

  const hint =
    STATUS_HINTS[status] ||
    (status >= 500
      ? 'This is a server-side error. Try again later, or contact support.'
      : '');

  return hint
    ? `API error ${status} — ${message}\n  ${hint}`
    : `API error ${status} — ${message}`;
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
