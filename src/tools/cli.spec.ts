import { describe, it, expect } from 'vitest';

import { PartiriApiClient } from '../client.js';
import { handlers, definitions } from './cli.js';

function resultText(result: {
  content: { type: string; text?: string }[];
}): string {
  const first = result.content[0];
  if (!first || first.type !== 'text' || first.text === undefined) {
    throw new Error('Expected text content');
  }
  return first.text;
}

describe('use_partiri_cli tool', () => {
  const client = new PartiriApiClient('test-key', 'https://api.example.com');
  const handler = handlers.get('use_partiri_cli')!;
  const def = definitions.find((d) => d.name === 'use_partiri_cli')!;

  it('is advertised as a read-only, non-destructive advisory tool', () => {
    expect(def.annotations?.readOnlyHint).toBe(true);
    expect(def.annotations?.destructiveHint).toBe(false);
    expect(def.annotations?.idempotentHint).toBe(true);
    expect(def.annotations?.openWorldHint).toBe(false);
  });

  it('requires an action and accepts an optional command', () => {
    expect(def.inputSchema.safeParse({}).success).toBe(false);
    expect(def.inputSchema.safeParse({ action: '' }).success).toBe(false);
    expect(
      def.inputSchema.safeParse({ action: 'delete a service' }).success,
    ).toBe(true);
    expect(
      def.inputSchema.safeParse({
        action: 'tear down a service',
        command: 'partiri service kill',
      }).success,
    ).toBe(true);
  });

  it('returns advisory guidance (not an error) that the agent must run the command itself', async () => {
    const result = await handler(client, {
      action: 'tear down a service',
      command: 'partiri service kill',
    });

    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    // Echoes the specific command for the agent to run.
    expect(text).toContain('partiri service kill');
    // Makes clear the MCP does not execute anything and the CLI auths on its own.
    expect(text).toContain('does NOT execute');
    expect(text).toContain('authenticates independently');
    // Preserves the discovery + secret-handling guidance.
    expect(text).toContain('partiri llm guide');
    expect(text).toContain('--token-stdin');
  });

  it('still guides the agent when no concrete command is supplied', async () => {
    const result = await handler(client, {
      action: 'rotate a workspace secret',
    });

    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain('rotate a workspace secret');
    expect(text).toContain('partiri llm guide');
  });
});
