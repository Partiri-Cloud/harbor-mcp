import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PartiriApiClient } from '../client.js';
import {
  handlers as serviceHandlers,
  definitions as serviceDefinitions,
} from './services.js';
import { handlers as resourceHandlers } from './resources.js';
import {
  handlers as validateHandlers,
  definitions as validateDefinitions,
} from './validate.js';
import { handlers as storageHandlers } from './storage.js';
import { quote, recurringMonthly } from './cost.js';
import { firstBlockingFailure } from './service-rules.js';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyOkResponse() {
  return new Response(null, { status: 200 });
}

function resultText(result: {
  content: { type: string; text?: string }[];
}): string {
  const first = result.content[0];
  if (!first || first.type !== 'text' || first.text === undefined) {
    throw new Error('Expected text content');
  }
  return first.text;
}

const WS_ID = '11111111-1111-1111-1111-111111111111';
const SVC_ID = '22222222-2222-2222-2222-222222222222';
const SECRET_ID = '33333333-3333-3333-3333-333333333333';
const REGION_ID = '44444444-4444-4444-4444-444444444444';
const POD_ID = '55555555-5555-5555-5555-555555555555';
const PROJ_ID = '66666666-6666-6666-6666-666666666666';
const VOL_ID = '77777777-7777-7777-7777-777777777777';

describe('Region read from primary replica', () => {
  let client: PartiriApiClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new PartiriApiClient('test-key', 'https://api.example.com');
  });

  afterEach(() => vi.restoreAllMocks());

  it('get_service derives fk_region from primary replica', async () => {
    const mockService = {
      id: SVC_ID,
      name: 'my-svc',
      deploy_type: 'webservice',
      runtime: 'node',
      fk_pod: POD_ID,
      replicas: [
        { id: 'rep-1', fk_region: 'non-primary-region', is_primary: false },
        { id: 'rep-2', fk_region: REGION_ID, is_primary: true },
      ],
    };
    fetchMock.mockResolvedValue(jsonResponse(mockService));
    const handler = serviceHandlers.get('get_service')!;
    const result = await handler(client, { serviceId: SVC_ID });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(resultText(result));
    expect(data.fk_region).toBe(REGION_ID);
    expect(data.replicas).toHaveLength(2);
  });

  it('get_service falls back to first replica when none is primary', async () => {
    const mockService = {
      id: SVC_ID,
      name: 'my-svc',
      replicas: [{ id: 'rep-1', fk_region: REGION_ID, is_primary: false }],
    };
    fetchMock.mockResolvedValue(jsonResponse(mockService));
    const handler = serviceHandlers.get('get_service')!;
    const result = await handler(client, { serviceId: SVC_ID });

    const data = JSON.parse(resultText(result));
    expect(data.fk_region).toBe(REGION_ID);
  });

  it('get_service sets fk_region to null when replicas is empty', async () => {
    const mockService = {
      id: SVC_ID,
      name: 'my-svc',
      replicas: [],
    };
    fetchMock.mockResolvedValue(jsonResponse(mockService));
    const handler = serviceHandlers.get('get_service')!;
    const result = await handler(client, { serviceId: SVC_ID });

    const data = JSON.parse(resultText(result));
    expect(data.fk_region).toBeNull();
  });
});

describe('name > 16 rejected by Zod', () => {
  it('create_service schema rejects name longer than 16 chars', () => {
    const def = serviceDefinitions.find((d) => d.name === 'create_service')!;
    expect(
      def.inputSchema.safeParse({
        name: 'a'.repeat(17),
        deployType: 'webservice',
        runtime: 'node',
        rootPath: '.',
        fkProject: PROJ_ID,
        fkRegion: REGION_ID,
        fkPod: POD_ID,
      }).success,
    ).toBe(false);
    expect(
      def.inputSchema.safeParse({
        name: 'a'.repeat(16),
        deployType: 'webservice',
        runtime: 'node',
        rootPath: '.',
        fkProject: PROJ_ID,
        fkRegion: REGION_ID,
        fkPod: POD_ID,
      }).success,
    ).toBe(true);
  });

  it('update_service schema rejects name longer than 16 chars', () => {
    const def = serviceDefinitions.find((d) => d.name === 'update_service')!;
    expect(
      def.inputSchema.safeParse({
        serviceId: SVC_ID,
        name: 'toolong-service-x',
      }).success,
    ).toBe(false);
    expect(
      def.inputSchema.safeParse({ serviceId: SVC_ID, name: 'exactlyok-123456' })
        .success,
    ).toBe(true);
  });
});

describe('worker deploy_type', () => {
  it('create_service schema accepts deployType worker', () => {
    const def = serviceDefinitions.find((d) => d.name === 'create_service')!;
    expect(
      def.inputSchema.safeParse({
        name: 'my-worker',
        deployType: 'worker',
        runtime: 'node',
        rootPath: '.',
        fkProject: PROJ_ID,
        fkRegion: REGION_ID,
        fkPod: POD_ID,
      }).success,
    ).toBe(true);
  });

  it('update_service schema accepts deployType worker', () => {
    const def = serviceDefinitions.find((d) => d.name === 'update_service')!;
    expect(
      def.inputSchema.safeParse({
        serviceId: SVC_ID,
        deployType: 'worker',
      }).success,
    ).toBe(true);
  });
});

describe('Pricing and balance tools', () => {
  let client: PartiriApiClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new PartiriApiClient('test-key', 'https://api.example.com');
  });

  afterEach(() => vi.restoreAllMocks());

  describe('get_pricing', () => {
    it('calls GET /resources/pricing with region query param', async () => {
      const mockPricing = {
        pods: [{ fk_pod: POD_ID, price: 10, perMinute: 0.000231 }],
        volume_price_per_gb: 0.5,
      };
      fetchMock.mockResolvedValue(jsonResponse(mockPricing));
      const handler = resourceHandlers.get('get_pricing')!;
      const result = await handler(client, { regionId: REGION_ID });

      const [url] = fetchMock.mock.calls[0];
      expect(url.pathname).toBe('/resources/pricing');
      expect(url.searchParams.get('region')).toBe(REGION_ID);
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(resultText(result));
      expect(data.volume_price_per_gb).toBe(0.5);
      expect(data.pods[0].fk_pod).toBe(POD_ID);
      expect(data.pods[0].price).toBe(10);
    });

    it('returns toolError on API failure', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ message: 'Not found' }, 404));
      const handler = resourceHandlers.get('get_pricing')!;
      const result = await handler(client, { regionId: REGION_ID });
      expect(result.isError).toBe(true);
    });

    // The response covers catalogue pods only, so a custom-sized pod has to be
    // named or it comes back absent and every `?? 0` fallback quotes it free.
    it('forwards podIds so a custom pod can be priced', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ pods: [], volume_price_per_gb: 0 }),
      );
      const handler = resourceHandlers.get('get_pricing')!;
      await handler(client, { regionId: REGION_ID, podIds: [POD_ID] });

      const [url] = fetchMock.mock.calls[0];
      expect(url.searchParams.get('pods')).toBe(POD_ID);
    });

    it('omits the pods param when none are named', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ pods: [], volume_price_per_gb: 0 }),
      );
      const handler = resourceHandlers.get('get_pricing')!;
      await handler(client, { regionId: REGION_ID });

      const [url] = fetchMock.mock.calls[0];
      expect(url.searchParams.has('pods')).toBe(false);
    });
  });

  describe('get_custom_pod_options', () => {
    it('joins every region so the range is the intersection', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ available: true, min_millicores: 500, rates: [] }),
      );
      const handler = resourceHandlers.get('get_custom_pod_options')!;
      const result = await handler(client, {
        regionIds: [REGION_ID, '00000000-0000-4000-8000-000000000099'],
      });

      const [url] = fetchMock.mock.calls[0];
      expect(url.pathname).toBe('/resources/custom-pod');
      expect(url.searchParams.get('regions')).toBe(
        `${REGION_ID},00000000-0000-4000-8000-000000000099`,
      );
      expect(JSON.parse(resultText(result)).available).toBe(true);
    });

    it('returns toolError on API failure', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ message: 'boom' }, 500));
      const handler = resourceHandlers.get('get_custom_pod_options')!;
      const result = await handler(client, { regionIds: [REGION_ID] });
      expect(result.isError).toBe(true);
    });
  });

  describe('get_balance', () => {
    it('calls GET /balances/:workspaceId', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ currency: 'EUR', amount: 25.0, updated_at: null }),
      );
      const handler = resourceHandlers.get('get_balance')!;
      const result = await handler(client, { workspaceId: WS_ID });

      const [url] = fetchMock.mock.calls[0];
      expect(url.pathname).toBe(`/balances/${WS_ID}`);
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(resultText(result));
      expect(data.balance.currency).toBe('EUR');
      expect(data.balance.amount).toBe(25.0);
    });

    it('degrades gracefully on 403 (billing:r not held)', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ message: 'Forbidden' }, 403));
      const handler = resourceHandlers.get('get_balance')!;
      const result = await handler(client, { workspaceId: WS_ID });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(resultText(result));
      expect(data.balance).toBeNull();
      expect(data.note).toBeDefined();
    });
  });
});

describe('cronjob services', () => {
  let client: PartiriApiClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new PartiriApiClient('test-key', 'https://api.example.com');
  });

  afterEach(() => vi.restoreAllMocks());

  // cronjob was missing from the deployType enum entirely, so an agent could
  // not create one at all.
  it('accepts deployType cronjob and maps the batch fields to snake_case', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: 'svc-1', fk_pod: POD_ID, replicas: [] }),
    );
    const handler = serviceHandlers.get('create_service')!;
    await handler(client, {
      name: 'nightly',
      deployType: 'cronjob',
      runtime: 'node',
      rootPath: '.',
      fkProject: PROJ_ID,
      fkRegion: REGION_ID,
      fkPod: POD_ID,
      registryUrl: 'ghcr.io/org/img:latest',
      scheduler: '0 3 * * *',
      cronjobTimeZone: 'Europe/Lisbon',
      cronjobActiveDeadlineSeconds: 300,
      cronjobConcurrencyPolicy: 'Forbid',
      cronjobCommand: ['node', 'job.js'],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.deploy_type).toBe('cronjob');
    expect(body.scheduler).toBe('0 3 * * *');
    expect(body.cronjob_time_zone).toBe('Europe/Lisbon');
    expect(body.cronjob_active_deadline_seconds).toBe(300);
    expect(body.cronjob_concurrency_policy).toBe('Forbid');
    expect(body.cronjob_command).toEqual(['node', 'job.js']);
  });

  // The deadline bounds a run's worst-case cost, so the API caps it at an hour.
  it('rejects a deadline beyond the one-hour cap', () => {
    const def = serviceDefinitions.find((d) => d.name === 'create_service')!;
    const parsed = def.inputSchema.safeParse({
      name: 'nightly',
      deployType: 'cronjob',
      runtime: 'node',
      rootPath: '.',
      fkProject: PROJ_ID,
      fkRegion: REGION_ID,
      fkPod: POD_ID,
      cronjobActiveDeadlineSeconds: 7200,
    });
    expect(parsed.success).toBe(false);
  });

  it('carries the batch fields through update_service too', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'svc-1' }));
    const handler = serviceHandlers.get('update_service')!;
    await handler(client, {
      serviceId: SVC_ID,
      scheduler: '*/15 * * * *',
      cronjobActiveDeadlineSeconds: 600,
    });

    const call = fetchMock.mock.calls.at(-1)!;
    const body = JSON.parse(call[1].body as string);
    expect(body.scheduler).toBe('*/15 * * * *');
    expect(body.cronjob_active_deadline_seconds).toBe(600);
  });

  it('maps the pod-retention and history fields to snake_case', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'svc-1' }));
    const handler = serviceHandlers.get('update_service')!;
    await handler(client, {
      serviceId: SVC_ID,
      cronjobTtlSecondsAfterFinished: 900,
      cronjobStartingDeadlineSeconds: 120,
      cronjobSuccessfulJobsHistoryLimit: 3,
      cronjobFailedJobsHistoryLimit: 5,
    });

    const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string);
    expect(body.cronjob_ttl_seconds_after_finished).toBe(900);
    expect(body.cronjob_starting_deadline_seconds).toBe(120);
    expect(body.cronjob_successful_jobs_history_limit).toBe(3);
    expect(body.cronjob_failed_jobs_history_limit).toBe(5);
  });

  // The API owns cronjob_suspend and drives it from pause/unpause so it stays
  // in step with the metered billing assignment. Accepting it here would stop
  // the schedule while billing still believed the service was live.
  it('does not accept cronjobSuspend on create or update', () => {
    for (const name of ['create_service', 'update_service']) {
      const def = serviceDefinitions.find((d) => d.name === name)!;
      expect(Object.keys(def.inputSchema.shape)).not.toContain(
        'cronjobSuspend',
      );
    }
  });

  it('rejects a cronjob with no active deadline', async () => {
    const handler = serviceHandlers.get('create_service')!;
    const result = await handler(client, {
      name: 'nightly',
      deployType: 'cronjob',
      runtime: 'node',
      rootPath: '.',
      fkProject: PROJ_ID,
      fkRegion: REGION_ID,
      fkPod: POD_ID,
      registryUrl: 'ghcr.io/org/img:latest',
      scheduler: '0 3 * * *',
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('cronjobActiveDeadlineSeconds');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a cronjob asking for more than one replica', async () => {
    const handler = serviceHandlers.get('create_service')!;
    const result = await handler(client, {
      name: 'nightly',
      deployType: 'cronjob',
      runtime: 'node',
      rootPath: '.',
      fkProject: PROJ_ID,
      fkRegion: REGION_ID,
      fkPod: POD_ID,
      registryUrl: 'ghcr.io/org/img:latest',
      cronjobActiveDeadlineSeconds: 300,
      replicaCount: 3,
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('single replica');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A cronjob is charged nothing at creation; each run is debited on its
  // duration. Quoting a flat month overstated the cost by ~99%.
  it('quotes a cronjob per run, never as a flat month', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ id: SVC_ID, fk_pod: POD_ID, replicas: [] }, 201),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          pods: [{ fk_pod: POD_ID, price: 43.2, perMinute: 0.001 }],
          volume_price_per_gb: 0,
        }),
      );

    const handler = serviceHandlers.get('create_service')!;
    const result = await handler(client, {
      name: 'nightly',
      deployType: 'cronjob',
      runtime: 'node',
      rootPath: '.',
      fkProject: PROJ_ID,
      fkRegion: REGION_ID,
      fkPod: POD_ID,
      registryUrl: 'ghcr.io/org/img:latest',
      scheduler: '0 3 * * *',
      cronjobActiveDeadlineSeconds: 300,
    });

    const data = JSON.parse(resultText(result));
    expect(data.cost_estimate.billing_model).toBe('metered');
    expect(data.cost_estimate.pod_monthly).toBeUndefined();
    expect(data.cost_estimate.total_monthly).toBeUndefined();
    expect(data.cost_estimate.per_minute).toBe(0.001);
    // 300s deadline -> 5 billed minutes at 0.001/min
    expect(data.cost_estimate.max_cost_per_run).toBe(0.005);
  });

  it('still quotes a flat month for a non-metered type', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ id: SVC_ID, fk_pod: POD_ID, replicas: [] }, 201),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          pods: [{ fk_pod: POD_ID, price: 10, perMinute: 0.001 }],
          volume_price_per_gb: 0,
        }),
      );

    const handler = serviceHandlers.get('create_service')!;
    const result = await handler(client, {
      name: 'api',
      deployType: 'worker',
      runtime: 'node',
      rootPath: '.',
      fkProject: PROJ_ID,
      fkRegion: REGION_ID,
      fkPod: POD_ID,
      registryUrl: 'ghcr.io/org/img:latest',
      replicaCount: 2,
    });

    const data = JSON.parse(resultText(result));
    expect(data.cost_estimate.billing_model).toBe('flat_monthly');
    expect(data.cost_estimate.pod_unit_monthly).toBe(10);
    expect(data.cost_estimate.replica_count).toBe(2);
    expect(data.cost_estimate.pod_monthly).toBe(20);
    expect(data.cost_estimate.total_monthly).toBe(20);
  });

  // The old `?? 0` fallback reported an unresolvable pod as free.
  it('omits the estimate rather than quoting an unpriceable pod as free', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ id: SVC_ID, fk_pod: POD_ID, replicas: [] }, 201),
      )
      .mockResolvedValueOnce(
        jsonResponse({ pods: [], volume_price_per_gb: 0 }),
      );

    const handler = serviceHandlers.get('create_service')!;
    const result = await handler(client, {
      name: 'api',
      deployType: 'webservice',
      runtime: 'node',
      rootPath: '.',
      fkProject: PROJ_ID,
      fkRegion: REGION_ID,
      fkPod: POD_ID,
      registryUrl: 'ghcr.io/org/img:latest',
    });

    const data = JSON.parse(resultText(result));
    expect(data.cost_estimate).toBeUndefined();
  });
});

// update_service's cost delta had no coverage of the metered path at all,
// which is how it shipped reporting a cronjob as already paying a month it
// never paid. Every branch of the delta is exercised here.
describe('update_service cost delta across billing models', () => {
  let client: PartiriApiClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new PartiriApiClient('test-key', 'https://api.example.com');
  });

  afterEach(() => vi.restoreAllMocks());

  /** Mock getService + getPricing, then the update itself. */
  function mockService(deployType: string, price = 20) {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: SVC_ID,
          deploy_type: deployType,
          fk_pod: POD_ID,
          replica_count: 1,
          replicas: [{ id: 'r1', fk_region: REGION_ID, is_primary: true }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          pods: [{ fk_pod: POD_ID, price, perMinute: 0.00046 }],
          volume_price_per_gb: 0,
        }),
      )
      .mockResolvedValue(jsonResponse({ id: SVC_ID }));
  }

  const runUpdate = async (args: Record<string, unknown>) => {
    const result = await serviceHandlers.get('update_service')!(client, {
      serviceId: SVC_ID,
      ...args,
    });
    return JSON.parse(resultText(result)).cost_delta;
  };

  // The headline defect: a cronjob pays no monthly charge, so converting it to
  // a flat-billed type STARTS a EUR 20/month charge. This reported 0.
  it('reports the full new monthly when a cronjob becomes flat-billed', async () => {
    mockService('cronjob');
    const d = await runUpdate({ deployType: 'webservice', fkPod: POD_ID });

    expect(d.current_billing_model).toBe('metered');
    expect(d.new_billing_model).toBe('flat_monthly');
    expect(d.current_monthly).toBe(0);
    expect(d.new_monthly).toBe(20);
    expect(d.delta_monthly).toBe(20);
    expect(d.current_per_minute).toBe(0.00046);
    expect(d.note).toMatch(/billing model changes/i);
  });

  it('reports the saving when a flat service becomes a cronjob', async () => {
    mockService('webservice');
    const d = await runUpdate({
      deployType: 'cronjob',
      cronjobActiveDeadlineSeconds: 300,
    });

    expect(d.current_monthly).toBe(20);
    expect(d.new_monthly).toBe(0);
    expect(d.delta_monthly).toBe(-20);
    expect(d.new_per_minute).toBe(0.00046);
  });

  // A deployType-only change is the largest billing change this tool can make
  // and used to produce no delta at all.
  it('produces a delta when only deployType changes', async () => {
    mockService('webservice');
    const d = await runUpdate({
      deployType: 'cronjob',
      cronjobActiveDeadlineSeconds: 300,
    });
    expect(d).toBeDefined();
  });

  it('compares per-minute rates when both sides stay metered', async () => {
    mockService('cronjob');
    const d = await runUpdate({ fkPod: POD_ID });

    expect(d.current_billing_model).toBe('metered');
    expect(d.new_billing_model).toBe('metered');
    expect(d.current_per_minute).toBe(0.00046);
    expect(d.new_per_minute).toBe(0.00046);
    expect(d.delta_monthly).toBe(0);
    expect(d.note).toBeUndefined();
  });

  it('still reports a plain flat-to-flat delta unchanged', async () => {
    mockService('webservice', 20);
    const d = await runUpdate({ replicaCount: 3 });

    expect(d.current_billing_model).toBe('flat_monthly');
    expect(d.current_monthly).toBe(20);
    expect(d.new_monthly).toBe(60);
    expect(d.delta_monthly).toBe(40);
  });
});

describe('cost quote shape', () => {
  // A volume is charged a flat month on EVERY deploy type, so dropping it for
  // a cronjob silently discarded a real recurring cost.
  it('includes disk_monthly in a metered quote', () => {
    const q = quote({
      deployType: 'cronjob',
      podMonthly: 43.2,
      perMinute: 0.001,
      activeDeadlineSeconds: 300,
      diskMonthly: 10,
    });
    expect(q).toMatchObject({
      billing_model: 'metered',
      per_minute: 0.001,
      max_cost_per_run: 0.005,
      disk_monthly: 10,
    });
  });

  it('counts only the volume as a metered service recurring cost', () => {
    const q = quote({
      deployType: 'cronjob',
      podMonthly: 43.2,
      diskMonthly: 10,
    });
    expect(recurringMonthly(q)).toBe(10);
  });

  it('counts the whole total for a flat service', () => {
    const q = quote({
      deployType: 'webservice',
      podMonthly: 20,
      diskMonthly: 1,
    });
    expect(recurringMonthly(q)).toBe(21);
  });

  // disk was rounded independently AND again inside the total, so the parts a
  // caller reads could disagree with the total by a cent.
  it.each([
    [10, 0.015],
    [10, 0.005],
    [33.33, 0.014],
    [7.77, 2.225],
  ])('parts sum to the total for pod %s + disk %s', (pod, disk) => {
    const q = quote({
      deployType: 'webservice',
      podMonthly: pod,
      diskMonthly: disk,
    }) as { pod_monthly: number; disk_monthly: number; total_monthly: number };

    expect(Number((q.pod_monthly + q.disk_monthly).toFixed(2))).toBe(
      q.total_monthly,
    );
  });

  it('yields no quote at all when the pod could not be priced', () => {
    expect(quote({ deployType: 'webservice', podMonthly: null })).toBeNull();
  });
});

describe('validate_service tool', () => {
  let client: PartiriApiClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new PartiriApiClient('test-key', 'https://api.example.com');
  });

  afterEach(() => vi.restoreAllMocks());

  const validArgs = {
    name: 'my-service',
    deployType: 'webservice',
    runtime: 'node',
    rootPath: '.',
    fkRegion: REGION_ID,
    fkPod: POD_ID,
    repositoryUrl: 'https://github.com/org/repo',
    buildCommand: 'npm run build',
    runCommand: 'npm start',
  };

  // A custom size satisfies the pod requirement: the server takes custom_pod in
  // place of fk_pod and resolves the class itself. Reporting "pod is required"
  // would send the caller hunting a bug that isn't there.
  it('accepts a customPod in place of fkPod', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ available: true, rates: [] }));
    const handler = validateHandlers.get('validate_service')!;
    const { fkPod: _drop, ...noPod } = validArgs;
    const result = await handler(client, {
      ...noPod,
      customPod: { vcpuMillicores: 1000, memoryMib: 1024 },
    });

    const data = JSON.parse(resultText(result));
    const podCheck = data.checks.find(
      (c: { field: string }) => c.field === 'fk_pod',
    );
    expect(podCheck.ok).toBe(true);
  });

  it('fails when neither fkPod nor customPod is given', async () => {
    const handler = validateHandlers.get('validate_service')!;
    const { fkPod: _drop, ...noPod } = validArgs;
    const result = await handler(client, noPod);

    const data = JSON.parse(resultText(result));
    const podCheck = data.checks.find(
      (c: { field: string }) => c.field === 'fk_pod',
    );
    expect(podCheck.ok).toBe(false);
    expect(data.valid).toBe(false);
  });

  // Every region runs replicaCount pods and is billed a month per pod, so a
  // quote that ignores it understates the real cost.
  it('scales the cost estimate by replicaCount', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        pods: [{ fk_pod: POD_ID, price: 10, perMinute: 0 }],
        volume_price_per_gb: 0,
      }),
    );
    const handler = validateHandlers.get('validate_service')!;
    const result = await handler(client, { ...validArgs, replicaCount: 3 });

    const data = JSON.parse(resultText(result));
    expect(data.cost_estimate.pod_monthly).toBe(30);
    expect(data.cost_estimate.total_monthly).toBe(30);
  });

  it('flags a config that sets both fkPod and customPod', async () => {
    const handler = validateHandlers.get('validate_service')!;
    const result = await handler(client, {
      ...validArgs,
      customPod: { vcpuMillicores: 1000, memoryMib: 1024 },
    });

    const data = JSON.parse(resultText(result));
    const podCheck = data.checks.find(
      (c: { field: string }) => c.field === 'fk_pod',
    );
    expect(podCheck.ok).toBe(false);
    expect(data.valid).toBe(false);
  });

  // create_service points callers here to preflight, so a deploy type it
  // accepts must not be rejected at this tool's schema boundary.
  it('accepts every deployType create_service accepts', () => {
    const createDef = serviceDefinitions.find(
      (d) => d.name === 'create_service',
    )!;
    const createTypes = createDef.inputSchema.shape.deployType.options;
    const validateDef = validateDefinitions.find(
      (d) => d.name === 'validate_service',
    )!;
    const validateTypes = validateDef.inputSchema.shape.deployType.options;

    expect(validateTypes).toEqual(expect.arrayContaining([...createTypes]));
    expect(validateTypes).toContain('cronjob');
  });

  it('flags a cronjob missing its active deadline', async () => {
    const handler = validateHandlers.get('validate_service')!;
    const result = await handler(client, {
      ...validArgs,
      deployType: 'cronjob',
      scheduler: '0 3 * * *',
    });

    const data = JSON.parse(resultText(result));
    const deadline = data.checks.find(
      (c: { field: string }) => c.field === 'cronjob_active_deadline_seconds',
    );
    expect(deadline.ok).toBe(false);
    expect(data.valid).toBe(false);
  });

  it('flags a cronjob asking for more than one replica', async () => {
    const handler = validateHandlers.get('validate_service')!;
    const result = await handler(client, {
      ...validArgs,
      deployType: 'cronjob',
      cronjobActiveDeadlineSeconds: 300,
      replicaCount: 2,
    });

    const data = JSON.parse(resultText(result));
    const replicas = data.checks.find(
      (c: { field: string }) => c.field === 'replica_count',
    );
    expect(replicas.ok).toBe(false);
  });

  it('estimates a cronjob per run instead of per month', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        pods: [{ fk_pod: POD_ID, price: 43.2, perMinute: 0.001 }],
        volume_price_per_gb: 0,
      }),
    );
    const handler = validateHandlers.get('validate_service')!;
    const result = await handler(client, {
      ...validArgs,
      deployType: 'cronjob',
      scheduler: '0 3 * * *',
      cronjobActiveDeadlineSeconds: 120,
    });

    const data = JSON.parse(resultText(result));
    expect(data.cost_estimate.billing_model).toBe('metered');
    expect(data.cost_estimate.total_monthly).toBeUndefined();
    expect(data.cost_estimate.max_cost_per_run).toBe(0.002);
  });

  // Quoting an unresolvable pod as free is worse than quoting nothing.
  it('omits the estimate when the pod has no price row', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ pods: [], volume_price_per_gb: 0.5 }),
    );
    const handler = validateHandlers.get('validate_service')!;
    const result = await handler(client, { ...validArgs, diskSizeGb: 2 });

    const data = JSON.parse(resultText(result));
    expect(data.cost_estimate).toBeUndefined();
  });

  it('returns valid=true for correct config', async () => {
    const handler = validateHandlers.get('validate_service')!;
    const result = await handler(client, validArgs);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(resultText(result));
    expect(data.valid).toBe(true);
  });

  it('rejects name longer than 16 chars', async () => {
    const handler = validateHandlers.get('validate_service')!;
    const result = await handler(client, {
      ...validArgs,
      name: 'toolongservicename',
    });

    const data = JSON.parse(resultText(result));
    expect(data.valid).toBe(false);
    expect(
      data.checks.find((c: { field: string }) => c.field === 'name_length')?.ok,
    ).toBe(false);
  });

  it('rejects both repo and registry set', async () => {
    const handler = validateHandlers.get('validate_service')!;
    const result = await handler(client, {
      ...validArgs,
      registryUrl: 'ghcr.io/org/image:tag',
    });

    const data = JSON.parse(resultText(result));
    expect(data.valid).toBe(false);
    const sourceCheck = data.checks.find(
      (c: { field: string }) => c.field === 'source',
    );
    expect(sourceCheck?.ok).toBe(false);
    expect(sourceCheck?.message).toContain('both');
  });

  it('rejects static deploy_type with registry source', async () => {
    const handler = validateHandlers.get('validate_service')!;
    const result = await handler(client, {
      ...validArgs,
      deployType: 'static',
      repositoryUrl: undefined,
      registryUrl: 'ghcr.io/org/image:tag',
    });

    const data = JSON.parse(resultText(result));
    const check = data.checks.find(
      (c: { field: string }) => c.field === 'deploy_type/static',
    );
    expect(check?.ok).toBe(false);
  });

  it('accepts worker deploy_type with run_command', async () => {
    const handler = validateHandlers.get('validate_service')!;
    const result = await handler(client, {
      ...validArgs,
      deployType: 'worker',
    });

    const data = JSON.parse(resultText(result));
    expect(data.valid).toBe(true);
  });

  it('rejects worker deploy_type missing run_command for a repo source', async () => {
    const handler = validateHandlers.get('validate_service')!;
    const result = await handler(client, {
      ...validArgs,
      deployType: 'worker',
      runCommand: undefined,
    });

    const data = JSON.parse(resultText(result));
    expect(data.valid).toBe(false);
    const check = data.checks.find(
      (c: { field: string }) => c.field === 'run_command',
    );
    expect(check?.ok).toBe(false);
  });

  it('includes cost_estimate when pricing is available', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        pods: [{ fk_pod: POD_ID, price: 10, perMinute: 0.000231 }],
        volume_price_per_gb: 0.5,
      }),
    );
    const handler = validateHandlers.get('validate_service')!;
    const result = await handler(client, { ...validArgs, diskSizeGb: 2 });

    const data = JSON.parse(resultText(result));
    expect(data.cost_estimate).toBeDefined();
    expect(data.cost_estimate.pod_monthly).toBe(10);
    expect(data.cost_estimate.disk_monthly).toBe(1.0); // 0.5 * 2
    expect(data.cost_estimate.total_monthly).toBe(11.0);
  });

  it('includes balance_note when balance is low', async () => {
    // First call: pricing, second call: balance
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          pods: [{ fk_pod: POD_ID, price: 100, perMinute: 0.00231 }],
          volume_price_per_gb: 0,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ currency: 'EUR', amount: 5.0, updated_at: null }),
      );

    const handler = validateHandlers.get('validate_service')!;
    const result = await handler(client, { ...validArgs, workspaceId: WS_ID });

    const data = JSON.parse(resultText(result));
    expect(data.balance_note).toBeDefined();
    expect(data.balance_note).toContain('Warning');
  });
});

/**
 * The invariant that ties the two tools together.
 *
 * validate_service exists to preflight create_service, so a preflight that
 * disagrees with the operation it previews is worse than none at all. These
 * two have drifted twice — validate rejected the `cronjob` deploy type create
 * accepted, then reported a dual-size config valid that create refuses. Both
 * now render the same rule list, and this asserts they cannot diverge again.
 */
describe('validate_service and create_service agree', () => {
  let client: PartiriApiClient;

  beforeEach(() => {
    // No network: the cost block is best-effort and swallows failures, and no
    // reachability probe is requested, so every rejection here is a rule.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    client = new PartiriApiClient('test-key', 'https://api.example.com');
  });

  afterEach(() => vi.restoreAllMocks());

  const base = {
    name: 'svc',
    deployType: 'webservice',
    runtime: 'node',
    rootPath: '.',
    fkRegion: REGION_ID,
    fkPod: POD_ID,
    repositoryUrl: 'https://github.com/org/repo',
    buildCommand: 'npm run build',
    runCommand: 'npm start',
  };

  const cases: Array<[string, Record<string, unknown>]> = [
    ['a valid repository config', base],
    [
      'a valid registry config',
      {
        ...base,
        repositoryUrl: undefined,
        registryUrl: 'ghcr.io/org/img:latest',
      },
    ],
    ['both sources', { ...base, registryUrl: 'ghcr.io/org/img:latest' }],
    ['no source', { ...base, repositoryUrl: undefined }],
    [
      'both sizes',
      { ...base, customPod: { vcpuMillicores: 1000, memoryMib: 1024 } },
    ],
    ['no size', { ...base, fkPod: undefined }],
    [
      'a valid cronjob',
      { ...base, deployType: 'cronjob', cronjobActiveDeadlineSeconds: 300 },
    ],
    ['a cronjob with no deadline', { ...base, deployType: 'cronjob' }],
    [
      'a cronjob with three replicas',
      {
        ...base,
        deployType: 'cronjob',
        cronjobActiveDeadlineSeconds: 300,
        replicaCount: 3,
      },
    ],
    [
      'static from a registry',
      {
        ...base,
        deployType: 'static',
        repositoryUrl: undefined,
        registryUrl: 'ghcr.io/org/img:latest',
      },
    ],
  ];

  it.each(cases)(
    'never reports %s valid while create_service would block it',
    async (_label, args) => {
      const result = await validateHandlers.get('validate_service')!(
        client,
        args,
      );
      const { valid } = JSON.parse(resultText(result));
      const blocked = firstBlockingFailure(args) !== null;

      // One-directional on purpose: validate is allowed to be STRICTER than
      // create (its advisory build/run rules are), but never more permissive.
      if (blocked) expect(valid).toBe(false);
    },
  );

  it('covers both outcomes, so the assertion is not vacuous', () => {
    const blocked = cases.filter(([, a]) => firstBlockingFailure(a) !== null);
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.length).toBeLessThan(cases.length);
  });
});

describe('Storage tools', () => {
  let client: PartiriApiClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new PartiriApiClient('test-key', 'https://api.example.com');
  });

  afterEach(() => vi.restoreAllMocks());

  describe('list_volumes', () => {
    it('calls GET /storage/volumes with project query param', async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));
      const handler = storageHandlers.get('list_volumes')!;
      await handler(client, { projectId: PROJ_ID });

      const [url] = fetchMock.mock.calls[0];
      expect(url.pathname).toBe('/storage/volumes');
      expect(url.searchParams.get('project')).toBe(PROJ_ID);
    });

    it('returns volume count', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse([{ id: VOL_ID, name: 'data', status: 'available' }]),
      );
      const handler = storageHandlers.get('list_volumes')!;
      const result = await handler(client, { projectId: PROJ_ID });

      const data = JSON.parse(resultText(result));
      expect(data.count).toBe(1);
    });
  });

  describe('get_volume', () => {
    it('calls GET /storage/volumes/:id', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ id: VOL_ID, name: 'data', status: 'available' }),
      );
      const handler = storageHandlers.get('get_volume')!;
      await handler(client, { volumeId: VOL_ID });

      const [url] = fetchMock.mock.calls[0];
      expect(url.pathname).toBe(`/storage/volumes/${VOL_ID}`);
    });
  });
});

describe('update_service cost-delta', () => {
  let client: PartiriApiClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new PartiriApiClient('test-key', 'https://api.example.com');
  });

  afterEach(() => vi.restoreAllMocks());

  const OLD_POD = '88888888-8888-8888-8888-888888888888';
  const NEW_POD = '99999999-9999-9999-9999-999999999999';

  it('includes cost_delta when fkPod changes', async () => {
    // Call 1: getService (for current state)
    // Call 2: getPricing
    // Call 3: updateService (PUT)
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: SVC_ID,
          fk_pod: OLD_POD,
          replicas: [{ id: 'r1', fk_region: REGION_ID, is_primary: true }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          pods: [
            { fk_pod: OLD_POD, price: 10, perMinute: 0.000231 },
            { fk_pod: NEW_POD, price: 20, perMinute: 0.000463 },
          ],
          volume_price_per_gb: 0.5,
        }),
      )
      .mockResolvedValueOnce(emptyOkResponse());

    const handler = serviceHandlers.get('update_service')!;
    const result = await handler(client, {
      serviceId: SVC_ID,
      fkPod: NEW_POD,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(resultText(result));
    expect(data.cost_delta).toBeDefined();
    expect(data.cost_delta.current_monthly).toBe(10);
    expect(data.cost_delta.new_monthly).toBe(20);
    expect(data.cost_delta.delta_monthly).toBe(10);
    expect(data.cost_delta.currency).toBe('EUR');
  });

  it('omits cost_delta when neither fkPod nor fkRegion changes', async () => {
    fetchMock.mockResolvedValueOnce(emptyOkResponse());
    const handler = serviceHandlers.get('update_service')!;
    const result = await handler(client, {
      serviceId: SVC_ID,
      name: 'new-name',
    });

    const data = JSON.parse(resultText(result));
    expect(data.cost_delta).toBeUndefined();
  });

  it('still updates even when cost-delta fetch fails', async () => {
    // getService fails (non-critical), updateService succeeds
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: 'Not found' }, 404))
      .mockResolvedValueOnce(emptyOkResponse());

    const handler = serviceHandlers.get('update_service')!;
    const result = await handler(client, {
      serviceId: SVC_ID,
      fkPod: NEW_POD,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(resultText(result));
    expect(data.status).toBe('updated');
    expect(data.cost_delta).toBeUndefined();
  });

  it('includes non-zero cost_delta when only fkRegion changes', async () => {
    const NEW_REGION = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    // Call 1: getService
    // Call 2: getPricing(currentRegion)
    // Call 3: getPricing(newRegion)
    // Call 4: updateService (PUT)
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: SVC_ID,
          fk_pod: OLD_POD,
          replicas: [{ id: 'r1', fk_region: REGION_ID, is_primary: true }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          pods: [{ fk_pod: OLD_POD, price: 10, perMinute: 0.000231 }],
          volume_price_per_gb: 0.5,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          pods: [{ fk_pod: OLD_POD, price: 25, perMinute: 0.000579 }],
          volume_price_per_gb: 0.6,
        }),
      )
      .mockResolvedValueOnce(emptyOkResponse());

    const handler = serviceHandlers.get('update_service')!;
    const result = await handler(client, {
      serviceId: SVC_ID,
      fkRegion: NEW_REGION,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(resultText(result));
    expect(data.cost_delta).toBeDefined();
    expect(data.cost_delta.current_monthly).toBe(10);
    expect(data.cost_delta.new_monthly).toBe(25);
    expect(data.cost_delta.delta_monthly).toBe(15);
    expect(data.cost_delta.currency).toBe('EUR');
  });
});

describe('create_service additional coverage', () => {
  let client: PartiriApiClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new PartiriApiClient('test-key', 'https://api.example.com');
  });

  afterEach(() => vi.restoreAllMocks());

  it('succeeds and attaches cost_estimate even when getPricing throws', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: SVC_ID, name: 'my-svc' }, 201))
      .mockResolvedValueOnce(
        jsonResponse({ message: 'Service Unavailable' }, 503),
      );

    const handler = serviceHandlers.get('create_service')!;
    const result = await handler(client, {
      name: 'my-svc',
      deployType: 'webservice',
      runtime: 'node',
      rootPath: '.',
      fkProject: PROJ_ID,
      fkRegion: REGION_ID,
      fkPod: POD_ID,
      repositoryUrl: 'https://github.com/org/repo',
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(resultText(result));
    expect(data.id).toBe(SVC_ID);
    expect(data.cost_estimate).toBeUndefined();
  });

  it('succeeds and includes cost_estimate when getPricing succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: SVC_ID, name: 'my-svc' }, 201))
      .mockResolvedValueOnce(
        jsonResponse({
          pods: [{ fk_pod: POD_ID, price: 15, perMinute: 0.000347 }],
          volume_price_per_gb: 0.5,
        }),
      );

    const handler = serviceHandlers.get('create_service')!;
    const result = await handler(client, {
      name: 'my-svc',
      deployType: 'webservice',
      runtime: 'node',
      rootPath: '.',
      fkProject: PROJ_ID,
      fkRegion: REGION_ID,
      fkPod: POD_ID,
      repositoryUrl: 'https://github.com/org/repo',
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(resultText(result));
    expect(data.cost_estimate).toBeDefined();
    expect(data.cost_estimate.pod_monthly).toBe(15);
  });

  it('sends fk_service_secret in create_service request body', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: SVC_ID, name: 'my-svc' }, 201),
    );

    const handler = serviceHandlers.get('create_service')!;
    await handler(client, {
      name: 'my-svc',
      deployType: 'webservice',
      runtime: 'node',
      rootPath: '.',
      fkProject: PROJ_ID,
      fkRegion: REGION_ID,
      fkPod: POD_ID,
      fkServiceSecret: SECRET_ID,
      repositoryUrl: 'https://github.com/org/repo',
    });

    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse(opts.body as string);
    expect(body.fk_service_secret).toBe(SECRET_ID);
  });

  it('sends fk_service_secret in update_service request body', async () => {
    fetchMock.mockResolvedValueOnce(emptyOkResponse());

    const handler = serviceHandlers.get('update_service')!;
    await handler(client, {
      serviceId: SVC_ID,
      fkServiceSecret: SECRET_ID,
    });

    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse(opts.body as string);
    expect(body.fk_service_secret).toBe(SECRET_ID);
  });
});

describe('validate_service probe branches', () => {
  let client: PartiriApiClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new PartiriApiClient('test-key', 'https://api.example.com');
  });

  afterEach(() => vi.restoreAllMocks());

  const baseArgs = {
    name: 'my-service',
    deployType: 'webservice',
    runtime: 'node',
    rootPath: '.',
    fkRegion: REGION_ID,
    fkPod: POD_ID,
    repositoryUrl: 'https://github.com/org/repo',
    buildCommand: 'npm run build',
    runCommand: 'npm start',
    probeReachability: true,
    workspaceId: WS_ID,
  };

  it('records repository_reachability ok=true on probe success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    const handler = validateHandlers.get('validate_service')!;
    const result = await handler(client, baseArgs);

    const data = JSON.parse(resultText(result));
    const check = data.checks.find(
      (c: { field: string }) => c.field === 'repository_reachability',
    );
    expect(check).toBeDefined();
    expect(check.ok).toBe(true);

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(String(url)).toContain(`workspace=${WS_ID}`);
  });

  it('records repository_reachability ok=false on probe failure', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: 'Not found' }, 404),
    );

    const handler = validateHandlers.get('validate_service')!;
    const result = await handler(client, baseArgs);

    const data = JSON.parse(resultText(result));
    const check = data.checks.find(
      (c: { field: string }) => c.field === 'repository_reachability',
    );
    expect(check).toBeDefined();
    expect(check.ok).toBe(false);
    expect(check.message).toContain('probe failed');
  });
});

describe('env dropped from service tools', () => {
  let client: PartiriApiClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new PartiriApiClient('test-key', 'https://api.example.com');
  });

  afterEach(() => vi.restoreAllMocks());

  it('get_service strips env entirely from its response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: SVC_ID,
        name: 'my-svc',
        env: [
          { key: 'DATABASE_URL', value: 'postgres://user:secret@host/db' },
          { key: 'JWT_SECRET', value: 'super-secret-value' },
        ],
        replicas: [{ id: 'r1', fk_region: REGION_ID, is_primary: true }],
      }),
    );
    const handler = serviceHandlers.get('get_service')!;
    const result = await handler(client, { serviceId: SVC_ID });

    const text = resultText(result);
    expect(text).not.toContain('postgres://user:secret@host/db');
    expect(text).not.toContain('super-secret-value');
    expect(text).not.toContain('DATABASE_URL');

    const data = JSON.parse(text);
    expect(data.env).toBeUndefined();
    // structuredContent must not smuggle env (keys or values) back either.
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      'super-secret-value',
    );
    expect(JSON.stringify(result.structuredContent)).not.toContain('env');
  });

  it('list_services returns only summary fields and never env', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          id: SVC_ID,
          name: 'svc-a',
          runtime: 'node',
          deploy_type: 'webservice',
          deploy_tag: 'abc123',
          active: true,
          repository_url: 'https://github.com/org/repo',
          env: [{ key: 'API_KEY', value: 'leak-me' }],
        },
      ]),
    );
    const handler = serviceHandlers.get('list_services')!;
    const result = await handler(client, { projectId: PROJ_ID });

    const text = resultText(result);
    expect(text).not.toContain('leak-me');
    expect(text).not.toContain('repository_url');
    // structuredContent is built from the same object — must not smuggle it back.
    expect(JSON.stringify(result.structuredContent)).not.toContain('leak-me');

    const data = JSON.parse(text);
    expect(data.count).toBe(1);
    expect(data.services[0]).toEqual({
      id: SVC_ID,
      name: 'svc-a',
      runtime: 'node',
      deploy_type: 'webservice',
      deploy_tag: 'abc123',
      active: true,
    });
    expect(data.services[0].env).toBeUndefined();
  });

  it('create_service strips env from its response', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          {
            id: SVC_ID,
            name: 'my-svc',
            env: [{ key: 'SECRET_TOKEN', value: 'do-not-leak' }],
          },
          201,
        ),
      )
      // pricing fetch (non-critical) — return a failure so cost estimate is skipped
      .mockResolvedValueOnce(
        jsonResponse({ message: 'Service Unavailable' }, 503),
      );

    const handler = serviceHandlers.get('create_service')!;
    const result = await handler(client, {
      name: 'my-svc',
      deployType: 'webservice',
      runtime: 'node',
      rootPath: '.',
      fkProject: PROJ_ID,
      fkRegion: REGION_ID,
      fkPod: POD_ID,
      repositoryUrl: 'https://github.com/org/repo',
    });

    const text = resultText(result);
    expect(text).not.toContain('do-not-leak');
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      'do-not-leak',
    );
    const data = JSON.parse(text);
    expect(data.env).toBeUndefined();
  });

  it('get_service strips fk_service_secret but keeps functional IDs', async () => {
    const secretRef = '9b2c6a1e-1111-2222-3333-444455556666';
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: SVC_ID,
        name: 'my-svc',
        fk_project: PROJ_ID,
        fk_service_secret: secretRef,
        replicas: [{ id: 'r1', fk_region: REGION_ID, is_primary: true }],
      }),
    );
    const handler = serviceHandlers.get('get_service')!;
    const result = await handler(client, { serviceId: SVC_ID });

    const text = resultText(result);
    expect(text).not.toContain(secretRef);
    expect(JSON.stringify(result.structuredContent)).not.toContain(secretRef);

    const data = JSON.parse(text);
    expect(data.fk_service_secret).toBeUndefined();
    expect(data.id).toBe(SVC_ID);
    expect(data.fk_project).toBe(PROJ_ID);
  });

  it('create_service strips fk_service_secret from its response', async () => {
    const secretRef = '9b2c6a1e-1111-2222-3333-444455556666';
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          { id: SVC_ID, name: 'my-svc', fk_service_secret: secretRef },
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ message: 'Service Unavailable' }, 503),
      );

    const handler = serviceHandlers.get('create_service')!;
    const result = await handler(client, {
      name: 'my-svc',
      deployType: 'webservice',
      runtime: 'node',
      rootPath: '.',
      fkProject: PROJ_ID,
      fkRegion: REGION_ID,
      fkPod: POD_ID,
      fkServiceSecret: secretRef,
      repositoryUrl: 'https://github.com/org/repo',
    });

    const text = resultText(result);
    const data = JSON.parse(text);
    expect(data.fk_service_secret).toBeUndefined();
    expect(data.id).toBe(SVC_ID);
  });
});

describe('service source-XOR guards and pagination', () => {
  let client: PartiriApiClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new PartiriApiClient('test-key', 'https://api.example.com');
  });

  afterEach(() => vi.restoreAllMocks());

  const base = {
    name: 'my-svc',
    deployType: 'webservice',
    runtime: 'node',
    rootPath: '.',
    fkProject: PROJ_ID,
    fkRegion: REGION_ID,
    fkPod: POD_ID,
  };

  it('create_service rejects a body with no source', async () => {
    const handler = serviceHandlers.get('create_service')!;
    const result = await handler(client, { ...base });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('source is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('create_service rejects a body with both sources', async () => {
    const handler = serviceHandlers.get('create_service')!;
    const result = await handler(client, {
      ...base,
      repositoryUrl: 'https://github.com/org/repo',
      registryUrl: 'ghcr.io/org/image:tag',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('only one source');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('update_service rejects a body with both sources', async () => {
    const handler = serviceHandlers.get('update_service')!;
    const result = await handler(client, {
      serviceId: SVC_ID,
      repositoryUrl: 'https://github.com/org/repo',
      registryUrl: 'ghcr.io/org/image:tag',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('only one source');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('list_services flags has_more when the page is full', async () => {
    const services = Array.from({ length: 3 }, (_, i) => ({
      id: `svc-${i}`,
      name: `s${i}`,
      runtime: 'node',
      deploy_type: 'webservice',
      deploy_tag: 't',
      active: true,
    }));
    fetchMock.mockResolvedValue(jsonResponse(services));
    const handler = serviceHandlers.get('list_services')!;
    const result = await handler(client, { projectId: PROJ_ID, limit: 3 });
    const data = JSON.parse(resultText(result));
    expect(data.count).toBe(3);
    expect(data.has_more).toBe(true);
  });

  it('list_services passes limit as a query param', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const handler = serviceHandlers.get('list_services')!;
    await handler(client, { projectId: PROJ_ID, limit: 25 });
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('limit=25');
  });
});

describe('validate_service annotations (#4)', () => {
  it('is not advertised as read-only and is marked open-world', () => {
    const def = validateDefinitions.find((d) => d.name === 'validate_service')!;
    expect(def.annotations?.readOnlyHint).toBe(false);
    expect(def.annotations?.openWorldHint).toBe(true);
  });
});
