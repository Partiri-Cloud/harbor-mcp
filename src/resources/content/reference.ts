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
| \`deployType\` | Deployment type: \`webservice\` (public HTTP), \`static\` (static hosting), \`private-service\` (internal), \`worker\` (background process, no inbound network). |
| \`runtime\` | Language runtime: \`node\`, \`deno\`, \`rust\`, \`python\`, \`go\`, \`ruby\`, \`elixir\`, \`php\`, \`jvm\`, \`dotnet\`, \`cpp\`, \`static\`, \`registry\`. |
| \`rootPath\` | Directory inside the repository where the service source code lives. Leave as \`.\` if at repo root. |
| \`repositoryUrl\` | HTTP URL of your Git repository. Mutually exclusive with \`registryUrl\`. |
| \`repositoryBranch\` | The branch to deploy from. Required when \`repositoryUrl\` is set. |
| \`registryUrl\` | Full container image reference (e.g. \`ghcr.io/owner/image:tag\`). The API splits host, repository, and tag server-side. Mutually exclusive with \`repositoryUrl\`. |
| \`fkServiceSecret\` | UUID of a repository or registry secret. Required for private repos and registries. Secrets are managed outside the MCP — in the dashboard or by running the \`partiri\` CLI yourself (the \`use_partiri_cli\` tool returns guidance); obtain the UUID there, then pass it here. |
| \`buildCommand\` | Command to build your project (e.g. \`npm run build\`). Required for repository-sourced non-static services. |
| \`buildPath\` | Directory containing the build output (e.g. \`dist/\`, \`build/\`). Required for static sites. |
| \`preDeployCommand\` | Command to run after build but before the service starts (e.g. database migrations). |
| \`runCommand\` | Command to start your service. Required for \`webservice\`, \`private-service\`, and \`worker\` (repository-sourced; a registry-sourced worker can rely on its image's \`CMD\`/\`ENTRYPOINT\` instead). For \`webservice\` and \`private-service\`, it **must listen on the port given by the \`$PORT\` environment variable** — the platform injects \`PORT\` at runtime. A \`worker\` has no port to listen on. |
| \`healthCheckPath\` | HTTP path the platform pings to verify your service is up (e.g. \`/health\`). Returns 200 when healthy. |
| \`maintenanceMode\` | Enable/disable maintenance mode. When enabled, serves a maintenance page instead of the app. |
| \`fkProject\` | Project UUID to create the service in (use \`list_projects\` to find). |
| \`fkRegion\` | Region UUID for the primary replica (use \`list_regions\` to find available regions). |
| \`fkPod\` | Compute pod UUID (use \`list_pods\` to find available pod sizes). |

> **Environment variables** are **not** set through these tools. Their values hold
> secrets, so \`create_service\`/\`update_service\` do not accept an \`env\` field and
> \`get_service\` omits it from its response. Manage them with the \`partiri\` CLI
> (\`partiri service env\`) — see the \`use_partiri_cli\` tool.

## Reading a service's region

\`get_service\` returns the full service object. The primary region is available via
\`replicas[].fk_region\` where \`replicas[].is_primary === true\`. For convenience the handler
also sets a top-level \`fk_region\` field to the primary replica's region UUID.

## Cost fields returned by create_service and update_service

\`create_service\` returns a \`cost_estimate\` object when pricing is available:
\`\`\`json
{
  "pod_monthly": 20.00,
  "total_monthly": 20.00,
  "currency": "EUR"
}
\`\`\`

\`update_service\` returns a \`cost_delta\` when the pod or region changes:
\`\`\`json
{
  "current_monthly": 20.00,
  "new_monthly": 35.00,
  "delta_monthly": 15.00,
  "currency": "EUR"
}
\`\`\`

Both are informational and never block the operation. Use \`get_pricing\` and \`get_balance\` directly
for pre-flight cost checks, or call \`validate_service\` which aggregates them.`,
  },
];
