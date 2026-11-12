# @repo/eslint-config

Shared ESLint flat configs, consumed by the root `eslint.config.js`.

- `base` — every package: `@eslint/js` + `typescript-eslint` recommended, a few correctness rules, Prettier-compatible.
- `react` — the dashboard: rules of hooks and Vite fast-refresh boundaries.

`typescript-eslint` parses with its own pinned TypeScript 5.x, because the workspace's TypeScript 7 (native) has no JavaScript API for parsers.
