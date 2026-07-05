import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Public base path: "/inboxclinic/" for the GitHub project-Pages URL, "/" for self-host
// at a domain root (design-deployment.md — Build inputs / BASE_PATH).
const base = process.env.BASE_PATH ?? "/";

// https://vite.dev/config/
export default defineConfig({
  base,
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
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        // Relative so the installed PWA works under any base (root or /inboxclinic/).
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
