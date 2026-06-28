import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "store",
    environment: "node",
    globals: false,
    setupFiles: ["./src/testing/setup.ts"],
    include: ["src/**/*.test.ts"],
  },
});
