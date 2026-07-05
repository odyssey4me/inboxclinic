import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Mirror the build-stamp globals from vite.config.ts so components that read them
  // (e.g. the footer) resolve under test instead of throwing a ReferenceError.
  define: {
    __APP_COMMIT__: JSON.stringify("test"),
    __APP_BUILT_AT__: JSON.stringify("1970-01-01T00:00:00.000Z"),
  },
  test: {
    name: "web",
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/testing/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
