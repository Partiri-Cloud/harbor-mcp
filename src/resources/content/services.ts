import type { DocResource } from '../index.js';

/**
 * Documentation resources covering service types and storage: web services,
 * private (internal-only) services, workers (egress-only background
 * processes), static websites, persistent volumes (read-only via MCP,
 * mutations via the `partiri` CLI), and the end-to-end service creation
 * workflow.
 */
export const resources: DocResource[] = [
  {
    name: 'Web service',
    uri: 'partiri://docs/services/web-service',
    description: 'Public-facing web services with custom domains and TLS',
    content: `# Web Service

A web service is anything that needs to be reachable from the internet — your backend API, a full-stack app, a webhook endpoint.

When you deploy a web service, it gets a public URL with HTTPS included. You can also set up a custom domain whenever you want.

Deploy from a Git repo or a container image, and we take care of builds, TLS certificates, and routing.

**deploy_type:** \`webservice\`

## $PORT contract

The platform injects a \`PORT\` environment variable at runtime. Your service **must** bind to that port — do not hard-code a port number. Using any other port will cause the health check to fail and the deployment to be marked unhealthy.`,
  },
  {
    name: 'Private service',
    uri: 'partiri://docs/services/private-service',
    description: 'Internal services not exposed to the public internet',
    content: `# Private Service

Private services run inside the platform but aren't exposed to the public internet. There's no public URL, no ingress — they only talk to your other services.

This is the right choice for:

- Internal APIs
- Any supporting service that needs a network port but doesn't need to face the outside world

For a service with no network port at all — a queue consumer or other background process — see the Worker service type instead.

Your other services can reach them through simple private connectivity.

**deploy_type:** \`private-service\`

## $PORT contract

The platform injects a \`PORT\` environment variable at runtime. Your service **must** bind to that port, even for internal services.`,
  },
  {
    name: 'Worker',
    uri: 'partiri://docs/services/worker',
    description:
      'Long-running background processes with no inbound network — queue consumers and similar egress-only jobs',
    content: `# Worker

A worker is a long-running background process with **no inbound network at all** — no port, no URL, and no health check. It runs continuously, like a private service, but nothing (not even other services on the platform) connects to it directly. This is the right choice for a queue consumer or any similar process that only talks *out*.

Workers are egress-only: they can call other services and reach the public internet, but there is nothing to route traffic to on the way in.

Deploy from a Git repository (needs a \`run_command\`) or a container registry image.

**deploy_type:** \`worker\`

## Requirements

- **No port, no URL, no health check** — these fields are not applicable and are ignored/rejected for workers.
- **Runnable target required:** a repository source needs \`run_command\`; a registry source is runnable via its image \`CMD\`/\`ENTRYPOINT\` without one.
- **Billing:** flat-rate monthly, the same as a web or private service — a worker runs continuously, so it isn't billed per-invocation like a cronjob.`,
  },
  {
    name: 'Static website',
    uri: 'partiri://docs/services/static-website',
    description: 'Static asset hosting for SPAs, docs sites, and landing pages',
    content: `# Static Website

For SPAs, documentation sites, landing pages, or anything that's just static assets.

Push your code, we build it and serve it. You get a subdomain immediately, custom domains with HTTPS are supported, and the hosting is CDN-friendly so your site loads fast.

Every push triggers a new build, so publishing updates is as simple as merging to your branch.

**deploy_type:** \`static\`
**Note:** Static websites require a Git repository source — container registry is not supported.`,
  },
  {
    name: 'Persistent storage (volumes)',
    uri: 'partiri://docs/services/storage',
    description:
      'Persistent volumes for stateful services — read via MCP, mutate via the partiri CLI',
    content: `# Persistent Storage (Volumes)

Persistent volumes provide durable storage that survives service restarts. Once attached to a service, the volume is mounted at the configured path inside the container.

## MCP tools (read-only)

| Tool | Description |
|------|-------------|
| \`list_volumes\` | List all volumes in a project. |
| \`get_volume\` | Get details of a single volume by UUID. |

## Mutations — CLI only

Creating, attaching, detaching, deleting, and retrying volumes are **not** MCP
tools — they are data-affecting or irreversible, so you run them yourself with the
\`partiri\` CLI. The \`use_partiri_cli\` tool does not execute anything; it returns
guidance for the command to run in your own terminal. Discover the exact
subcommands and flags at runtime rather than guessing:

\`\`\`
use_partiri_cli({ action: "discover CLI commands", command: "partiri llm guide" })
use_partiri_cli({ action: "list CLI capabilities as JSON", command: "partiri llm capabilities -j" })
\`\`\`

Always pass \`-j\`/\`--json\` for machine-readable output.

## Volume lifecycle

\`\`\`
volume create → pending → provisioning → available
                                           ↓
                                     volume attach → attached (service redeployed)
                                           ↓
                                     volume detach → available
                                           ↓
                                     volume delete → (deleted)
\`\`\`

## Single-region constraint

A service with an attached volume is **single-region only**. Adding a second region while a
volume is attached returns a \`storage_replica_conflict\` API error. Detach the volume first
if you need to add replicas or change regions.

## Destructive operation guards

- \`volume detach\` — requires the service to be paused and have no active job running. The API
  returns a 400 with a clear error if a job is active. Pause the service first.
- \`volume delete\` — requires the volume to be in \`available\` (detached) status.
- Deleting a volume is **permanent** and cannot be undone. Billing for the volume stops only
  after deletion.

## Create and attach workflow

\`\`\`
1. Create the volume by running the partiri CLI yourself (call use_partiri_cli for
   guidance; see \`partiri llm guide\` for the command)
   → volume with status "pending"
2. (wait for status "available" — poll get_volume)
3. Attach it to a service by running the partiri CLI yourself
   → service is automatically redeployed
\`\`\`

## Volume pricing

Call \`get_pricing\` with a region UUID to see \`volume_price_per_gb\` (EUR/GB/month).
Use it to estimate a volume's monthly cost before creating it via the CLI.`,
  },
  {
    name: 'Service creation workflow',
    uri: 'partiri://docs/services/creation-workflow',
    description:
      'Step-by-step guide to creating a service with credentials, cost estimate, and storage',
    content: `# Service Creation Workflow

## Preflight: validate_service

Before calling \`create_service\`, use \`validate_service\` to catch configuration errors early:

\`\`\`
validate_service({
  name, deployType, runtime, rootPath,
  fkRegion, fkPod,
  repositoryUrl,        // or registryUrl
  fkServiceSecret,      // optional; authenticates the reachability probe
  probeReachability: true,
  workspaceId,          // required to probe reachability; also enables balance check
  diskSizeGb,           // optional; included in cost estimate
})
\`\`\`

Returns \`{ valid, summary, checks[], cost_estimate?, balance_note? }\`.

## Creating a service with a private source

1. Obtain the credential UUID (if not already present) — secrets are managed
   outside the MCP, in the dashboard or by running the \`partiri\` CLI yourself
   (the \`use_partiri_cli\` tool returns guidance). See
   \`partiri://docs/configuration/credentials\`.
2. Call \`create_service\` with \`fkServiceSecret\` set to the credential UUID.

\`create_service\` returns a \`cost_estimate\` when pricing is available:
\`\`\`json
{
  "pod_monthly": 20.00,
  "total_monthly": 20.00,
  "currency": "EUR"
}
\`\`\`

## Cost estimate and balance

- \`get_pricing({ regionId })\` returns pod prices and volume price per GB per month.
- \`get_balance({ workspaceId })\` returns the workspace balance. Requires \`billing:r\` permission;
  returns \`null\` (not an error) on a 403.
- A low balance is **informational only**. The API's 402 response is the hard backstop when the
  balance runs out. Check the balance before a large deployment to warn the user proactively.

## $PORT contract

Your service **must** listen on the port given by the \`PORT\` environment variable. The platform
injects \`PORT\` at runtime. Hard-coding any other port causes health-check failures and the
deployment to roll back.`,
  },
];
