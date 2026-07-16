# Contributing

## Development Setup

```bash
npm install
npm run dev        # run server via tsx (stdio transport, development)
```

For HTTP transport:

```bash
MCP_TRANSPORT=http \
MCP_TOKEN_SECRET=$(openssl rand -hex 32) \
MCP_BASE_URL=http://localhost:3000 \
npm run dev
```

## Build

```bash
npm run build      # bundles to dist/index.mjs via tsdown
```

## Tests

```bash
npm test           # run all tests once (vitest)
npm run test:watch # watch mode
```

Lint, tests, and the build must all be clean before submitting a pull request.
CI (`.github/workflows/ci.yml`) runs `npm run lint`, `npm run format:check`,
`npm test`, and `npm run build` on every PR targeting `master` or `dev`.

## Code Style

- **TypeScript** — strict mode. `tsc` must report no errors after your changes.
- **ESLint + Prettier** — single quotes, trailing commas, 2-space indent.
  Run `npm run lint` (and `npm run lint:fix` to auto-fix) and `npm run format`
  before committing; `npm run format:check` verifies formatting without writing.
- No hardcoded config values. All tunable behaviour goes through environment
  variables.
- Never log API keys, tokens, or request bodies.

## Adding a New Tool

1. **Add the API method** to `src/client.ts`.
2. **Add the tool definition and handler** in the appropriate
   `src/tools/<domain>.ts` file. Each tool needs:
   - A Zod input schema for validation.
   - An `annotations` object with `readOnlyHint: true` if the tool only reads
     data (this gates it correctly when `MCP_READONLY` is set).
   - A handler that calls the client method and returns a `toolResult` or
     `toolError`.
3. **Export from the aggregator** — the tool is picked up automatically via
   `src/tools/index.ts` as long as your definition and handler are exported
   from the domain file and imported in the aggregator.

## Pull Requests

- Keep PRs focused. One concern per PR.
- Include or update tests for any new behaviour.
- Update the `## [Unreleased]` section of `CHANGELOG.md` with a brief entry.
- For security-sensitive changes, describe the threat model in the PR
  description.

## Reporting Bugs

Open a GitHub issue for non-security bugs. For security vulnerabilities, follow
the process in [SECURITY.md](SECURITY.md).
