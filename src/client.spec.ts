import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PartiriApiClient } from './client.js';

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('PartiriApiClient', () => {
  let client: PartiriApiClient;
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PARTIRI_TIMEOUT;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new PartiriApiClient('test-api-key', 'https://api.example.com');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  describe('request headers', () => {
    it('sends x-api-key header on GET', async () => {
      fetchMock.mockResolvedValue(jsonResponse([{ id: '1', name: 'ws' }]));
      await client.listWorkspaces();

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers['x-api-key']).toBe('test-api-key');
    });

    it('sends Content-Type on POST', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: '1' }));
      await client.createProject('proj', 'production', 'ws-1');

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(opts.method).toBe('POST');
    });
  });

  describe('HTTP methods', () => {
    it('listWorkspaces sends GET to /workspaces', async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));
      await client.listWorkspaces();

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url.pathname).toBe('/workspaces');
      expect(opts.method).toBe('GET');
    });

    it('createProject sends POST with body', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: '1' }));
      await client.createProject('my-project', 'staging', 'ws-1');

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url.pathname).toBe('/projects');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({
        name: 'my-project',
        environment: 'staging',
        fk_workspace: 'ws-1',
      });
    });

    it('updateService sends PUT', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
      await client.updateService('svc-1', { name: 'new-name' });

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url.pathname).toBe('/services/svc-1');
      expect(opts.method).toBe('PUT');
    });
  });

  describe('query parameters', () => {
    it('listProjects sends workspace query param', async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));
      await client.listProjects('ws-1');

      const [url] = fetchMock.mock.calls[0];
      expect(url.searchParams.get('workspace')).toBe('ws-1');
    });
  });

  describe('retry on 429', () => {
    it('retries and succeeds on second attempt', async () => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(new Response(null, { status: 429 }))
        .mockResolvedValueOnce(jsonResponse([]));

      const promise = client.listWorkspaces();
      await vi.advanceTimersByTimeAsync(5_000);

      const result = await promise;
      expect(result).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('respects Retry-After header', async () => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(
          new Response(null, { status: 429, headers: { 'Retry-After': '2' } }),
        )
        .mockResolvedValueOnce(jsonResponse([]));

      const promise = client.listWorkspaces();
      // Retry-After: 2 means 2 seconds
      await vi.advanceTimersByTimeAsync(2_000);

      await promise;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('gives up after max retries', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ message: 'Rate limited' }), {
          status: 429,
        }),
      );

      const promise = client.listWorkspaces().catch((e: Error) => e);

      // Advance through all retry delays
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(10_000);
      }

      const error = await promise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Rate limit');
      expect(fetchMock).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
      vi.useRealTimers();
    });
  });

  describe('error handling', () => {
    it('throws on non-OK response', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }),
      );

      await expect(client.getService('missing')).rejects.toThrow('Not found');
    });
  });
});
