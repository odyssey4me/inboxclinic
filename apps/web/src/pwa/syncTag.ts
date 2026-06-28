/**
 * Shared constants for the page ⇄ service-worker sync handshake.
 *
 * Kept free of DOM/WebWorker APIs so it can be imported by both the page-side
 * registration (`periodicSync.ts`, DOM lib) and the service worker (`sw.ts`, WebWorker
 * lib) without dragging incompatible ambient types into either typecheck.
 */

/** Tag shared between Periodic Background Sync registration and the SW handler. */
export const PERIODIC_SYNC_TAG = "inbox-clinic-sync";

/** `postMessage` payload the SW sends to clients to trigger an incremental sync. */
export const SW_SYNC_MESSAGE = "inbox-clinic:sync";
