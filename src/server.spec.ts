import { createRequire } from 'node:module';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PartiriApiClient } from './client.js';
import { allDefinitions } from './tools/index.js';
import { allResources } from './resources/index.js';
import {
  createServer,
  resolveEnabledTools,
  sanitizeErrorMessage,
  SERVER_INSTRUCTIONS,
} from './server.js';

const require = createRequire(import.meta.url);

const pkg = require('../package.json') as { version: string; name: string };

vi.stubGlobal('fetch', vi.fn());

// registerTool is generic, which collapses the spy's inferred call tuple to
// `never` — recover the (name, config) shape we actually assert on.
type RegisterToolCall = [
  string,
  { title?: string; description?: string; annotations?: unknown },
];

function registerToolCalls(
  spy: ReturnType<typeof vi.spyOn>,
): RegisterToolCall[] {
  return spy.mock.calls as unknown as RegisterToolCall[];
}

describe('createServer', () => {
  const client = new PartiriApiClient('test-key', 'https://api.example.com');

  // createServer now reads tool-filtering env vars via resolveEnabledTools.
  // Clear them so an ambient MCP_READONLY (etc.) in CI can't break the
  // "registers all tool definitions" assertion with a confusing failure.
  const ENV_KEYS = [
    'MCP_READONLY',
    'MCP_TOOLS_ALLOWLIST',
    'MCP_TOOLS_DENYLIST',
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns an McpServer instance', () => {
    const server = createServer(client);
    expect(server).toBeInstanceOf(McpServer);
  });

  it('uses the version from package.json', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pkg.version).not.toBe('0.1.0');
  });

  it('registers all tool definitions', () => {
    const toolSpy = vi.spyOn(McpServer.prototype, 'registerTool');
    createServer(client);

    const registeredNames = registerToolCalls(toolSpy).map(([name]) => name);
    for (const def of allDefinitions) {
      expect(registeredNames).toContain(def.name);
    }

    toolSpy.mockRestore();
  });

  it('registers each tool with its title and full annotations', () => {
    const toolSpy = vi.spyOn(McpServer.prototype, 'registerTool');
    createServer(client);

    for (const [name, config] of registerToolCalls(toolSpy)) {
      const def = allDefinitions.find((d) => d.name === name);
      expect(def).toBeDefined();
      expect(config.title).toBe(def!.title);
      expect(config.description).toBe(def!.description);
      expect(config.annotations).toEqual(def!.annotations);
    }

    toolSpy.mockRestore();
  });

  it('passes server-wide instructions to the McpServer', () => {
    const server = createServer(client);
    // The underlying Server carries the instructions into the initialize
    // response (also asserted end-to-end in http.spec.ts).
    const inner = server.server as unknown as { _instructions?: string };
    expect(inner._instructions).toBe(SERVER_INSTRUCTIONS);
  });

  it('registers all documentation resources', () => {
    const resourceSpy = vi.spyOn(McpServer.prototype, 'registerResource');
    createServer(client);

    expect(resourceSpy).toHaveBeenCalledTimes(allResources.length);

    resourceSpy.mockRestore();
  });
});

describe('sanitizeErrorMessage', () => {
  it('redacts HTTP URLs', () => {
    const msg =
      'Failed to reach https://internal.api.partiri.cloud:8080/v1/services';
    expect(sanitizeErrorMessage(msg)).toBe('Failed to reach [redacted-url]');
  });

  it('redacts file paths', () => {
    const msg = 'Error at /app/dist/server.js:42';
    expect(sanitizeErrorMessage(msg)).toBe('Error at [redacted-path]');
  });

  it('redacts TypeScript paths', () => {
    const msg = 'TypeError in /home/user/mcp/src/client.ts:99';
    expect(sanitizeErrorMessage(msg)).toBe('TypeError in [redacted-path]');
  });

  it('truncates long messages to 500 chars', () => {
    const msg = 'x'.repeat(1000);
    expect(sanitizeErrorMessage(msg)).toHaveLength(500);
  });

  it('preserves safe messages', () => {
    const msg = 'Service not found. The resource was not found.';
    expect(sanitizeErrorMessage(msg)).toBe(msg);
  });

  it('handles multiple URLs and paths', () => {
    const msg =
      'Error at https://a.com and /src/foo.ts:1 and https://b.com/path';
    const result = sanitizeErrorMessage(msg);
    expect(result).not.toContain('https://');
    expect(result).not.toContain('/src/foo.ts');
  });
});

describe('resolveEnabledTools (#5 tool filtering)', () => {
  const ENV_KEYS = [
    'MCP_READONLY',
    'MCP_TOOLS_ALLOWLIST',
    'MCP_TOOLS_DENYLIST',
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  // Restore env so the "registers all tool definitions" test still sees the full set.
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const names = () => resolveEnabledTools(allDefinitions).map((d) => d.name);

  it('returns the full surface when no env is set', () => {
    expect(resolveEnabledTools(allDefinitions)).toHaveLength(
      allDefinitions.length,
    );
  });

  it('MCP_READONLY registers only read-only tools', () => {
    process.env.MCP_READONLY = 'true';
    const enabled = names();

    for (const mutating of [
      'create_project',
      'create_service',
      'update_service',
      'deploy_service',
      'pause_service',
      'unpause_service',
      'validate_service', // now readOnlyHint:false (#4)
    ]) {
      expect(enabled).not.toContain(mutating);
    }
    expect(enabled).toContain('list_services');
    expect(enabled).toContain('get_service');
    // every survivor is genuinely annotated read-only
    expect(
      resolveEnabledTools(allDefinitions).every(
        (d) => d.annotations?.readOnlyHint === true,
      ),
    ).toBe(true);
  });

  it('treats 1/yes/on/TRUE as truthy for MCP_READONLY', () => {
    for (const v of ['1', 'yes', 'on', 'TRUE']) {
      process.env.MCP_READONLY = v;
      expect(names()).not.toContain('create_service');
    }
  });

  it('MCP_TOOLS_ALLOWLIST re-enables a specific tool on top of read-only', () => {
    process.env.MCP_READONLY = 'true';
    process.env.MCP_TOOLS_ALLOWLIST = 'deploy_service';
    const enabled = names();
    expect(enabled).toContain('deploy_service');
    expect(enabled).toContain('list_services');
    expect(enabled).not.toContain('create_service');
  });

  it('MCP_TOOLS_DENYLIST removes a tool, and wins over the allowlist', () => {
    process.env.MCP_TOOLS_DENYLIST = 'get_service';
    expect(names()).not.toContain('get_service');

    process.env.MCP_TOOLS_ALLOWLIST = 'get_service';
    expect(names()).not.toContain('get_service');
  });

  it('createServer registers only the resolved subset under MCP_READONLY', () => {
    process.env.MCP_READONLY = 'true';
    const toolSpy = vi.spyOn(McpServer.prototype, 'registerTool');
    createServer(new PartiriApiClient('test-key', 'https://api.example.com'));

    const registered = registerToolCalls(toolSpy).map(([name]) => name);
    expect(registered).not.toContain('create_service');
    expect(registered).toContain('get_service');

    toolSpy.mockRestore();
  });
});

// Both connector directories (Anthropic, OpenAI) require a human-readable
// title and reject annotation/behavior mismatches; missing hints fall back to
// unsafe spec defaults (destructiveHint:true, openWorldHint:true). Lock the
// metadata contract in.
describe('tool metadata completeness', () => {
  it('every tool has a unique name (≤64 chars) and a non-empty title', () => {
    const seen = new Set<string>();
    for (const def of allDefinitions) {
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.name.length).toBeLessThanOrEqual(64);
      expect(seen.has(def.name)).toBe(false);
      seen.add(def.name);
      expect(def.title.trim().length).toBeGreaterThan(0);
    }
  });

  it('every tool sets all four annotation hints explicitly', () => {
    for (const def of allDefinitions) {
      expect(typeof def.annotations.readOnlyHint, def.name).toBe('boolean');
      expect(typeof def.annotations.destructiveHint, def.name).toBe('boolean');
      expect(typeof def.annotations.idempotentHint, def.name).toBe('boolean');
      expect(typeof def.annotations.openWorldHint, def.name).toBe('boolean');
    }
  });

  it('read-only tools are never marked destructive', () => {
    for (const def of allDefinitions) {
      if (def.annotations.readOnlyHint) {
        expect(def.annotations.destructiveHint, def.name).toBe(false);
      }
    }
  });

  it('server instructions stay within the 512-char self-contained budget', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(512);
    expect(SERVER_INSTRUCTIONS.trim().endsWith('.')).toBe(true);
  });
});
