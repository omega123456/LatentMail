# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Building and Running

```bash
# Build Angular (development)
yarn build

# Build Angular (production)
yarn build:prod

# Compile Electron main process TypeScript
yarn build:electron

# Build both Angular (electron config) and Electron main
yarn build:all

# Run in Electron development mode (hot-reload Angular, watches localhost:4200)
yarn electron:dev

# Build everything and run packaged Electron app
yarn electron:start

# Package the app (creates unpacked app in out/)
yarn package

# Create platform-specific installer (out/)
yarn make
```

### Testing

```bash
# Full test suite (backend + frontend with coverage) — run before ending any session with code changes
yarn test:full-suite

# --- Backend (electron/main process) ---
# Run all backend tests (sequential)
yarn test:backend

# Filter tests by name (regex match on describe/it titles, sequential)
yarn test:backend --filter="sync"

# Run tests from a specific suite file (substring match, sequential)
yarn test:backend --file="database-settings"

# List available test suites (sequential runner)
yarn test:backend --list

# Run all backend tests in parallel across suites
yarn test:backend:parallel

# Limit number of parallel workers
yarn test:backend:parallel --jobs=8

# List available test suites and usage (parallel runner)
yarn test:backend:parallel --list

# Run parallel tests with coverage report
yarn test:backend:parallel --coverage

# Enforce overall coverage threshold (example: 80%)
yarn test:backend:parallel --check-coverage=80

# Enforce per-metric coverage thresholds
yarn test:backend:parallel --check-statements=90 --check-branches=90 --check-functions=90 --check-lines=90

# --- Frontend (Playwright + Electron renderer) ---
# Run frontend E2E tests (builds Angular + Electron, then Playwright)
yarn test:frontend

# Run frontend tests only (assumes build already done; use for quick re-runs)
yarn test:frontend:run

# Update visual regression snapshots
yarn test:frontend:update-screenshots

# Frontend tests with coverage collection and threshold check
yarn test:frontend --coverage
yarn test:frontend --check-coverage=90
```

### Native Module Rebuilding

After installing dependencies or updating Electron, rebuild native modules:

```bash
npx @electron/rebuild
```

### Git Hooks (Worktree Support)

Git hooks live in `.githooks/` (versioned) rather than `.git/hooks/`. This ensures hooks work across git worktrees, where each worktree has a separate `$GIT_DIR`.

The `postinstall` script automatically sets `core.hooksPath` to `.githooks/` on `yarn install`.

**Current hooks:**
- `post-checkout` — Runs `yarn install` when creating a new worktree (detects initial checkout)

### Native Drag-and-Drop Addon (Windows Only)

The app includes a C++ NAPI addon (`native/win32-drop-target/`) that fixes OS file drag-and-drop on Windows (broken by a Chromium regression in Electron 28+). The addon uses `DragAcceptFiles` + window subclassing to intercept `WM_DROPFILES` messages, bypassing Chromium's broken OLE handler.

**Building the addon (Windows only):**

```bash
# Requires: Visual Studio Build Tools with "Desktop development with C++" workload, Python 3.x
yarn build:native
```

This compiles the `.node` binary to `native/win32-drop-target/build/Release/win32_drop_target.node`, targeting the correct Electron ABI. The addon is loaded automatically by `NativeDropService` on app startup.

**Development workflow (Windows):**

```bash
yarn build:native      # One-time build (or after C++ changes)
yarn electron:dev      # Start dev mode — addon loads automatically
```

**Development workflow (macOS/Linux):**

No native addon needed — drag-and-drop works natively through Chromium on these platforms. `yarn build:native` is a no-op on non-Windows. `NativeDropService` skips initialization on non-Windows platforms.

```bash
yarn electron:dev      # Just works — no addon build needed
```

**Production / Packaging:**

Packaging uses **electron-builder** (config in `package.json` under `"build"`). The native addon is unpacked via `asarUnpack: ["**/native/**/*.node"]` so it is available at `app.asar.unpacked/native/...`. `NativeDropService` tries the production path (`app.asar.unpacked/native/...`) first, then falls back to the dev path.

```bash
# Windows
yarn build:native && yarn package   # or: yarn build:native && yarn make

# macOS/Linux
yarn package   # or: yarn make (no native build needed)
```

**When to rebuild:**
- After changing C++ source files in `native/win32-drop-target/src/`
- After upgrading Electron (the addon must match the Electron ABI)
- After `yarn install` (if `node_modules` changed)

**Graceful degradation:** If the addon is not built or fails to load, the app runs normally — OS file drops simply don't work on Windows (same as the current Electron bug behavior). A warning is logged at startup.

## Architecture Overview

### Dual-Process Architecture

This is an **Electron + Angular** desktop email client with a strict IPC-based separation:

- **Main Process** (Node.js): Electron backend in `electron/` - handles SQLite database, IMAP/SMTP, OAuth, credentials storage, and all email operations
- **Renderer Process** (Browser): Angular 21 frontend in `src/` - UI only, communicates with main via IPC

### IPC Communication Pattern

All main-renderer communication flows through the IPC bridge defined in `electron/preload.ts`:

1. **Renderer → Main**: Angular services call `ElectronService` methods → IPC invoke → handlers in `electron/ipc/*-ipc.ts`
2. **Main → Renderer**: Main process emits events via `BrowserWindow.webContents.send()` → renderer listens via `electronAPI.on()`. Channel names are in `IPC_EVENTS` in `ipc-channels.ts` (e.g. `mail:sync`, `queue:update`, `os-file:drop`).
3. **Response Format**: All IPC handlers return `IpcResponse<T>` with `{ success, data?, error? }`

**Key IPC Modules**:
- `mail-ipc.ts` - Email operations (fetch, search, move, flag, delete); label CRUD (create, delete, update-color)
- `queue-ipc.ts` - Mail queue operations (draft, send, retry)
- `auth-ipc.ts` - Google OAuth login/logout
- `ai-ipc.ts` - Ollama AI integration
- `compose-ipc.ts` - Contact search, signatures
- `db-ipc.ts` - Settings and filters persistence
- `filter-ipc.ts` - Apply filters (filter:apply-all)
- `attachment-ipc.ts` - Attachment download, content, draft attachments
- `logger-ipc.ts` - Recent log entries (for settings/debug)
- `bimi-ipc.ts` - BIMI sender logo (domain DNS)
- `system-ipc.ts` - Window controls (minimize, maximize, close), platform, zoom

### Database Schema (SQLite via better-sqlite3)

**Migrations**: Schema is managed by **Umzug** (file-based migrations). Migrations live in `electron/database/migrations/` (e.g. `001_initial_schema.ts`, `002_remove_gmail_parent_label.ts`); executed migrations are recorded in the `schema_migrations` table. On app start, `DatabaseService.initialize()` runs `umzug.up()`. To add schema changes: add a new migration file with `up` (and optionally `down`) receiving `{ context }: { context: MigrationContext }` — the `MigrationContext` type is exported from `001_initial_schema.ts` and has `db` and `databaseService`.

**Core tables**:
- `accounts` - Gmail accounts (email, tokens stored separately in OS keychain)
- `emails` - Email messages (1 row per message, no folder column)
- `email_folders` - Many-to-many link table (emails ↔ folders, stores IMAP UIDs)
- `threads` - Conversation threads
- `thread_folders` - Many-to-many link table (threads ↔ folders)
- `attachments` - Email attachments metadata
- `contacts` - Auto-extracted contacts with frequency tracking
- `labels` - Gmail folders/labels
- `filters` - User-defined/AI-generated filters
- `settings` - Key-value config store
- `mail_queue` - Persistent operation queue (drafts, sends, moves, flags, deletes)
- `ai_cache` - Ollama response cache
- `search_index` - Denormalized search cache (uses LIKE, not FTS5)

**Important constraints**:
- Emails can exist in multiple folders (via `email_folders` junction table)
- IMAP UIDs are stored per-folder in `email_folders.uid` (different UIDs in different folders)
- `x_gm_msgid` (Gmail message ID) is the stable identifier across all folders
- New DBs use only `schema_migrations` (Umzug); legacy `schema_version` table is no longer written

### State Management (NgRx SignalStore)

Angular uses **NgRx SignalStore** (not traditional NgRx Store):

- `accounts.store.ts` - Current account, account list
- `emails.store.ts` - Email list, threads, selected emails
- `folders.store.ts` - Folder list, current folder, unread counts
- `compose.store.ts` - Compose window state, drafts
- `queue.store.ts` - Mail queue status
- `settings.store.ts` - User preferences
- `ui.store.ts` - UI state (sidebar collapsed, theme, layout)
- `ai.store.ts` - AI state (Ollama connection, models, summarize/compose/search/filter UI)

Stores are used in components via `inject()` and expose signals/computed values.

### Mail Queue System

The app uses a **persistent, resumable queue** for all mail operations (`MailQueueService` + `mail_queue` table):

**Queue Operations**:
- `draft-create` - Save draft to Gmail's Drafts folder
- `draft-update` - Update existing draft (resolves via `originalQueueId`)
- `send` - Send email via SMTP, delete draft
- `move` - Move emails between folders (IMAP COPY + STORE)
- `flag` - Set/unset flags (starred, read, important)
- `delete` - Soft delete to Trash or permanent delete

**Key features**:
- Operations are persisted before execution (survives app restarts)
- UIDs are resolved and snapshotted at enqueue time (avoids UID drift during offline)
- Uses `fastq` for sequential processing per account+folder
- Optimistic UI updates in renderer, reconciled on completion
- Failed operations can be retried individually or in batch
- Draft-send chain is tracked via in-memory `queueId` mapping

**Critical**: When enqueuing operations that reference emails (move/flag/delete), resolve UIDs **at enqueue time** and store them in the payload (`resolvedUids`), because UIDs may change between enqueue and execution.

### Services (Main Process)

**Core services** (all singleton instances):
- `DatabaseService` - SQLite database wrapper, schema migrations, CRUD operations
- `ImapService` - IMAP client pool (1 connection per account), folder sync, IDLE monitoring
- `SmtpService` - SMTP client for sending (uses nodemailer)
- `OAuthService` - Google OAuth2 PKCE flow, token refresh timers
- `CredentialService` - Stores tokens in OS-native secure storage (Windows DPAPI, macOS Keychain, Linux Secret Service via Electron's `safeStorage`)
- `SyncService` - Background sync orchestrator (syncs all accounts every 5min, prioritizes INBOX/Sent/Drafts)
- `MailQueueService` - Persistent queue processor with folder locking
- `FolderLockManager` - Per-folder mutex to prevent concurrent IMAP operations
- `BodyPrefetchService` - Prefetches email bodies for threads (reduces latency when opening messages)
- `NativeDropService` - Loads Win32 drag-and-drop addon, forwards OS file drops to renderer (Windows only)

### Angular Components Structure

**Feature modules** (all standalone components):
- `features/auth/` - Login, OAuth callback
- `features/mail/` - Main mail UI (sidebar, email list, reading pane, status bar)
- `features/compose/` - Compose window (TipTap editor, recipients, attachments, signatures)
- `features/settings/` - Settings panels (general, accounts, queue management)

**Shared components** in `shared/` (avatar, search bar, etc.)

**Core services** in `core/services/`:
- `ElectronService` - IPC wrapper, exposes typed API to Angular
- `ThemeService` - Material theme switching (light/dark)
- `ToastService` - Snackbar notifications
- `KeyboardService` - Global keyboard shortcuts
- `ZoomService` - Window zoom level (system:set-zoom / system:get-zoom)
- `LayoutService` - Layout state for mail/compose
- `CommandRegistryService` - Global command palette / shortcuts

## Key Development Patterns

### Adding a New IPC Handler

1. Define the channel name in `electron/ipc/ipc-channels.ts`
2. Add handler in appropriate `electron/ipc/*-ipc.ts` file using `ipcMain.handle()`
3. Add method signature to `electronAPI` in `electron/preload.ts`
4. Add TypeScript interface to `ElectronAPI` in `src/app/core/services/electron.service.ts`
5. Call via `electronService.api.<namespace>.<method>()` in Angular components

### Database Schema Migrations (Umzug)

1. Add a new file under `electron/database/migrations/` (e.g. `008_add_foo.ts`) with named exports `up` and optionally `down`.
2. Migration functions receive `{ context }: { context: MigrationContext }` (import `MigrationContext` from `./001_initial_schema`). Use `context.db.exec()` for DDL (no parameters); use `context.db.prepare(sql).run(params)` or `.all(params)` for parameterized queries.
3. Run `yarn build:electron` so the new migration is compiled to `dist-electron/database/migrations/*.js`. Migrations run automatically on app start via `umzug.up()` in `DatabaseService.initialize()`.
4. The `schema_migrations` table records executed migration names; no manual version bump needed.

### Handling Email Operations

**Always use the queue** for operations that modify server state (send, move, flag, delete). Direct IMAP operations should only be used for read operations (fetch, search).

**When enqueuing operations**:
1. Resolve UIDs from `email_folders` table at enqueue time
2. Store resolved UIDs in payload (`resolvedUids`, `resolvedEmails`)
3. Return optimistic success to renderer immediately
4. Queue will reconcile DB state on completion

### Working with IMAP UIDs

**Critical**: UIDs are **per-folder** and can change (e.g., after EXPUNGE). Always:
- Store UIDs in `email_folders.uid` (per email-folder pair)
- Use `x_gm_msgid` (Gmail message ID) as the stable cross-folder identifier
- Snapshot UIDs at operation enqueue time
- Handle "UID not found" errors gracefully (email may have been deleted/moved)

### Folder Locking

IMAP operations on the same folder must be serialized to avoid UID corruption. `FolderLockManager` ensures:
- One operation per `(accountId, folder)` at a time
- Operations queue and wait for the lock
- Lock is released even if operation fails

**Usage**: Wrap all IMAP operations in `folderLockManager.withLock(accountId, folder, async () => { ... })`

## Code Style and Conventions

### CRITICAL

- **Always use curly braces for control statements** — no single-line `if`/`else`/`for`/`while`/`do`. Every branch or loop body must be wrapped in `{ }`.
- **Use full words for variable and parameter names** — no single letters (e.g. use `deltaX` not `dx`, `width` not `w`) and no abbreviations (e.g. use `element` not `el`, `bounds` not `rect`, `index` not `i` where readability benefits). Exception: very short loop variables in tiny scope (e.g. `index` in a 2-line loop) may use a full word like `index`; avoid `i`, `j`, `n`, `x`, etc.
- **Run tests before ending any session with code changes** — If you modified any code during the session, you MUST run `yarn test:full-suite` before finishing and ensure all tests pass. This runs backend tests (parallel, with 90% coverage check) then frontend tests (Playwright E2E, with 90% coverage check). Do not leave a session with failing tests. If tests fail, fix them before completing the task.
- **New code requires test coverage** — Any new functionality, service, IPC handler, or non-trivial logic must have corresponding tests: backend code in `tests/backend/suites/` (Mocha + Chai, see "Backend Testing"), frontend/UI code in `tests/frontend/suites/` (Playwright, see "Frontend Testing"). Do not add features without tests.
- **Only end-to-end tests** — Write **only** end-to-end (E2E) or functional tests. **Never** write unit tests. **Never** test by calling application functions, classes, or services directly; always exercise behavior through the public IPC interface (e.g. `callIpc()`). Tests must verify real workflows and real system state, not isolated units.

### Dates and Time

- **Always use the Luxon library** for date/time handling in both the main process (`electron/`) and the renderer (`src/`). Do not use native `Date`, `moment`, or other date libraries.
- Import from `luxon`: use `DateTime`, `Duration`, `Interval`, and helpers like `DateTime.now()`, `DateTime.fromISO()`, `.toISO()`, `.toFormat()` for parsing, formatting, and arithmetic. Store or exchange ISO 8601 strings when persisting or crossing IPC; use Luxon to parse and format them.

### TypeScript

- Use strict mode (enabled in both `tsconfig.json` and `tsconfig.electron.json`)
- Prefer `interface` over `type` for object shapes
- Use `unknown` over `any` for IPC payloads, narrow with type guards
- All IPC handlers must return `Promise<IpcResponse<T>>`

### Angular

- **Use external template files** for all components: `templateUrl: './<name>.component.html'`. Do **not** use inline `template: \`...\`` in `@Component()`. Place the `.html` file in the same directory as the component (e.g. `compose-window.component.html` next to `compose-window.component.ts`).
- **Use external style files** for all components: `styleUrl: './<name>.component.scss'`. Do **not** use inline `styles: [\`...\`]` in `@Component()`. Place the `.scss` file in the same directory as the component and follow SASS nesting conventions.
- Use standalone components; app is bootstrapped with `bootstrapApplication(AppComponent, appConfig)` (no NgModules)
- Inject services via `inject()` function, not constructor DI
- Use signals and `computed()` for reactive state
- Use `OnPush` change detection (default for all components)
- Use Angular Material components for UI consistency

### Electron

- Never expose Node.js APIs directly to renderer (use IPC)
- Validate all IPC input (treat renderer as untrusted)
- Use `electron-log` for all logging (auto-rotates, persists to file)
- Use `safeStorage` for credentials (never store tokens in SQLite or files)
- **Always use platform/arch helpers** for OS and CPU checks: import from `electron/utils/platform.ts` and use `isWindows()`, `isMacOS()`, `isLinux()`, `isX64()`, `isArm64()` (or `isPlatform()` / `isArch()` for other values). Do not compare `process.platform` or `process.arch` directly.

### Database

- Use parameterized queries for all user input (`db.prepare(sql).run(params)` / `db.prepare(sql).all(params)`)
- **Use named placeholders only** — never positional `?`. Use `:name` in SQL and pass an object: `{ accountId: id, folder: folder }`. Keys must NOT include the colon (per better-sqlite3). This keeps queries readable and avoids parameter-order bugs.
- **Trash folder**: Never hardcode `'[Gmail]/Trash'` or any trash path in SQL or application code. Always resolve the trash folder via `DatabaseService.getTrashFolder(accountId)` and pass it as a bound parameter (e.g. `:trashFolder`). This supports accounts that use `[Gmail]/Bin` or other locale- or provider-specific trash folders; inline `labels` joins for `special_use = '\Trash'` can fail and fall back incorrectly.
- Wrap multi-statement transactions in `db.transaction(() => { ... })` (or `BEGIN`/`COMMIT`/`ROLLBACK` where used)
- Always handle foreign key constraints (CASCADE deletes)
- Use ISO 8601 format for timestamps (`datetime('now')`)

## Testing and Debugging

### Running in Development

**Recommended workflow**:
1. `yarn electron:dev` - Starts Angular dev server + Electron with hot-reload
2. Open DevTools automatically in main window
3. Check `~/Library/Logs/LatentMail/main.log` (macOS) or `%USERPROFILE%\AppData\Roaming\LatentMail\logs\main.log` (Windows) for main process logs

### Debugging Main Process

- Main process logs to `electron-log` (see above paths)
- Set `LOG_LEVEL=debug` in `.env` for verbose output
- Use `log.debug()`, `log.info()`, `log.warn()`, `log.error()` (not `console.log`)

### Debugging Renderer Process

- Use Chrome DevTools in the Electron window
- Renderer logs appear in DevTools console
- Check Network tab for IPC timing (though IPC doesn't show as HTTP)

### Database Inspection

SQLite database location:
- **macOS**: `~/Library/Application Support/LatentMail/latentmail.db`
- **Windows**: `%APPDATA%\LatentMail\latentmail.db`
- **Linux**: `~/.config/LatentMail/latentmail.db`

Use `sqlite3` CLI or DB Browser for SQLite to inspect.

## Backend Testing

### Philosophy: Functional/E2E Tests Only (Mandatory)

This project uses **only functional and end-to-end tests**. Unit tests and direct function/service calls in tests are **not allowed**.

**DO NOT**:
- Write unit tests or test functions in isolation
- Call application code directly (no direct imports of services, handlers, or internal functions for the purpose of testing them)
- Mock internal services, classes, or functions
- Use dependency injection to swap internal implementations
- Test private methods or internal state directly

**DO**:
- Test **only** through the public IPC interface (e.g. `callIpc()`)
- Use real service instances only as exercised via IPC (e.g. assertions via `getDatabase()` after IPC calls)
- Exercise complete workflows (e.g., sync → store → retrieve)
- Verify end-to-end behavior from API input to database state

### Mocking Policy: External Services Only

**Only mock external network services** — systems that live outside this codebase and would require real network I/O:

| Mock Server | Location | What It Replaces |
|-------------|----------|------------------|
| `GmailImapServer` | `tests/backend/mocks/imap/gmail-imap-server.ts` | Real Gmail IMAP servers |
| `SmtpCaptureServer` | `tests/backend/mocks/smtp/smtp-capture-server.ts` | Real SMTP relay |
| `FakeOAuthServer` | `tests/backend/mocks/oauth/fake-oauth-server.ts` | Google OAuth endpoints |
| `FakeOllamaServer` | `tests/backend/mocks/ollama/fake-ollama-server.ts` | Local Ollama AI server |

**Never mock**:
- `DatabaseService` — use the real SQLite instance (restored to a clean snapshot between suites)
- `MailQueueService` — test queue operations against the real implementation
- `SyncService`, `ImapService`, `SmtpService` — these are the code under test
- Any internal helper, utility, or service class

### Test Structure

```
tests/backend/
├── fixtures/              # Shared test data (emails, accounts)
├── infrastructure/        # Test framework setup
│   ├── mocha-setup.ts     # Mocha runner configuration
│   ├── suite-lifecycle.ts # quiesceAndRestore() for DB isolation
│   ├── test-helpers.ts    # callIpc(), getDatabase(), seedTestAccount()
│   └── test-event-bus.ts  # Captures IPC events for assertions
├── mocks/                 # External service mocks (IMAP, SMTP, OAuth, Ollama)
├── suites/                # Test files (*.test.ts)
└── test-main.ts           # Test entry point, initializes all services
```

### Writing a New Test Suite

1. **Create** a file in `tests/backend/suites/` named `<feature>.test.ts`

2. **Import** required helpers:

```typescript
import { expect } from 'chai';
import { quiesceAndRestore } from '../infrastructure/suite-lifecycle';
import { callIpc, getDatabase, seedTestAccount } from '../infrastructure/test-helpers';
```

3. **Initialize** with `quiesceAndRestore()` in `before()` to reset DB state:

```typescript
describe('My Feature', () => {
  before(async () => {
    await quiesceAndRestore();
  });

  it('does something', async () => {
    // Seed an account if needed
    const { accountId } = seedTestAccount({ email: 'user@example.com' });

    // Call IPC handlers directly
    const result = await callIpc('my:ipc-channel', accountId, 'arg2');
    expect(result.success).to.be.true;

    // Assert database state
    const db = getDatabase();
    const rows = db.getDatabase().prepare('SELECT * FROM my_table WHERE ...').all();
    expect(rows).to.have.length(1);
  });
});
```

### Key Test Helpers

- **`quiesceAndRestore()`** — Resets DB to clean snapshot, clears credentials, resets mock servers. Call in `before()` hook.
- **`seedTestAccount(options)`** — Creates a test account in DB + credentials + configures all mock servers to accept it. Returns `{ accountId, email, accessToken }`.
- **`callIpc(channel, ...args)`** — Invokes IPC handlers directly (no Electron wire protocol). Returns the handler's response.
- **`getDatabase()`** — Returns `DatabaseService` instance for direct DB assertions.
- **`waitForEvent(channel, options)`** — Waits for an IPC event on `TestEventBus` (useful for async operations).
- **`triggerSyncAndWait(accountId)`** — Triggers a sync and waits for completion. Inject IMAP messages first via `imapStateInspector.injectMessage()`.

### IMAP State Inspector

For sync tests, use the `imapStateInspector` to inject messages into the fake IMAP server:

```typescript
import { imapStateInspector } from '../test-main';

// Inject a message into a folder
imapStateInspector.injectMessage('INBOX', {
  uid: 100,
  xGmMsgid: '1234567890',
  xGmThrid: '1234567890',
  flags: [],
  internalDate: DateTime.now().toJSDate(),
  envelope: { subject: 'Test Email', from: [{ address: 'sender@example.com' }], ... },
  bodyStructure: { ... },
});

// Then trigger sync
await triggerSyncAndWait(accountId);

// Assert the email was stored
const db = getDatabase();
const email = db.getDatabase().prepare('SELECT * FROM emails WHERE x_gm_msgid = :msgId').get({ msgId: '1234567890' });
expect(email).to.exist;
```

### Test Isolation

Each test suite gets a fresh database snapshot via `quiesceAndRestore()`. This ensures:
- Tests don't leak state to other suites
- Each suite starts with a known clean state
- Tests can mutate the DB freely without cleanup

## Frontend Testing

Frontend tests are **Playwright** E2E tests that launch the real Electron app (main + renderer), load the Angular UI, and assert on DOM and behavior. They live in `tests/frontend/` and are run via `scripts/run-frontend-tests.js`.

### Commands and workflow

- **`yarn test:frontend`** — Full run: builds Angular (electron config), compiles Electron + test code, copies prompts, then runs Playwright. Use `--coverage` to collect renderer JS coverage (rebuilds with `electron-coverage`), or `--check-coverage=N` to enforce a coverage threshold (e.g. 90).
- **`yarn test:frontend:run`** — Same as above but skips native rebuild; use when only re-running tests after a previous build.
- **`yarn test:frontend:update-screenshots`** — Runs frontend tests with `--update-snapshots` to refresh visual regression images.
- **`yarn test:full-suite`** — Runs `yarn test:backend:parallel --check-coverage=90` then `yarn test:frontend --check-coverage=90`. **Mandatory** before ending any session that changed code.

### Test structure

```
tests/frontend/
├── infrastructure/
│   ├── electron-fixture.ts   # Playwright worker fixtures: electronApp, sharedPage, resetApp()
│   ├── helpers.ts           # Shared DOM/assertion helpers
│   └── test-hooks-types.ts   # Types for resetApp options/result
├── suites/                   # Test files (*.test.ts)
├── screenshots/              # Visual regression snapshots (per platform)
├── playwright.config.ts      # Playwright config (testDir, timeouts, snapshot paths)
└── test-frontend-main.ts     # Electron main entry used when launching the app under test
```

Playwright is configured with `workers: 1`, retries, and long timeouts. The runner sets `LATENTMAIL_TEST_MODE=1` and `LATENTMAIL_TEST_TEMP_DIR`; the Electron main used for tests is `dist-test/tests/frontend/test-frontend-main.js`.

### Fixtures and isolation

- **`electronApp`** — Launched once per worker via `playwright`'s `_electron.launch()` with args pointing at `test-frontend-main.js`.
- **`sharedPage`** / **`page`** — First window of the Electron app; tests interact with the Angular UI in this window.
- **`resetApp(options?)`** — Resets app state (e.g. database) for isolation. Use in `beforeEach` or at the start of tests that need a clean state. Options and result types are in `test-hooks-types.ts`.

When coverage is requested (`--coverage` or `--check-coverage`), the script rebuilds Angular with the `electron-coverage` config, sets `PLAYWRIGHT_COVERAGE_DIR`, and the fixture starts JS coverage on the first window. After tests, `run-frontend-tests.js` runs c8 report (and optional threshold check) then exits with the combined result.

### Writing frontend tests

1. Create a file in `tests/frontend/suites/` named `<feature>.test.ts`.
2. Use the `test` and fixtures from `tests/frontend/infrastructure/electron-fixture.ts` (e.g. `test.extend(workerFixtures)` or the default export that provides `page`, `electronApp`, `resetApp`).
3. Use `resetApp()` when the test needs a clean DB/state.
4. Prefer user-facing behavior and DOM assertions; avoid depending on internal APIs. For visual regression, use Playwright snapshots (stored under `screenshots/{platform}/`).

### Coverage

- Enable with `yarn test:frontend --coverage` or `--check-coverage=N`.
- Coverage is collected from the renderer (Angular) via Playwright's JS coverage API; c8 produces reports under `coverage/frontend/`.
- Per-metric thresholds: `--check-statements`, `--check-branches`, `--check-functions`, `--check-lines` (same semantics as backend).

## Common Gotchas

1. **Dates**: Use **Luxon** only for date/time logic and formatting; do not use native `Date` or other date libraries — see Dates and Time in Code Style and Conventions.
2. **SQL placeholders**: Use **named** placeholders only (`:name` + object params). Do not add new queries with positional `?` and arrays — see Database conventions above.
3. **Native modules**: If you see "Module did not self-register", run `npx @electron/rebuild`
4. **IMAP UID drift**: Always snapshot UIDs at enqueue time, never resolve during execution
5. **Folder locking**: Forgetting `withLock()` can corrupt UIDs or cause race conditions
6. **OAuth token refresh**: Tokens expire after 1 hour; refresh timer runs automatically
7. **Schema migrations**: Always test on a copy of a real database, not a fresh one
8. **Queue persistence**: Don't clear queue table manually; use `queue:clear-completed` IPC
9. **Draft-send lifecycle**: Send operation must either succeed or leave draft untouched (no orphan drafts)
10. **Gmail folder names**: Use `[Gmail]/...` paths, not localized names (e.g., `[Gmail]/Sent Mail`, not "Sent")
11. **Trash folder**: Use `getTrashFolder(accountId)` and pass as `:trashFolder`; do not hardcode `[Gmail]/Trash` or join on `labels.special_use` in raw SQL (Bin/other locales break).
