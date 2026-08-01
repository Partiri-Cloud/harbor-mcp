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

describe('scaling doc', () => {
  const scaling = allResources.find(
    (r) => r.uri === 'partiri://docs/deployments/scaling',
  );

  it('exists', () => {
    expect(scaling).toBeDefined();
  });

  it('does not claim usage-based billing', () => {
    // This doc used to say pods were "billed per second of uptime, so you only
    // pay for what you use". Long-running services are billed a flat monthly
    // rate per size, so that wording told agents an oversized pod was nearly
    // free and drove them to over-provision. Guard the exact failure mode.
    expect(scaling!.content).not.toMatch(/per second/i);
    expect(scaling!.content).not.toMatch(/only pay for what you use/i);
  });

  it('states the flat monthly, prepaid, per-replica billing model', () => {
    expect(scaling!.content).toMatch(/flat monthly rate/i);
    expect(scaling!.content).toMatch(/per region replica/i);
    expect(scaling!.content).toMatch(/renewed monthly/i);
  });

  it('tells the reader to pick the cheapest adequate pod', () => {
    expect(scaling!.content).toMatch(/cheapest pod/i);
  });

  it('points at the tools rather than the dashboard for resizing', () => {
    expect(scaling!.content).toMatch(/update_service/);
    expect(scaling!.content).not.toMatch(/service settings page/i);
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
