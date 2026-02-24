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

# Package the app (creates distributable in out/)
yarn package

# Create platform-specific installer
yarn make
```

### Testing

```bash
# Run Angular unit tests
yarn test
```

### Native Module Rebuilding

After installing dependencies or updating Electron, rebuild native modules:

```bash
npx @electron/rebuild
```

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

The addon binary is included automatically when packaging on Windows. The `AutoUnpackNativesPlugin` in `forge.config.ts` extracts `.node` files from the ASAR archive. `NativeDropService` tries the production path (`app.asar.unpacked/native/...`) first, then falls back to the dev path.

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
2. **Main → Renderer**: Main process emits events via `BrowserWindow.webContents.send()` → renderer listens via `electronAPI.on()`
3. **Response Format**: All IPC handlers return `IpcResponse<T>` with `{ success, data?, error? }`

**Key IPC Modules**:
- `mail-ipc.ts` - Email operations (fetch, search, move, flag, delete)
- `queue-ipc.ts` - Mail queue operations (draft, send, retry)
- `auth-ipc.ts` - Google OAuth login/logout
- `ai-ipc.ts` - Ollama AI integration
- `compose-ipc.ts` - Contact search, signatures
- `db-ipc.ts` - Settings persistence
- `system-ipc.ts` - Window controls (minimize, maximize, close)

### Database Schema (SQLite via sql.js)

**Migrations**: Schema is managed by **Umzug** (file-based migrations). Migrations live in `electron/database/migrations/`; executed migrations are recorded in the `schema_migrations` table. On app start, `DatabaseService.initialize()` runs `umzug.up()`. To add schema changes: add a new migration file (e.g. `002_add_foo.ts`) with `up` (and optionally `down`) receiving `{ context: { db, databaseService } }`.

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

## Key Development Patterns

### Adding a New IPC Handler

1. Define the channel name in `electron/ipc/ipc-channels.ts`
2. Add handler in appropriate `electron/ipc/*-ipc.ts` file using `ipcMain.handle()`
3. Add method signature to `electronAPI` in `electron/preload.ts`
4. Add TypeScript interface to `ElectronAPI` in `src/app/core/services/electron.service.ts`
5. Call via `electronService.api.<namespace>.<method>()` in Angular components

### Database Schema Migrations (Umzug)

1. Add a new file under `electron/database/migrations/` (e.g. `002_add_foo.ts`) with named exports `up` and optionally `down`.
2. Migration functions receive `{ context }: { context: { db, databaseService } }`. Use `context.db.run()` or `context.db.exec()` for SQL; use **named placeholders** (`:name`) and objects for parameters.
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

### TypeScript

- Use strict mode (enabled in both `tsconfig.json` and `tsconfig.electron.json`)
- Prefer `interface` over `type` for object shapes
- Use `unknown` over `any` for IPC payloads, narrow with type guards
- All IPC handlers must return `Promise<IpcResponse<T>>`

### Angular

- **Use external template files** for all components: `templateUrl: './<name>.component.html'`. Do **not** use inline `template: \`...\`` in `@Component()`. Place the `.html` file in the same directory as the component (e.g. `compose-window.component.html` next to `compose-window.component.ts`).
- **Use external style files** for all components: `styleUrl: './<name>.component.scss'`. Do **not** use inline `styles: [\`...\`]` in `@Component()`. Place the `.scss` file in the same directory as the component and follow SASS nesting conventions.
- Use standalone components (no NgModules except `AppModule`)
- Inject services via `inject()` function, not constructor DI
- Use signals and `computed()` for reactive state
- Use `OnPush` change detection (default for all components)
- Use Angular Material components for UI consistency

### Electron

- Never expose Node.js APIs directly to renderer (use IPC)
- Validate all IPC input (treat renderer as untrusted)
- Use `electron-log` for all logging (auto-rotates, persists to file)
- Use `safeStorage` for credentials (never store tokens in SQLite or files)

### Database

- Use parameterized queries for all user input (`db.run()` / `db.exec()` with params)
- **Use named placeholders only** — never positional `?`. Use `:name` in SQL and pass an object: `{ ':accountId': id, ':folder': folder }`. Keys must include the colon (per sql.js). This keeps queries readable and avoids parameter-order bugs.
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

## Common Gotchas

1. **SQL placeholders**: Use **named** placeholders only (`:name` + object params). Do not add new queries with positional `?` and arrays — see Database conventions above.
2. **Native modules**: If you see "Module did not self-register", run `npx @electron/rebuild`
3. **IMAP UID drift**: Always snapshot UIDs at enqueue time, never resolve during execution
4. **Folder locking**: Forgetting `withLock()` can corrupt UIDs or cause race conditions
5. **OAuth token refresh**: Tokens expire after 1 hour; refresh timer runs automatically
6. **Schema migrations**: Always test on a copy of a real database, not a fresh one
7. **Queue persistence**: Don't clear queue table manually; use `queue:clear-completed` IPC
8. **Draft-send lifecycle**: Send operation must either succeed or leave draft untouched (no orphan drafts)
9. **Gmail folder names**: Use `[Gmail]/...` paths, not localized names (e.g., `[Gmail]/Sent Mail`, not "Sent")
