import type { DocResource } from '../index.js';

/**
 * Documentation resources covering account and workspace management: API key
 * authentication, workspace organization, pay-as-you-go billing, and
 * role-based team permissions (including the MCP tool permissions each
 * role/API key requires).
 */
export const resources: DocResource[] = [
  {
    name: 'API keys',
    uri: 'partiri://docs/account/api-keys',
    description: 'How API key authentication works for the Partiri API and CLI',
    content: `# API Keys

API keys allow you to authenticate with the Partiri API and CLI without using your email and password.

You can generate API keys from your account settings. Each key has a name so you can identify its purpose.

API keys provide the same access as your user account, so keep them secure. You can delete a key at any time to revoke access.

## Using an API key with the CLI

Run \`partiri auth\` and paste the key when prompted. Non-interactively, pass \`--key <KEY>\`, or — recommended for agents and scripts to avoid leaving the key in shell history — pipe it via \`partiri auth --key-stdin\`. The key is written to \`~/.config/partiri/key\` (the same path the MCP server's stdio transport falls back to when \`PARTIRI_API_KEY\` is unset).`,
  },
  {
    name: 'Workspaces',
    uri: 'partiri://docs/account/workspaces',
    description: 'Workspace organization, team members, and role assignment',
    content: `# Workspaces

Workspaces are the top-level organizational unit in Partiri. Each workspace has its own:

- Projects
- Services
- Billing
- Team members

You can create multiple workspaces to separate different environments or clients. Team members can be invited by email and assigned one of three roles: Admin, Management, or User.`,
  },
  {
    name: 'Billing',
    uri: 'partiri://docs/account/billing',
    description:
      'Pay-as-you-go billing model, workspace balance, and transaction history',
    content: `# Billing

Partiri uses a pay-as-you-go billing model. Each workspace has its own balance that is consumed based on the resources your services use.

You can view your current balance and transaction history from the billing page. When your balance runs low, you can add funds to keep your services running.

There are no subscriptions or commitments — you only pay for what you use.`,
  },
  {
    name: 'Team roles',
    uri: 'partiri://docs/account/team-roles',
    description:
      'Role-based access control: Admin, Management, and User permissions',
    content: `# Team Roles

Invite team members to a workspace from the workspace settings page by entering their email address. They will receive an invitation and can join once they have a Partiri account.

Each member is assigned one of three roles:

| Role | Access |
|------|--------|
| **Admin** | Full access: manage members, billing, workspace settings, and all services and projects. |
| **Management** | Manage services, projects, and configuration. Cannot manage billing or invite/remove workspace members. |
| **User** | View services, logs, and metrics. Can trigger deployments. Cannot create, edit, or delete services. |

## MCP tool permissions

The API key used by an MCP agent must hold the following permissions for each operation:

| Operation | Required permission |
|-----------|---------------------|
| \`get_balance\` | \`billing:r\` (returns \`null\` on 403, not an error) |
| \`create_service\`, \`update_service\` | Admin or Management workspace role |
| \`list_volumes\`, \`get_volume\` | \`workspace:r\` |

Some sensitive operations are **not** MCP tools — you run them yourself with the
\`partiri\` CLI (the \`use_partiri_cli\` tool returns guidance, it does not execute
anything): managing secrets, the volume lifecycle (create / attach / detach /
delete / retry), and deleting a service. The CLI authenticates with its own
credentials, independent of the MCP session.

A **User**-role key can trigger deployments on existing services but cannot create, update, or delete services or volumes.`,
  },
];
