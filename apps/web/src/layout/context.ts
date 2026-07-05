// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext } from "react";

/**
 * Layout mode (design-frontend.md — Application shell & navigation). The app has two
 * structurally distinct layouts: a touch-first single-column **mobile** shell and a
 * sidebar **desktop** shell. `pref` is the user's choice — `auto` follows the device
 * breakpoint; `mobile`/`desktop` pin a layout and are remembered on-device.
 */
export type LayoutPref = "auto" | "mobile" | "desktop";
export type Layout = "mobile" | "desktop";

export const STORAGE_KEY = "inboxclinic.layoutPref";
export const DESKTOP_QUERY = "(min-width: 1024px)";

export interface LayoutContextValue {
  pref: LayoutPref;
  setPref: (pref: LayoutPref) => void;
  layout: Layout;
}

export const LayoutContext = createContext<LayoutContextValue | null>(null);

export function readPref(): LayoutPref {
  if (typeof localStorage === "undefined") return "auto";
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "mobile" || stored === "desktop" ? stored : "auto";
}

/** The device's natural layout — only meaningful while `pref` is `auto`. */
export function detectAuto(): Layout {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "desktop";
  return window.matchMedia(DESKTOP_QUERY).matches ? "desktop" : "mobile";
}

/** Layout context, or a read-only fallback (device-detected, no persistence) when used
 *  outside a `LayoutProvider` — e.g. a screen rendered in isolation. */
export function useLayout(): LayoutContextValue {
  const ctx = useContext(LayoutContext);
  return ctx ?? { pref: "auto", setPref: () => {}, layout: detectAuto() };
}
