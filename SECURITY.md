# Security Policy

## Supported Versions

Only the latest release line (`0.1.x`) receives security fixes. Older tags are
not actively maintained.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately by emailing **support@partiri.cloud** with:

- A description of the vulnerability and its potential impact.
- Steps to reproduce (proof-of-concept is welcome but not required).
- The version of the package you are testing against.

We will acknowledge receipt within **3 business days** and aim to provide an
initial assessment within **7 business days**. We practice coordinated
disclosure — please allow us reasonable time to investigate and ship a fix
before publishing details publicly.

## Security Model and Accepted Residual Risk

The following are **known, deliberate design trade-offs** — not bugs. They are
documented here so security reviewers understand the intended behaviour.

### CORS allow-all on OAuth endpoints

The MCP SDK's auth router sets `Access-Control-Allow-Origin: *` on the OAuth
endpoints it handles: `/token`, `/register`, and the `.well-known` metadata
endpoints (`/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource/mcp`). This is intentional — the SDK
comment reads: "Configure CORS to allow any origin, to make accessible to
web-based MCP clients."

This is safe because:

- These endpoints are either unauthenticated (`.well-known`, `/register`) or
  token-bearing (`/token` uses an authorization code or refresh token in the
  request body, not a cookie). The `Access-Control-Allow-Origin: *` header
  only enables credential-less cross-origin reads; it does not enable
  CSRF (which requires cookies or ambient credentials).
- `/mcp`, `/authorize`, and `/callback` are **not** handled by this CORS
  middleware.

### In-memory sessions with file-backed fallback

MCP sessions are held in-memory (a `Map<sessionId, Session>`). On a
pod restart or redeploy, the map is empty. Without persistent storage
configured, clients receive a `404 Session not found` response, which causes
the MCP client to perform one extra `initialize` round-trip; the client's
existing Bearer token (stateless, encrypted) remains valid and **no
re-authentication via OAuth is required** provided:

1. `MCP_TOKEN_SECRET` is set to a stable 32-byte hex value, and
2. `MCP_DATA_DIR` points to a writable persistent volume (so dynamic client
   registrations stored in `clients.json` survive restarts).

Without both of those, tokens and client registrations are regenerated on
restart and users must re-authenticate. This is expected for ephemeral or
stateless deployments.

## Security Strengths

- **Stateless AES-256-GCM tokens.** The Partiri API key is encrypted inside
  every access and refresh token. No token database is required or maintained.
- **PKCE S256-only.** The authorization code flow requires PKCE
  (`code_challenge_method=S256`); plain method is not accepted.
- **Restricted OAuth redirect targets.** Dynamically-registered clients may only
  use loopback redirect URIs or hosts in `MCP_ALLOWED_REDIRECT_HOSTS`, enforced
  at registration and re-checked when the code is issued. A registered client
  therefore cannot receive another user's minted credential (confused-deputy).
- **Single-use authorization codes.** Each authorization code carries a unique
  id; on redemption that id is recorded in a bounded in-memory set and any reuse
  is rejected (`exchangeAuthorizationCode`), per OAuth 2.1 §4.1.3. The pending
  browser sign-in `state` is likewise one-shot (`consumePendingLogin`).
- **No secrets logged.** Request bodies and `Authorization` headers are never
  written to the access log. Error messages are sanitized before being returned
  to callers (URLs and file paths are redacted).
- **Sensitive operations are CLI-only.** Workspace secret management, volume
  lifecycle mutations, and service teardown are intentionally absent from the
  MCP tool surface. The `use_partiri_cli` tool returns guidance text only — it
  does not spawn processes or execute commands.
- **Service env never crosses the MCP boundary.** Environment-variable values
  hold secrets (DB URLs, API keys), so `create_service`/`update_service` do not
  accept an `env` field and `get_service` strips `env` from its response.
- **SSRF guard on reachability probes.** Before `validate_service` probes a
  caller-supplied git repository or container-registry URL, the `net-guard`
  module rejects private, loopback, link-local, and cloud-metadata hosts (with
  numeric-IP-encoding normalization). This is a literal-check, defense-in-depth
  layer; the authoritative resolve-and-block guard lives in the upstream Partiri
  API probe endpoints.
- **Rate limiting.** OAuth endpoints (`/authorize`, `/token`, `/register`,
  `/callback`) are rate-limited to 20 requests per minute per IP. The `/mcp`
  endpoint is limited to 200 requests per minute with a tighter limit of 10
  new session initializations per minute. Set `MCP_TRUSTED_PROXIES` to your
  ingress IP/CIDR so these limits key on the real client IP and a direct
  connection cannot spoof `X-Forwarded-For`.
- **Validated, bounded sessions.** A new session is created only after the API
  key is verified against the upstream API, and the in-memory pending-login and
  client-registration stores evict their oldest entry when full — so neither
  garbage keys nor a registration flood can exhaust the server or lock out
  legitimate users.
