/**
 * auth.js
 *
 * Thin adapter that delegates all session-token management to
 * `./sessionService.js` while preserving the original export surface
 * (`getSessionToken`, `clearCachedSessionToken`) so that existing
 * consumers (client.js, sync/run.js, etc.) continue to work unchanged.
 *
 * New code should prefer importing directly from `./sessionService.js`
 * (`ensureSessionToken`, `invalidateSession`, `withKfAuth`).
 */

import {
  ensureSessionToken,
  invalidateSession,
  clearCachedToken,
  withKfAuth,
} from './sessionService.js';

/**
 * Returns a valid KashFlow session token, obtaining/refreshing one as needed.
 * Delegates to sessionService.ensureSessionToken().
 */
export async function getSessionToken() {
  return ensureSessionToken();
}

/**
 * Clears the locally cached session token so the next call to
 * getSessionToken() will re-authenticate.
 */
export function clearCachedSessionToken() {
  clearCachedToken();
}

// Re-export the richer session-service API for callers that want it
export { ensureSessionToken, invalidateSession, withKfAuth };
