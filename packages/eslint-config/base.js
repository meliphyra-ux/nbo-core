// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import turboPlugin from "eslint-plugin-turbo";
import globals from "globals";

/**
 * Shared ESLint config for every NBO package: TypeScript-aware
 * correctness rules, no formatting rules (Prettier owns formatting).
 *
 * @type {import("eslint").Linter.Config[]}
 */
export const config = tseslint.config(
  {
    ignores: ["**/dist/**", "**/.nbo/**", "**/.next/**", "**/.turbo/**", "**/node_modules/**", "**/coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    plugins: { turbo: turboPlugin },
    rules: {
      "turbo/no-undeclared-env-vars": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      "object-shorthand": "error",
      "no-throw-literal": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports", disallowTypeAnnotations: false },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      // Tests use non-null assertions on fixtures they just created.
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["**/__tests__/**", "**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  eslintConfigPrettier,
);
