# Phases 7 & 8 — Remaining Work

Extracted from `mailclient_plan.md`. Items already fully implemented have been
removed. Items that are partially implemented note current state.

---

## Phase 7 — Keyboard & Command Palette

> `KeyboardService` is already fully implemented with chord support, modifier
> normalization, and a `shortcutTriggered$` observable. The items below build
> on top of it.

### 1. Command Palette Overlay Component

**Current state**: `UiStore` has `commandPaletteOpen`, `openCommandPalette`,
`closeCommandPalette`, and `toggleCommandPalette`. No component exists.

Create `src/app/features/command-palette/command-palette.component.ts` and
`command-palette.component.html`:

- Opens on `Ctrl+K` / `Cmd+K` (wired via `KeyboardService`)
- Reads open/close state from `UiStore.commandPaletteOpen`
- Renders a fuzzy-searchable list of commands from `CommandRegistryService`
- Supports arrow-key navigation, `Enter` to execute, `Escape` to close
- Displays icon + label + default key binding per command
- Shows a "Recent commands" section (last 5 executed, tracked in `UiStore`)
- Uses Angular CDK Overlay with a semi-transparent backdrop

### 2. Centralized Command Registry

**Current state**: `KeyboardService` provides registration primitives but there
is no central file defining all app-wide commands with labels, icons, or
default bindings.

Create `src/app/core/services/command-registry.service.ts`:

- Defines `Command` interface:
`{ id, label, description, icon, defaultKeys, action, context? }`
- Registers all default app commands at startup (see shortcut table in
`mailclient_plan.md` → Keyboard Shortcuts)
- Reads custom keybindings from `SettingsStore` and overrides defaults
- Registers all commands with `KeyboardService` on init
- Exposes `getAllCommands()` and `getCommand(id)` for the command palette
and keyboard settings page

Default commands to register (from the original plan):


| ID                       | Label               | Default Keys         |
| ------------------------ | ------------------- | -------------------- |
| `compose-new`            | Compose New Email   | `Ctrl+N` / `Cmd+N`   |
| `search-focus`           | Search Emails       | `Ctrl+F` / `/`       |
| `sync-now`               | Sync Now            | `Ctrl+R` / `Cmd+R`   |
| `open-settings`          | Open Settings       | `Ctrl+,` / `Cmd+,`   |
| `toggle-command-palette` | Command Palette     | `Ctrl+K` / `Cmd+K`   |
| `reply`                  | Reply               | `R` (email selected) |
| `reply-all`              | Reply All           | `Shift+R`            |
| `forward`                | Forward             | `F`                  |
| `archive`                | Archive             | `E`                  |
| `delete`                 | Delete              | `#`                  |
| `star`                   | Star / Unstar       | `S`                  |
| `mark-read`              | Mark Read           | `Shift+I`            |
| `mark-unread`            | Mark Unread         | `Shift+U`            |
| `nav-next`               | Next Email          | `J` / `↓`            |
| `nav-prev`               | Previous Email      | `K` / `↑`            |
| `open-thread`            | Open Thread         | `Enter` / `O`        |
| `go-inbox`               | Go to Inbox         | `g i` (chord)        |
| `go-sent`                | Go to Sent          | `g s` (chord)        |
| `go-drafts`              | Go to Drafts        | `g d` (chord)        |
| `ai-summarize`           | AI Summarize Thread | `Ctrl+J` / `Cmd+J`   |
| `toggle-sidebar`         | Toggle Sidebar      | `Ctrl+B` / `Cmd+B`   |
| `toggle-reading-pane`    | Toggle Reading Pane | `Ctrl+.` / `Cmd+.`   |
| `select-all`             | Select All          | `Ctrl+A` / `Cmd+A`   |
| `escape`                 | Escape / Close      | `Escape`             |


### 3. Vim-style Navigation in Email List

**Current state**: `KeyboardService` supports chords; no bindings are wired
in `email-list.component.ts` or any shell component.

In `src/app/features/mail/email-list/email-list.component.ts`:

- Subscribe to `KeyboardService.shortcutTriggered$` (or inject
`CommandRegistryService`)
- Handle `nav-next` (`J`/`↓`) → select next thread in list
- Handle `nav-prev` (`K`/`↑`) → select previous thread in list
- Handle `open-thread` (`Enter`/`O`) → open selected thread in reading pane
- Handle `archive` (`E`), `delete` (`#`), `star` (`S`), `mark-read`,
`mark-unread` for the currently selected email(s)

In `src/app/features/mail/mail-shell.component.ts` (or `AppComponent`):

- Handle `go-inbox` (`g i`) → navigate to inbox folder via router
- Handle `go-sent` (`g s`) → navigate to sent folder
- Handle `go-drafts` (`g d`) → navigate to drafts folder
- Handle `select-all` (`Ctrl+A`) → select all visible emails
- Handle `escape` → deselect emails / close open overlays

### 4. Keyboard Settings Page

**Current state**: No `keyboard-settings.component.ts` exists. `SettingsStore`
has no keybinding persistence.

**Step 1** — Add keybinding persistence to `SettingsStore`
(`src/app/store/settings.store.ts`):

- Add `customKeyBindings: Record<string, string>` to `AppSettings`
(`src/app/core/models/settings.model.ts`)
- Add `setKeyBinding(commandId: string, keys: string)` and
`resetKeyBinding(commandId: string)` methods
- Persist via `db:set-settings` IPC

**Step 2** — Create `src/app/features/settings/keyboard-settings.component.ts`
and `keyboard-settings.component.html`:

- List all commands from `CommandRegistryService`
- Show current binding per command (custom or default)
- Allow inline editing: click to enter capture mode, press the desired keys,
`Escape` to cancel
- "Reset to default" button per command; global "Reset all" button
- Inline conflict warnings (see item 5 below)

**Step 3** — Add route `/settings/keyboard` to `app.routes.ts` and add a nav
item in `src/app/features/settings/settings-shell.component.html` if missing.

### 5. Shortcut Conflict Detection

**Current state**: `KeyboardService.register()` silently overwrites; no
duplicate or overlap checking.

Add conflict detection to `CommandRegistryService`:

- When `setKeyBinding()` is called, check all registered command key strings
for an exact match
- Return a `ConflictResult: { hasConflict: boolean, conflictingCommandId?: string }`
- In the keyboard settings UI: show an inline warning with the conflicting
command name and offer to reassign or cancel

---

## Phase 8 — Polish & Platform Integration

> Already implemented in Phase 8: desktop notifications (SyncService),
> single-instance enforcement, window position/size persistence, DOMPurify
> HTML sanitization, and filter rule management UI.

### 1. System Tray with Unread Badge

**Current state**: `ipc-channels.ts` defines `SYSTEM_TRAY_ACTION` and preload
exposes the channel. No `Tray` object is created anywhere in the main process.
No `notification-service.ts` exists.

Create `electron/services/tray-service.ts`:

- On `app.whenReady()`, create a `Tray` with the app icon
- Build context menu:
  - **Show / Hide** — toggle main window visibility
  - **Compose** — show window + open compose via IPC event
  - **Sync Now** — trigger sync
  - **Quit** — `app.quit()`
- Left-click (Windows/Linux): show and focus main window
- Update badge / tooltip when unread counts change:
  - Subscribe to post-sync unread totals from `DatabaseService`
  - macOS: `app.setBadgeCount(totalUnread)` for the Dock badge
  - Windows: tray tooltip showing unread count
- Fire `system:tray-action` IPC event to renderer on tray interactions
(compose, show, etc.) using the already-defined channel

Instantiate `TrayService` from `electron/main.ts` after `createMainWindow()`.


### 3. Remote Image Blocking — Enforcement + Per-Sender Allowlist

**Current state**: `SettingsStore.blockRemoteImages` defaults to `true` and
persists. `email-body-frame.component.ts` uses DOMPurify but does **not**
block remote `<img src="http(s)://...">` tags based on the setting.

**Step 1** — Enforce blocking in
`src/app/features/mail/reading-pane/email-body-frame.component.ts`:

- After DOMPurify sanitization, when `blockRemoteImages` is `true` (and
sender is not in allowlist), find all `<img>` elements whose `src` starts
with `http://` or `https://`
- Store original URL in `data-src`; replace `src` with a 1×1 grey
placeholder data URI
- Show a "Load images" banner above the email body when any images were
blocked

**Step 2** — Add per-sender allowlist to settings:

- Add `allowedImageSenders: string[]` to `AppSettings`
(`src/app/core/models/settings.model.ts`)
- Add `addAllowedImageSender(email: string)` and
`removeAllowedImageSender(email: string)` to `SettingsStore`
- Persist via `db:set-settings` IPC

**Step 3** — "Load images" banner actions:

- **Load once** — reload current email bypassing the block (local state only)
- **Always allow from [sender]** — call `addAllowedImageSender()`, reload

**Step 4** — Settings UI (add to `general-settings.component.html`):

- Verify "Block remote images by default" toggle is wired to
`SettingsStore.blockRemoteImages`
- Add a list of allowed senders with per-item remove buttons

### 4. Notification Sound Support

**Current state**: `SyncService` fires OS notifications silently. No sound
setting exists in `SettingsStore`.

**Step 1** — Add settings:

- Add `notificationSound: boolean` (default `true`) and
`notificationSoundVolume: number` (default `0.8`) to `AppSettings`
- Add corresponding controls to
`src/app/features/settings/notification-settings.component.html`

**Step 2** — Add audio asset:

- Add `assets/sounds/notification.mp3` (short, subtle chime)

**Step 3** — Playback (renderer):

- Add `SYSTEM_PLAY_SOUND` to `electron/ipc/ipc-channels.ts`
- Expose in `electron/preload.ts` and add to `ElectronService`
- In `SyncService` (main process): after emitting `mail:new-email`, also
emit `system:play-sound`
- In the renderer (`AppComponent` or a new `NotificationSoundService`):
listen for `system:play-sound`, check `SettingsStore.notificationSound`,
and play `assets/sounds/notification.mp3` via the Web Audio API or an
`<audio>` element at the configured volume

---

## Deferred (out of scope for now)

- **Snooze functionality** — deferred to a future phase
