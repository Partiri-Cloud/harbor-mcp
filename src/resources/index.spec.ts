import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { allResources, registerResources } from './index.js';

vi.stubGlobal('fetch', vi.fn());

describe('allResources', () => {
  it('has no duplicate URIs', () => {
    const uris = allResources.map((r) => r.uri);
    const unique = new Set(uris);
    expect(unique.size).toBe(uris.length);
  });

  it('all URIs start with partiri://docs/', () => {
    for (const r of allResources) {
      expect(r.uri).toMatch(/^partiri:\/\/docs\//);
    }
  });

  it('all resources have non-empty name, description, and content', () => {
    for (const r of allResources) {
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
      expect(r.content.length).toBeGreaterThan(0);
    }
  });
});

describe('registerResources', () => {
  it('registers all resources on the server', () => {
    const spy = vi.spyOn(McpServer.prototype, 'registerResource');
    const server = new McpServer({ name: 'test', version: '0.0.0' });

    registerResources(server);

    expect(spy).toHaveBeenCalledTimes(allResources.length);

    const registeredUris = spy.mock.calls.map(([, uri]) => uri);
    for (const r of allResources) {
      expect(registeredUris).toContain(r.uri);
    }

    spy.mockRestore();
  });
});
