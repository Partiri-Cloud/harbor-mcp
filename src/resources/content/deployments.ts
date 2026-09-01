import type { DocResource } from '../index.js';

/**
 * Documentation resources covering the deployment lifecycle: how deployments
 * work end to end, supported language runtimes, supported Git and container
 * registry providers, pod sizing and billing, the zero-downtime rolling
 * update strategy, and how to roll back to a previous deployment.
 */
export const resources: DocResource[] = [
  {
    name: 'How deployments work',
    uri: 'partiri://docs/deployments/how-it-works',
    description:
      'Overview of the deployment process: source, build, deploy, and tracking',
    content: `# How Deployments Work

Every deployment starts the same way: you connect a source, either a Git repository or a container registry. Choose a location and pod size, and deploy.

We pull your code, build it (if needed), and get it running. Each deployment is tracked, so you can see whether it succeeded or failed and roll things forward with confidence.

No guessing, no surprises. All deployments run on infrastructure hosted within Europe.`,
  },
  {
    name: 'Supported runtimes',
    uri: 'partiri://docs/deployments/runtimes',
    description:
      'List of all supported language runtimes: Node.js, Deno, Python, Go, Rust, Ruby, Elixir, PHP, JVM, .NET, C++, Static',
    content: `# Supported Runtimes

Partiri currently supports the following runtimes:

| Runtime | Value | Detected from |
|---------|-------|---------------|
| Node.js | \`node\` | \`package.json\` |
| Deno | \`deno\` | \`deno.json\`, \`deno.jsonc\` |
| Python | \`python\` | \`requirements.txt\`, \`pyproject.toml\` |
| Go | \`go\` | \`go.mod\` |
| Rust | \`rust\` | \`Cargo.toml\` |
| Ruby | \`ruby\` | \`Gemfile\` |
| Elixir | \`elixir\` | \`mix.exs\` |
| PHP | \`php\` | \`composer.json\` |
| JVM (Java/Kotlin) | \`jvm\` | \`build.gradle\`, \`pom.xml\` |
| .NET | \`dotnet\` | \`.csproj\`, \`.fsproj\` |
| C++ | \`cpp\` | \`CMakeLists.txt\` |
| Static Sites | \`static\` | — |
| Container Image | \`registry\` | — |

Use \`registry\` when deploying from a pre-built Docker image instead of source code.`,
  },
  {
    name: 'Git providers',
    uri: 'partiri://docs/deployments/git-providers',
    description: 'Supported Git providers: GitHub, GitLab, Bitbucket, Codeberg',
    content: `# Git Providers

We accept private and public repositories from these providers:

- **GitHub**
- **GitLab**
- **Bitbucket**
- **Codeberg**

## Private repositories

Private repositories require a repository secret. Secrets are managed outside the MCP — in the
dashboard or by running the \`partiri\` CLI yourself (the \`use_partiri_cli\` tool returns guidance);
run \`partiri llm guide\` for the exact command, and pass any token on \`stdin\` so it stays out of
the argument list.

Pass the resulting secret \`id\` as \`fkServiceSecret\` when creating or updating a service. You can also call
\`validate_service\` with \`probeReachability: true\`, \`fkServiceSecret\` and \`workspaceId\` set to confirm
access before deploying (the probe is authorized against that workspace).`,
  },
  {
    name: 'Registry providers',
    uri: 'partiri://docs/deployments/registry-providers',
    description:
      'Supported container registries: Docker Hub, AWS ECR, Google Artifact Registry',
    content: `# Registry Providers

If you prefer deploying from a container image, we accept private and public images from these registries:

- **Docker Hub**
- **AWS ECR**
- **Google Artifact Registry**

## Private registries

Private registries require a registry secret. Secrets are managed outside the MCP — in the
dashboard or by running the \`partiri\` CLI yourself (the \`use_partiri_cli\` tool returns guidance);
run \`partiri llm guide\` for the exact command, and pass any password on \`stdin\`.

Pass the resulting secret \`id\` as \`fkServiceSecret\` when creating or updating a service. You can also call
\`validate_service\` with \`probeReachability: true\`, \`fkServiceSecret\` and \`workspaceId\` set to confirm
access before deploying (the probe is authorized against that workspace).`,
  },
  {
    name: 'Scaling & pod sizes',
    uri: 'partiri://docs/deployments/scaling',
    description:
      'Pod sizes, custom sizing, replica counts, CPU/memory allocation, and billing model',
    content: `# Scaling & Pod Sizes

Services run on pods. You select a pod size when creating a service, which determines the CPU and memory available to your container.

**Pick the cheapest pod that meets the workload's needs.** Use \`list_pods\` for the available sizes and \`get_pricing\` for what each one costs in a region, then start at the smallest size that fits.

- **Smaller pods** — suitable for background workers, lightweight APIs, and static sites
- **Larger pods** — appropriate for compute-intensive workloads, LLM inference, or services that hold state in memory

Scaling up later is a single \`update_service\` call with a new \`fkPod\` (or \`partiri service push\` from the CLI), applied on the next deployment. There is no penalty for starting small.

## Requests vs limits

A catalogue pod publishes two numbers per resource: the **request** (\`cpu_request\`, \`ram_request\`) is what the pod is guaranteed and scheduled against, and the **limit** (\`cpu_limit\`, \`ram_limit\`) is the ceiling it may burst to. \`list_pods\` returns both. A container exceeding its memory limit is OOM-killed; exceeding the CPU limit is throttled, not killed.

A **custom** pod is sized with requests equal to limits — the number you dial in is both what you are guaranteed and what you are billed for, with no burst headroom above it.

## Custom pod sizes

If no catalogue size fits, \`create_service\` accepts \`customPod: { vcpuMillicores, memoryMib }\` instead of \`fkPod\`. Provide exactly one of the two — never both.

Call \`get_custom_pod_options({ regionIds })\` first. It returns the permitted range and the **step grid** values must land on; anything off the grid is rejected. Pass every region the service will run in, since one pod size covers all of them and the offered range is the intersection. \`available: false\` means custom pods cannot be offered for that region set — use a catalogue pod instead.

Custom pods are priced from a rate card, not the catalogue: \`vCPU x price_per_vcpu_month + GB x price_per_gb_ram_month\`, both returned in \`rates\`.

Custom pods are deliberately **absent** from \`list_pods\` and from the default \`get_pricing\` response. To price a service that already runs one, name its \`fk_pod\` in \`get_pricing({ regionId, podIds: [...] })\` — otherwise it comes back unpriced.

## Replicas

\`replicaCount\` is the number of pods run **in each region**. It is not the same thing as the \`replicas\` array on a service, which lists the *regions* the service is deployed to.

Total pods — and the monthly bill — is \`replicaCount x number of regions\`. Changing \`replicaCount\` through \`update_service\` changes billing immediately and enqueues a deploy, so it restarts the workload.

Cronjob and database services always run a single replica.

## Billing — read this before choosing a size

Pod pricing is a **flat monthly rate per size**, charged in full when the service is created and renewed monthly. Actual CPU and memory consumption is never an input to the bill: a pod sitting at 2% utilization costs exactly what the same pod costs at 90%. The rate is charged **per pod**, so a service running two replicas across two regions pays the rate four times.

Choosing a size that costs 12x more than one that would have sufficed costs 12x from day one, and low usage does not recover it. Downsizing later takes effect immediately, but the refund on the already-charged month is prorated by **whole remaining days, rounded up** — the money spent on an oversized first month is largely spent.

### Cronjobs are the exception

A cronjob is **metered, not billed monthly**: nothing is charged at creation and each run is debited on its actual duration (rounded up to the minute, 1-minute floor) at the pod's monthly price divided by 43,200. Everything above about flat monthly pricing does **not** apply to it.

That inverts the sizing advice: because you pay for time actually used, a larger pod that halves the runtime often costs the same or less. See \`partiri://docs/services/cronjob\`.`,
  },
  {
    name: 'Zero-downtime deployments',
    uri: 'partiri://docs/deployments/zero-downtime',
    description:
      'Rolling update strategy and what happens when deployments fail',
    content: `# Zero-Downtime Deployments

By default, deployments are rolling updates. When you trigger a deployment:

1. The new version of your service is started alongside the old one.
2. The platform waits for the new pod to pass its health check.
3. Traffic is directed to the new pod and the previous pod is stopped.

Your service stays available throughout the deployment with no interruption for your users.

## Failed deployments

If the new version fails to start or fails its health check within the deployment timeout window, the deployment is marked as failed. The old version continues running, so your service remains available while you investigate the issue.

## Tips to minimize risk

- Set a health check path on your service
- Keep your startup time short
- Test your build locally before pushing`,
  },
  {
    name: 'Rollbacks',
    uri: 'partiri://docs/deployments/rollbacks',
    description: 'How to revert to a previous deployment version',
    content: `# Rollbacks

Every deployment is tracked in your service's job history. Each job records the Git commit SHA or container image tag that was deployed.

## How to roll back

1. Open the service
2. Navigate to the Jobs tab
3. Redeploy a previous successful job

A rollback creates a new deployment job using the same source reference as the selected job — it follows the same build and health check process as any other deployment.

## From the CLI

Use \`partiri service deploy\` to redeploy the latest configuration. The command prompts for confirmation by default; pass \`-y\` (or run with a non-TTY stdin) to skip the prompt in scripts and agents. If you need to redeploy a specific commit, push a revert commit or update your branch to the desired commit SHA and deploy from there.`,
  },
];
