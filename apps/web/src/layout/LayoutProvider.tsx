// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ReactNode } from "react";

import {
  detectAuto,
  DESKTOP_QUERY,
  LayoutContext,
  readPref,
  STORAGE_KEY,
  type Layout,
  type LayoutPref,
} from "./context";

/**
 * Provides the current layout to the shell and screens. `pref` (Auto / Desktop / Mobile)
 * is persisted on-device; the effective `layout` is the pinned value, or the device
 * breakpoint while on Auto. See design-frontend.md — Application shell & navigation.
 */
export function LayoutProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<LayoutPref>(readPref);
  const [autoLayout, setAutoLayout] = useState<Layout>(detectAuto);

  // Track the device breakpoint while on Auto (ignored once a layout is pinned).
  useEffect(() => {
    if (pref !== "auto") return;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(DESKTOP_QUERY);
    const update = (): void => setAutoLayout(mq.matches ? "desktop" : "mobile");
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [pref]);

  const layout: Layout = pref === "auto" ? autoLayout : pref;

  // "Desktop site" on a physically small screen: widen the viewport so the desktop
  // layout has room and mobile browsers zoom to fit. Desktop browsers ignore this, so
  // pinning Mobile on a wide screen simply renders the mobile shell centred.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta === null) return;
    const physicallyNarrow =
      typeof window !== "undefined" && typeof window.screen !== "undefined"
        ? window.screen.width < 1024
        : false;
    meta.setAttribute(
      "content",
      layout === "desktop" && physicallyNarrow
        ? "width=1024"
        : "width=device-width, initial-scale=1.0",
    );
  }, [layout]);

  const setPref = (next: LayoutPref): void => {
    setPrefState(next);
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, next);
  };

  return <LayoutContext value={{ pref, setPref, layout }}>{children}</LayoutContext>;
}
