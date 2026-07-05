// SPDX-License-Identifier: Apache-2.0
/**
 * Periodic Background Sync registration — feature-detected, graceful no-op.
 *
 * See docs/design-frontend.md Decision 4 (PWA with periodic sync; "Capability is
 * feature-detected — degrade gracefully where Periodic Sync is unavailable, e.g. iOS
 * Safari"). The API is Chromium-only and gated by site engagement, so every step is
 * guarded: this never throws where the API is absent.
 *
 * The OAuth token lives in the page (in-memory; design-gmail-integration.md Decision 1),
 * so the service worker cannot sync by itself — it messages open clients, which run the
 * incremental sync. This registration simply asks the platform to wake the SW.
 */

export { PERIODIC_SYNC_TAG, SW_SYNC_MESSAGE } from "./syncTag";
import { PERIODIC_SYNC_TAG } from "./syncTag";

/** Default cadence (design-gmail-integration.md `sync.periodMinutes`, 60 minutes). */
const DEFAULT_MIN_INTERVAL_MS = 60 * 60 * 1000;

interface PeriodicSyncManager {
  register(tag: string, options?: { minInterval: number }): Promise<void>;
  getTags(): Promise<string[]>;
}

type RegistrationWithPeriodicSync = ServiceWorkerRegistration & {
  periodicSync?: PeriodicSyncManager;
};

/**
 * Register Periodic Background Sync if the platform supports it and the permission is
 * granted. Resolves to `true` when registered, `false` on any unsupported/denied path.
 */
export async function registerPeriodicSync(
  minIntervalMs: number = DEFAULT_MIN_INTERVAL_MS,
): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return false;
    }
    const registration = (await navigator.serviceWorker.ready) as RegistrationWithPeriodicSync;
    const periodicSync = registration.periodicSync;
    if (periodicSync === undefined) {
      return false;
    }

    // Permission is best-effort: where the Permissions API can't answer, still attempt
    // registration and let it fail silently below.
    if (typeof navigator.permissions?.query === "function") {
      try {
        const status = await navigator.permissions.query({
          // `periodic-background-sync` is not in the standard PermissionName union.
          name: "periodic-background-sync" as PermissionName,
        });
        if (status.state === "denied") return false;
      } catch {
        // Unknown permission name on this platform — fall through and try to register.
      }
    }

    const existing = await periodicSync.getTags();
    if (!existing.includes(PERIODIC_SYNC_TAG)) {
      await periodicSync.register(PERIODIC_SYNC_TAG, { minInterval: minIntervalMs });
    }
    return true;
  } catch {
    // Any failure (unsupported, denied, transient) degrades to on-open sync only.
    return false;
  }
}
