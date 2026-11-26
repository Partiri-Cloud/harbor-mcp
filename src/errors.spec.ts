import { describe, it, expect } from 'vitest';
import {
  parseApiError,
  toolError,
  toolResult,
  capToolResult,
  TOOL_RESULT_CHAR_BUDGET,
} from './errors.js';

describe('parseApiError GitHub codes', () => {
  async function parse(status: number, body: unknown): Promise<string> {
    return parseApiError(new Response(JSON.stringify(body), { status }));
  }

  it('adds the code and its hint instead of the status hint', async () => {
    const result = await parse(403, {
      statusCode: 403,
      error: 'github_identity_required',
      message: 'No GitHub identity',
    });
    expect(result).toContain(
      'API error 403 (github_identity_required) — No GitHub identity',
    );
    expect(result).toContain('Connect your GitHub account first');
    expect(result).toContain('partiri github setup');
    expect(result).not.toContain('workspace limit has been reached');
  });

  it('maps every allowlisted code', async () => {
    for (const code of [
      'github_app_disabled',
      'github_repo_not_accessible',
      'github_branch_not_found',
      'github_registry_switch_forbidden',
      'installation_suspended',
      'preview_service_managed',
      'dockerfile_requires_github_app',
      'github_state_invalid',
    ]) {
      const result = await parse(400, { error: code, message: 'm' });
      expect(result).toContain(`(${code})`);
      expect(result).not.toContain('Check that your configuration values');
    }
  });

  it('ignores the HTTP reason phrase in error and keeps the status hint', async () => {
    const result = await parse(403, { error: 'Forbidden', message: 'nope' });
    expect(result).toContain('API error 403 — nope');
    expect(result).not.toContain('(Forbidden)');
    expect(result).toContain('may lack permission');
  });

  it('does not treat inherited object keys as codes', async () => {
    const result = await parse(400, { error: 'constructor', message: 'x' });
    expect(result).toContain('API error 400 — x');
  });
});

describe('parseApiError', () => {
  it('extracts message from JSON body', async () => {
    const response = new Response(JSON.stringify({ message: 'Not found' }), {
      status: 404,
    });
    const result = await parseApiError(response);
    expect(result).toContain('Not found');
    expect(result).toContain('404');
  });

  it('uses default message when body is not JSON', async () => {
    const response = new Response('plain text error', { status: 500 });
    const result = await parseApiError(response);
    // json() consumes the body stream, so text() fallback can't re-read it
    expect(result).toContain('An unexpected error occurred');
  });

  it('appends hint for 401', async () => {
    const response = new Response(JSON.stringify({ message: 'Unauthorized' }), {
      status: 401,
    });
    const result = await parseApiError(response);
    expect(result).toContain("Run 'partiri auth'");
  });

  it('appends hint for 402', async () => {
    const response = new Response(
      JSON.stringify({ message: 'Payment required' }),
      {
        status: 402,
      },
    );
    const result = await parseApiError(response);
    expect(result).toContain('workspace balance is insufficient');
  });

  it('appends hint for 429', async () => {
    const response = new Response(
      JSON.stringify({ message: 'Too many requests' }),
      {
        status: 429,
      },
    );
    const result = await parseApiError(response);
    expect(result).toContain('Rate limit exceeded');
  });

  it('appends server error hint for 5xx', async () => {
    const response = new Response(
      JSON.stringify({ message: 'Internal error' }),
      {
        status: 502,
      },
    );
    const result = await parseApiError(response);
    expect(result).toContain('server-side error');
  });

  it('returns default message when body is unreadable', async () => {
    const response = new Response(null, { status: 418 });
    const result = await parseApiError(response);
    expect(result).toContain('418');
  });
});

describe('toolError', () => {
  it('returns error result with isError true', () => {
    const result = toolError('something went wrong');
    expect(result).toEqual({
      content: [{ type: 'text', text: 'something went wrong' }],
      isError: true,
    });
  });
});

describe('toolResult', () => {
  it('returns string content as-is', () => {
    const result = toolResult('hello');
    expect(result).toEqual({
      content: [{ type: 'text', text: 'hello' }],
    });
  });

  it('serializes objects as JSON', () => {
    const result = toolResult({ id: '123', name: 'test' });
    expect(getText(result)).toBe(
      JSON.stringify({ id: '123', name: 'test' }, null, 2),
    );
  });

  it('does not set isError', () => {
    const result = toolResult('data');
    expect(result).not.toHaveProperty('isError');
  });
});

function getText(result: ReturnType<typeof toolResult>): string {
  const item = result.content[0];
  if (item.type !== 'text') throw new Error('expected text content');
  return item.text;
}

describe('capToolResult', () => {
  it('passes through a result under the budget unchanged', () => {
    const input = toolResult({ id: '1', name: 'test' });
    const output = capToolResult(input);
    expect(output).toEqual(input);
  });

  it('passes through a string result under the budget unchanged', () => {
    const input = toolResult('short text');
    const output = capToolResult(input);
    expect(getText(output)).toBe('short text');
    expect(output.structuredContent).toBeUndefined();
  });

  it('truncates text content exceeding the budget', () => {
    const overBudget = 'x'.repeat(TOOL_RESULT_CHAR_BUDGET + 10_000);
    const input = toolResult(overBudget);
    const output = capToolResult(input);
    expect(getText(output).length).toBeLessThan(overBudget.length);
    expect(getText(output)).toContain('[truncated:');
  });

  it('appends a notice showing original and shown character counts when truncated', () => {
    const total = TOOL_RESULT_CHAR_BUDGET + 5_000;
    const overBudget = 'y'.repeat(total);
    const input = toolResult(overBudget);
    const output = capToolResult(input);
    expect(getText(output)).toContain(`of ${total} characters`);
  });

  it('omits structuredContent when text is truncated', () => {
    const overBudget = 'z'.repeat(TOOL_RESULT_CHAR_BUDGET + 1_000);
    const input = toolResult({ payload: overBudget });
    expect(input.structuredContent).toBeDefined();
    const output = capToolResult(input);
    expect(output.structuredContent).toBeUndefined();
  });

  it('exports TOOL_RESULT_CHAR_BUDGET as a positive number well below 100k', () => {
    expect(TOOL_RESULT_CHAR_BUDGET).toBeGreaterThan(0);
    expect(TOOL_RESULT_CHAR_BUDGET).toBeLessThan(100_000);
  });
});
