#!/usr/bin/env node

/**
 * @fileoverview Entry point for the Partiri Cloud MCP server. Selects the
 * transport (stdio or HTTP) based on the MCP_TRANSPORT environment variable
 * and starts the corresponding server.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveApiKeyOrLogin, resolveBaseUrl } from './auth.js';
import { PartiriApiClient } from './client.js';
import { createServer } from './server.js';
import { startHttp } from './http.js';

/**
 * Starts the MCP server over the stdio transport, resolving the API key via
 * {@link resolveApiKeyOrLogin} (env var, credentials file, or interactive
 * browser login) before connecting the transport.
 */
async function startStdio(): Promise<void> {
  const apiKey = await resolveApiKeyOrLogin();
  const baseUrl = resolveBaseUrl();
  const client = new PartiriApiClient(apiKey, baseUrl);
  const server = createServer(client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Selected MCP transport, read from MCP_TRANSPORT. Defaults to `stdio` when
 * unset.
 */
const transport = process.env.MCP_TRANSPORT || 'stdio';

if (transport === 'http') {
  startHttp().catch((error) => {
    console.error('Failed to start Partiri MCP HTTP server:', error.message);
    process.exit(1);
  });
} else {
  startStdio().catch((error) => {
    console.error('Failed to start Partiri MCP server:', error.message);
    process.exit(1);
  });
}
