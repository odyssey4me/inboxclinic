import { useEffect, useState } from "react";

/**
 * Track network reachability for the offline-aware UI (design-frontend.md: "App still
 * launches from cache; show 'Offline — Gmail sync paused; local data is available'").
 *
 * Feature-detected: where `navigator.onLine` is unavailable we optimistically assume
 * online so the app never wedges into a permanent offline state on odd platforms. Only
 * Google calls require connectivity — the local store renders regardless.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === "undefined" || typeof navigator.onLine !== "boolean"
      ? true
      : navigator.onLine,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const goOnline = (): void => setOnline(true);
    const goOffline = (): void => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}
