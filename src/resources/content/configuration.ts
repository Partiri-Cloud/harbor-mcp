import type { DocResource } from '../index.js';

/**
 * Documentation resources covering per-service configuration: Git push
 * webhooks, runtime environment variables, health check endpoints,
 * credentials for private repositories/registries, CI/CD deploy hooks, and
 * monorepo (subdirectory) deployments.
 */
export const resources: DocResource[] = [
  {
    name: 'Webhooks',
    uri: 'partiri://docs/configuration/webhooks',
    description: 'Automatic deployments triggered by Git push events',
    content: `# Webhooks

Partiri supports automatic deployments triggered by Git push events. When you enable auto-deploy on a service, a webhook URL is generated that you can add to your repository settings.

Supported providers: GitHub, GitLab, Bitbucket, and Codeberg.

Each push to the configured branch will trigger a new deployment automatically. Webhook secrets are generated for signature validation to ensure only legitimate pushes trigger builds.`,
  },
  {
    name: 'Environment variables',
    uri: 'partiri://docs/configuration/env-vars',
    description: 'How to configure runtime environment variables for services',
    content: `# Environment Variables

Each service can have its own set of environment variables that are injected at runtime. Use them for:

- Configuration values
- Secrets references
- API endpoints
- Feature flags

Environment variable values hold secrets (database URLs, API keys), so they are **not** managed through the MCP: \`create_service\` and \`update_service\` do not accept an \`env\` field, and \`get_service\` omits \`env\` from its response. Manage them either from the service settings page in the dashboard, or by running the locally-installed \`partiri\` CLI yourself — \`partiri service env\` (the \`use_partiri_cli\` tool returns guidance for the command; it does not execute anything). Changes take effect on the next deployment.`,
  },
  {
    name: 'Health checks',
    uri: 'partiri://docs/configuration/health-checks',
    description:
      'Configuring health check endpoints for automatic service monitoring',
    content: `# Health Checks

You can configure a health check path for your service (for example, \`/health\`). The platform will periodically send HTTP GET requests to this endpoint to verify that your service is running correctly.

- If the health check fails, the platform will automatically restart the service.
- The endpoint should return a **200 status code** when the service is healthy.
- Make sure the endpoint is reachable **without authentication**.

Set the \`healthCheckPath\` field when creating or updating a service.`,
  },
  {
    name: 'Credentials',
    uri: 'partiri://docs/configuration/credentials',
    description:
      'Setting up authentication for private Git repos and container registries',
    content: `# Credentials

To deploy from private Git repositories or private container registries, you need to configure credentials.

Credentials are managed at the **workspace level** and can be reused across services. The value is stored encrypted server-side — it is never returned after creation.

## Managing credentials — outside the MCP

Secrets are **not** created, listed, or deleted through dedicated MCP tools — that
keeps long-lived credentials out of the model context. Manage them either in the
Partiri dashboard, or by running the locally-installed \`partiri\` CLI **yourself**.
The \`use_partiri_cli\` tool does not run anything — it returns guidance for the
command to run in your own terminal.

The CLI's exact secret subcommands and flags vary by version, so **discover them
at runtime** rather than guessing — run these in your terminal (or ask
\`use_partiri_cli\` for guidance):

\`\`\`
use_partiri_cli({ action: "discover CLI commands", command: "partiri llm guide" })
use_partiri_cli({ action: "list CLI capabilities as JSON", command: "partiri llm capabilities -j" })
\`\`\`

When a command accepts a credential value, pass it on **stdin** (using the CLI's
stdin flag, e.g. \`--key-stdin\`) so the secret never appears in the argument list.
A repository secret can be attached to a service by running
\`partiri service token --secret <secretUUID>\` — for guidance, call
\`use_partiri_cli({ action: "attach a repository secret to a service", command: "partiri service token --secret <secretUUID>" })\`.

## Typical workflow: deploy a private repo

1. Obtain a secret UUID — create it in the dashboard, or by running the \`partiri\` CLI yourself (\`use_partiri_cli\` returns guidance; consult \`partiri llm guide\` for the exact command). \`partiri llm context\` lists existing repository secrets.
2. Pass \`fkServiceSecret: "<id>"\` to \`create_service\` (or \`update_service\` to update an existing service).
3. Optionally call \`validate_service\` with \`probeReachability: true\` to confirm the repository is reachable.

## Git repository providers

GitHub, GitLab, Bitbucket, Codeberg

## Container registry providers

Docker Hub, AWS ECR, Google Artifact Registry`,
  },
  {
    name: 'Deploy hooks',
    uri: 'partiri://docs/configuration/deploy-hooks',
    description:
      'Unique URLs that trigger deployments via HTTP POST for CI/CD pipelines',
    content: `# Deploy Hooks

Deploy hooks are unique URLs that trigger a new deployment when called with an HTTP POST request.

They are useful for CI/CD pipelines that are not connected via Git push webhooks — for example, triggering a deploy after a custom build step in your pipeline, or deploying from a system outside your Git provider.

## How to use

1. Open the service settings
2. Find the deploy hook URL
3. Make a POST request to that URL from your CI system

No request body or authentication header is required — the URL itself acts as the secret.

You can regenerate the deploy hook URL at any time to invalidate the previous one. Deploy hooks trigger a deployment of the current branch and configuration, the same as pressing the Deploy button.`,
  },
  {
    name: 'Monorepo support',
    uri: 'partiri://docs/configuration/monorepo',
    description:
      'Deploying multiple services from different subdirectories in one repository',
    content: `# Monorepo Support

If your repository contains multiple services in separate subdirectories, you can configure each Partiri service to build and deploy from a specific path within the repository.

Set the **root_path** field in your service configuration to the subdirectory path (for example, \`apps/api\` or \`packages/backend\`). The platform will use that directory as the working directory when running your build and run commands.

This works for both Git-based and Dockerfile-based deployments.

You can have multiple Partiri services pointing to the same repository with different root paths, each deploying independently. When auto-deploy is enabled, a push to the configured branch will trigger a deployment for all services sharing that repository.`,
  },
];
