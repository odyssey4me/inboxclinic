/// <reference lib="webworker" />
/**
 * Service worker (vite-plugin-pwa `injectManifest`).
 *
 * See docs/design-frontend.md Decision 4: precache the app shell for offline launch and
 * register a Periodic Background Sync handler. Because the OAuth token is held in the
 * page (in-memory; design-gmail-integration.md Decision 1), the SW cannot call Gmail
 * itself — on a `periodicsync` it messages open clients, which run `incrementalSync`.
 *
 * `autoUpdate` is preserved: `skipWaiting` + `clientsClaim` activate new builds promptly.
 */
import { clientsClaim } from "workbox-core";
import { precacheAndRoute } from "workbox-precaching";

import { PERIODIC_SYNC_TAG, SW_SYNC_MESSAGE } from "./pwa/syncTag";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: { url: string; revision: string | null }[];
};

/** `periodicsync` is not yet in TS's DOM/WebWorker lib — model the part we use. */
interface PeriodicSyncEvent extends ExtendableEvent {
  readonly tag: string;
}

// Precache the app shell + static assets (offline launch). The plugin injects the list.
precacheAndRoute(self.__WB_MANIFEST);

self.skipWaiting();
clientsClaim();

/** Ask every controlled client to run an incremental sync. */
async function notifyClientsToSync(): Promise<void> {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const client of clients) {
    client.postMessage({ type: SW_SYNC_MESSAGE });
  }
}

self.addEventListener("periodicsync", (event: Event) => {
  const periodic = event as PeriodicSyncEvent;
  if (periodic.tag === PERIODIC_SYNC_TAG) {
    periodic.waitUntil(notifyClientsToSync());
  }
});
