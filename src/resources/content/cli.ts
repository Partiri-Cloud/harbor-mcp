import type { DocResource } from '../index.js';

/**
 * Documentation resources for the `partiri` CLI: the full command reference
 * (global flags, setup, service management, secrets, storage, discovery,
 * projects/workspaces, `partiri llm` agent helpers, MCP install/uninstall,
 * the JSON output contract, and installation) plus the annotated
 * `.partiri.jsonc` configuration file reference.
 */
export const resources: DocResource[] = [
  {
    name: 'CLI commands',
    uri: 'partiri://docs/cli/commands',
    description: 'Complete list of Partiri CLI commands with descriptions',
    content: `# CLI Commands

The Partiri CLI lets you manage your services directly from the terminal.

If \`partiri\` is installed, prefer \`partiri llm guide\` and \`partiri llm schema --json\` over this resource — they are version-pinned to the installed CLI and stay in sync with the binary.

## Global flags

These work on every subcommand:

- \`-j\`, \`--json\` — Emit machine-readable JSON to stdout (errors as JSON to stderr). Use this in scripts and from agents.
- \`-y\`, \`--yes\` — Skip confirmation prompts on destructive operations (\`deploy\`, \`kill\`, \`pause\`, \`unpause\`).
- \`--no-input\` — Never prompt; error if a required value is missing. Auto-enabled when stdin is not a TTY (so MCP/agent invocations get this for free).

## Setup

- \`partiri auth\` — Configure your API key. Accepts \`--key <KEY>\`, \`--key-stdin\` (recommended for agents — no shell history), or \`--force\` to overwrite without confirmation.
- \`partiri init\` — Interactive setup wizard that creates a \`.partiri.jsonc\` config file. Pass \`--template\` for a non-interactive commented scaffold (refuses to overwrite an existing file).
- \`partiri validate\` — Validate the local configuration file. Pass \`--remote\` to also run live API checks: UUIDs exist, region/pod pairing, repo/registry reachability, and (for absolute URLs) the health-check endpoint.

## Service management

- \`partiri service create\` — Register a new service on Partiri.
- \`partiri service pull\` — Pull an existing service configuration from Partiri (the only service subcommand that does not require an existing \`.partiri.jsonc\`).
- \`partiri service push\` — Push local config changes to an existing service.
- \`partiri service deploy\` — Trigger a new deployment. Prompts for confirmation by default; pass \`-y\` (or run with non-TTY stdin) to skip. Pass \`--service <UUID>\` to deploy a service by ID from outside its directory (bypasses \`.partiri.jsonc\`).
- \`partiri service metrics\` — Show current resource metrics and recent jobs.
- \`partiri service logs\` — Show the last 35 log lines from the past hour.
- \`partiri service jobs\` — List deployment jobs.
- \`partiri service pause\` / \`partiri service unpause\` — Pause or resume the service. Both prompt for confirmation by default.
- \`partiri service kill\` — Permanently stop the service. Prompts for confirmation by default.
- \`partiri service link\` — Fill in workspace, project, region and pod UUIDs in one call. Interactive when no flags are passed; non-interactive with \`--workspace --project --region --pod\` (and optional \`--token <UUID>\` / \`--clear-token\`). Workspace and project must change together; region and pod must change together.
- \`partiri service token\` — Link an authentication token for private repositories or registries (\`--secret <UUID>\` to set, \`--clear\` to remove).
- \`partiri service env [--path <.env>] [--save]\` — Manage runtime env vars. Without flags, prints the env vars currently stored on the service. With \`--path\`, parses the dotenv file and **replaces** the service's env vars in full. With \`--save\`, fetches the service's env vars and writes them to \`.env.partiri\` in the current directory (gitignore it — contains secrets). Env vars are never stored in \`.partiri.jsonc\`.

## Secrets

Repository and registry credentials for private sources. Secret VALUES are write-only — the API never reads them back (\`partiri secret list\` returns only id, name, and provider).

- \`partiri secret create-repository [--workspace <UUID>] [--name <NAME>] [--provider <PROVIDER>] [--username <USER>] [--token <TOKEN> | --token-stdin]\` — Create a git repository access secret (e.g. a PAT). Prefer \`--token-stdin\` so the credential never hits your shell history.
- \`partiri secret create-registry [--workspace <UUID>] [--name <NAME>] [--provider <PROVIDER>] [--username <USER>] [--password <PASS> | --password-stdin]\` — Create a container registry secret. Prefer \`--password-stdin\`.
- \`partiri secret list [--workspace <UUID>]\` — List secrets in a workspace.

Attach a secret to a service with \`partiri service token --secret <UUID>\`.

## Storage

Persistent volumes. Creating, attaching, and retry-provisioning a volume are done in the dashboard or via the API — they have no CLI subcommand.

- \`partiri storage list [--project <UUID>] [--workspace <UUID>]\` — List volumes.
- \`partiri storage show <UUID>\` — Show a single volume.
- \`partiri storage detach <UUID>\` — Detach a volume from its service.
- \`partiri storage delete <UUID>\` — Permanently delete a volume (irreversible data loss).

## Discovery

- \`partiri services list [--project <UUID>] [--workspace <UUID>]\` — List services in a project. Prompts when no flags are passed; \`--project\` skips all prompts, \`--workspace\` skips only the workspace picker.
- \`partiri regions list --workspace <UUID>\` — List regions available in a workspace.
- \`partiri pods list --workspace <UUID>\` — List compute pods (CPU/RAM tiers) available in a workspace.

## Projects & workspaces

- \`partiri projects list [--workspace <UUID>]\` — List projects in a workspace.
- \`partiri projects create [--workspace <UUID>] [--name <NAME>] [--environment <dev|staging|prod>]\` — Create a project. Prompts for any missing values unless \`--no-input\` is set.
- \`partiri workspaces list\` — List all accessible workspaces.

## Agent helpers (\`partiri llm\`)

A family of read-only commands designed for LLM agents and scripts. All output JSON when invoked with \`-j\`.

- \`partiri llm context [--workspace <UUID>]\` — One call returns the full nested workspace tree (workspaces → projects → services + regions + pods + repository secrets). The single best discovery call.
- \`partiri llm next\` — Inspects the current \`.partiri.jsonc\` and most recent job, suggests the next command to run.
- \`partiri llm doctor\` — Environment-level diagnostic (auth state, API reachability, config validity).
- \`partiri llm whoami\` — Auth state and identity (single call to \`/workspaces\`).
- \`partiri llm guide\` — Print the embedded agent guide (the in-binary \`LLM.md\`).
- \`partiri llm schema\` — JSON Schema for \`.partiri.jsonc\`, including mutual-exclusion and required-field rules.
- \`partiri llm template [--deploy_type ...] [--runtime ...] [--source repo|registry]\` — Pre-filled template printed to stdout (does not write to disk).
- \`partiri llm examples\` — Worked examples for common deployment shapes.
- \`partiri llm capabilities\` — The entire CLI tree as JSON.
- \`partiri llm errors\` — Catalog of every error code the CLI emits, with hints and suggested commands.
- \`partiri llm explain "<command>"\` — Deep help for a single command (e.g. \`partiri llm explain "service deploy"\`).

## MCP

- \`partiri mcp install [--client <slug>]\` — Install the Partiri MCP server configuration into an AI client. Omit \`--client\` to pick interactively.
- \`partiri mcp uninstall [--client <slug>]\` — Remove the Partiri MCP server configuration from an AI client.

Valid client slugs: \`claude-desktop\`, \`claude-code\`, \`cursor\`, \`vscode\`, \`copilot-cli\`, \`windsurf\`.

## JSON output contract

When invoked with \`-j\`/\`--json\`:

- **stdout**: exactly one structured result per invocation, terminated by \`\\n\`.
- **stderr**: spinners, prompts, warnings, and (on failure) the error JSON document.
- Every JSON document carries \`"schema_version": "1"\`.

Envelope shapes:

\`\`\`jsonc
// list
{ "schema_version": "1", "data": [ { ... } ] }
// single resource
{ "schema_version": "1", "data": { ... } }
// successful mutation
{ "schema_version": "1", "ok": true, "message": "...", "data": { ... } }
// error (stderr, exit code 1)
{
  "schema_version": "1",
  "ok": false,
  "error": {
    "code": "401",
    "message": "Unauthorized",
    "hint": "Run 'partiri auth' to update your API key.",
    "likely_causes": ["..."],
    "suggested_commands": ["partiri auth --key <K>", "partiri llm doctor"]
  }
}
\`\`\`

Exit codes: \`0\` success, \`1\` error, \`2\` user cancellation (Ctrl-C / interactive abort).

When something goes wrong, read \`error.suggested_commands\` first — that is the next command to run.

## Installation

Install via Cargo: \`cargo install partiri-cli\`
Install via npm: \`npm install -g @partiri/cli\`
Or download a pre-built binary from the Codeberg releases page for Linux and macOS (x64 and arm64).

## Configuration

The CLI uses a \`.partiri.jsonc\` file in your project root. This file stores the workspace ID, project ID, service configuration (runtime, build commands, run command, environment variables), and region/pod selection. After creating a service, the service ID is saved to this file automatically.

You can override the default API URL with \`PARTIRI_API_URL\` and the request timeout (in seconds) with \`PARTIRI_TIMEOUT\`.`,
  },
  {
    name: '.partiri.jsonc config reference',
    uri: 'partiri://docs/cli/config-reference',
    description:
      'Complete .partiri.jsonc configuration file reference with annotated example and field documentation',
    content: `# .partiri.jsonc Reference

The \`.partiri.jsonc\` file is created by \`partiri init\` and read by all CLI commands. It is a JSON5 file — comments (\`//\`) and trailing commas are supported. Edit it by hand and push changes with \`partiri service push\`.

For agents, the canonical machine-readable schema is \`partiri llm schema --json\` (mutual-exclusion and required-field rules included), and the easiest way to discover the UUIDs you need is \`partiri llm context\` (full nested workspace tree in one call). To fill \`fk_workspace\`/\`fk_project\`/\`fk_region\`/\`fk_pod\` interactively or in a single call, prefer \`partiri service link\` over hand-editing.

## Example

\`\`\`jsonc
{
  // The service ID assigned by Partiri after running 'partiri service create'.
  // Leave as null until you have created the service.
  "id": null,

  // Set by Partiri after each deployment. Required for 'partiri service logs' and metrics.
  // Run 'partiri service pull' to refresh this value after a new deployment.
  "deploy_tag": null,

  // The workspace this service belongs to (selected during init).
  "fk_workspace": "uuid",

  // The project this service belongs to (selected during init).
  "fk_project": "uuid",

  "service": {
    "name": "my-api",
    "deploy_type": "webservice",
    "runtime": "node",
    "root_path": ".",
    "repository_url": "https://github.com/org/repo",
    "repository_branch": "main",
    "build_command": "npm run build",
    "pre_deploy_command": "npm run migrate",
    "run_command": "npm start",
    "fk_region": "uuid",
    "fk_pod": "uuid",
    "health_check_path": "/health",
    "maintenance_mode": false,
    "active": true
    // Environment variables are managed via 'partiri service env --path <.env>'.
    // They are never stored in this file.
  }
}
\`\`\`

## Validation rules

- \`service.name\` must be **16 characters or fewer**. Validated locally and rejected by the API.
- \`repository_url\` and \`registry_url\` are **mutually exclusive** — set exactly one. \`partiri validate\` flags this.
- \`fk_region\` and \`fk_pod\` must belong to the **same workspace** as \`fk_workspace\`. Cross-workspace UUIDs return 404.
- Private repositories or registries require \`fk_service_secret\` to be set. Without it, \`partiri validate --remote\` fails on the source-reachability check. Create the secret with \`partiri secret create-repository\` / \`create-registry\` (or in the dashboard), then attach it with \`partiri service token --secret <UUID>\`.
- \`health_check_path\` accepts either a path (\`/health\`) or an absolute URL. Only absolute URLs are probed by \`partiri validate --remote\`; relative paths are deferred to runtime.

## Top-level fields

| Field | Description |
|-------|-------------|
| \`id\` | Service ID assigned by Partiri after \`partiri service create\`. Null until then — do not set manually. |
| \`deploy_tag\` | Set by Partiri after each deployment. Required for logs and metrics. Refresh with \`partiri service pull\`. |
| \`fk_workspace\` | The workspace this service belongs to (selected during \`partiri init\`). |
| \`fk_project\` | The project this service belongs to (selected during \`partiri init\`). |

## Service object fields

| Field | Description |
|-------|-------------|
| \`name\` | Display name for your service on Partiri Cloud. |
| \`deploy_type\` | Service type. One of: \`webservice\` (public HTTP), \`static\` (static hosting, repo only), \`private-service\` (internal), \`worker\` (background process, no inbound network). |
| \`runtime\` | Runtime environment. One of: \`node\`, \`deno\`, \`rust\`, \`python\`, \`go\`, \`ruby\`, \`elixir\`, \`php\`, \`jvm\`, \`dotnet\`, \`cpp\`, \`static\`, \`registry\`. |
| \`root_path\` | Path to the app root within the repository. Use \`.\` for repo root. Set to a subdirectory for monorepos. |
| \`repository_url\` | Git repository URL. Mutually exclusive with \`registry_url\`. Required for \`deploy_type: static\`. |
| \`repository_branch\` | Branch to deploy. |
| \`registry_url\` | Full container image reference (e.g. \`ghcr.io/owner/image:tag\`). The API splits host, repository, and tag server-side. Use instead of \`repository_url\` for Docker images. Not supported for \`static\`. |
| \`fk_service_secret\` | Authentication token for private repository or registry access. Set via \`partiri service token\`. |
| \`build_command\` | Command to build the project. Leave empty if not needed. |
| \`build_path\` | Output directory of the build step (e.g. \`dist\`). Required for \`deploy_type: static\`. |
| \`pre_deploy_command\` | Runs before each deployment, after build and before start (e.g. database migrations). |
| \`run_command\` | Command to start the service at runtime. Not used for \`deploy_type: static\`. |
| \`fk_region\` | Region where the service will be deployed. |
| \`fk_pod\` | Compute pod — determines CPU and RAM allocated to the service. |
| \`health_check_path\` | HTTP path polled to verify service health (e.g. \`/health\`). Must return HTTP 200. Set to null to disable. |
| \`maintenance_mode\` | When true, serves a maintenance page instead of routing traffic to your app. |
| \`active\` | Whether the service is active. |

> **Env vars** are never stored in \`.partiri.jsonc\`. Manage them via \`partiri service env --path <.env>\` (replaces in full).`,
  },
];
