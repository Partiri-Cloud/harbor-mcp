import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Path to the credentials file the CLI's `partiri auth login` writes to.
 * Resolves to `~/.config/partiri/key` (or `$XDG_CONFIG_HOME/partiri/key`).
 *
 * @returns The absolute path to the credentials file.
 */
export function credentialsPath(): string {
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configDir, 'partiri', 'key');
}

/**
 * Reads and trims the API key from the credentials file, if present.
 *
 * @returns The trimmed key, or undefined if the file is missing, unreadable,
 * or empty.
 */
function readKeyFromFile(): string | undefined {
  try {
    const fileKey = readFileSync(credentialsPath(), 'utf-8').trim();
    return fileKey || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Partiri API key without prompting.
 *
 * @remarks
 * Resolution order:
 * 1. PARTIRI_API_KEY env var
 * 2. ~/.config/partiri/key (written by `partiri auth`)
 *
 * @returns The resolved API key.
 * @throws If no key is found in the env var or credentials file.
 */
export function resolveApiKey(): string {
  const envKey = process.env.PARTIRI_API_KEY;
  if (envKey?.trim()) return envKey.trim();

  const fileKey = readKeyFromFile();
  if (fileKey) return fileKey;

  throw new Error(
    "No API key found. Set PARTIRI_API_KEY or run 'partiri auth' to configure your key.",
  );
}

/**
 * Determines whether the current process is attached to an interactive
 * terminal and not running in CI.
 *
 * @returns True if stdin is a TTY and the CI environment variable is unset.
 */
function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.env.CI == null;
}

/**
 * Resolve the Partiri API key, falling back to the CLI-style browser login
 * flow when no key is found in the env or credentials file.
 *
 * @remarks
 * In non-interactive environments (CI, headless) the login flow is skipped
 * and an error is thrown instead — otherwise the process would hang waiting
 * for a browser.
 *
 * @returns The resolved API key, from the env var, credentials file, or a
 * completed browser login.
 * @throws If no key is found and no interactive terminal is available.
 */
export async function resolveApiKeyOrLogin(): Promise<string> {
  const envKey = process.env.PARTIRI_API_KEY;
  if (envKey?.trim()) return envKey.trim();

  const fileKey = readKeyFromFile();
  if (fileKey) return fileKey;

  if (!isInteractive()) {
    throw new Error(
      'No API key found and no interactive terminal available. ' +
        'Set the PARTIRI_API_KEY environment variable or run `partiri auth login` to configure your key. ' +
        'See https://docs.partiri.cloud/mcp for details.',
    );
  }

  const { browserLogin } = await import('./auth-login.js');
  return browserLogin();
}

/**
 * Resolve the Partiri API base URL. Defaults to https://api.partiri.cloud.
 *
 * @returns The resolved base URL, with any trailing slashes removed.
 * @throws If the URL (from PARTIRI_API_URL or the default) does not use
 * HTTPS.
 */
export function resolveBaseUrl(): string {
  const url = process.env.PARTIRI_API_URL || 'https://api.partiri.cloud';

  if (!url.startsWith('https://')) {
    throw new Error(`PARTIRI_API_URL must use HTTPS. Got: ${url}`);
  }

  return url.replace(/\/+$/, '');
}
