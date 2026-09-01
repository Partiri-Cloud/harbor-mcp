import type { DocResource } from '../index.js';

/**
 * Documentation resource with the quick-reference table of service
 * configuration fields accepted by the `create_service` and
 * `update_service` tools, plus notes on reading a service's region and the
 * cost estimate/delta fields those tools return.
 */
export const resources: DocResource[] = [
  {
    name: 'Service configuration fields',
    uri: 'partiri://docs/reference/service-fields',
    description:
      'Quick reference for all service configuration fields used in create_service and update_service tools',
    content: `# Service Configuration Fields

Quick reference for the fields used when creating or updating a service via the \`create_service\` and \`update_service\` tools.

| Field | Description |
|-------|-------------|
| \`name\` | Display name (max 16 characters). Must be unique within the project. |
| \`deployType\` | Deployment type: \`webservice\` (public HTTP), \`static\` (static hosting), \`private-service\` (internal), \`worker\` (background process, no inbound network), \`cronjob\` (batch workload, metered per run — see \`partiri://docs/services/cronjob\`). |
| \`runtime\` | Language runtime: \`node\`, \`deno\`, \`rust\`, \`python\`, \`go\`, \`ruby\`, \`elixir\`, \`php\`, \`jvm\`, \`dotnet\`, \`cpp\`, \`static\`, \`registry\`. |
| \`rootPath\` | Directory inside the repository where the service source code lives. Leave as \`.\` if at repo root. |
| \`repositoryUrl\` | HTTP URL of your Git repository. Mutually exclusive with \`registryUrl\`. |
| \`repositoryBranch\` | The branch to deploy from. Required when \`repositoryUrl\` is set. |
| \`registryUrl\` | Full container image reference (e.g. \`ghcr.io/owner/image:tag\`). The API splits host, repository, and tag server-side. Mutually exclusive with \`repositoryUrl\`. |
| \`fkServiceSecret\` | UUID of a repository or registry secret. Required for private repos and registries. Secrets are managed outside the MCP — in the dashboard or by running the \`partiri\` CLI yourself (the \`use_partiri_cli\` tool returns guidance); obtain the UUID there, then pass it here. |
| \`buildCommand\` | Command to build your project (e.g. \`npm run build\`). Required for repository-sourced non-static services. |
| \`buildPath\` | Directory containing the build output (e.g. \`dist/\`, \`build/\`). Required for static sites. |
| \`preDeployCommand\` | Command to run after build but before the service starts (e.g. database migrations). |
| \`runCommand\` | Command to start your service. Required for \`webservice\`, \`private-service\`, \`worker\`, and \`cronjob\` (repository-sourced; a registry-sourced worker or cronjob can rely on its image's \`CMD\`/\`ENTRYPOINT\` instead). For \`webservice\` and \`private-service\`, it **must listen on the port given by the \`$PORT\` environment variable** — the platform injects \`PORT\` at runtime. A \`worker\` or \`cronjob\` has no port to listen on. |
| \`healthCheckPath\` | HTTP path the platform pings to verify your service is up (e.g. \`/health\`). Returns 200 when healthy. |
| \`maintenanceMode\` | Enable/disable maintenance mode. When enabled, serves a maintenance page instead of the app. |
| \`fkProject\` | Project UUID to create the service in (use \`list_projects\` to find). |
| \`fkRegion\` | Region UUID for the primary replica (use \`list_regions\` to find available regions). |
| \`fkPod\` | Compute pod UUID (use \`list_pods\` to find available pod sizes). Provide **either** this or \`customPod\`, never both. |
| \`customPod\` | \`{ vcpuMillicores, memoryMib }\` — a custom size in place of a catalogue pod. Values must land on the step grid from \`get_custom_pod_options\`. Requests equal limits, so this is what the service is both guaranteed and billed for. |
| \`replicaCount\` | Pods to run **in each region** (default 1). Total pods, and the monthly bill, is this times the number of regions. Always 1 for \`cronjob\` and database services. |

### Cronjob-only fields

Only meaningful when \`deployType\` is \`cronjob\`. See \`partiri://docs/services/cronjob\`.

| Field | Description |
|-------|-------------|
| \`scheduler\` | 5-field cron expression (e.g. \`0 3 * * *\`). Set = recurring; omitted = one-shot. Consecutive runs must be at least 5 minutes apart. |
| \`cronjobTimeZone\` | IANA timezone the schedule is interpreted in (e.g. \`Europe/Lisbon\`). |
| \`cronjobActiveDeadlineSeconds\` | **Required for a cronjob.** Hard kill-timeout for a single run, 1–3600 seconds. Bounds the worst-case metered cost of a run. |
| \`cronjobConcurrencyPolicy\` | \`Allow\`, \`Forbid\`, or \`Replace\` — what happens when a run is still going as the next is due. |
| \`cronjobBackoffLimit\` | Retries before a run counts as failed. |
| \`cronjobCommand\` | Container entrypoint override, as an argv array. |
| \`cronjobStartingDeadlineSeconds\` | Grace window for starting a missed run. Past it, the run is skipped rather than fired late. |
| \`cronjobTtlSecondsAfterFinished\` | Seconds a finished run's pod is kept before cleanup. |
| \`cronjobSuccessfulJobsHistoryLimit\` | Succeeded runs kept in history. |
| \`cronjobFailedJobsHistoryLimit\` | Failed runs kept in history. |

> Suspending a schedule is **not** one of these fields. Use \`pause_service\` / \`unpause_service\`;
> the API owns the suspend flag and keeps it in step with the metered billing assignment.

> **Environment variables** are **not** set through these tools. Their values hold
> secrets, so \`create_service\`/\`update_service\` do not accept an \`env\` field and
> \`get_service\` omits it from its response. Manage them with the \`partiri\` CLI
> (\`partiri service env\`) — see the \`use_partiri_cli\` tool.

## Reading a service's region

\`get_service\` returns the full service object. The primary region is available via
\`replicas[].fk_region\` where \`replicas[].is_primary === true\`. For convenience the handler
also sets a top-level \`fk_region\` field to the primary replica's region UUID.

## Cost fields returned by create_service and update_service

Every cost object carries a \`billing_model\` discriminator. **Read it first** — the flat and metered
shapes share no numeric fields.

\`create_service\` returns a \`cost_estimate\` when the pod can be priced:

\`\`\`json
{
  "billing_model": "flat_monthly",
  "pod_unit_monthly": 20.00,
  "replica_count": 1,
  "region_count": 1,
  "pod_monthly": 20.00,
  "total_monthly": 20.00,
  "currency": "EUR"
}
\`\`\`

\`pod_unit_monthly\` is one pod for one month; \`pod_monthly\` is that times \`replica_count\` times
\`region_count\`. \`validate_service\` returns the same shape plus \`disk_monthly\` when \`diskSizeGb\`
is given (a volume is a single copy and does not scale with replicas). The parts always add up:
\`pod_monthly\` + \`disk_monthly\` equals \`total_monthly\`.

For a \`cronjob\` there is no monthly **compute** figure at all — it is metered:

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

\`max_cost_per_run\` is \`per_minute\` times the billed minutes of \`cronjobActiveDeadlineSeconds\`
(rounded up, 1-minute floor); it is \`null\` when no deadline was supplied. Never present these
numbers as a monthly cost.

\`disk_monthly\` appears on **both** shapes: an attached volume is charged a flat month on every
deploy type. On a metered service it is therefore the *entire* recurring charge — the compute
carries none.

\`update_service\` returns a \`cost_delta\` when the pod, region, replica count, **or deploy type**
changes:

\`\`\`json
{
  "current_billing_model": "flat_monthly",
  "new_billing_model": "flat_monthly",
  "current_monthly": 20.00,
  "new_monthly": 35.00,
  "delta_monthly": 15.00,
  "currency": "EUR"
}
\`\`\`

The monthly figures are the **recurring** charge on each side, so the delta stays meaningful even
when the billing model itself changes. A metered side contributes 0 for compute (its volume, if
any, still counts), \`current_per_minute\` / \`new_per_minute\` appear for whichever side is metered,
and a \`note\` explains the switch:

\`\`\`json
{
  "current_billing_model": "metered",
  "new_billing_model": "flat_monthly",
  "current_monthly": 0,
  "new_monthly": 20.00,
  "delta_monthly": 20.00,
  "current_per_minute": 0.00046,
  "currency": "EUR",
  "note": "Billing model changes: runs were debited per minute; the service now carries a flat monthly charge."
}
\`\`\`

Converting a cronjob to a long-running type genuinely **starts** a monthly charge, and converting
one away genuinely ends it — that is why the delta reports the full amount rather than zero.

A cost object is **omitted entirely** when it cannot be computed — an unpriceable pod, a custom
resize whose pod class does not exist yet, or a pricing call that failed. Absent means unknown,
never free.

All of these are informational and never block the operation. Use \`get_pricing\` and \`get_balance\`
directly for pre-flight cost checks, or call \`validate_service\` which aggregates them.`,
  },
];
