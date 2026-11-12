# Tests and code quality

How NBO's code is checked, and what to run before you commit a change.

## The checks

| Command (repo root)      | Checks                                                | Tool                          |
| ------------------------ | ----------------------------------------------------- | ----------------------------- |
| `pnpm test`              | Behaviour: every package's tests                      | Vitest                        |
| `pnpm check-types`       | Types: TypeScript errors anywhere                     | `tsc --noEmit` per package    |
| `pnpm lint`              | Code mistakes and risky patterns                      | ESLint (`eslint.config.mjs`)  |
| `npx prettier --check .` | Formatting                                            | Prettier (`.prettierrc.json`) |
| `npx knip`               | Unused files, exports and dependencies                | Knip (`knip.json`)            |
| `pnpm docs:check`        | Docs against code: links, paths, API routes, settings | `scripts/docs/check-docs.mjs` |

Run one package's checks with a filter: `pnpm --filter @nbo/router test`, `pnpm --filter @nbo/controlplane check-types`.

Two packages have their own tools: `go test ./...` inside `packages/terraform-provider` (Go) and `cargo test` inside `packages/edge-rs` (Rust).

`pnpm docs:check` compares the written docs with the code: it fails when a link or a path in a doc points at nothing, when an API route or a `NBO_*` setting is missing from the docs, and so on. For this manual it checks every relative link between chapters.

## Tests

### Where they live

Next to the code, in `src/__tests__/*.test.ts(x)` (a few packages use `src/*.test.ts`). Each test file covers one module.

### What they look like

Vitest's API is the same as Jest's: `describe`, `it`, `expect`. A typical control-plane test:

```ts
it("rejects a project name that is taken", async () => {
  const mux = newTestServer(); // real handlers, fake clouds
  await post(mux, "/projects/setup", validRequest); // first one: 201
  const res = await post(mux, "/projects/setup", validRequest);
  expect(res.status).toBe(409);
});
```

Handlers are plain functions, so tests call them directly with a `Request`, with no server and no port.

### The rule: test first

New behaviour starts with a test that fails, then the code that makes it pass. A bug fix starts with a test that reproduces the bug. That way every test has been seen failing at least once, which proves it actually tests something.

### Timeouts

Control-plane tests allow 20 seconds each (`testTimeout` in its `vitest.config`). Some control-plane tests run real `git` commands, which are slow on Windows.

## End-to-end checks

Unit tests don't start Docker or clouds. The scripts in `scripts/` do:

| Script                                   | Proves                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `verify-step0.sh`                        | Fixtures build twice to the same content id; validate; serve.                                 |
| `verify-slice1.sh`                       | Static site and SPA deploy to kind over HTTPS; deep links; immutable caching; redeploy no-op. |
| `verify-slice2.sh`                       | Next.js SSR on `nbo serve` and kind, conformance transcripts, streaming timing.               |
| `verify-slice3*.sh`                      | Cloud Run, the edge, zero failed requests during a switch under load.                         |
| `verify-slice4*.sh`, `verify-slice5*.sh` | Images, middleware, ISR, crons, partial prerendering.                                         |

**Conformance transcripts** (`fixtures/conformance/`) are recorded request/response pairs. `nbo conformance <dir> <url>` replays them against any deployment; the same transcripts must pass on `nbo serve`, Kubernetes and Cloud Run. That's how NBO proves "the same build behaves the same everywhere".

## Linting

`eslint.config.mjs` at the root uses the shared rules in `packages/eslint-config`: `base` (TypeScript rules for every package) and `react` (React hooks and fast-refresh rules, for React code). Highlights:

- the recommended TypeScript rules from typescript-eslint,
- no unused variables or imports (a leading `_` marks one as intentionally unused),
- React hooks rules: hooks only at the top level of components, complete effect dependencies.

`pnpm lint` checks everything; `npx eslint --config eslint.config.mjs packages/<name>` checks one package.

## Formatting

Prettier, configured in `.prettierrc.json`: lines up to 180 characters, `endOfLine: "auto"` (the repository is checked out with Windows line endings on Windows; `auto` keeps Prettier from rewriting every file). Format before committing: `npx prettier --write <files>`.

## Unused code

`knip.json` tells Knip each package's entry points. `npx knip` lists files nothing imports, exports nothing uses, and dependencies no file needs. Delete what it finds unless it's used in a way Knip can't see (then add it to `knip.json`).

## Rules the code must not break

These rules are checked by tests, the validator, or review:

- `.nbo/` never contains cloud names, account ids, region codes or secret values.
- Route patterns are RE2 only.
- Digests are SHA-256 over file bytes, and every metadata JSON file is in canonical form (RFC 8785); content id = manifest minus its `build` block.
- Builds are deterministic: the same commit twice gives the same content id. For Next.js apps, the two builds may differ only in pages the app rendered at build time (a page that prints the clock, or the partial prerendering resume state); anything else fails the check.
- Functions are keyed by name; URL paths map to functions only in `routes.json`.
- Every static file has a `contentType`.
- Core schemas reject unknown fields; extensions use an `x-` prefix.
- New behaviour gets a conformance fixture run against `nbo serve` and each adapter.
- The spec version lives in one file, `spec/version.json`; the writer and the validator both read it.

## Continuous integration

> **Not tried for real yet.** The GitLab pipeline. It has not run on a real GitLab. The local rehearsal of the `kubernetes` job passed the `nbo serve` and kind bootstrap steps but not the kind deploy step, and the `cloudrun` job has never run against a real Google project. `pnpm test:ci` checks the scripts with fake cloud tools.

The same checks (including `pnpm docs:check`), plus the determinism builds (each fresh build must also pass `nbo validate --strict`) and the Next.js harness against `nbo serve`, a throwaway kind cluster and Cloud Run, run in GitLab from `.gitlab-ci.yml`. What runs when, what it costs and the one-time Cloud Run setup are in `docs/ci.md` in the repository. `pnpm test:ci` runs the tests of the CI scripts themselves, with fake cloud tools.

## Before you commit

```bash
pnpm --filter <changed packages> test
pnpm --filter <changed packages> check-types
pnpm lint
npx prettier --write <changed files>
```

If you changed how something works, update the matching chapter of this manual. It is in `docs/manual/`.
