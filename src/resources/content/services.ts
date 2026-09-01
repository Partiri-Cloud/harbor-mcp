import type { DocResource } from '../index.js';

/**
 * Documentation resources covering service types and storage: web services,
 * private (internal-only) services, workers (egress-only background
 * processes), cronjobs (metered batch workloads), static websites, persistent
 * volumes (read-only via MCP, mutations via the `partiri` CLI), and the
 * end-to-end service creation workflow.
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
    name: 'Cronjob',
    uri: 'partiri://docs/services/cronjob',
    description:
      'Scheduled and one-shot batch workloads — metered per run, not billed monthly',
    content: `# Cronjob

A cronjob is a batch workload: it starts, does its work, and exits. Use it for nightly reports, cleanup passes, data imports, or any task that runs to completion rather than staying up.

**deploy_type:** \`cronjob\`

## Recurring vs one-shot

\`scheduler\` is the discriminator, and it is the only thing that separates the two:

| \`scheduler\` | Behaviour |
|---|---|
| set (e.g. \`'0 3 * * *'\`) | Recurring — a Kubernetes CronJob fires on the schedule |
| omitted | One-shot — a single Job runs once when deployed |

The expression is standard 5-field cron. **Consecutive runs must be at least 5 minutes apart** — a tighter schedule is rejected. Set \`cronjobTimeZone\` to an IANA name (e.g. \`Europe/Lisbon\`) to pin the schedule to a timezone; without it the schedule is interpreted in the cluster's zone.

## Billing: metered, NOT monthly

**This is the important difference from every other service type.** A cronjob is *never* charged a flat month:

- **Nothing is charged when you create it.** Long-running types (webservice, private-service, worker, static) are charged a full pod month up front. A cronjob is not.
- **Each run is debited on its actual duration**, rounded up to the whole minute, with a 1-minute floor. A run that takes 12 seconds costs one minute.
- The per-minute rate is the pod's monthly price divided by 43,200 (30 x 24 x 60). \`get_pricing\` returns it directly as \`perMinute\`.

So a job on a €43.20/month pod costs €0.001/minute. Running nightly for 5 minutes costs about €0.15 a month — not €43.20. **Never quote a cronjob a monthly pod price.** \`create_service\` and \`validate_service\` return a \`cost_estimate\` with \`billing_model: "metered"\` for this type, carrying \`per_minute\` and \`max_cost_per_run\` instead of \`pod_monthly\`.

Because you pay for time actually used, a *bigger* pod is often *cheaper* for a cronjob: double the CPU that halves the runtime costs the same or less. That is the opposite of the trade-off for a long-running service.

## Required fields

- **\`cronjobActiveDeadlineSeconds\` is required** (1–3600). It is the hard kill-timeout for a single run and it is what bounds the worst-case cost of a runaway job. \`create_service\` rejects a cronjob without it.
- **A runnable target:** a repository source needs \`runCommand\`; a registry source can rely on the image's \`CMD\`/\`ENTRYPOINT\`. Override the entrypoint with \`cronjobCommand\` (argv array) if needed.
- **Single replica, single region.** A cronjob always runs one replica in one region — metered billing resolves exactly one pod assignment per service, so a second region would go unbilled. \`replicaCount\` must be 1 or omitted.

## Optional tuning

| Field | Purpose |
|---|---|
| \`cronjobConcurrencyPolicy\` | \`Allow\` / \`Forbid\` / \`Replace\` — what happens when a run is still going as the next is due. \`Forbid\` is the safe default for jobs that must not overlap. |
| \`cronjobBackoffLimit\` | Retries before a run counts as failed. |
| \`cronjobStartingDeadlineSeconds\` | Grace window for a missed slot. Past it, the run is skipped rather than fired late. |
| \`cronjobTtlSecondsAfterFinished\` | How long a finished run's pod is kept. Keep it long enough to read the logs of a failure. |
| \`cronjobSuccessfulJobsHistoryLimit\` | Succeeded runs kept in history. |
| \`cronjobFailedJobsHistoryLimit\` | Failed runs kept in history. |

## Pausing a schedule

Use \`pause_service\` to suspend a recurring cronjob and \`unpause_service\` to resume it. Do **not** try to set the suspend flag through \`update_service\` — it is not accepted there. The API owns that flag and toggles it as part of the pause flow so it stays in step with the metered billing assignment; writing it directly would stop the schedule while billing still treated the service as live.

## Example

\`\`\`
create_service({
  name: "nightly-etl",
  deployType: "cronjob",
  runtime: "node",
  rootPath: ".",
  fkProject, fkRegion, fkPod,
  repositoryUrl: "https://github.com/org/repo",
  buildCommand: "npm ci && npm run build",
  runCommand: "node dist/etl.js",
  scheduler: "0 3 * * *",
  cronjobTimeZone: "Europe/Lisbon",
  cronjobActiveDeadlineSeconds: 900,
  cronjobConcurrencyPolicy: "Forbid",
})
\`\`\``,
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
  fkRegion,
  fkPod,                // OR customPod — exactly one
  customPod,            // { vcpuMillicores, memoryMib }; see get_custom_pod_options
  replicaCount,         // optional; pods per region, scales the estimate
  repositoryUrl,        // or registryUrl
  fkServiceSecret,      // optional; authenticates the reachability probe
  probeReachability: true,
  workspaceId,          // required to probe reachability; also enables balance check
  diskSizeGb,           // optional; included in cost estimate
  scheduler,            // cronjob only
  cronjobActiveDeadlineSeconds,  // cronjob only; required for that type
})
\`\`\`

Returns \`{ valid, summary, checks[], cost_estimate?, balance_note? }\`.

It accepts every \`deployType\` \`create_service\` does, cronjob included.

## Creating a service with a private source

1. Obtain the credential UUID (if not already present) — secrets are managed
   outside the MCP, in the dashboard or by running the \`partiri\` CLI yourself
   (the \`use_partiri_cli\` tool returns guidance). See
   \`partiri://docs/configuration/credentials\`.
2. Call \`create_service\` with \`fkServiceSecret\` set to the credential UUID.

## Cost estimate and balance

\`create_service\` and \`validate_service\` return a \`cost_estimate\` when the pod can be priced. **Check \`billing_model\` before reading any other field** — the two shapes are not interchangeable.

Continuously running types (webservice, private-service, worker, static) are billed a flat month per pod, charged up front:

\`\`\`json
{
  "billing_model": "flat_monthly",
  "pod_unit_monthly": 20.00,
  "replica_count": 2,
  "region_count": 1,
  "pod_monthly": 40.00,
  "disk_monthly": 1.00,
  "total_monthly": 41.00,
  "currency": "EUR"
}
\`\`\`

\`pod_unit_monthly\` is one pod; \`pod_monthly\` is that times \`replica_count\` times \`region_count\`, because every pod in every region is billed a full month. A volume is a single copy and does not scale with replicas.

\`pod_monthly\` + \`disk_monthly\` always equals \`total_monthly\`.

A cronjob is metered — nothing is charged at creation and there is no monthly figure for compute:

\`\`\`json
{
  "billing_model": "metered",
  "per_minute": 0.001,
  "max_cost_per_run": 0.005,
  "disk_monthly": 10.00,
  "currency": "EUR",
  "note": "..."
}
\`\`\`

See \`partiri://docs/services/cronjob\`. Do not present \`per_minute\` as a monthly cost.
\`disk_monthly\` is present whenever the service has a volume — a volume is charged a flat month on
every deploy type, so on a cronjob it is the *entire* recurring charge.

If the pod cannot be priced, \`cost_estimate\` is **omitted entirely** rather than reported as zero — an absent estimate means unknown, never free.

- \`get_pricing({ regionId, podIds? })\` returns pod prices and volume price per GB per month. The response covers catalogue pods only; name a custom pod's id in \`podIds\` to have it priced too.
- \`get_balance({ workspaceId })\` returns the workspace balance. Requires \`billing:r\` permission;
  returns \`null\` (not an error) on a 403.
- A low balance is **informational only**. The API's 402 response is the hard backstop when the
  balance runs out. Check the balance before a large deployment to warn the user proactively.
  A metered cronjob's compute is not compared against the balance — it costs nothing up front —
  but an attached volume still is, since that is a real monthly charge.

## $PORT contract

Your service **must** listen on the port given by the \`PORT\` environment variable. The platform
injects \`PORT\` at runtime. Hard-coding any other port causes health-check failures and the
deployment to roll back.`,
  },
];
