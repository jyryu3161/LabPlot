import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Playwright E2E specs are CommonJS (require()) and not part of the Next
    // app bundle — they have their own runtime, so don't lint them as app code.
    "qa-e2e/**",
  ]),
  {
    rules: {
      // Reading localStorage / syncing derived state on mount legitimately
      // needs setState in an effect (SSR can't touch storage). The pattern is
      // already used across the app; keep it visible as a warning, not a
      // build-blocking error.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
