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
