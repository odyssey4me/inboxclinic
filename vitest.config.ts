import { defineConfig } from "vitest/config";

// Root config supplies the *global* coverage gate for the workspace run. Project
// configs (referenced by vitest.workspace.ts) own each suite's environment; coverage
// is a cross-project concern and is configured here so `vitest run --coverage`
// enforces it once across all suites.
//
// The gate is intentionally scoped to the portable, high-value *logic* in
// `packages/core` and `packages/store` (design-testing.md Decision 6). Type-only
// ports/entities, barrels, ambient declarations, test fixtures, and `apps/web`
// (UI/adapters) are not gated.
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/core/src/**/*.ts", "packages/store/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/index.ts",
        "**/*.d.ts",
        "**/testing/**",
        // Type-only port / entity declarations (no runtime logic to cover).
        "packages/core/src/ports/**",
        "packages/core/src/store/types.ts",
        "packages/core/src/store/Store.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 80,
      },
    },
  },
});
