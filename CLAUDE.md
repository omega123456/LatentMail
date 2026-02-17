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

### Database Schema (SQLite via better-sqlite3)

**Schema version**: 5 (tracked in `schema_version` table)

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
- `gmail_message_id` is the stable identifier across all folders
- Schema migrations happen automatically on app start in `DatabaseService.migrate()`

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

### Database Schema Migrations

1. Increment `SCHEMA_VERSION` in `electron/database/schema.ts`
2. Add migration logic in `DatabaseService.migrate()` in `electron/services/database-service.ts`
3. Use `db.prepare()` for each ALTER/CREATE statement
4. Test migration from previous version (database persists across restarts)

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
- Use `gmail_message_id` as the stable cross-folder identifier
- Snapshot UIDs at operation enqueue time
- Handle "UID not found" errors gracefully (email may have been deleted/moved)

### Folder Locking

IMAP operations on the same folder must be serialized to avoid UID corruption. `FolderLockManager` ensures:
- One operation per `(accountId, folder)` at a time
- Operations queue and wait for the lock
- Lock is released even if operation fails

**Usage**: Wrap all IMAP operations in `folderLockManager.withLock(accountId, folder, async () => { ... })`

## Code Style and Conventions

### TypeScript

- Use strict mode (enabled in both `tsconfig.json` and `tsconfig.electron.json`)
- **Always use curly braces for control statements** — no single-line `if`/`else`/`for`/`while`/`do`. Every branch or loop body must be wrapped in `{ }`.
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
3. Check `~/Library/Logs/MailClient/main.log` (macOS) or `%USERPROFILE%\AppData\Roaming\MailClient\logs\main.log` (Windows) for main process logs

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
- **macOS**: `~/Library/Application Support/MailClient/mailclient.db`
- **Windows**: `%APPDATA%\MailClient\mailclient.db`
- **Linux**: `~/.config/MailClient/mailclient.db`

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
