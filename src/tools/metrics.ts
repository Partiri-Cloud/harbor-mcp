import { z } from 'zod';
import type { PartiriApiClient } from '../client.js';
import type { PrometheusResponse, NetworkMetricsResponse } from '../client.js';
import { toolResult, toolError, capToolResult } from '../errors.js';
import type { ToolDefinition, ToolHandler } from './index.js';
import { READ_ONLY } from './annotations.js';

/**
 * Zod input schema shared by all metrics tools (`get_cpu_metrics`,
 * `get_memory_metrics`, `get_network_metrics`). Requires a service ID and
 * accepts optional deploy tag and time-range filters.
 */
const metricsInput = z.object({
  serviceId: z.string().uuid().describe('The service UUID'),
  deployTag: z
    .string()
    .max(255)
    .optional()
    .describe('Filter by deployment tag'),
  start: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Start timestamp (Unix seconds)'),
  end: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('End timestamp (Unix seconds)'),
});

/**
 * Tool definitions for the metrics domain: `get_cpu_metrics`,
 * `get_memory_metrics`, and `get_network_metrics`. All are read-only and
 * share {@link metricsInput} as their input schema.
 */
export const definitions: ToolDefinition[] = [
  {
    name: 'get_cpu_metrics',
    title: 'Get CPU Metrics',
    description:
      'Get CPU usage metrics (average, peak, current in cores) for a service. Automatically uses the current deploy tag if not specified. Use get_service to find service IDs.',
    inputSchema: metricsInput,
    annotations: READ_ONLY,
  },
  {
    name: 'get_memory_metrics',
    title: 'Get Memory Metrics',
    description:
      'Get memory usage metrics (average, peak, current in bytes) for a service. Automatically uses the current deploy tag if not specified. Use get_service to find service IDs.',
    inputSchema: metricsInput,
    annotations: READ_ONLY,
  },
  {
    name: 'get_network_metrics',
    title: 'Get Network Metrics',
    description:
      'Get network download and upload metrics (bytes/s) for a service. Automatically uses the current deploy tag if not specified. Use get_service to find service IDs.',
    inputSchema: metricsInput,
    annotations: READ_ONLY,
  },
];

/**
 * Formats a raw Prometheus range-query response into a human-readable
 * summary with average, peak, and current values.
 *
 * @param response - The Prometheus response to summarize.
 * @param label - Human-readable label for the metric (e.g. "CPU Usage").
 * @param unit - Unit string appended to each formatted value (e.g. "cores").
 * @returns A multi-line summary string, or a "no data" message when the
 *   response has no results or no numeric data points.
 */
function summarizePrometheus(
  response: PrometheusResponse,
  label: string,
  unit: string,
): string {
  const results = response.data?.result;
  if (!results || results.length === 0) {
    return `No ${label} data available.`;
  }

  const allValues = results
    .flatMap((r) => r.values.map(([, v]) => parseFloat(v)))
    .filter((v) => !isNaN(v));

  if (allValues.length === 0) {
    return `No ${label} data points.`;
  }

  const avg = allValues.reduce((sum, v) => sum + v, 0) / allValues.length;
  const peak = Math.max(...allValues);
  const current = allValues[allValues.length - 1];

  return [
    `${label}:`,
    `  Average: ${avg.toFixed(3)} ${unit}`,
    `  Peak:    ${peak.toFixed(3)} ${unit}`,
    `  Current: ${current.toFixed(3)} ${unit}`,
    `  Data points: ${allValues.length}`,
  ].join('\n');
}

/**
 * Formats a network metrics response (download and/or upload) into a
 * combined human-readable summary, delegating each direction to
 * {@link summarizePrometheus}.
 *
 * @param response - The network metrics response, with optional `download`
 *   and `upload` Prometheus results.
 * @returns The combined summary, or a "no data" message when neither
 *   direction is present.
 */
function summarizeNetwork(response: NetworkMetricsResponse): string {
  const parts: string[] = [];

  if (response.download) {
    parts.push(summarizePrometheus(response.download, 'Download', 'bytes/s'));
  }
  if (response.upload) {
    parts.push(summarizePrometheus(response.upload, 'Upload', 'bytes/s'));
  }

  return parts.length > 0 ? parts.join('\n\n') : 'No network data available.';
}

/**
 * Resolves the deploy tag to use for a metrics query, falling back to the
 * service's current deploy tag when none is explicitly provided.
 *
 * @param client - The Partiri API client used to look up the service.
 * @param serviceId - The service UUID.
 * @param deployTag - An explicit deploy tag, if the caller supplied one.
 * @returns The provided deploy tag, the service's current deploy tag, or
 *   `undefined` if neither is available.
 */
async function resolveDeployTag(
  client: PartiriApiClient,
  serviceId: string,
  deployTag?: string,
): Promise<string | undefined> {
  if (deployTag) return deployTag;
  const service = await client.getService(serviceId);
  return service.deploy_tag ?? undefined;
}

/**
 * Handler map for the metrics domain, keyed by tool name. Each handler
 * resolves the deploy tag (if not supplied), fetches the corresponding
 * metrics from the Partiri API, and returns a summarized text result.
 */
export const handlers: Map<string, ToolHandler> = new Map([
  /**
   * Fetches and summarizes CPU usage metrics (average, peak, current in
   * cores) for a service.
   */
  [
    'get_cpu_metrics',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      try {
        const serviceId = args.serviceId as string;
        const deployTag = await resolveDeployTag(
          client,
          serviceId,
          args.deployTag as string | undefined,
        );
        const response = await client.getCpuMetrics(serviceId, {
          deployTag,
          start: args.start as number | undefined,
          end: args.end as number | undefined,
        });
        return capToolResult(
          toolResult(summarizePrometheus(response, 'CPU Usage', 'cores')),
        );
      } catch (e) {
        return toolError(
          (e as Error).message,
          'Verify the service ID and that the service has been deployed at least once.',
        );
      }
    },
  ],
  /**
   * Fetches and summarizes memory usage metrics (average, peak, current in
   * bytes) for a service.
   */
  [
    'get_memory_metrics',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      try {
        const serviceId = args.serviceId as string;
        const deployTag = await resolveDeployTag(
          client,
          serviceId,
          args.deployTag as string | undefined,
        );
        const response = await client.getMemoryMetrics(serviceId, {
          deployTag,
          start: args.start as number | undefined,
          end: args.end as number | undefined,
        });
        return capToolResult(
          toolResult(summarizePrometheus(response, 'Memory Usage', 'bytes')),
        );
      } catch (e) {
        return toolError(
          (e as Error).message,
          'Verify the service ID and that the service has been deployed at least once.',
        );
      }
    },
  ],
  /**
   * Fetches and summarizes network download and upload metrics (bytes/s)
   * for a service.
   */
  [
    'get_network_metrics',
    async (client: PartiriApiClient, args: Record<string, unknown>) => {
      try {
        const serviceId = args.serviceId as string;
        const deployTag = await resolveDeployTag(
          client,
          serviceId,
          args.deployTag as string | undefined,
        );
        const response = await client.getNetworkMetrics(serviceId, {
          deployTag,
          start: args.start as number | undefined,
          end: args.end as number | undefined,
        });
        return capToolResult(toolResult(summarizeNetwork(response)));
      } catch (e) {
        return toolError(
          (e as Error).message,
          'Verify the service ID and that the service has been deployed at least once.',
        );
      }
    },
  ],
]);
