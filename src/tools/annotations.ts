import type { CompleteToolAnnotations } from './index.js';

/**
 * Shared annotation set for tools that strictly fetch from the Partiri API
 * and change nothing.
 *
 * @remarks
 * `openWorldHint` is false because every call targets our own first-party
 * API, a closed domain — not arbitrary internet state.
 */
export const READ_ONLY: CompleteToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
