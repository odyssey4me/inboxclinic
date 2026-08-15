import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/dev-dist/**", "**/coverage/**", "**/node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      "react-hooks": (await import("eslint-plugin-react-hooks")).default,
      "react-refresh": (await import("eslint-plugin-react-refresh")).default,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  {
    // Fixture data must name no domain anyone could really own — see
    // tools/eslint/no-real-domains.js and docs/design-testing.md.
    files: [
      "**/*.test.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
      "packages/core/src/demo/**/*.ts",
      "apps/web/e2e/**/*.ts",
    ],
    plugins: {
      local: {
        rules: { "no-real-domains": (await import("./tools/eslint/no-real-domains.js")).default },
      },
    },
    rules: {
      "local/no-real-domains": "error",
    },
  },
  {
    files: ["**/*.config.{js,ts}", "**/vite.config.ts", "**/vitest.config.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
