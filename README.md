# Partiri Cloud MCP Server

MCP server for the Partiri Cloud PaaS platform. Allows AI agents (Claude Code, VS Code, etc.) to manage workspaces, projects, services, deployments, and metrics through the [Model Context Protocol](https://modelcontextprotocol.io).

## Transports

The server supports two transport modes:

| Transport | Use case | Set via |
|-----------|----------|---------|
| **stdio** (default) | Local CLI / direct integration | `MCP_TRANSPORT=stdio` or omit |
| **HTTP** | Remote access with OAuth 2.1 | `MCP_TRANSPORT=http` |

## Quick Start

```bash
npm install
npm run build
```

### stdio (local)

```bash
PARTIRI_API_KEY=your-key npx tsx src/index.ts
```

Or point your MCP client at the built binary:

```json
{
  "partiri": {
    "type": "stdio",
    "command": "node",
    "args": ["dist/index.mjs"],
    "env": { "PARTIRI_API_KEY": "your-key" }
  }
}
```

### HTTP (remote)

```bash
MCP_TRANSPORT=http \
MCP_TOKEN_SECRET=$(openssl rand -hex 32) \
MCP_BASE_URL=https://your-domain.com \
PORT=3000 \
npx tsx src/index.ts
```

Then configure your MCP client:

```json
{
  "partiri": {
    "type": "http",
    "url": "https://your-domain.com/mcp"
  }
}
```

No API key in the config &mdash; the OAuth 2.1 browser flow handles authentication.

## Authentication

### stdio

The API key is resolved in order:

1. `PARTIRI_API_KEY` environment variable
2. `~/.config/partiri/key` file (written by `partiri auth`)
3. If the process is interactive (TTY attached and no CI environment detected), `browserLogin()` opens a browser and waits for the user to authorize
4. Otherwise, throws a descriptive error with a link to docs

**Headless / CI usage:** set `PARTIRI_API_KEY`. In CI or non-TTY contexts step 3 is skipped and the server fails fast with a clear error rather than hanging on a browser prompt.

### HTTP (OAuth 2.1)

The HTTP transport implements a full OAuth 2.1 authorization server. When a client like Claude Code connects, the flow is:

1. Client discovers endpoints via `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`
2. Client dynamically registers via `POST /register`
3. The client opens `/authorize`, which redirects the browser to the hosted Partiri sign-in page (`PARTIRI_WEB_URL/cli-auth`) with a short `state` and the server's public `callback` URL
4. After the user confirms, the sign-in page mints a Partiri API key and redirects it back to the server's `GET /callback`, which validates the key against the Partiri API
5. The server issues an encrypted authorization code (bound to the client's PKCE challenge and redirect URI) and redirects to the client, which exchanges it for access/refresh tokens
6. All subsequent MCP requests use `Authorization: Bearer <token>`

Tokens are stateless &mdash; the API key is AES-256-GCM encrypted inside the token itself. No token database is needed.

Legacy `x-api-key` header authentication is also supported for backward compatibility with curl and non-OAuth clients.

#### Resource binding (RFC 8707)

Issued tokens are audience-bound to this server's canonical resource, `MCP_BASE_URL` + `/mcp` (e.g. `https://mcp.partiri.cloud/mcp`). A `resource` parameter naming any other server is rejected with `invalid_target`, and an access token whose audience names another server fails verification. Tokens issued before this claim existed remain valid until their natural expiry and are upgraded to audience-bound tokens on their next refresh.

The protected-resource metadata (RFC 9728) is served at both `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource`, and every `401` carries a `WWW-Authenticate` header with a `resource_metadata` pointer so clients can discover the authorization server.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PARTIRI_API_KEY` | stdio only | &mdash; | API key for the Partiri REST API |
| `PARTIRI_API_URL` | No | `https://api.partiri.cloud` | Partiri API base URL (must be HTTPS) |
| `PARTIRI_WEB_URL` | No | `https://partiri.cloud` | Hosted Partiri web app URL (HTTP OAuth sign-in redirect) |
| `PARTIRI_TIMEOUT` | No | `30` | API request timeout in seconds |
| `MCP_TRANSPORT` | No | `stdio` | Transport mode: `stdio` or `http` |
| `PORT` | No | `3000` | HTTP server port |
| `MCP_TOKEN_SECRET` | HTTP prod | &mdash; | 32-byte hex key (64 chars) for token encryption. Auto-generated in dev with a warning. |
| `MCP_BASE_URL` | HTTP prod | `http://localhost:{PORT}` | Public URL of the MCP server |
| `MCP_DATA_DIR` | No | &mdash; | Persistent dir for client registrations + token secret (survives restarts; single-replica) |
| `MCP_ALLOWED_REDIRECT_HOSTS` | No | &mdash; | Comma-separated OAuth redirect hosts allowed in addition to loopback |
| `MCP_ALLOWED_ORIGINS` | No | claude.ai, claude.com, chatgpt.com, chat.openai.com | Comma-separated browser Origins allowed on `/mcp` (own origin always included). Requests with any other `Origin` header get 403; requests without one (non-browser clients) always pass |
| `MCP_TRUSTED_PROXIES` | HTTP prod | `loopback` | Trusted proxy IP(s)/CIDR(s) for client-IP rate limiting; set to your ingress so X-Forwarded-For can't be spoofed |
| `MCP_MAX_SESSIONS` | No | `1000` | Max concurrent MCP sessions |
| `MCP_MAX_SESSIONS_PER_KEY` | No | `5` | Max sessions per API key |
| `MCP_SESSION_TTL_MINUTES` | No | `30` | Session inactivity timeout |
| `MCP_READONLY` | No | `false` | When truthy, only read-only tools are registered |
| `MCP_TOOLS_ALLOWLIST` | No | &mdash; | Comma-separated tool names to enable on top of the base set |
| `MCP_TOOLS_DENYLIST` | No | &mdash; | Comma-separated tool names to remove (wins over allowlist) |

## Available Tools

| Tool | Description |
|------|-------------|
| `list_workspaces` | List all workspaces the user has access to |
| `get_current_user` | Get the authenticated user's profile |
| `list_projects` | List projects in a workspace |
| `create_project` | Create a new project |
| `list_pods` | List available compute pods |
| `list_regions` | List available deployment regions |
| `list_services` | List services in a project |
| `get_service` | Get service details |
| `create_service` | Create a new service |
| `update_service` | Update service configuration |
| `validate_service` | Preflight-validate a service config; optionally probe repo/registry reachability (needs `workspaceId`) |
| `deploy_service` | Trigger a new deployment |
| `pause_service` | Pause a running service |
| `unpause_service` | Resume a paused service |
| `list_jobs` | List deployment jobs for a service |
| `list_volumes` | List persistent volumes in a project |
| `get_volume` | Get details of a single volume |
| `get_cpu_metrics` | Get CPU usage metrics |
| `get_memory_metrics` | Get memory usage metrics |
| `get_network_metrics` | Get network metrics |
| `get_pricing` | Get pod and volume pricing for a region |
| `get_balance` | Get a workspace's billing balance |
| `use_partiri_cli` | Advisory guidance for running the `partiri` CLI yourself for sensitive, CLI-only operations |

### CLI-only operations

To keep long-lived credentials out of the model context and irreversible
operations off the MCP surface, the following are **not** individual MCP tools.
You run them yourself with the locally-installed `partiri` CLI, which
authenticates independently of the MCP session. The `use_partiri_cli` tool does
**not** execute anything — it returns guidance for the command to run in your
own shell:

- **Workspace secrets** — create / list / delete repository and registry secrets
- **Service environment variables** — `partiri service env`; values hold secrets
  (DB URLs, API keys), so they are never read or written through the MCP —
  `create_service`/`update_service` don't accept `env` and `get_service` omits it
- **Volume lifecycle** — create / attach / detach / delete / retry
- **Service teardown** — `partiri service kill`

Discover exact subcommands and flags at runtime (`partiri llm guide`,
`partiri llm capabilities -j`, or `partiri <area> --help`) rather than assuming
syntax. For credential values, pass them on stdin (e.g. `--key-stdin`) so they
stay out of the argument list and this context.

## Project Structure

```
src/
  index.ts              Entry point (transport selection)
  auth.ts               API key resolution (env / file / browser login)
  auth-login.ts         Browser-based login flow for interactive stdio sessions
  client.ts             PartiriApiClient (HTTP, retry on 429)
  server.ts             MCP server creation, tool filtering, and tool registration
  errors.ts             Error formatting helpers
  net-guard.ts          SSRF / OAuth-redirect host classification (private/loopback/metadata)
  http.ts               HTTP transport (Express, OAuth, sessions)
  oauth/
    provider.ts         OAuthServerProvider — authorize, token exchange, verification
    client-store.ts     Dynamic client registration (in-memory and file-backed)
    crypto.ts           AES-256-GCM token encryption/decryption
  tools/
    index.ts            Tool aggregator
    workspaces.ts       Workspace tools
    user.ts             User tools
    projects.ts         Project tools
    resources.ts        Pod, region, pricing, and balance tools
    services.ts         Service CRUD tools
    validate.ts         validate_service preflight tool (SSRF-guarded reachability probe)
    deployments.ts      Deploy, pause, unpause, and job-list tools
    storage.ts          Volume read tools (list_volumes, get_volume)
    metrics.ts          CPU, memory, network metrics tools
    cli.ts              use_partiri_cli advisory tool
  resources/            Embedded MCP documentation resources
    index.ts            Resource registration
    content/            Guides (getting started, services, deployments, …)
```

## Development

```bash
npm install
npm test              # run tests (vitest)
npm run test:watch    # watch mode
npm run dev           # run with tsx (stdio)
npm run build         # bundle to dist/
```

### Adding a New Tool

1. Add the API method to `src/client.ts`
2. Add a tool definition and handler in the appropriate `src/tools/<domain>.ts`
3. The tool is automatically registered via `tools/index.ts` aggregation

## Deployment

For production behind a reverse proxy (Cloudflare, nginx):

1. Set `MCP_TRANSPORT=http`
2. Generate a stable token secret: `openssl rand -hex 32`
3. Set `MCP_TOKEN_SECRET` to the generated value
4. Set `MCP_BASE_URL` to the public URL (e.g. `https://mcp.partiri.cloud`)
5. Set `PARTIRI_API_URL` if the API is not at the default `https://api.partiri.cloud`
6. Set `MCP_TRUSTED_PROXIES` to your ingress/proxy IP or CIDR (e.g. `10.0.0.0/8`)
7. Deploy and expose port `3000` (or set `PORT`)

Rate limiting keys on the client IP derived from `X-Forwarded-For`, which is only
trusted from the proxies named in `MCP_TRUSTED_PROXIES` (default: loopback only).
Set it to your real ingress range **and** ensure the proxy overwrites inbound
`X-Forwarded-For` — otherwise a client able to reach the server through a
trusted/loopback proxy could spoof its IP and bypass per-IP limits. The session
and client-registration stores are independently bounded (the API key is
validated before a session is created, and stores evict oldest-first), so
resource exhaustion and lockout are prevented even if IP limiting is
misconfigured.

## Usage Examples

The following examples show realistic prompts an end user might give to an AI agent connected to this MCP server, and which tools each prompt exercises.

**Inspect a service and check its resource usage**

> "Show me CPU and memory usage for my api service over the last hour."

Exercises: `list_workspaces` → `list_projects` → `list_services` → `get_service` → `get_cpu_metrics`, `get_memory_metrics`

**Deploy a service and monitor progress**

> "Deploy the latest commit of the frontend service in my production project, then tell me when it succeeds."

Exercises: `list_workspaces` → `list_projects` → `list_services` → `deploy_service` → `list_jobs`

**Create a new service from a Git repository**

> "List all services in my staging project and create a new Node.js web service from github.com/owner/repo on the main branch."

Exercises: `list_workspaces` → `list_projects` → `list_services` → `list_pods` → `list_regions` → `create_service`

**Put a service in maintenance mode**

> "Enable maintenance mode on the checkout service while I push a hotfix."

Exercises: `list_workspaces` → `list_projects` → `list_services` → `update_service`

## Support

For questions, bug reports, or integration help: **support@partiri.cloud**

Full documentation is available at https://partiri.cloud/documentation/mcp.

## Privacy

This connector accesses workspace, project, service, deployment, log, and metrics data from your Partiri account on behalf of the authenticated user, and only that data. Secrets never reach the model context: environment variable values and secret references (`env`, `fk_service_secret`) are stripped from every tool response, and secret management is deliberately CLI-only. It does not maintain a token database — API keys are AES-256-GCM encrypted inside stateless OAuth tokens — and server-side session state is in-memory with a 30-minute inactivity TTL.

Privacy policy: https://partiri.cloud/privacy
