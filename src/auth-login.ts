import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { credentialsPath } from './auth.js';

/**
 * Maximum time to wait for the browser to complete the sign-in flow and hit
 * the local callback before {@link browserLogin} gives up.
 */
const LOGIN_TIMEOUT_MS = 180_000;

/** HTML page shown in the browser tab once sign-in succeeds. */
const SUCCESS_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Partiri MCP signed in</title></head>' +
  '<body style="font-family:system-ui,sans-serif;text-align:center;padding:4rem;color:#0f172a;">' +
  '<h1 style="margin-bottom:1rem;">You\'re signed in.</h1>' +
  '<p>You can close this tab.</p></body></html>';

/**
 * Opens the given URL in the user's default browser, best-effort. Failures
 * are swallowed since the URL is also printed for the user to open manually.
 *
 * @param url - The URL to open.
 */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Fall through — user can click the printed URL manually.
  }
}

/**
 * Compares two strings for equality in constant time, to avoid leaking
 * timing information when validating the OAuth-style `state` parameter.
 *
 * @param a - The first string to compare.
 * @param b - The second string to compare.
 * @returns True if `a` and `b` are equal in length and content.
 */
export function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Checks that a request's Host header matches the expected loopback
 * listener, to guard the one-shot callback server against DNS rebinding.
 *
 * @param host - The Host header value from the incoming request.
 * @param port - The port the local callback listener is bound to.
 * @returns True if `host` is exactly `127.0.0.1:<port>` or
 * `localhost:<port>`.
 */
export function isValidHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const v = host.trim();
  return v === `127.0.0.1:${port}` || v === `localhost:${port}`;
}

/**
 * Writes the API key to the credentials file used by both the CLI and MCP
 * server, creating the parent directory if needed and restricting
 * permissions to the owner.
 *
 * @param key - The API key to persist.
 * @returns The path the key was written to.
 */
export function writeCredentials(key: string): string {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key, { encoding: 'utf-8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod is best-effort (no-op on Windows).
  }
  return path;
}

/**
 * Outcome of validating the browser's callback request in
 * {@link handleCallback}: either the extracted API key, or the details
 * needed to send an HTTP error response.
 */
export type CallbackResult =
  | {
      /** Discriminant — the callback was valid. */
      ok: true;
      /** The API key extracted from the callback's `key` query parameter. */
      key: string;
    }
  | {
      /** Discriminant — the callback failed validation. */
      ok: false;
      /** HTTP status code to send in the error response. */
      status: number;
      /** HTML body to send in the error response. */
      body: string;
      /** Human-readable reason for the failure, used for logging. */
      reason: string;
    };

/**
 * Validate the incoming browser callback request and either return the key,
 * or describe the HTTP error response that should be sent.
 *
 * @remarks
 * Pure function — no I/O — so the callback validation can be tested without
 * binding a listener.
 *
 * @param method - The HTTP method of the incoming request.
 * @param url - The request URL, including query string.
 * @param hostHeader - The request's Host header value.
 * @param port - The port the local callback listener is bound to, used to
 * validate `hostHeader`.
 * @param expectedState - The random state value generated at the start of
 * the login flow, compared against the callback's `state` parameter.
 * @returns The extracted API key on success, or the HTTP error response
 * details on failure.
 */
export function handleCallback(
  method: string | undefined,
  url: string | undefined,
  hostHeader: string | undefined,
  port: number,
  expectedState: string,
): CallbackResult {
  if (method !== 'GET') {
    return {
      ok: false,
      status: 405,
      body: '<p>Only GET is allowed.</p>',
      reason: 'Browser callback used the wrong HTTP method.',
    };
  }
  if (!isValidHost(hostHeader, port)) {
    return {
      ok: false,
      status: 400,
      body: '<p>Invalid Host header.</p>',
      reason: 'Browser callback had an invalid Host header.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url ?? '/', 'http://127.0.0.1');
  } catch {
    return {
      ok: false,
      status: 400,
      body: '<p>Malformed request URL.</p>',
      reason: 'Malformed callback URL.',
    };
  }

  if (parsed.pathname !== '/callback') {
    return {
      ok: false,
      status: 404,
      body: '<p>Unexpected callback path.</p>',
      reason: `Browser callback hit unexpected path '${parsed.pathname}'.`,
    };
  }

  const state = parsed.searchParams.get('state');
  const key = parsed.searchParams.get('key');

  if (!state) {
    return {
      ok: false,
      status: 400,
      body: '<p>Missing state parameter.</p>',
      reason: 'Callback missing `state` parameter.',
    };
  }
  if (!key) {
    return {
      ok: false,
      status: 400,
      body: '<p>Missing key parameter.</p>',
      reason: 'Callback missing `key` parameter.',
    };
  }
  if (!constantTimeEq(state, expectedState)) {
    return {
      ok: false,
      status: 400,
      body: '<p>Invalid state parameter.</p>',
      reason:
        'State mismatch on browser callback — possible CSRF or stale link.',
    };
  }

  return { ok: true, key };
}

/**
 * Writes an HTML response with the headers appropriate for the one-shot
 * callback listener (no caching, connection closed after send).
 *
 * @param res - The HTTP response to write to.
 * @param status - The HTTP status code to send.
 * @param body - The HTML body to send.
 */
function sendResponse(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  res.end(body);
}

/**
 * Open the browser to the Partiri sign-in page and wait for the API key to
 * arrive at a one-shot localhost listener. Writes the key to the same
 * credentials file as the CLI (`~/.config/partiri/key`) and returns it.
 *
 * @remarks
 * Mirrors the CLI's `partiri auth login` flow.
 *
 * @returns The API key received from the browser callback.
 * @throws If the local listener fails to start, the callback fails
 * validation, writing the credentials file fails, or the login flow times
 * out after {@link LOGIN_TIMEOUT_MS}.
 */
export function browserLogin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const expectedState = randomBytes(32).toString('hex');
    let port = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    // Captured by the cleanup/settle closures defined below before it is
    // assigned the created listener, so it must be declared with let.
    // eslint-disable-next-line prefer-const
    let server: Server;

    /** Cancels the timeout and closes the one-shot listener. */
    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      server.close();
    };

    /**
     * Settles the promise successfully: persists the key to the credentials
     * file and resolves with it. No-ops if already settled.
     *
     * @param key - The API key received from the browser callback.
     */
    const settleOk = (key: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const path = writeCredentials(key);

        console.error(`Partiri API key saved to ${path}.`);
        resolve(key);
      } catch (e) {
        reject(
          new Error(`Failed to write credentials: ${(e as Error).message}`),
        );
      }
    };

    /**
     * Settles the promise with a failure, rejecting with the given message.
     * No-ops if already settled.
     *
     * @param err - The error message to reject with.
     */
    const settleErr = (err: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(err));
    };

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const result = handleCallback(
        req.method,
        req.url,
        req.headers.host,
        port,
        expectedState,
      );
      if (result.ok) {
        sendResponse(res, 200, SUCCESS_HTML);
        settleOk(result.key);
      } else {
        sendResponse(res, result.status, result.body);
        settleErr(result.reason);
      }
    });

    server.on('error', (e) =>
      settleErr(`Localhost listener failed: ${e.message}`),
    );

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        settleErr('Failed to read local listener address.');
        return;
      }
      port = addr.port;

      const webBase = (
        process.env.PARTIRI_WEB_URL ?? 'https://partiri.cloud'
      ).replace(/\/+$/, '');
      const url = `${webBase}/cli-auth?state=${expectedState}&port=${port}`;

      console.error(
        `\nNo Partiri API key found. Opening your browser to sign in…\nIf it does not open, visit:\n  ${url}\n`,
      );

      openBrowser(url);

      timer = setTimeout(
        () =>
          settleErr(
            `Timed out after ${LOGIN_TIMEOUT_MS / 1000}s waiting for browser callback.`,
          ),
        LOGIN_TIMEOUT_MS,
      );
    });
  });
}
