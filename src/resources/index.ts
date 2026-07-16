import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { resources as gettingStarted } from './content/getting-started.js';
import { resources as services } from './content/services.js';
import { resources as deployments } from './content/deployments.js';
import { resources as observability } from './content/observability.js';
import { resources as frameworks } from './content/frameworks.js';
import { resources as configuration } from './content/configuration.js';
import { resources as account } from './content/account.js';
import { resources as cli } from './content/cli.js';
import { resources as reference } from './content/reference.js';

/**
 * A single MCP documentation resource served to clients as a markdown page.
 */
export interface DocResource {
  /** Human-readable title, used as the MCP resource's registered name. */
  name: string;
  /** Stable `partiri://docs/...` URI clients use to fetch this resource. */
  uri: string;
  /**
   * One-line summary shown in resource listings, describing what the
   * markdown content covers.
   */
  description: string;
  /** Full markdown body returned as the resource's `text/markdown` content. */
  content: string;
}

/**
 * All documentation resources, aggregated from each `content/*.ts` topic
 * module. Order here determines listing order in MCP resource discovery.
 */
export const allResources: DocResource[] = [
  ...gettingStarted,
  ...services,
  ...deployments,
  ...observability,
  ...frameworks,
  ...configuration,
  ...account,
  ...cli,
  ...reference,
];

/**
 * Registers every entry in {@link allResources} on the given MCP server as a
 * read-only markdown resource.
 *
 * @param server - The MCP server instance to register resources on.
 * @remarks Each resource is exposed with `mimeType: 'text/markdown'` and an
 * `audience: ['assistant']` annotation, and its content is served lazily via
 * the read callback rather than being attached eagerly at registration time.
 */
export function registerResources(server: McpServer): void {
  for (const doc of allResources) {
    server.registerResource(
      doc.name,
      doc.uri,
      {
        description: doc.description,
        mimeType: 'text/markdown',
        annotations: { audience: ['assistant'] },
      },
      async () => ({
        contents: [
          { uri: doc.uri, mimeType: 'text/markdown', text: doc.content },
        ],
      }),
    );
  }
}
