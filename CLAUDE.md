## Project Overview

LatentMail v2 is a ground-up rewrite of a desktop Gmail client as a **Tauri v2 · Rust · React 19 · TypeScript** app, built with `pnpm`. Gmail access is the REST API (never IMAP/SMTP). See `.agent/plans/` for the full implementation plan and `.agent/adr/` for recorded architectural divergences.

### Ownership split

- **Rust owns** all data, network, persistence, sanitization, scheduling and business logic.
- **React owns** presentation and interaction state only.
- **State management rule:** TanStack Query owns anything that comes from Rust (mailboxes, threads, messages, accounts, settings). Zustand owns anything the user did that Rust doesn't know about (selection, cursor, panel sizes, layout mode, density, theme, route). Rule of thumb: _a thread's ID is Zustand; a thread's content is Query._ Rust events are bridged to `queryClient.invalidateQueries` by a small listener layer (`src/lib/query/event-bridge.ts`) — never invalidate/refetch by hand outside that bridge.

### IPC conventions

- Commands and events are typed centrally in `src/lib/types/ipc.ts` (`IpcCommandMap` / `IpcEventMap`). Adding a command means adding a map entry and a Rust handler — **never** a new per-command TypeScript wrapper. `src/lib/ipc/commands.ts` exposes one generic invoke function keyed on `IpcCommandMap`.
- Events follow the `domain://event` naming convention (e.g. `sync://progress`, `queue://summary`, `account://state`).
- A runtime `forbidden`/permission error almost always means a missing or mistyped entry in `capabilities/default.json`, or a mismatch between the TOML `commands.allow` name and the registered Rust command name.

### SQLite conventions

The database is a rebuildable cache of Gmail, but it is also the thing the UI reads on every keystroke, so read paths are held to query-plan standards, not just correctness.

- **Load the `sql-writer` skill before writing or editing any SQL** (queries, migrations, repository statements) — invoke it first, then make the change.
- **`thread_labels` is derived data with exactly one writer.** It answers "which threads carry label X, newest first" for the mailbox listing, because the filter (`message_labels`) and the sort key (`threads.latest_at`) live in different tables and no index over the normalised schema serves both — see the `thread_labels` comment in `V1__initial_schema.sql` for the measurements this table's design is based on. It is maintained **only** by `ThreadRepository::write_summary`, and thread deletion is handled by the FK cascade, never by hand.
  - Consequence: **any code path that changes label membership must call `ThreadRepository::recompute`/`recompute_many` for the touched threads in the same transaction as the change.** Every existing path does. Skipping it does not fail a test or corrupt a row — the thread just silently stops appearing under a label in the UI.
  - Consequence for tests: a fixture that hand-writes `ThreadRepository::upsert` plus `set_label_membership` builds a state production cannot produce, and will not appear in a label-filtered listing. Write messages and memberships first, then `recompute`.
- **Repository statements executed in a loop use `prepare_cached`, not `connection.execute`.** `execute` re-compiles its SQL on every call; the per-message write path runs ~12 statements per message, so a backfill page paid thousands of avoidable compiles. `STATEMENT_CACHE_CAPACITY` in `storage/mod.rs` is sized for the widest transaction (sync/backfill) — if you add statements to that path, check it still fits. Never build a statement with `format!` where a fixed set of literals would do; a formatted string defeats the cache.
- **Epoch units are a boundary contract**: SQLite stores seconds, IPC DTOs emit milliseconds via `sync::dto::to_millis`. See the date/time rule below.
- **Every hot query's plan is asserted**, not assumed: `storage_schema_integration::hot_queries_use_their_purpose_built_indexes_without_avoidable_sorts` runs `EXPLAIN QUERY PLAN` against the real migrated schema and fails on `TEMP B-TREE` or a lost index. Extend it when you add a read path, and prefer it over reasoning about plans in review.
- **Indexes are replaced, not stacked.** Before adding one, check whether an existing composite already provides the prefix; before removing one, grep for every query that could use it, including FK cascades — an un-indexed `ON DELETE CASCADE` turns a bulk delete quadratic.
- **Migrations are forward-only from here**, numbered `V<n>__snake_case.sql` starting at `V2`; `refinery` wraps each in a transaction. `V1__initial_schema.sql` is a one-time squash of this project's first ten migrations, sanctioned while no production data existed (recorded in `.agent/adr/`) — that squash is not a precedent for squashing again. Validate a new migration against a _populated_ database (`PRAGMA foreign_key_check` plus a set-equivalence query against the query it replaces), not just the empty one the tests build.

### Security

- OAuth uses PKCE (S256) with `access_type=offline` and `prompt=consent`; redirects go to `127.0.0.1`, never `localhost`. Refresh tokens live in the OS keychain only — never in the database or on disk in plaintext.
- Email HTML is sanitized **twice**: `ammonia` in Rust before it crosses IPC, then DOMPurify in React before injection. Message bodies render inside a `srcdoc` iframe whose own CSP is `default-src 'none'; form-action 'none'` (plus `img-src`/`style-src`/`font-src` allowances) — nothing inside can execute regardless of what survives sanitization. The iframe carries **no `sandbox` attribute**: WebKit dispatches no DOM events at all inside a scripting-disabled sandbox, which broke link handling. See `.agent/adr/2026-08-21--drop-the-reader-iframe-sandbox-attribute-and-rely-on-its-content-security-policy--3f6b1a74.md`.
- Remote images are always blocked/rewritten to placeholders in this slice; there is no bypass or allowlist yet.

## Critical Rules for Agents

- **Every change must work on BOTH Windows and macOS.** This is a cross-OS app — never make a change that fixes/works on one OS while breaking or ignoring the other.
- **Excluding functions or files from test coverage is strictly prohibited.** Maintain 90% lines/functions/statements for both TypeScript (Vitest v8) and Rust (`cargo-llvm-cov` `--fail-under-*`). Never lower thresholds or hide untested code — write tests instead. Forbidden: `istanbul`/`c8`/`v8` ignore comments, Vitest `coverage.exclude` / `coverage.include` tweaks that skip production code, Rust `#[cfg(coverage)]` / `#[cfg(not(coverage))]` beyond the existing Tauri entrypoint carve-out (`lib::run` / `main`), and any other exclude/ignore mechanism. No exceptions.
- **No fixed delays > 5 s** in any test. Use condition-based waiting (Playwright auto-wait, `waitFor`, `findBy*`, polling). Each individual test must complete in under 2 seconds.
- **Tests must never hit real machine-global APIs.** Rust tests run with `--features test-utils`; any code path that can touch vendor drivers, global OS settings, registry-backed settings, process-wide services, real GPUs, NVIDIA/NVAPI/DRS, or other machine-global state must compile to a fake/in-memory implementation or return `Unsupported` under `feature = "test-utils"` (and usually `coverage`). Never write tests that permit "real API success" as an acceptable branch for these integrations — assert the safe test fallback instead.
- **Package manager: `pnpm` only.**
- **No comments and no docblocks in code.** Do not write `//`, `/* */`, `///`, `//!`, `#`, JSDoc/TSDoc or Rust doc comments in any production or test file. Names, types and small functions carry the meaning instead — if something needs explaining, rename it or split it until it doesn't. Rationale, trade-offs and "why not X" belong in the commit message, the PR, or an ADR under `.agent/adr/`, never in the source. This applies to new code and to any code touched during a change. The only exceptions are machine-read directives that must be in the file to work (`#!` shebangs, `#[...]`/`@ts-*` attributes, license headers where legally required).
- **All date/time work goes through the date library — never hand-written.** Every parse, format, comparison, arithmetic and unit conversion involving dates or times must use `date-fns` in TypeScript and `chrono` in Rust, in production code **and** tests. No exceptions for "simple" cases. Specifically forbidden: manual millisecond/second arithmetic (`* 1000`, `/ 1000`, `+ 86_400`), hand-rolled formatting (`toISOString().slice(...)`, template strings of date parts), ad hoc native `Date`/`NaiveDate` parsing or construction from strings, and hand-written relative-time or duration logic. Use the library helper (`fromUnixTime`, `getUnixTime`, `format`, `formatDistanceToNow`, `addDays`, `differenceInDays`; `DateTime::from_timestamp`, `timestamp_millis`, `Duration::days`) — if none exists for the case, say so explicitly rather than open-coding it. **Epoch units are a boundary contract, not arithmetic:** SQLite stores seconds, IPC DTOs emit milliseconds (`sync::dto::to_millis`), and the conversion belongs in the library call at that boundary — a raw `* 1000` anywhere else is a bug waiting to happen (it already caused every conversation row to render as January 1970).
- **Lint must be genuinely clean.** See the **Lint rule** above — zero warnings/errors repo-wide, no suppressions, including for pre-existing issues encountered during the session.
- **Vitest must run without React `act(...)` warnings.** Treat any `act(...)` stderr from Vitest as unfinished work — fix the test (e.g. `await userEvent`, `waitFor` / `findBy*`, wrap timer advances and IPC event emits in `act`, use the shared `ipc.emit` harness) rather than ignoring the warning. Pre-existing `act` warnings are in scope. **The default reporter hides console output for passing tests, so `pnpm test` / `pnpm test:coverage` can look clean while warnings are still firing.** Surface them with `npx vitest run --reporter=verbose` (optionally scoped to a file/dir), then grep stderr for `not wrapped in act`. A common source: a test calls a Zustand store setter (`useXStore.setState(...)`) directly — including in a `finally`/cleanup block — while a component from that test is still mounted and subscribed; wrap that call in `act(() => { ... })`.
- **Vitest IPC mocking is mandatory and centralized.** All Vitest tests that touch Tauri IPC must use the shared harness in `src/tests/ipc-mock.ts` plus `ipc.override(...)` / `ipc.emit(...)`. Do **not** create ad hoc IPC mocks, per-test `mockIPC(...)` calls, direct `vi.mock()` stubs for `@tauri-apps/api/*` IPC modules, or direct mocks of `src/lib/*-commands.ts` command wrappers. If a command is missing from the default fixtures, add it to `src/tests/fixtures.ts` or override it in the test. **The intentional missing-mock failure (`[vitest] Unmocked Tauri IPC command: <cmd>`) is part of the contract and must not be bypassed.**
- **Critical instruction: any time you add or update a screenshot test or regenerate a screenshot baseline, you must inspect the resulting image and verify it matches expectations before you consider the change complete. Never accept an unreviewed screenshot baseline change.**
- **Screenshot tests cant take longer than 2 seconds to run each. Anything that takes longer is considered a failure.**
- **Rust and vitests cant take longer than 1 second per test suite. Anything that takes longer is considered a failure.**

**Permission debugging:** A runtime `forbidden`/permission error almost always means a missing or mistyped entry in `capabilities/default.json` or a mismatch between the TOML `commands.allow` name and the registered Rust name.

### Rust

- Never embed `#[cfg(test)]` or `#[test]` in `src-tauri/src/` — all tests go in `src-tauri/tests/` only.

## Styling constraint (NON-NEGOTIABLE)

- **Pure Tailwind utility classes only.**
- **No custom CSS rules. No `@apply`. No square-bracket arbitrary values** (e.g. `w-[237px]`, `text-[#abc]`).
- The Tailwind v4 **`@theme {}` block in `index.css` is the allowed design-system config** — every custom color/spacing/type-step/radius/shadow is a **named token** there, used as a normal utility (`bg-dark-window`, `w-tree`, `text-row`).
- Need a new value? Add a **named `@theme` token**, then use the generated utility. Never inline a bracket value.
- **Radius tokens are redefined from Tailwind's defaults**: `rounded-sm` 0.25rem, `rounded` (DEFAULT) 0.5rem, `rounded-md` 0.75rem, `rounded-lg` 1rem, `rounded-xl` 1.5rem. Do not assume Tailwind's stock values (e.g. `rounded-md` is **not** 0.375rem here).
- `index.css` may contain **only** the Tailwind import, `@custom-variant dark`, and the `@theme` block — no other CSS rules.

## Testing Conventions

Keep every test in a dedicated file under the appropriate test root (`src/tests/`, `src-tauri/tests/`, `e2e/`). Production files must contain only shipping code.

### Vitest (TypeScript)

- Test files mirror source: `src/components/Foo.tsx` → `src/tests/components/Foo.test.tsx`.
- Setup file `src/tests/setup.ts` provides jsdom polyfills (`ResizeObserver`, `matchMedia`, `scrollIntoView`) and wires Vitest IPC through the shared `src/tests/ipc-mock.ts` harness. A missing IPC fixture throws `[vitest] Unmocked Tauri IPC command: <cmd>`.
- Always test real behavior through the public API with the shared harness. Use `ipc.override(...)` for per-test behavior and `ipc.emit(...)` for events. If a test needs a new IPC response, extend `src/tests/fixtures.ts` or override only that command in the test.
- After `render`, use `waitFor` / `findBy*` for async-mounted state. Use `const user = userEvent.setup()` and await interactions to avoid React `act(...)` warnings. **`pnpm test:coverage` must complete with zero `act(...)` warnings** — fix or wrap async updates (including `ipc.emit` and fake-timer advances) rather than leaving warnings in stderr.

### Rust

- Tests only in `src-tauri/tests/<area>_<focus>_integration.rs`. Name files after what they test, not meta-goals like `coverage_boost`.
- Native integration boundaries that can mutate host/global state must be gated out of Rust tests with `feature = "test-utils"` and tested through fakes or explicit `Unsupported` assertions. This includes NVAPI/NVIDIA DRS preset writes, registry-backed driver settings, real vendor APIs, and similar machine-global APIs.
- After adding a new test file, register it in **both** aliases in the repo-root `.cargo/config.toml`: `gm-test-integration` and `gm-llvm-cov`.
- Run with `pnpm test:rust` for fast iteration; `pnpm test:rust:coverage` for the coverage gate (`cargo llvm-cov nextest`). `cargo-llvm-cov` sets `--cfg coverage` to exclude the Tauri runtime entrypoint (`lib::run` / `main`); do not add other code behind `cfg(coverage)` to dodge coverage.

### Playwright (E2E + Visual Regression)

- Specs live in `e2e/`. `pnpm test:e2e` (and therefore `pnpm test:all`) always includes `screenshots.spec.ts`.
- Treat visual regression as a component inventory, not a state matrix: keep **exactly one screenshot scenario per visually distinct component**, run that scenario in light and dark themes, and extend it instead of adding cases for densities, interactions, loading/error variants, or other states already covered by Vitest.
- Keep only the canonical shell's light and dark baselines as full-page screenshots. Do not add per-layout or per-state full-page baselines.
- **Do not increase Playwright screenshot pixel tolerance** (or any visual diff threshold in `playwright.config.mjs`) to make tests pass — fix the UI/regression or intentionally update baselines instead.
- Update the `VITE_PLAYWRIGHT` mock for any new IPC command called from the UI. **Never embed fixture data or domain logic inline in `playwright-ipc-mock.ts`** — all fixture data belongs in `src/tests/playwright-fixtures/` (one file per domain) and must be wired through the registry in `src/tests/playwright-fixtures/index.ts` so it can be looked up and overridden per-test without touching the mock router.
- After intentional visual changes, regenerate baselines: `pnpm test:e2e --update-snapshots` and commit the updated snapshot files.

## Commands

```
pnpm dev                # run the Tauri app in dev
pnpm build              # build frontend + app
pnpm test               # Vitest (run once)
pnpm test:coverage      # Vitest with v8 coverage (90% gate)
pnpm test:rust          # cargo-nextest integration tests
pnpm test:rust:coverage # cargo-llvm-cov (90/90/80 gates)
pnpm test:e2e           # Playwright visual-regression
pnpm test:all           # Vitest + Rust + Playwright, all three layers
pnpm lint / format / typecheck
cargo clippy --all-targets --all-features -- -D warnings   # from src-tauri/
```

Helper scripts (`scripts/`): `create-secrets.mjs` (git-ignored OAuth client secrets), `run-rust-coverage.mjs` (drives `cargo-llvm-cov`), `ensure-playwright-port.mjs` (Playwright dev-server port check).
