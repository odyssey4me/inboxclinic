import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Public base path. Defaults to "/" — Cloudflare Pages (and the custom domain) serve at
// the root. Set BASE_PATH=/sub/ only when self-hosting under a sub-path
// (design-deployment.md — Build inputs / BASE_PATH).
const base = process.env.BASE_PATH ?? "/";

// Build stamp (design-error-reporting.md Decision 4 / Configuration): the deployed commit
// and build time, injected as compile-time constants so the footer and diagnostic reports
// can say exactly what was live. CI sets VITE_APP_COMMIT=${{ github.sha }}; falls back to
// GITHUB_SHA or "dev" for local builds. Declared in src/vite-env.d.ts.
const commit = (process.env.VITE_APP_COMMIT ?? process.env.GITHUB_SHA ?? "dev").slice(0, 7);
const builtAt = process.env.VITE_APP_BUILT_AT ?? new Date().toISOString();

// https://vite.dev/config/
export default defineConfig({
  base,
  define: {
    __APP_COMMIT__: JSON.stringify(commit),
    __APP_BUILT_AT__: JSON.stringify(builtAt),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      // Custom SW (src/sw.ts) so we can add a Periodic Background Sync handler while
      // still precaching the app shell via Workbox (design-frontend.md Decision 4).
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg}"],
      },
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Inbox Clinic",
        short_name: "InboxClinic",
        description: "Take back control of your inbox — on-device, local-first email triage.",
        // "Vitals" palette (design-frontend.md): calm light ground, teal brand accent.
        theme_color: "#0d9488",
        background_color: "#f8fafa",
        display: "standalone",
        // Relative so the installed PWA works under any base (root, or a sub-path).
        start_url: ".",
        scope: base,
        icons: [
          {
            src: "icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
    }),
  ],
});
