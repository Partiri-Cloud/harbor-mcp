# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A stale or expired `x-api-key` in a client's configuration no longer suppresses
  OAuth Bearer validation on `/mcp`. The header short-circuited the auth
  middleware on presence alone, so a client that completed the OAuth flow was
  rejected on every reconnect while it still sent the old header — and because
  the rejection was indistinguishable from an expired session, the client
  re-authenticated and was rejected again. The `Authorization` header is now
  validated first; `x-api-key` remains the fallback when no Bearer token is
  present.
- 401s raised on the legacy `x-api-key` path now carry a `WWW-Authenticate`
  header with an RFC 9728 `resource_metadata` pointer, matching what the Bearer
  path already emitted. Without it a rejected client had no way to discover the
  authorization server from the response.

## [0.3.0] — 2026-08-25

### Added

- Cronjob services. `create_service` and `update_service` accept
  `deployType: 'cronjob'` — a batch workload that runs to completion rather than
  staying up. `scheduler` is the discriminator: set it for a recurring CronJob,
  omit it for a one-shot Job. Also accepted: `cronjobTimeZone`,
  `cronjobActiveDeadlineSeconds`, `cronjobBackoffLimit`,
  `cronjobConcurrencyPolicy`, `cronjobCommand`, `cronjobStartingDeadlineSeconds`,
  `cronjobTtlSecondsAfterFinished`, `cronjobSuccessfulJobsHistoryLimit`, and
  `cronjobFailedJobsHistoryLimit`.

  A cronjob is **metered, not billed monthly** — nothing is charged at creation
  and each run is debited on its actual duration, rounded up to the minute at the
  pod's monthly price divided by 43,200. A nightly five-minute job on a €43.20
  pod costs roughly €0.15 a month, so its cost estimate reports a per-minute rate
  rather than a monthly one. `cronjobActiveDeadlineSeconds` is required because it
  bounds the worst-case cost of a run, and a cronjob always runs a single replica
  in one region.

  Suspending a schedule is deliberately **not** an `update_service` field: the API
  owns that flag and drives it from `pause_service` / `unpause_service` so it stays
  in step with the metered billing assignment. It is readable on `get_service`.

  A new `partiri://docs/services/cronjob` resource documents the type, and the
  service-fields and scaling resources cover the new fields.
- Custom pod sizes. `create_service` and `update_service` accept
  `customPod: { vcpuMillicores, memoryMib }` in place of `fkPod`, and a new
  `get_custom_pod_options` tool returns the permitted range, the step grid values
  must land on, and the rate card they are priced from. `get_pricing` gained a
  `podIds` parameter, since the bulk response covers catalogue pods only and a
  custom pod would otherwise come back unpriced.
- `replicaCount` on `create_service` and `update_service` — pods to run in each
  region. Total pods, and the monthly bill, is this times the number of regions.

### Changed

- **Cost objects have a new shape.** Every estimate now carries a
  `billing_model` discriminator (`flat_monthly` or `metered`), because the two
  models share no numeric fields and a caller must branch before reading any.
  A flat estimate reports `pod_unit_monthly` (one pod) alongside `pod_monthly`
  (that times `replica_count` times `region_count`); previously there was only
  an ambiguous `pod_monthly`. A metered estimate reports `per_minute` and
  `max_cost_per_run` instead, and `disk_monthly` appears on both — an attached
  volume is charged a flat month on any deploy type, so on a cronjob it is the
  entire recurring charge.
- **`update_service`'s `cost_delta` has a new shape** and now also fires when
  `deployType` changes, not only the pod, region, or replica count. It carries
  `current_billing_model` and `new_billing_model` so a delta stays meaningful
  when the model itself switches: converting a cronjob to a long-running service
  reports the full monthly charge it starts paying, and converting one away
  reports the saving, each with a `note` explaining the switch. Per-minute rates
  appear for whichever side is metered.
- The `validate_service` workspace-balance warning is compared against the
  **recurring** monthly charge. A metered workload no longer raises a false alarm
  over compute it is never billed for up front, while an attached volume is still
  checked.

### Fixed

- Cost estimates reported an unpriceable pod as **free**. A pod missing from the
  pricing response fell through a `?? 0` and was quoted at €0.00 in
  `create_service`, `update_service`, and `validate_service` alike. The estimate
  is now omitted entirely — absent means unknown, never free.
- `validate_service`'s cost estimate was not rounded to cents:
  `total_monthly` was a raw `podPrice + diskMonthly` sum, so ordinary prices could
  surface floating-point noise like `10.299999999999999`. Every component is now
  rounded once, and the total is the sum of the rounded parts, so what a caller
  reads always adds up.
- The `partiri://docs/deployments/scaling` resource claimed pods had "a fixed
  allocation of CPU and memory — there is no bursting". Catalogue pods publish a
  request and a separate, higher limit, which `list_pods` returns as
  `cpu_request`/`cpu_limit` and `ram_request`/`ram_limit`. The resource now
  distinguishes the two and notes that a custom pod's requests equal its limits.
  It also stated the flat monthly rate was charged per region replica, which
  understated a service running several replicas per region; it is charged per
  pod.

### Internal

- The billing-model decision lives in one place (`src/tools/cost.ts`): call sites
  pass facts to `quote()` and diff two quotes with `delta()` rather than each
  branching on deploy type.
- `create_service` and `validate_service` evaluate one shared rule list
  (`src/tools/service-rules.ts`), each rule marked blocking (mirrors something
  the API rejects, so `create_service` refuses) or advisory (stricter than the
  API, so only `validate_service` reports it). A property test asserts
  `validate_service` never reports a config valid that `create_service` would
  block, so the preflight cannot drift from the operation it previews.

## [0.2.3] — 2026-08-01

### Fixed

- The `partiri://docs/deployments/scaling` resource claimed pods were "billed per
  second of uptime, so you only pay for what you use". That is not how a
  long-running service is billed: pod pricing is a flat monthly rate per size,
  charged in full when the service is created, renewed monthly, and charged once
  per region replica — actual CPU and memory consumption is never an input. The
  incorrect wording told agents an oversized pod was nearly free and drove them
  to over-provision, at real cost to the user. The resource now states the
  billing model accurately, notes that a later downsize refunds only whole
  remaining days of the already-charged month, and advises picking the cheapest
  pod that meets the workload with `list_pods` and `get_pricing`. It also points
  at `update_service` for resizing instead of the dashboard.

## [0.2.2] — 2026-07-25

### Fixed

- `validate_service` reachability probes now send the `workspace` query param the
  Partiri API requires on `GET /resources/utils/git` and `/resources/utils/reg`.
  Without it the API answers 403, which the tool reported as an unreachable
  repository or registry. `workspaceId` is therefore required whenever
  `probeReachability` is set; when it is missing the affected source reports the
  missing argument instead of an outbound call that cannot succeed. A private or
  loopback host still reports the SSRF refusal first.

## [0.1.12] — 2026-06-23

### Security

- OAuth redirect targets are restricted to loopback addresses plus an explicit
  `MCP_ALLOWED_REDIRECT_HOSTS` allowlist, enforced at registration and re-checked
  when the sign-in callback issues the code (non-conforming stored clients are
  purged on load) — closing a confused-deputy path that could forward a signed-in
  user's credential to an attacker-registered client.
- SSRF defense for `validate_service` reachability probes: caller-supplied git
  repository and container-registry URLs are classified by a new `net-guard`
  module, and a private, loopback, link-local, or cloud-metadata host is refused
  before any outbound probe. This is a defense-in-depth layer — literal host
  checks only — backing the authoritative resolve-and-block guard in the upstream
  Partiri API.
- Authorization codes are now single-use: each code carries a unique id that is
  recorded on redemption, so a code cannot be exchanged for tokens more than once
  (OAuth 2.1 §4.1.3). The pending browser sign-in state remains one-shot as well.
- Denial-of-service hardening: the API key is validated against the upstream API
  before a session is allocated (garbage keys can no longer fill the session
  pool); the pending sign-in and dynamic-client stores evict their oldest entry
  when full instead of rejecting (a flood cannot lock out new sign-ins or client
  registrations); and `trust proxy` is driven by `MCP_TRUSTED_PROXIES` so a
  direct/off-proxy attacker cannot spoof `X-Forwarded-For` to bypass per-IP rate
  limits.
- `verifyAndDecrypt` fails closed on malformed tokens: a missing or non-numeric
  `exp` is treated as expired, and a missing or non-string API key is rejected,
  rather than flowing through unchecked.

### Changed

- Service environment variables are no longer exposed on the MCP surface at all.
  `create_service` and `update_service` no longer accept an `env` field, and
  `get_service` strips `env` from its response entirely (0.1.11 only redacted the
  values). Manage environment variables out-of-band with the `partiri` CLI (see
  `use_partiri_cli`).

### Added

- `list_services` pagination: a `limit` parameter (default 50, max 200) and a
  `has_more` flag in the response so callers can tell when a result set was
  truncated and raise `limit` to fetch the rest.
- Exactly-one-source validation on `create_service` and `update_service`
  (repository URL XOR registry URL), mirroring `validate_service`, so a sourceless
  or dual-source body is rejected client-side instead of failing later at deploy
  time.
- `LICENSE` (MIT).
- `SECURITY.md` — vulnerability reporting process, security model, accepted
  residual risks, and strengths summary.
- `CONTRIBUTING.md` — dev setup, build, test, code style, and how to add a new
  tool.
- `CODE_OF_CONDUCT.md` — Contributor Covenant v2.1.
- `.env.example` — reference for all supported environment variables.

## [0.1.11] — 2026-06-16

### Added

- `MCP_READONLY` environment variable: when truthy, only tools annotated with
  `readOnlyHint: true` are registered, giving operators a low-trust surface for
  read-only agent sessions.
- `MCP_TOOLS_ALLOWLIST` and `MCP_TOOLS_DENYLIST` for fine-grained tool
  filtering on top of the read-only base. Denylist always wins over allowlist.
- `use_partiri_cli` tool: advisory guidance for running the locally-installed
  `partiri` CLI for sensitive operations (workspace secrets, volume lifecycle,
  service teardown) that are intentionally absent from the MCP tool surface.
- Service environment values are redacted in API responses to avoid leaking
  secrets into the model context.

## [0.1.10] — 2026-06-02

### Changed

- Unknown or expired MCP session IDs now return HTTP 404 (previously 400),
  allowing MCP clients to transparently re-initialize without forcing a fresh
  OAuth sign-in after a server restart.
- Corrected several tool descriptions and annotations to match the current
  Partiri CLI interface.

## [0.1.0] — 2026-04-05

### Added

- Initial release with stdio and HTTP (Streamable HTTP) transports.
- **OAuth 2.1** authorization server for the HTTP transport: authorization code
  + PKCE (S256 only), dynamic client registration (RFC 7591), discovery
  endpoints (`.well-known/oauth-authorization-server` and
  `.well-known/oauth-protected-resource`).
- Stateless **AES-256-GCM** encrypted access and refresh tokens — no token
  database required.
- Dual authentication on `/mcp`: OAuth Bearer token or legacy `x-api-key`
  header.
- Hosted sign-in flow: `/authorize` redirects to the Partiri sign-in page;
  the page returns the minted API key to the server's `/callback` endpoint.
- File-backed persistence for dynamic client registrations (`FileClientStore`)
  and token secret (`token-secret` file) when `MCP_DATA_DIR` is set.
- In-memory session management with configurable TTL, total cap, and per-key
  cap (`MCP_MAX_SESSIONS`, `MCP_MAX_SESSIONS_PER_KEY`, `MCP_SESSION_TTL_MINUTES`).
- Rate limiting: OAuth endpoints (20 req/min), `/mcp` general (200 req/min),
  session initialization (10 req/min).
- **Tool domains**: workspaces, user, projects, services, deployments, storage
  (volumes), metrics (CPU, memory, network), resources (pods, regions).
- **MCP resources**: embedded documentation for getting started, services,
  deployments, observability, frameworks, configuration, account management,
  and CLI usage.
- `Dockerfile` for containerized HTTP deployment.
- CI workflow (`.github/workflows/ci.yml`) running tests and build on PRs.
