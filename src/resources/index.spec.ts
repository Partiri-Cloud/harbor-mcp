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

  it('states the flat monthly, prepaid, per-pod billing model', () => {
    expect(scaling!.content).toMatch(/flat monthly rate/i);
    // Charged once per POD, which is replicaCount x regions -- not once per
    // region, which understates a multi-replica service.
    expect(scaling!.content).toMatch(/per pod/i);
    expect(scaling!.content).toMatch(/renewed monthly/i);
  });

  it('tells the reader to pick the cheapest adequate pod', () => {
    expect(scaling!.content).toMatch(/cheapest pod/i);
  });

  it('points at the tools rather than the dashboard for resizing', () => {
    expect(scaling!.content).toMatch(/update_service/);
    expect(scaling!.content).not.toMatch(/service settings page/i);
  });

  // The flat-monthly model above is exactly wrong for a cronjob, which is
  // metered. A reader who stops before the exception would quote a nightly
  // job a full pod month -- off by ~99%.
  it('carves out cronjobs as metered', () => {
    expect(scaling!.content).toMatch(/metered/i);
    expect(scaling!.content).toMatch(/partiri:\/\/docs\/services\/cronjob/);
  });

  it('documents custom pod sizing and its step grid', () => {
    expect(scaling!.content).toMatch(/get_custom_pod_options/);
    expect(scaling!.content).toMatch(/step grid/i);
  });

  // list_pods publishes a request AND a limit; the doc used to claim pods had
  // a fixed allocation with no bursting, contradicting the tool's own output.
  it('distinguishes requests from limits', () => {
    expect(scaling!.content).toMatch(/cpu_request/);
    expect(scaling!.content).toMatch(/cpu_limit/);
    expect(scaling!.content).not.toMatch(/there is no bursting/i);
  });
});

describe('cronjob doc', () => {
  const cronjob = allResources.find(
    (r) => r.uri === 'partiri://docs/services/cronjob',
  );

  it('exists', () => {
    expect(cronjob).toBeDefined();
  });

  // Nothing is charged at creation; each run is debited on its duration. An
  // agent that reads this as a monthly pod price misquotes by orders of
  // magnitude, so state the model explicitly and never imply a month.
  it('states the metered billing model, not a monthly one', () => {
    expect(cronjob!.content).toMatch(/metered/i);
    expect(cronjob!.content).toMatch(
      /never.*charged a flat month|NOT billed monthly/i,
    );
    expect(cronjob!.content).toMatch(/43,200/);
  });

  it('names scheduler as the recurring/one-shot discriminator', () => {
    expect(cronjob!.content).toMatch(/one-shot/i);
    expect(cronjob!.content).toMatch(/scheduler/);
  });

  it('flags the required active deadline and the single-replica rule', () => {
    expect(cronjob!.content).toMatch(/cronjobActiveDeadlineSeconds/);
    expect(cronjob!.content).toMatch(/single replica/i);
  });

  // Suspend is owned by the API's pause flow so it stays in step with the
  // metered billing assignment; steering readers to update_service would
  // desync the two.
  it('points at pause_service rather than a suspend field', () => {
    expect(cronjob!.content).toMatch(/pause_service/);
  });
});

describe('service-fields cost documentation', () => {
  const fields = allResources.find(
    (r) => r.uri === 'partiri://docs/reference/service-fields',
  );

  it('exists', () => {
    expect(fields).toBeDefined();
  });

  // The delta carries a model per SIDE, because a switch between them is
  // exactly the case the old single `billing_model` field could not express.
  it('documents the per-side delta discriminators', () => {
    expect(fields!.content).toMatch(/current_billing_model/);
    expect(fields!.content).toMatch(/new_billing_model/);
  });

  // Converting a cronjob to a long-running type genuinely starts a monthly
  // charge; the doc must not imply the delta is zero.
  it('explains that a model switch reports the full amount', () => {
    expect(fields!.content).toMatch(/recurring/i);
    expect(fields!.content).not.toMatch(
      /monthly charge does not change because there isn't one/i,
    );
  });

  // A volume is billed a flat month on every deploy type.
  it('states that disk_monthly applies to both billing models', () => {
    expect(fields!.content).toMatch(/disk_monthly/);
    expect(fields!.content).toMatch(/both/i);
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
