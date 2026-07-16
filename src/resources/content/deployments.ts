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
\`validate_service\` with \`probeReachability: true\` and \`fkServiceSecret\` set to confirm access
before deploying.`,
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
\`validate_service\` with \`probeReachability: true\` and \`fkServiceSecret\` set to confirm access
before deploying.`,
  },
  {
    name: 'Scaling & pod sizes',
    uri: 'partiri://docs/deployments/scaling',
    description: 'Pod sizes, CPU/memory allocation, and billing model',
    content: `# Scaling & Pod Sizes

Services run on pods. You select a pod size when creating a service, which determines the CPU and memory available to your container.

- **Smaller pods** — suitable for background workers, lightweight APIs, and static sites
- **Larger pods** — appropriate for compute-intensive workloads, LLM inference, or services that hold state in memory

You can change the pod size at any time from the service settings page. The change takes effect on the next deployment.

## Billing

Pod sizes are billed per second of uptime, so you only pay for what you use. All pod sizes include a fixed allocation of CPU and memory — there is no bursting or shared-CPU throttling.`,
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
