import type { DocResource } from '../index.js';

/**
 * Documentation resources covering observability: tracking deployment
 * status and the CPU/memory/network monitoring metrics tools.
 */
export const resources: DocResource[] = [
  {
    name: 'Deployment status',
    uri: 'partiri://docs/observability/status',
    description: 'Monitoring deployment progress and status tracking',
    content: `# Deployment Status

Every service includes a deployment status table so you can see at a glance whether your latest deploy went through. You'll know if it's building, running, or if something went wrong.

Use the \`list_jobs\` tool to check deployment status programmatically.`,
  },
  {
    name: 'Monitoring',
    uri: 'partiri://docs/observability/monitoring',
    description: 'Available metrics: CPU, memory, and network traffic charts',
    content: `# Monitoring

Each deployed service has charts for the key metrics you care about:

- **Network traffic** — use the \`get_network_metrics\` tool
- **Memory usage** — use the \`get_memory_metrics\` tool
- **CPU consumption** — use the \`get_cpu_metrics\` tool

It's not a full observability suite — it's the essentials, presented clearly, so you can spot problems quickly and keep things running smoothly.

All metrics tools accept an optional \`deployTag\` to query a specific deployment, and optional \`start\`/\`end\` timestamps for time range filtering.`,
  },
];
