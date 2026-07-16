import type { DocResource } from '../index.js';

/**
 * Documentation resources for onboarding: the platform overview, a
 * step-by-step first-deployment guide, a general FAQ (domains, regions,
 * billing, private repos, free tier), a migration guide from Heroku /
 * Railway / Render, security & compliance details, and a troubleshooting
 * guide for common deployment issues.
 */
export const resources: DocResource[] = [
  {
    name: 'Platform overview',
    uri: 'partiri://docs/getting-started/overview',
    description:
      'What Partiri Cloud is, supported service types, and infrastructure overview',
    content: `# Platform Overview

Partiri is a simple platform for deploying your applications to the web. You bring your code, we handle the rest — builds, networking, TLS, and hosting.

Whether it's a backend API, an internal worker, or a static website, you can have it running in minutes.

## Service types

- **Web services** — public-facing, with a subdomain and optional custom domain
- **Private services** — internal, service-to-service only
- **Workers** — long-running background processes with no inbound network at all (queue consumers and similar)
- **Static websites** — SPAs, docs sites, landing pages

Every public service gets a subdomain out of the box. You can attach your own custom domain whenever you're ready.

## Infrastructure

Partiri is a European company. All infrastructure runs entirely out of European regions. GDPR-compliant by default — no extra configuration needed.`,
  },
  {
    name: 'First deployment guide',
    uri: 'partiri://docs/getting-started/first-deployment',
    description:
      'Step-by-step guide to deploying your first application on Partiri',
    content: `# First Deployment

Deploying your first app takes just a few steps:

1. **Point us to your code** — either a Git repository (public or private) or a Docker image from a container registry.
2. **Pick your location and pod size** — all available regions are based in Europe.
3. **Hit deploy.**

That's it. We build your app, assign it a subdomain, and it's live. No infrastructure to configure, no YAML to wrestle with.`,
  },
  {
    name: 'FAQ',
    uri: 'partiri://docs/getting-started/faq',
    description:
      'Frequently asked questions about domains, regions, billing, private repos, and free tier',
    content: `# FAQ

## Can I use my own domain?

Yes. You can attach custom domains to any web service or static website from the service settings. TLS certificates are provisioned automatically via Let's Encrypt.

## What regions are available?

All regions are based in Europe. You can see the full list of regions when creating a service.

## How is billing calculated?

Billing is pay-as-you-go based on resource usage per workspace. You are only charged for the time your services are running. There are no minimum commitments.

## Can I deploy from a private repository?

Yes. Secrets are managed outside the MCP — in the Partiri dashboard or by running the \`partiri\` CLI yourself (the \`use_partiri_cli\` tool returns guidance) — so the credential never passes through the model context. Store an SSH private key or personal access token there (encrypted server-side), then pass the resulting secret UUID as \`fkServiceSecret\` when calling \`create_service\` or \`update_service\`. The same applies to private container registries. See \`partiri://docs/configuration/credentials\` and run \`partiri llm guide\` for the exact CLI commands.

## What happens if my balance runs out?

Services are paused when your workspace balance reaches zero. Top up your balance to resume them.

## Is there a free tier?

We do not offer a free tier at this time. All services consume from your workspace balance based on the pod size and uptime.`,
  },
  {
    name: 'Migration guide',
    uri: 'partiri://docs/getting-started/migration',
    description: 'How to migrate from Heroku, Railway, or Render to Partiri',
    content: `# Migrating from Another Platform

Coming from Heroku, Railway, or Render? Most apps migrate in minutes. We support the same runtimes and a similar Git-based deployment model, so your existing app will likely work without changes.

## From Heroku

- Replace your Procfile with a run command in the service settings.
- Heroku-style buildpacks are not supported — use a native runtime or a Dockerfile instead.
- Environment variables, add-on credentials, and custom domains all map directly to Partiri equivalents.

## From Railway or Render

- Your build command, start command, and environment variables transfer as-is.
- If you are using a Dockerfile, it will work unchanged.
- Custom domains and TLS certificates are provisioned automatically.
- There is no sleep-on-idle behavior — services run continuously and are billed by uptime.

## Differences to note

There is no automatic preview environment feature for pull requests. Deployments are always triggered manually or via Git push webhooks to a configured branch.`,
  },
  {
    name: 'Security & compliance',
    uri: 'partiri://docs/getting-started/security',
    description:
      'GDPR compliance, container isolation, TLS, and API security details',
    content: `# Security & Compliance

Partiri is a European platform. All infrastructure runs in EU regions and customer data stays within the EU. We are GDPR-compliant by default — no extra configuration is required.

## Container isolation

- Containers run as non-root users (UID 1001)
- Read-only root filesystems
- Dropped Linux capabilities
- Each service runs in an isolated Kubernetes pod on a shared cluster

## TLS & networking

- TLS certificate provisioning and renewal handled automatically via Let's Encrypt
- HTTPS is enforced for all public-facing web services and static websites
- Private services are never exposed to the internet — they are only reachable from other services within the same workspace

## API security

- All API communication uses HTTPS
- API keys are stored hashed and are not recoverable after creation`,
  },
  {
    name: 'Troubleshooting',
    uri: 'partiri://docs/getting-started/troubleshooting',
    description:
      'Common issues: build failures, startup crashes, health checks, stuck deployments, DNS',
    content: `# Troubleshooting

## Build fails

Check that your build command is correct and that all dependencies are declared in your dependency file (\`package.json\`, \`requirements.txt\`, \`Cargo.toml\`, \`go.mod\`, etc.). The build runs in a clean environment, so any dependency that is not declared will not be available.

## Service crashes on start

Open the Logs tab for your service and look for error messages at startup. Common causes:

- A missing or incorrect run command
- A missing required environment variable
- A port mismatch — the platform injects a \`PORT\` environment variable at runtime; your service **must** bind to that port. Do not hard-code a port number.

## Health check failing

Verify that your health check path returns HTTP 200. The check runs after the service starts, so a slow-starting service may need a longer initial grace period. Make sure the endpoint is reachable without authentication.

## Deployment stuck in progress

Deployments have a timeout. If a build takes too long or the container never passes its health check, the deployment will be marked as failed and the previous version (if any) will continue running. Check the Events tab for details.

## Custom domain not resolving

DNS changes can take up to 48 hours to propagate. Verify that your CNAME or A record points to the correct value shown in the service settings. Make sure there are no conflicting records at your DNS provider.`,
  },
];
