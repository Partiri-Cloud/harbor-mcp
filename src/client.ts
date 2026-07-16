import { parseApiError } from './errors.js';

/**
 * Options for a single HTTP call made via {@link PartiriApiClient.request}.
 */
interface RequestOptions {
  /** HTTP method, e.g. `'GET'`, `'POST'`, `'PUT'`, `'DELETE'`. */
  method: string;
  /** Request path relative to the client's `baseUrl`. */
  path: string;
  /** Query-string parameters to append to the URL, if any. */
  query?: Record<string, string>;
  /** JSON-serializable request body, if any. */
  body?: unknown;
}

/**
 * HTTP client for the Partiri Cloud REST API. Wraps `fetch` with API-key
 * auth, timeout handling, 429 retry, and typed wrapper methods per endpoint.
 */
export class PartiriApiClient {
  /** Base URL the API is reachable at, e.g. `https://api.partiri.cloud`. */
  private readonly baseUrl: string;
  /** API key sent as the `x-api-key` header on every request. */
  private readonly apiKey: string;
  /** Per-request timeout in milliseconds, derived from `PARTIRI_TIMEOUT`. */
  private readonly timeoutMs: number;

  /**
   * Creates a client bound to a single API key and base URL.
   *
   * @param apiKey - API key sent on every request via `x-api-key`.
   * @param baseUrl - Base URL of the Partiri Cloud API.
   * @remarks Reads `PARTIRI_TIMEOUT` (seconds, default `30`) from the
   * environment to compute the per-request timeout.
   */
  constructor(apiKey: string, baseUrl: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.timeoutMs = parseInt(process.env.PARTIRI_TIMEOUT || '30', 10) * 1000;
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  /**
   * Performs a single HTTP request against the Partiri Cloud API, applying
   * the API-key header, query params, timeout, and 429 retry, then parses
   * the JSON response body.
   *
   * @param opts - Method, path, query, and body for the request.
   * @returns The parsed JSON response body, or `undefined` cast to `T` when
   * the response body is empty.
   * @throws Error with a formatted API error message when the response is
   * not `ok`.
   */
  private async request<T>(opts: RequestOptions): Promise<T> {
    const url = new URL(opts.path, this.baseUrl);
    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined) url.searchParams.set(key, value);
      }
    }

    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
    };
    if (opts.body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await this.sendWithRetry(() =>
      fetch(url, {
        method: opts.method,
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      }),
    );

    if (!response.ok) {
      const errorMessage = await parseApiError(response);
      throw new Error(errorMessage);
    }

    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  /**
   * Retry on HTTP 429 up to 3 times with exponential backoff. Respects the
   * `Retry-After` header if present.
   *
   * @param buildRequest - Factory that issues one HTTP request attempt.
   * @returns The response from the last attempt (a 429 if all retries were
   * exhausted, or the first non-429 response).
   * @throws Error (`'Unreachable'`) only if the retry loop exits without
   * returning, which should not happen given `MAX_RETRIES` is finite.
   */
  private async sendWithRetry(
    buildRequest: () => Promise<Response>,
  ): Promise<Response> {
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await buildRequest();

      if (response.status !== 429 || attempt === MAX_RETRIES) {
        return response;
      }

      const retryAfter = response.headers.get('retry-after');
      const waitSeconds = retryAfter
        ? parseInt(retryAfter, 10) || 1 << attempt
        : 1 << attempt;

      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    }

    throw new Error('Unreachable');
  }

  /**
   * Issues a GET request via {@link request}.
   *
   * @param path - Request path relative to `baseUrl`.
   * @param query - Optional query-string parameters.
   * @returns The parsed JSON response body.
   */
  private get<T>(path: string, query?: Record<string, string>): Promise<T> {
    return this.request({ method: 'GET', path, query });
  }

  /**
   * Issues a POST request via {@link request}.
   *
   * @param path - Request path relative to `baseUrl`.
   * @param body - JSON-serializable request body.
   * @returns The parsed JSON response body.
   */
  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request({ method: 'POST', path, body });
  }

  /**
   * Issues a PUT request via {@link request}.
   *
   * @param path - Request path relative to `baseUrl`.
   * @param body - JSON-serializable request body.
   * @returns The parsed JSON response body.
   */
  private put<T>(path: string, body: unknown): Promise<T> {
    return this.request({ method: 'PUT', path, body });
  }

  /**
   * Issues a DELETE request via {@link request}.
   *
   * @param path - Request path relative to `baseUrl`.
   * @returns The parsed JSON response body.
   */
  private del<T>(path: string): Promise<T> {
    return this.request({ method: 'DELETE', path });
  }

  // ── Workspaces ────────────────────────────────────────────────────────────

  /**
   * Lists workspaces visible to the authenticated API key.
   *
   * @returns The workspaces via `GET /workspaces`.
   */
  listWorkspaces() {
    return this.get<Workspace[]>('/workspaces');
  }

  // ── User ──────────────────────────────────────────────────────────────────

  /**
   * Fetches the profile of the currently authenticated user.
   *
   * @returns The user profile via `GET /user`.
   */
  getCurrentUser() {
    return this.get<UserProfile>('/user');
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  /**
   * Lists projects belonging to a workspace.
   *
   * @param workspaceId - ID of the workspace to list projects for.
   * @returns The projects via `GET /projects`.
   */
  listProjects(workspaceId: string) {
    return this.get<Project[]>('/projects', { workspace: workspaceId });
  }

  /**
   * Creates a new project in a workspace.
   *
   * @param name - Project name.
   * @param environment - Environment identifier (e.g. `'production'`).
   * @param workspaceId - ID of the owning workspace.
   * @returns The created project via `POST /projects`.
   */
  createProject(name: string, environment: string, workspaceId: string) {
    return this.post<Project>('/projects', {
      name,
      environment,
      fk_workspace: workspaceId,
    });
  }

  // ── Resources ─────────────────────────────────────────────────────────────

  /**
   * Lists pod (compute plan) options available to a workspace.
   *
   * @param workspaceId - ID of the workspace to list pods for.
   * @returns The pods via `GET /resources/pods`.
   */
  listPods(workspaceId: string) {
    return this.get<Pod[]>('/resources/pods', { workspace: workspaceId });
  }

  /**
   * Lists deployment regions available to a workspace.
   *
   * @param workspaceId - ID of the workspace to list regions for.
   * @returns The regions via `GET /resources/regions`.
   */
  listRegions(workspaceId: string) {
    return this.get<Region[]>('/resources/regions', { workspace: workspaceId });
  }

  /**
   * Fetches pod and volume pricing for a region.
   *
   * @param regionId - ID of the region to fetch pricing for.
   * @returns The pricing via `GET /resources/pricing`.
   */
  getPricing(regionId: string) {
    return this.get<Pricing>('/resources/pricing', { region: regionId });
  }

  /**
   * Fetches the current balance of a workspace.
   *
   * @param workspaceId - ID of the workspace to fetch the balance for.
   * @returns The balance via `GET /balances/{workspaceId}`.
   */
  getBalance(workspaceId: string) {
    return this.get<Balance>(`/balances/${workspaceId}`);
  }

  // ── Services ──────────────────────────────────────────────────────────────

  /**
   * Lists services in a project.
   *
   * @param projectId - ID of the project to list services for.
   * @param limit - Optional maximum number of services to return.
   * @returns The services via `GET /services`.
   */
  listServices(projectId: string, limit?: number) {
    const query: Record<string, string> = { project: projectId };
    if (limit !== undefined) query.limit = String(limit);
    return this.get<Service[]>('/services', query);
  }

  /**
   * Fetches a single service by ID.
   *
   * @param serviceId - ID of the service to fetch.
   * @returns The service via `GET /services/{serviceId}`.
   */
  getService(serviceId: string) {
    return this.get<Service>(`/services/${serviceId}`);
  }

  /**
   * Creates a new service.
   *
   * @param service - Service configuration to create.
   * @returns The created service via `POST /services`.
   */
  createService(service: CreateServicePayload) {
    return this.post<Service>('/services', service);
  }

  /**
   * Updates an existing service's configuration.
   *
   * @param serviceId - ID of the service to update.
   * @param updates - Partial service fields to update.
   * @returns The response via `PUT /services/{serviceId}`.
   */
  updateService(serviceId: string, updates: UpdateServicePayload) {
    return this.put<void>(`/services/${serviceId}`, updates);
  }

  // Service deletion is intentionally not exposed here — it is done by running
  // the `partiri` CLI yourself (use_partiri_cli returns guidance), keeping
  // irreversible deletes off the MCP surface.

  // ── Resource probes ───────────────────────────────────────────────────────

  /**
   * Probes a Git repository (e.g. for existence/accessibility/default
   * branch) via the API's server-side probe.
   *
   * @param query - Probe query parameters (e.g. repository URL).
   * @returns The probe result via `GET /resources/utils/git`.
   */
  probeGitRepository(query: Record<string, string>) {
    return this.get<unknown>('/resources/utils/git', query);
  }

  /**
   * Probes a container registry (e.g. for image existence/tags) via the
   * API's server-side probe.
   *
   * @param query - Probe query parameters (e.g. registry/image reference).
   * @returns The probe result via `GET /resources/utils/reg`.
   */
  probeRegistry(query: Record<string, string>) {
    return this.get<unknown>('/resources/utils/reg', query);
  }

  // ── Storage / Volumes (read-only) ─────────────────────────────────────────
  // Workspace secrets and volume mutations (create/attach/detach/delete/retry)
  // are intentionally absent — they are done by running the `partiri` CLI
  // yourself (use_partiri_cli returns guidance), keeping credentials and
  // irreversible operations off the MCP surface.

  /**
   * Lists volumes belonging to a project.
   *
   * @param projectId - ID of the project to list volumes for.
   * @returns The volumes via `GET /storage/volumes`.
   */
  listVolumes(projectId: string) {
    return this.get<Volume[]>('/storage/volumes', { project: projectId });
  }

  /**
   * Fetches a single volume by ID.
   *
   * @param volumeId - ID of the volume to fetch.
   * @returns The volume via `GET /storage/volumes/{volumeId}`.
   */
  getVolume(volumeId: string) {
    return this.get<Volume>(`/storage/volumes/${volumeId}`);
  }

  // ── Jobs / Deployments ────────────────────────────────────────────────────

  /**
   * Lists deployment jobs for a service.
   *
   * @param serviceId - ID of the service to list jobs for.
   * @returns The paginated jobs via `GET /jobs/services/{serviceId}`.
   */
  listJobs(serviceId: string) {
    return this.get<PaginatedJobs>(`/jobs/services/${serviceId}`);
  }

  /**
   * Triggers a new deployment of a service.
   *
   * @param serviceId - ID of the service to deploy.
   * @returns The response via `POST /jobs/services/deploy/{serviceId}`.
   */
  deployService(serviceId: string) {
    return this.post<void>(`/jobs/services/deploy/${serviceId}`, {});
  }

  /**
   * Pauses a running service.
   *
   * @param serviceId - ID of the service to pause.
   * @returns The response via `POST /jobs/services/pause/{serviceId}`.
   */
  pauseService(serviceId: string) {
    return this.post<void>(`/jobs/services/pause/${serviceId}`, {});
  }

  /**
   * Resumes a paused service.
   *
   * @param serviceId - ID of the service to unpause.
   * @returns The response via `POST /jobs/services/unpause/{serviceId}`.
   */
  unpauseService(serviceId: string) {
    return this.post<void>(`/jobs/services/unpause/${serviceId}`, {});
  }

  // ── Metrics ───────────────────────────────────────────────────────────────

  /**
   * Fetches CPU usage metrics for a service.
   *
   * @param serviceId - ID of the service to fetch metrics for.
   * @param query - Optional deploy-tag and time-range filters.
   * @returns The Prometheus-shaped response via `GET /metrics/cpu/{serviceId}`.
   */
  getCpuMetrics(serviceId: string, query?: MetricsQuery) {
    return this.get<PrometheusResponse>(
      `/metrics/cpu/${serviceId}`,
      buildMetricsQuery(query),
    );
  }

  /**
   * Fetches memory usage metrics for a service.
   *
   * @param serviceId - ID of the service to fetch metrics for.
   * @param query - Optional deploy-tag and time-range filters.
   * @returns The Prometheus-shaped response via
   * `GET /metrics/memory/{serviceId}`.
   */
  getMemoryMetrics(serviceId: string, query?: MetricsQuery) {
    return this.get<PrometheusResponse>(
      `/metrics/memory/${serviceId}`,
      buildMetricsQuery(query),
    );
  }

  /**
   * Fetches network (download/upload) metrics for a service.
   *
   * @param serviceId - ID of the service to fetch metrics for.
   * @param query - Optional deploy-tag and time-range filters.
   * @returns The download/upload metrics via
   * `GET /metrics/network/{serviceId}`.
   */
  getNetworkMetrics(serviceId: string, query?: MetricsQuery) {
    return this.get<NetworkMetricsResponse>(
      `/metrics/network/${serviceId}`,
      buildMetricsQuery(query),
    );
  }
}

/**
 * Builds the query-string parameters for a metrics endpoint from an optional
 * {@link MetricsQuery}, omitting keys whose values are unset.
 *
 * @param query - Optional deploy-tag and time-range filters.
 * @returns A query-parameter map suitable for {@link PartiriApiClient.get}.
 */
function buildMetricsQuery(query?: MetricsQuery): Record<string, string> {
  const params: Record<string, string> = {};
  if (query?.deployTag) params.deployTag = query.deployTag;
  if (query?.start !== undefined) params.start = String(query.start);
  if (query?.end !== undefined) params.end = String(query.end);
  return params;
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** A workspace — the top-level billing/organizational unit. */
export interface Workspace {
  /** Workspace ID. */
  id: string;
  /** Workspace display name. */
  name: string;
  /** Billing/contact email, or `null` if unset. */
  email: string | null;
}

/** Profile of the currently authenticated user. */
export interface UserProfile {
  /** User ID. */
  id: string;
  /** User email address. */
  email: string;
  /** User display name. */
  name: string;
}

/** A project — a grouping of services within a workspace. */
export interface Project {
  /** Project ID. */
  id: string;
  /** Project display name. */
  name: string;
  /** Environment identifier (e.g. `'production'`). */
  environment: string;
  /** ID of the owning workspace. */
  fk_workspace: string;
}

/** A pod — a selectable compute plan (CPU/RAM allocation) for a service. */
export interface Pod {
  /** Pod ID. */
  id: string;
  /** Pod internal name. */
  name: string;
  /** Human-readable label, or `null` if unset. */
  label: string | null;
  /** CPU allocation (e.g. `'0.5'`), or `null` if unset. */
  cpu: string | null;
  /** RAM allocation (e.g. `'512Mi'`), or `null` if unset. */
  ram: string | null;
}

/** A deployment region. */
export interface Region {
  /** Region ID. */
  id: string;
  /** Region internal name. */
  name: string;
  /** Human-readable label, or `null` if unset. */
  label: string | null;
  /** ISO country code, or `null` if unset. */
  country_code: string | null;
}

/** A single running replica of a service, pinned to a region. */
export interface ServiceReplica {
  /** Replica ID. */
  id: string;
  /** ID of the region this replica runs in. */
  fk_region: string;
  /** Whether this replica is the primary (write) replica. */
  is_primary: boolean;
}

/** A deployable service and its full configuration. */
export interface Service {
  /** Service ID. */
  id: string;
  /** Service display name. */
  name: string;
  /** Deployment source type (e.g. `'git'`, `'image'`). */
  deploy_type: string;
  /** Runtime/language used to build and run the service. */
  runtime: string;
  /** Source repository URL, or `null` for registry-image services. */
  repository_url: string | null;
  /** Source repository branch, or `null` for registry-image services. */
  repository_branch: string | null;
  /** Container registry image URL, or `null` for git-sourced services. */
  registry_url: string | null;
  /** ID of the associated service secret, or `null` if none. */
  fk_service_secret: string | null;
  /** Root path within the repository/image, or `null` if unset. */
  root_path: string | null;
  /** Build working directory, or `null` if unset. */
  build_path: string | null;
  /** Build command, or `null` if unset. */
  build_command: string | null;
  /** Command run before deploy, or `null` if unset. */
  pre_deploy_command: string | null;
  /** Command used to run the service, or `null` if unset. */
  run_command: string | null;
  /** ID of the assigned pod (compute plan), or `null` if unset. */
  fk_pod: string | null;
  /** ID of the owning project, or `null` if unset. */
  fk_project: string | null;
  /** Externally reachable service-discovery URL, or `null` if unset. */
  external_sd_url: string | null;
  /** Internal (cluster-local) service-discovery URL, or `null` if unset. */
  internal_sd_url: string | null;
  /** Custom domain URL, or `null` if unset. */
  custom_url: string | null;
  /** Health check path, or `null` if unset. */
  health_check_path: string | null;
  /** Whether the service is in maintenance mode, or `null` if unset. */
  maintenance_mode: boolean | null;
  /** Whether the service is active, or `null` if unset. */
  active: boolean | null;
  /** Currently deployed tag/ref, or `null` if unset. */
  deploy_tag: string | null;
  /**
   * Environment variables, or `null` if unset. Intentionally omitted from
   * `get_service` responses since values may hold secrets.
   */
  env: { key: string; value: string }[] | null;
  /** Running replicas of this service, or `null` if unset. */
  replicas: ServiceReplica[] | null;
  /** ISO timestamp of creation, or `null` if unset. */
  created_at: string | null;
  /** ISO timestamp of last update, or `null` if unset. */
  updated_at: string | null;
}

/** Payload for {@link PartiriApiClient.createService}. */
export interface CreateServicePayload {
  /** Service display name. */
  name: string;
  /** Deployment source type (e.g. `'git'`, `'image'`). */
  deploy_type: string;
  /** Runtime/language used to build and run the service. */
  runtime: string;
  /** Root path within the repository/image. */
  root_path: string;
  /** ID of the owning project. */
  fk_project: string;
  /** ID of the region to deploy into. */
  fk_region: string;
  /** ID of the pod (compute plan) to use. */
  fk_pod: string;
  /** ID of an associated service secret, if any. */
  fk_service_secret?: string;
  /** Source repository URL, for git-sourced services. */
  repository_url?: string;
  /** Source repository branch, for git-sourced services. */
  repository_branch?: string;
  /** Container registry image URL, for registry-image services. */
  registry_url?: string;
  /** Build command. */
  build_command?: string;
  /** Build working directory. */
  build_path?: string;
  /** Command run before deploy. */
  pre_deploy_command?: string;
  /** Command used to run the service. */
  run_command?: string;
  /** Health check path. */
  health_check_path?: string;
}

/** Payload for {@link PartiriApiClient.updateService}; all fields optional. */
export interface UpdateServicePayload {
  /** New service display name. */
  name?: string;
  /** New deployment source type. */
  deploy_type?: string;
  /** New runtime/language. */
  runtime?: string;
  /** New root path within the repository/image. */
  root_path?: string;
  /** New region ID. */
  fk_region?: string;
  /** New pod (compute plan) ID. */
  fk_pod?: string;
  /** New associated service secret ID. */
  fk_service_secret?: string;
  /** New source repository URL. */
  repository_url?: string;
  /** New source repository branch. */
  repository_branch?: string;
  /** New container registry image URL. */
  registry_url?: string;
  /** New build command. */
  build_command?: string;
  /** New build working directory. */
  build_path?: string;
  /** New command run before deploy. */
  pre_deploy_command?: string;
  /** New command used to run the service. */
  run_command?: string;
  /** New health check path. */
  health_check_path?: string;
  /** New maintenance-mode flag. */
  maintenance_mode?: boolean;
}

/** A deployment/lifecycle job for a service. */
export interface Job {
  /** Job ID. */
  id: string;
  /** ID of the service this job acts on. */
  fk_service: string;
  /** Job type (e.g. `'deploy'`, `'pause'`, `'unpause'`). */
  type: string;
  /** Job status (e.g. `'pending'`, `'running'`, `'succeeded'`, `'failed'`). */
  status: string;
  /** Deployed ref/tag this job targets, or `null` if not applicable. */
  deploy_ref: string | null;
  /** ISO timestamp of creation, or `null` if unset. */
  created_at: string | null;
  /** ISO timestamp of last update, or `null` if unset. */
  updated_at: string | null;
}

/** A page of {@link Job} results. */
export interface PaginatedJobs {
  /** Jobs in this page. */
  data: Job[];
  /** Total number of jobs across all pages. */
  total: number;
}

/** A single Prometheus time series result. */
export interface PrometheusResult {
  /** `[timestamp, value]` pairs. */
  values: [number, string][];
}

/** The `data` payload of a Prometheus-shaped response. */
export interface PrometheusData {
  /** Time series results. */
  result: PrometheusResult[];
}

/** A Prometheus-shaped metrics response, as returned by the metrics API. */
export interface PrometheusResponse {
  /** The metrics data payload. */
  data: PrometheusData;
}

/** Response shape for {@link PartiriApiClient.getNetworkMetrics}. */
export interface NetworkMetricsResponse {
  /** Download (ingress) metrics. */
  download: PrometheusResponse;
  /** Upload (egress) metrics. */
  upload: PrometheusResponse;
}

/** Pricing for a single pod (compute plan). */
export interface PodPrice {
  /** ID of the priced pod. */
  fk_pod: string;
  /** Price per billing unit. */
  price: number;
  /** Price per minute. */
  perMinute: number;
}

/** Pricing information for a region. */
export interface Pricing {
  /** Per-pod pricing. */
  pods: PodPrice[];
  /** Volume storage price per GB. */
  volume_price_per_gb: number;
}

/** A workspace's current billing balance. */
export interface Balance {
  /** Currency code (e.g. `'EUR'`). */
  currency: string;
  /** Balance amount in the given currency. */
  amount: number;
  /** ISO timestamp of last update, or `null` if unset. */
  updated_at: string | null;
}

/** Filters for the metrics endpoints. */
export interface MetricsQuery {
  /** Restrict metrics to a specific deploy tag, if provided. */
  deployTag?: string;
  /** Range start, as a Unix timestamp, if provided. */
  start?: number;
  /** Range end, as a Unix timestamp, if provided. */
  end?: number;
}

/** Lifecycle status of a {@link Volume}. */
export type VolumeStatus =
  | 'pending'
  | 'provisioning'
  | 'available'
  | 'attached'
  | 'deleting'
  | 'failed';

/** A persistent storage volume attachable to a service. */
export interface Volume {
  /** Volume ID, absent for a not-yet-created volume. */
  id?: string;
  /** Volume display name. */
  name: string;
  /** ID of the owning project. */
  fk_project: string;
  /** ID of the owning workspace. */
  fk_workspace: string;
  /** ID of the region the volume is provisioned in. */
  fk_region: string;
  /** ID of the service the volume is attached to, or `null`/unset if none. */
  fk_service?: string | null;
  /** Filesystem path the volume is mounted at. */
  mount_path: string;
  /** Volume size in GB. */
  size: number;
  /** Current lifecycle status. */
  status: VolumeStatus;
  /** ISO timestamp of creation, or `null`/unset if unavailable. */
  created_at?: string | null;
  /** ISO timestamp of last update, or `null`/unset if unavailable. */
  updated_at?: string | null;
}
