# MailClient — Desktop Email Client Application Plan

## Table of Contents

- [Overview](#overview)
- [Goals and Objectives](#goals-and-objectives)
- [File System Changes](#file-system-changes)
- [Routing & Navigation](#routing--navigation)
- [Architecture & Structure](#architecture--structure)
- [Data & State Management](#data--state-management)
- [UI/UX Design System](#uiux-design-system)
- [UI/UX Wireframes](#uiux-wireframes)
- [AI Features — Ollama Integration](#ai-features--ollama-integration)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Electron Configuration](#electron-configuration)
- [OAuth2 Authentication Flow](#oauth2-authentication-flow)
- [Error Handling & Logging](#error-handling--logging)
- [Sync & Conflict Resolution](#sync--conflict-resolution)
- [Security & Privacy](#security--privacy)
- [Testing Strategy](#testing-strategy)
- [Implementation Steps](#implementation-steps)
- [Acceptance Criteria](#acceptance-criteria)
- [Notes and Considerations](#notes-and-considerations)

---

## Overview

MailClient is a cross-platform desktop email client for **Windows 10+ (x64)** and **macOS 12+ (Apple Silicon and Intel)**, built with **Electron 40+** and **Angular 21+**. It features a clean, minimal design inspired by Mailbird, supports Gmail via IMAP with OAuth2 (system browser + loopback redirect), and integrates local AI through Ollama for intelligent email management. The application stores emails locally in SQLite for offline reading and fast full-text search.

> **Technology Rationale**: Electron was chosen over Tauri for its mature ecosystem, broad Angular integration support, and proven track record with email clients. Angular was chosen for its strong typing, dependency injection, and enterprise-grade architecture. SQLite was chosen over IndexedDB for its superior full-text search (FTS5), cross-process accessibility from the main process, and proven performance with large datasets.

### Key Technology Choices

| Layer | Technology |
|-------|-----------|
| **Desktop Shell** | Electron 40+ |
| **Frontend Framework** | Angular 21+ (standalone components, signals) |
| **UI Components** | Angular Material + Tailwind CSS |
| **State Management** | NgRx SignalStore |
| **Rich Text Editor** | TipTap (ProseMirror-based) |
| **Local Database** | SQLite (via better-sqlite3) |
| **Email Protocol** | IMAP/SMTP via imapflow + nodemailer |
| **AI Integration** | Ollama REST API (local, user-configurable models) |
| **Icons** | Material Symbols (outlined) |
| **Build/Package** | Electron Forge |
| **Credential Storage** | Electron safeStorage API |
| **Testing** | Vitest + Angular Testing Library + Playwright (E2E) |

---

## Goals and Objectives

1. **Cross-platform**: Run natively on Windows and macOS with platform-appropriate packaging
2. **Gmail-first**: Seamless Gmail integration via OAuth2 (system browser + loopback redirect, no embedded webview)
3. **Multi-account**: Support multiple Gmail accounts with unified inbox and per-account views
4. **Local-first**: All emails cached in SQLite for offline reading and fast full-text search
5. **AI-powered**: Full suite of local AI features via Ollama — summarize, compose, sort, filter, search, and transform text
6. **Clean & minimal UI**: Mailbird-inspired design with dark/light themes, switchable layouts, and comfortable density
7. **Keyboard-driven**: Full keyboard shortcut support with command palette for power users
8. **Privacy-focused**: No external servers, local AI, sandboxed email rendering, remote image blocking

---

## File System Changes

### Directory Structure

```
D:\mailclient\
├── package.json
├── forge.config.ts                    # Electron Forge configuration
├── tsconfig.json                      # Root TypeScript config
├── tailwind.config.ts                 # Tailwind CSS configuration
├── angular.json                       # Angular workspace config
├── vite.config.ts                     # Vite build config (Angular + Electron)
├── vitest.config.ts                   # Test configuration
├── .env.example                       # Environment variable template (see below)
├── README.md                          # Developer setup and onboarding guide
├── assets/
│   ├── icons/                         # App icons (Windows .ico, macOS .icns)
│   ├── images/                        # Splash screen, onboarding images
│   └── sounds/                        # Notification sounds
├── electron/
│   ├── main.ts                        # Electron main process entry
│   ├── preload.ts                     # Preload script (context bridge)
│   ├── ipc/
│   │   ├── ipc-channels.ts            # IPC channel name constants
│   │   ├── mail-ipc.ts               # Mail-related IPC handlers
│   │   ├── auth-ipc.ts               # OAuth/auth IPC handlers
│   │   ├── db-ipc.ts                 # Database operation IPC handlers
│   │   ├── ai-ipc.ts                 # Ollama AI IPC handlers
│   │   ├── system-ipc.ts             # System tray, notifications, window IPC
│   │   └── index.ts                   # IPC handler registration
│   ├── services/
│   │   ├── imap-service.ts           # IMAP connection and operations
│   │   ├── smtp-service.ts           # SMTP sending operations
│   │   ├── oauth-service.ts          # Google OAuth2 token management
│   │   ├── database-service.ts       # SQLite database operations
│   │   ├── sync-service.ts           # Email sync orchestration
│   │   ├── search-service.ts         # Full-text search via SQLite FTS5
│   │   ├── ollama-service.ts         # Ollama REST API client
│   │   ├── notification-service.ts   # Desktop notifications
│   │   ├── credential-service.ts    # Secure credential storage (Electron safeStorage)
│   │   └── oauth-loopback.ts        # Local HTTP server for OAuth redirect
│   ├── database/
│   │   ├── schema.ts                 # SQLite table definitions
│   │   ├── migrations/               # Database migration files
│   │   └── seed.ts                   # Initial data seeding
│   └── utils/
│       ├── html-sanitizer.ts         # Email HTML sanitization
│       ├── crypto.ts                 # Token encryption utilities
│       └── platform.ts              # Platform detection helpers
├── src/
│   ├── main.ts                        # Angular bootstrap entry
│   ├── index.html                     # Root HTML
│   ├── styles.scss                    # Global styles, theme setup
│   ├── app/
│   │   ├── app.component.ts          # Root app component
│   │   ├── app.config.ts             # Angular app configuration
│   │   ├── app.routes.ts             # Top-level route definitions
│   │   ├── core/
│   │   │   ├── services/
│   │   │   │   ├── electron.service.ts        # Electron IPC bridge
│   │   │   │   ├── theme.service.ts           # Theme management (dark/light/system)
│   │   │   │   ├── keyboard.service.ts        # Global keyboard shortcut manager
│   │   │   │   ├── layout.service.ts          # Layout preference management
│   │   │   │   └── toast.service.ts           # Notification toast manager
│   │   │   ├── guards/
│   │   │   │   ├── auth.guard.ts              # Route guard for authenticated users
│   │   │   │   └── setup.guard.ts             # Route guard for first-run setup
│   │   │   ├── interceptors/
│   │   │   │   └── error.interceptor.ts       # Global error handling
│   │   │   └── models/
│   │   │       ├── email.model.ts             # Email, Thread, Attachment interfaces
│   │   │       ├── account.model.ts           # Account, Folder interfaces
│   │   │       ├── contact.model.ts           # Contact interfaces
│   │   │       ├── ai.model.ts                # AI request/response interfaces
│   │   │       ├── filter.model.ts            # Filter rule interfaces
│   │   │       └── settings.model.ts          # Settings/preferences interfaces
│   │   ├── store/
│   │   │   ├── accounts.store.ts              # Multi-account state
│   │   │   ├── emails.store.ts                # Email list and thread state
│   │   │   ├── folders.store.ts               # Folder/label state
│   │   │   ├── compose.store.ts               # Compose window state
│   │   │   ├── search.store.ts                # Search state
│   │   │   ├── ai.store.ts                    # AI feature state
│   │   │   ├── settings.store.ts              # App settings state
│   │   │   └── ui.store.ts                    # UI state (layout, sidebar, density)
│   │   ├── features/
│   │   │   ├── auth/
│   │   │   │   ├── auth-landing.component.ts  # Welcome/sign-in page
│   │   │   │   └── auth-callback.component.ts # OAuth callback handler
│   │   │   ├── mail/
│   │   │   │   ├── mail-shell.component.ts    # Main three-panel layout shell
│   │   │   │   ├── sidebar/
│   │   │   │   │   ├── sidebar.component.ts           # Sidebar container
│   │   │   │   │   ├── account-switcher.component.ts  # Multi-account dropdown
│   │   │   │   │   ├── folder-list.component.ts       # Folder navigation list
│   │   │   │   │   └── sidebar-footer.component.ts    # Settings/collapse controls
│   │   │   │   ├── email-list/
│   │   │   │   │   ├── email-list.component.ts        # Virtual-scrolling email list
│   │   │   │   │   ├── email-list-header.component.ts # Sort, filter, select-all controls
│   │   │   │   │   ├── email-list-item.component.ts   # Individual email row
│   │   │   │   │   └── email-list-empty.component.ts  # Empty state display
│   │   │   │   ├── reading-pane/
│   │   │   │   │   ├── reading-pane.component.ts      # Reading pane container
│   │   │   │   │   ├── message-header.component.ts    # Subject, from, to, date display
│   │   │   │   │   ├── message-body.component.ts      # Sandboxed email body renderer
│   │   │   │   │   ├── message-toolbar.component.ts   # Reply, forward, delete actions
│   │   │   │   │   ├── thread-view.component.ts       # Threaded conversation display
│   │   │   │   │   ├── attachment-list.component.ts   # Attachment display and download
│   │   │   │   │   └── inline-reply.component.ts      # Quick inline reply
│   │   │   │   └── resizable-panel.directive.ts       # Panel resize drag directive
│   │   │   ├── compose/
│   │   │   │   ├── compose-window.component.ts        # Compose dialog/window
│   │   │   │   ├── compose-toolbar.component.ts       # Formatting toolbar
│   │   │   │   ├── recipient-input.component.ts       # To/Cc/Bcc with autocomplete
│   │   │   │   ├── attachment-upload.component.ts     # Drag-and-drop attachment
│   │   │   │   └── signature-selector.component.ts    # Signature picker
│   │   │   ├── search/
│   │   │   │   ├── search-bar.component.ts            # Global search input
│   │   │   │   └── search-results.component.ts        # Search results display
│   │   │   ├── ai/
│   │   │   │   ├── ai-panel.component.ts              # AI assistant side panel
│   │   │   │   ├── ai-summarize.component.ts          # Thread summary display
│   │   │   │   ├── ai-compose.component.ts            # AI compose assistant
│   │   │   │   ├── ai-reply-suggestions.component.ts  # Smart reply chips
│   │   │   │   ├── ai-text-transform.component.ts     # Improve/shorten/formalize
│   │   │   │   ├── ai-categorize.component.ts         # Auto-categorization UI
│   │   │   │   ├── ai-search.component.ts             # Natural language search
│   │   │   │   └── ai-filter-builder.component.ts     # AI-assisted filter creation
│   │   │   ├── settings/
│   │   │   │   ├── settings-shell.component.ts        # Settings page layout
│   │   │   │   ├── general-settings.component.ts      # Theme, density, layout prefs
│   │   │   │   ├── account-settings.component.ts      # Account management
│   │   │   │   ├── ai-settings.component.ts           # Ollama configuration
│   │   │   │   ├── keyboard-settings.component.ts     # Shortcut customization
│   │   │   │   ├── notification-settings.component.ts # Notification preferences
│   │   │   │   ├── signature-settings.component.ts    # Signature management
│   │   │   │   └── filter-settings.component.ts       # Filter rule management
│   │   │   └── command-palette/
│   │   │       └── command-palette.component.ts       # Global command palette overlay
│   │   └── shared/
│   │       ├── components/
│   │       │   ├── avatar.component.ts                # User/contact avatar
│   │       │   ├── badge.component.ts                 # Unread count badge
│   │       │   ├── loading-spinner.component.ts       # Loading indicator
│   │       │   ├── empty-state.component.ts           # Empty state illustration
│   │       │   ├── confirm-dialog.component.ts        # Confirmation dialog
│   │       │   ├── snooze-picker.component.ts         # Snooze date/time picker
│   │       │   └── label-chip.component.ts            # Gmail label chip
│   │       ├── directives/
│   │       │   ├── keyboard-shortcut.directive.ts     # Keyboard shortcut binding
│   │       │   ├── auto-focus.directive.ts            # Auto-focus on mount
│   │       │   └── tooltip.directive.ts               # Enhanced tooltip
│   │       └── pipes/
│   │           ├── relative-time.pipe.ts              # "2 hours ago" formatting
│   │           ├── file-size.pipe.ts                  # "2.4 MB" formatting
│   │           └── highlight.pipe.ts                  # Search term highlighting
│   └── environments/
│       ├── environment.ts                             # Development config
│       └── environment.prod.ts                        # Production config
└── tests/
    ├── unit/                                          # Unit tests
    ├── integration/                                   # Integration tests
    └── e2e/                                           # End-to-end tests
```

### Environment Variables (.env.example)

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth2 Client ID (Desktop type, from Google Cloud Console) |
| `OLLAMA_URL` | No | Ollama API base URL (default: `http://localhost:11434`) |
| `DATABASE_PATH` | No | Override SQLite database location (default: platform user data dir) |
| `LOG_LEVEL` | No | Logging level: `debug`, `info`, `warn`, `error` (default: `info`) |
| `SYNC_INTERVAL_MS` | No | Email sync interval in milliseconds (default: `300000` / 5 minutes) |

> **Note**: No `GOOGLE_CLIENT_SECRET` is needed — the app uses PKCE flow for desktop applications.

**Database File Location** (default, per platform):
- **Windows**: `%APPDATA%/MailClient/mailclient.db`
- **macOS**: `~/Library/Application Support/MailClient/mailclient.db`

### New Files Summary

- **~90+ new files** across Electron main process, Angular frontend, and configuration
- **Electron layer** (~20 files): Main process, IPC handlers, backend services, database
- **Angular layer** (~60 files): Components, stores, services, models, directives, pipes
- **Configuration** (~10 files): Build configs, environment files, test configs

---

## Routing & Navigation

### Route Definitions

| Route Path | Component | Guard | Purpose |
|-----------|-----------|-------|---------|
| `/auth` | AuthLandingComponent | SetupGuard | Welcome/sign-in page for first-time users |
| `/auth/callback` | AuthCallbackComponent | — | OAuth2 redirect handler |
| `/mail` | MailShellComponent | AuthGuard | Main email interface — redirects to last-used account/folder |
| `/mail/unified` | MailShellComponent | AuthGuard | Unified inbox (all accounts merged, sorted by date) |
| `/mail/:accountId` | MailShellComponent | AuthGuard | Account-specific view (defaults to inbox) |
| `/mail/:accountId/:folderId` | MailShellComponent | AuthGuard | Folder-specific email list |
| `/mail/:accountId/:folderId/:threadId` | MailShellComponent | AuthGuard | Specific thread in reading pane |
| `/settings` | SettingsShellComponent | AuthGuard | Application settings |
| `/settings/general` | GeneralSettingsComponent | AuthGuard | Theme, layout, density |
| `/settings/accounts` | AccountSettingsComponent | AuthGuard | Account management |
| `/settings/ai` | AiSettingsComponent | AuthGuard | Ollama configuration |
| `/settings/keyboard` | KeyboardSettingsComponent | AuthGuard | Shortcut customization |
| `/settings/notifications` | NotificationSettingsComponent | AuthGuard | Notification prefs |
| `/settings/signatures` | SignatureSettingsComponent | AuthGuard | Signature management |
| `/settings/filters` | FilterSettingsComponent | AuthGuard | Filter rule management |
| `/settings/queue` | QueueSettingsComponent | AuthGuard | Mail operation queue management |

### Navigation Flow

1. **First Launch**: SetupGuard detects no accounts → redirects to `/auth`
2. **After Sign-In**: OAuth callback → account stored → redirect to `/mail`
3. **Normal Launch**: AuthGuard verifies stored credentials → loads `/mail` with last-used account/folder
4. **Account Switching**: Sidebar account switcher updates route to `/mail/:newAccountId/inbox`
5. **Folder Navigation**: Sidebar folder click updates route to `/mail/:accountId/:folderId`
6. **Email Selection**: Email list click updates route to include `/:threadId`, reading pane loads thread
7. **Settings**: Navigate to `/settings/*` from sidebar footer; back button returns to `/mail`
8. **Command Palette**: Overlay (not routed), can trigger navigation to any route

### Route Guards

- **AuthGuard**: Checks for at least one authenticated account with valid tokens. Redirects to `/auth` if none found.
- **SetupGuard**: Checks if accounts exist. If accounts exist, redirects away from `/auth` to `/mail`.

---

## Architecture & Structure

### Process Architecture

MailClient follows Electron's two-process model with a clear separation of concerns:

```
┌─────────────────────────────────────────────────────┐
│                  MAIN PROCESS (Node.js)              │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐│
│  │ IMAP Service  │  │ SMTP Service │  │ OAuth Svc  ││
│  │ (imapflow)    │  │ (nodemailer) │  │ (Google)   ││
│  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘│
│         │                  │                 │       │
│  ┌──────┴──────────────────┴─────────────────┴─────┐│
│  │              Sync Service                        ││
│  │  (orchestrates fetch, store, push operations)    ││
│  └──────────────────┬──────────────────────────────┘│
│                     │                                │
│  ┌──────────────────┴──────────────────────────────┐│
│  │           Database Service (SQLite)              ││
│  │  (better-sqlite3 + FTS5 full-text search)       ││
│  └─────────────────────────────────────────────────┘│
│                                                      │
│  ┌─────────────────┐  ┌───────────────────────────┐│
│  │ Ollama Service   │  │ Notification Service      ││
│  │ (HTTP to local)  │  │ (system tray, badges)     ││
│  └─────────────────┘  └───────────────────────────┘│
│                                                      │
│  ┌─────────────────────────────────────────────────┐│
│  │              IPC Handler Layer                    ││
│  │  (routes IPC calls to appropriate services)      ││
│  └──────────────────┬──────────────────────────────┘│
│                     │ contextBridge (preload.ts)     │
├─────────────────────┼───────────────────────────────┤
│                     │                                │
│  ┌──────────────────┴──────────────────────────────┐│
│  │           RENDERER PROCESS (Angular)             ││
│  │                                                   ││
│  │  ┌─────────────┐  ┌──────────────────────────┐  ││
│  │  │ Electron Svc │  │  NgRx SignalStores       │  ││
│  │  │ (IPC bridge) │→ │  (accounts, emails,      │  ││
│  │  └─────────────┘  │   folders, compose, ai,   │  ││
│  │                    │   search, settings, ui)   │  ││
│  │                    └──────────┬───────────────┘  ││
│  │                               │                   ││
│  │  ┌────────────────────────────┴────────────────┐ ││
│  │  │           Angular Components                 │ ││
│  │  │  (features/mail, compose, ai, settings...)  │ ││
│  │  └─────────────────────────────────────────────┘ ││
│  └──────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

### Main Process Services

#### ImapService
**Purpose**: Manages persistent IMAP connections to Gmail servers for each account

**Responsibilities**:
- Establish and maintain IMAP connections using OAuth2 tokens
- Fetch email headers, bodies, and attachments
- Listen for real-time mailbox updates (IDLE)
- Handle folder operations (list, create, rename, delete)
- Manage message flags (read, starred, deleted)
- Move/copy messages between folders

**Key Dependencies**: imapflow, OAuthService, DatabaseService

#### SmtpService
**Purpose**: Handles outgoing email delivery through Gmail's SMTP servers

**Responsibilities**:
- Send emails with HTML body, attachments, and inline images
- Support reply, reply-all, and forward operations
- Handle send-later/scheduled sending
- Manage draft saving to Gmail's drafts folder

**Key Dependencies**: nodemailer, OAuthService

#### OAuthService
**Purpose**: Manages Google OAuth2 authentication lifecycle for all accounts using system browser + loopback redirect flow

**Responsibilities**:
- Start a local HTTP server on a random available port for OAuth redirect
- Open the system default browser to Google's OAuth2 consent screen
- Receive the authorization code via the loopback redirect
- Exchange the authorization code for access and refresh tokens
- Refresh expired access tokens automatically (with exponential backoff on failure)
- Store tokens securely via CredentialService (Electron safeStorage)
- Revoke tokens on account removal
- Handle token refresh failures (prompt user to re-authenticate if refresh token is revoked)

**Key Dependencies**: CredentialService, oauth-loopback server, Google OAuth2 endpoints

> **Note**: Google forbids OAuth in embedded webviews for desktop apps. This app uses the "installed application" flow with a loopback IP redirect (`http://127.0.0.1:{port}/callback`). No client secret is embedded in the app binary — the app is registered as a "Desktop" type OAuth client in Google Cloud Console, which uses PKCE instead of a client secret.

#### DatabaseService
**Purpose**: Manages the local SQLite database for offline email storage and search

**Responsibilities**:
- Initialize database schema and run migrations
- CRUD operations for emails, threads, contacts, labels, and settings
- Full-text search via FTS5 virtual tables
- Manage per-account data isolation
- Handle database compaction and cleanup

**Key Dependencies**: better-sqlite3

#### SyncService
**Purpose**: Orchestrates synchronization between Gmail and local database

**Responsibilities**:
- Perform initial full sync on account setup (headers first, then bodies on demand)
- Incremental sync using IMAP CONDSTORE/QRESYNC extensions where available
- Background sync scheduling with configurable intervals (default: 5 minutes)
- Emit sync progress events to renderer (percentage, current folder, errors)
- Handle IMAP IDLE for real-time push notifications of new mail
- Manage concurrent account syncs (parallel, max 3 simultaneous connections)
- Handle Gmail rate limits with exponential backoff
- Handle UIDVALIDITY changes (trigger full resync of affected folder)

**Conflict Resolution Policy**: **Server wins** — Gmail is the authoritative source of truth. Local-only changes (flag toggles, moves) are pushed to Gmail immediately when online. If a conflict is detected during sync (e.g., email was modified both locally and remotely), the server state overwrites local state. Unsent drafts are preserved locally and never overwritten.

**Key Dependencies**: ImapService, DatabaseService

#### SearchService
**Purpose**: Provides fast full-text search across locally cached emails

**Responsibilities**:
- Index email content in SQLite FTS5 tables
- Support Gmail-style search operators (from:, to:, subject:, has:attachment, label:)
- Return ranked search results with snippet highlighting
- Maintain search index during sync operations

**Key Dependencies**: DatabaseService

#### OllamaService
**Purpose**: Interfaces with the local Ollama instance for all AI features

**Responsibilities**:
- Detect Ollama availability and connection status
- List available models from user's Ollama installation
- Send chat completion requests for summarization, composition, and categorization
- Stream AI responses for real-time display
- Cache AI results locally to avoid redundant processing
- Handle model loading/unloading for memory management

**Key Dependencies**: Ollama REST API (default: http://localhost:11434)

**Ollama API Integration Points**:
- `GET /api/tags` — List available models for settings UI
- `POST /api/chat` — Chat completions for all AI features (streaming and non-streaming)
- `POST /api/show` — Show model info for capability detection

#### NotificationService
**Purpose**: Manages desktop notifications and system tray integration

**Responsibilities**:
- Show native desktop notifications for new emails
- Manage system tray icon with unread badge count
- Handle notification click actions (open specific email)
- Respect user notification preferences

#### CredentialService
**Purpose**: Securely stores sensitive credentials using Electron's safeStorage API

**Responsibilities**:
- Encrypt OAuth tokens using Electron's safeStorage (DPAPI on Windows, Keychain on macOS)
- Store encrypted tokens in a local JSON file within the app's user data directory
- Retrieve and decrypt stored credentials on demand
- Handle safeStorage unavailability gracefully (fallback to plaintext with user warning)
- Clear credentials on account removal

**Key Dependencies**: Electron safeStorage API

**Data Storage Location**:
- **Windows**: `%APPDATA%/MailClient/credentials.enc`
- **macOS**: `~/Library/Application Support/MailClient/credentials.enc`

### Renderer Process Architecture

#### ElectronService
**Purpose**: Bridge between Angular components and Electron's main process via IPC

**Responsibilities**:
- Expose typed methods for all IPC operations
- Handle IPC response deserialization
- Manage connection state and error handling
- Provide Observable wrappers for IPC event streams

#### NgRx SignalStores

| Store | Purpose | Key State |
|-------|---------|-----------|
| **AccountsStore** | Multi-account management | Active account, account list, connection status |
| **EmailsStore** | Email list and thread data | Current email list, selected thread, loading state, pagination |
| **FoldersStore** | Folder/label hierarchy | Folder tree per account, unread counts, active folder |
| **ComposeStore** | Compose window state | Draft content, recipients, attachments, queueId, send status |
| **SearchStore** | Search operations | Query, results, filters, search history |
| **AiStore** | AI feature state | Ollama connection, active model, summaries cache, suggestions |
| **QueueStore** | Queue operation state | Pending/processing/completed/failed items, queue statistics |
| **SettingsStore** | Application preferences | Theme, density, layout, shortcuts, notification prefs |
| **UiStore** | Transient UI state | Sidebar collapsed, reading pane mode, command palette open, loading states |

#### ThemeService
**Purpose**: Manages application theming (dark/light/system) and dynamic color application

**Responsibilities**:
- Detect system theme preference and respond to changes
- Apply CSS custom properties for active theme
- Persist user theme preference
- Integrate with Angular Material's theming system

#### KeyboardService
**Purpose**: Global keyboard shortcut management and command palette

**Responsibilities**:
- Register and manage global keyboard shortcuts
- Dispatch shortcut actions to appropriate handlers
- Support customizable key bindings stored in settings
- Power the command palette with searchable action registry

#### LayoutService
**Purpose**: Manages reading pane layout mode and panel sizing

**Responsibilities**:
- Track current layout mode (three-column, bottom-preview, hidden)
- Persist panel sizes per layout mode
- Handle layout switching with appropriate transitions
- Manage sidebar collapse state

---

## Data & State Management

### SQLite Database Schema

#### Core Tables

**accounts**
- Stores Gmail account information (email, display name, avatar URL)
- References OAuth tokens stored in OS keychain (not in DB)
- Tracks sync state (last sync timestamp, sync cursor)

**emails**
- Stores individual email messages with full content
- Key fields: account reference, Gmail message ID, thread ID, folder, from/to/cc/bcc addresses, subject, text body, HTML body, date, flags (read, starred, important), snippet, size
- Indexed on: account + folder, account + thread ID, date, from address

**threads**
- Groups related emails into conversation threads
- Key fields: account reference, Gmail thread ID, subject, last message date, participant list, message count, snippet
- Indexed on: account + folder, last message date

**attachments**
- Stores attachment metadata and optionally cached file data
- Key fields: email reference, filename, MIME type, size, content ID (for inline), local file path (if cached)

**contacts**
- Auto-populated from email headers for autocomplete
- Key fields: email address, display name, avatar URL, frequency count, last contacted date
- Indexed on: email address, frequency (for ranked autocomplete)

**labels**
- Gmail labels/folders per account
- Key fields: account reference, Gmail label ID, name, type (system/user), color, unread count, total count

**filters**
- User-defined and AI-suggested email filter rules
- Key fields: account reference, name, conditions (JSON), actions (JSON), enabled flag, AI-generated flag

**settings**
- Key-value store for application preferences
- Key fields: key, value (JSON), scope (global or per-account)

**ai_cache**
- Cached AI operation results to avoid redundant processing
- Key fields: operation type, input hash, model used, result, created timestamp, expiry

**search_index** (FTS5 virtual table)
- Full-text search index over email subjects, bodies, and sender names
- Supports Gmail-style query operators

### Data Flow Patterns

**Email Sync Flow**:
1. SyncService triggers sync (on schedule or manual)
2. ImapService fetches new/changed messages from Gmail
3. DatabaseService stores messages in SQLite
4. SearchService updates FTS5 index
5. Main process sends IPC event to renderer
6. EmailsStore updates with new data
7. UI components react to store changes

**AI Operation Flow**:
1. User triggers AI action (summarize, compose, etc.)
2. AiStore dispatches request via ElectronService IPC
3. Main process OllamaService sends request to local Ollama
4. Streaming response forwarded via IPC events
5. AiStore updates with streamed tokens
6. Result cached in ai_cache table
7. UI component displays streaming result

**Compose & Send Flow**:
1. User opens compose (new, reply, or forward)
2. ComposeStore initializes with context (quoted text, recipients)
3. Auto-save enqueues draft-create or draft-update operations via MailQueueService every 5 seconds
4. Queue worker APPENDs draft to Gmail's Drafts folder via IMAP, fetches back server-confirmed data, and updates local DB
5. On send: ComposeStore enqueues send operation via MailQueueService
6. Queue worker sends via SmtpService and deletes draft from server
7. Sent message appears in Sent folder on next sync
8. ComposeStore clears draft state on successful send

### API Contracts

**Ollama Integration** (via OllamaService):
- **Connection check**: GET to Ollama base URL, expect version response
- **Model listing**: GET `/api/tags`, returns array of available models with metadata
- **Chat completion**: POST `/api/chat` with model name, system prompt, and message history; supports streaming
- **Model info**: POST `/api/show` with model name, returns capabilities and parameters

**Gmail OAuth2** (System Browser + Loopback Redirect):
- **Flow**: Installed application flow with PKCE — no client secret needed
- **Authorization**: Open system browser to Google's OAuth2 consent screen; redirect to `http://127.0.0.1:{randomPort}/callback`
- **Token exchange**: POST to Google's token endpoint with authorization code + PKCE code verifier
- **Token refresh**: POST to Google's token endpoint with refresh token; exponential backoff on failure
- **Token storage**: Encrypted via Electron safeStorage, stored in app user data directory
- **Scopes required**: `https://mail.google.com/`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/userinfo.profile`

> **Google API Compliance**: The app must be registered as a "Desktop" type OAuth client in Google Cloud Console. Gmail API must be enabled. For distribution beyond testing, Google's OAuth verification process is required (privacy policy, homepage, authorized domains).

**IPC Channel Contracts** (between main and renderer):

All **Renderer → Main** channels use `ipcRenderer.invoke` / `ipcMain.handle` (Promise-based request/response). All **Main → Renderer** channels use `webContents.send` / `ipcRenderer.on` (event push). All responses follow the envelope: `{ success: boolean, data?: T, error?: { code: string, message: string } }`. Default timeout: 30 seconds (120 seconds for sync operations).

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `mail:sync` | Main → Renderer | Sync progress events (streaming: folder name, percentage, new message count) |
| `mail:fetch-emails` | Renderer → Main | Request email list for folder |
| `mail:fetch-thread` | Renderer → Main | Request full thread content |
| `mail:send` | Renderer → Main | Send composed email |
| `mail:move` | Renderer → Main | Move email to folder |
| `mail:flag` | Renderer → Main | Toggle email flags (read, star, etc.) |
| `mail:search` | Renderer → Main | Execute search query |
| `auth:login` | Renderer → Main | Initiate OAuth flow |
| `auth:logout` | Renderer → Main | Remove account |
| `auth:refresh` | Main → Renderer | Token refresh status |
| `ai:summarize` | Renderer → Main | Summarize thread |
| `ai:compose` | Renderer → Main | AI compose assistance |
| `ai:categorize` | Renderer → Main | Categorize emails |
| `ai:search` | Renderer → Main | Natural language search |
| `ai:transform` | Renderer → Main | Text transformation |
| `ai:status` | Main → Renderer | Ollama connection status |
| `ai:stream` | Main → Renderer | Streaming AI response tokens |
| `db:get-settings` | Renderer → Main | Read settings |
| `db:set-settings` | Renderer → Main | Write settings |
| `queue:enqueue` | Renderer → Main | Enqueue a mail operation (draft-create, draft-update, send, move, flag, delete) |
| `queue:get-status` | Renderer → Main | Get current queue state (all items) |
| `queue:retry-failed` | Renderer → Main | Retry failed operations (specific queueId or all) |
| `queue:clear-completed` | Renderer → Main | Remove completed items from queue |
| `queue:cancel` | Renderer → Main | Cancel a pending operation |
| `queue:get-pending-count` | Renderer → Main | Get count of non-completed items |
| `queue:update` | Main → Renderer | Queue item status changed (streaming: queueId, type, status, description, error, result) |
| `system:notification` | Main → Renderer | New email notification |
| `system:tray-action` | Main → Renderer | System tray click actions |

---

## UI/UX Design System

### Design Principles

- **Clean & Minimal**: Flat design with subtle shadows, no glassmorphism
- **Information Hierarchy**: Clear visual weight for subjects > senders > snippets > metadata
- **Comfortable Density**: Default 56px email rows, with compact (44px) and spacious (72px) options
- **Consistent Spacing**: 4px base grid, 8px standard spacing unit
- **Accessible**: WCAG AA contrast ratios, keyboard navigable, screen reader compatible

### Color Palette

#### Light Theme

| Token | Hex | Usage |
|-------|-----|-------|
| **Primary** | `#1976D2` | Active states, links, compose button, selected items |
| **Primary Light** | `#E3F2FD` | Hover backgrounds, selected row background |
| **Secondary** | `#00897B` | Archive action, secondary CTAs |
| **Accent/Warning** | `#FF6F00` | Unread badges, important markers, star active |
| **Surface** | `#FFFFFF` | Cards, panels, reading pane background |
| **Surface Variant** | `#F5F5F5` | Sidebar background, alternating rows |
| **Background** | `#FAFAFA` | App chrome, page background |
| **Text Primary** | `#212121` | Headings, email subjects, body text |
| **Text Secondary** | `#666666` | Sender names, metadata, snippets |
| **Text Tertiary** | `#999999` | Timestamps, placeholders, disabled text |
| **Border** | `#E0E0E0` | Dividers, panel edges, input borders |
| **Error** | `#D32F2F` | Destructive actions, validation errors |
| **Success** | `#388E3C` | Send confirmation, positive states |

#### Dark Theme

| Token | Hex | Usage |
|-------|-----|-------|
| **Primary** | `#64B5F6` | Active states, links, compose button |
| **Primary Light** | `#1A237E` | Hover backgrounds, selected row |
| **Secondary** | `#4DB6AC` | Archive action, secondary CTAs |
| **Accent/Warning** | `#FFB74D` | Unread badges, important markers |
| **Surface** | `#121212` | Cards, panels, reading pane |
| **Surface Variant** | `#1E1E1E` | Sidebar, elevated surfaces |
| **Background** | `#0A0A0A` | App chrome, page background |
| **Text Primary** | `#FFFFFF` | Headings, subjects, body text |
| **Text Secondary** | `#B0B0B0` | Sender names, metadata |
| **Text Tertiary** | `#757575` | Timestamps, placeholders |
| **Border** | `#333333` | Dividers, panel edges |
| **Error** | `#FF6B6B` | Destructive actions |
| **Success** | `#81C784` | Positive states |

### Typography

**Font Stack**: `Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`

| Element | Size | Weight | Color Token |
|---------|------|--------|-------------|
| App/Section Headers | 20px | 600 | Text Primary |
| Folder Names | 14px | 400 (500 if unread) | Text Primary |
| Email Subject (unread) | 14px | 600 | Text Primary |
| Email Subject (read) | 14px | 400 | Text Primary |
| Sender Name | 14px | 500 | Text Primary |
| Email Snippet | 13px | 400 | Text Secondary |
| Timestamp | 12px | 400 | Text Tertiary |
| Reading Pane Subject | 20px | 600 | Text Primary |
| Reading Pane Body | 15px | 400 | Text Primary |
| Button Text | 14px | 500 | — |
| Badge/Count | 12px | 500 | White on Accent |

### Icon Set — Material Symbols (Outlined)

| Function | Icon Name | Filled Variant (Active) |
|----------|-----------|------------------------|
| Inbox | `inbox` | `inbox` (filled) |
| Sent | `send` | — |
| Drafts | `edit_note` | — |
| Trash | `delete` | — |
| Spam | `report` | — |
| Archive | `archive` | — |
| Compose | `edit` | — |
| Reply | `reply` | — |
| Reply All | `reply_all` | — |
| Forward | `forward` | — |
| Delete | `delete` | — |
| Star | `star_border` | `star` (filled) |
| Search | `search` | — |
| Settings | `settings` | — |
| Attachment | `attach_file` | — |
| AI/Sparkle | `auto_awesome` | `auto_awesome` (filled) |
| Snooze | `snooze` | — |
| Label/Tag | `label` | `label` (filled) |
| Filter | `filter_list` | — |
| Account | `account_circle` | — |
| More Actions | `more_vert` | — |
| Close | `close` | — |
| Minimize | `remove` | — |
| Maximize | `crop_square` | — |
| Sidebar Toggle | `menu` | — |
| Layout Switch | `view_sidebar` | — |
| Mark Read | `mark_email_read` | — |
| Mark Unread | `mark_email_unread` | — |

### Animations & Transitions

| Interaction | Duration | Easing | Type |
|------------|----------|--------|------|
| Email row hover | 120ms | ease | background-color |
| Email row selection | 150ms | ease | background-color |
| Panel layout switch | 250ms | cubic-bezier(0.4, 0, 0.2, 1) | fade + translate |
| Compose window open | 250ms | cubic-bezier(0.4, 0, 0.2, 1) | scale(0.98→1) + opacity |
| Compose window close | 200ms | cubic-bezier(0.4, 0, 1, 1) | scale + opacity |
| Sidebar collapse | 200ms | cubic-bezier(0.4, 0, 0.2, 1) | width |
| Command palette open | 150ms | ease-out | opacity + translateY |
| Star toggle | 200ms | ease | scale(1→1.2→1) + color |
| Toast notification | 300ms | ease-out | translateY + opacity |

> **Accessibility**: All animations respect `prefers-reduced-motion: reduce` — replaced with instant state changes.

---

## UI/UX Wireframes

### Main Email View — Three-Column Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [─] [□] [×]                    MailClient                          [🔍] [⚙] │ Custom Titlebar (32px)
├────────────┬─────────────────────────┬───────────────────────────────────────┤
│            │ [🔍 Search emails...]   │                                       │
│ [👤▾]      │ [☐ All] [↕ Sort▾] [≡]  │  ┌─ Message Toolbar ──────────────┐  │
│ user@gmail │─────────────────────────│  │ [← Back] [Archive] [Delete]    │  │
│            │                         │  │ [Spam]  ···  [Reply] [Fwd] [⋮] │  │
│ ┌────────┐ │ ┌─────────────────────┐ │  └────────────────────────────────┘  │
│ │📥 Inbox │ │ │ [☐][👤] John Smith  │ │                                       │
│ │   (12) │ │ │  Meeting Tomorrow    │ │  From: John Smith <john@example.com> │
│ ├────────┤ │ │  Hey, are we still...│ │  To: me                              │
│ │📝 Drafts│ │ │           2:30 PM ⭐│ │  Date: Feb 14, 2026 2:30 PM          │
│ │        │ │ ├─────────────────────┤ │                                       │
│ │✈ Sent  │ │ │ [☐][👤] Jane Doe    │ │  ─────────────────────────────────── │
│ │        │ │ │  Project Update  📎  │ │                                       │
│ │📦Archive│ │ │  Please review the..│ │  Hey,                                │
│ │        │ │ │           1:15 PM   │ │                                       │
│ │🚫 Spam │ │ ├─────────────────────┤ │  Are we still on for the meeting     │
│ │        │ │ │ [☐][👤] Newsletter   │ │  tomorrow at 3pm? I've prepared      │
│ │🗑 Trash │ │ │  Weekly Digest       │ │  the slides and wanted to go over    │
│ │        │ │ │  Your weekly summa...│ │  them with you beforehand.           │
│ ├────────┤ │ │          12:00 PM   │ │                                       │
│ │ Labels │ │ ├─────────────────────┤ │  Best,                               │
│ │ 🏷 Work │ │ │ [☐][👤] Alex Chen   │ │  John                                │
│ │ 🏷 Pers.│ │ │  Bug Fix PR #142    │ │                                       │
│ │        │ │ │  Fixed the login...  │ │  ─────────────────────────────────── │
│ │        │ │ │          11:30 AM   │ │                                       │
│ │        │ │ │         ...         │ │  [✨ AI Summarize] [💬 Smart Reply]   │
│ ├────────┤ │ │                     │ │                                       │
│ │[⚙]     │ │ │                     │ │  ┌─ Quick Reply ──────────────────┐  │
│ └────────┘ │ └─────────────────────┘ │  │ [Type your reply...]           │  │
│            │                         │  │                     [Send ➤]   │  │
│  240px     │        320px            │  └────────────────────────────────┘  │
│            │                         │              Flexible                 │
├────────────┴─────────────────────────┴───────────────────────────────────────┤
│ ✓ Synced · 3 accounts · Ollama: Connected (llama3.2)              [Ctrl+K] │ Status Bar (24px)
└──────────────────────────────────────────────────────────────────────────────┘
```

**Element Details**:
- **Custom Titlebar** (32px): Draggable area, window controls (minimize/maximize/close), app name centered, search and settings icons right-aligned
- **Sidebar** (240px, collapsible to 56px): Account switcher at top, folder navigation with unread counts, labels section, settings at bottom
- **Email List** (320px default, resizable): Search bar, list controls (select all, sort, density toggle), virtual-scrolled email rows
- **Reading Pane** (flexible, min 400px): Message toolbar, email metadata, sanitized HTML body, AI action buttons, quick reply input
- **Status Bar** (24px): Sync status, account count, Ollama connection status, command palette hint

### Main Email View — Bottom Preview Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [─] [□] [×]                    MailClient                          [🔍] [⚙] │
├────────────┬─────────────────────────────────────────────────────────────────┤
│            │ [🔍 Search emails...]    [☐ All] [↕ Sort▾] [≡ Density]         │
│ [👤▾]      ├─────────────────────────────────────────────────────────────────┤
│ user@gmail │ [☐][👤] John Smith    Meeting Tomorrow       2:30 PM  ⭐  📎   │
│            │ [☐][👤] Jane Doe      Project Update          1:15 PM      📎   │
│ 📥 Inbox   │ [☐][👤] Newsletter    Weekly Digest           12:00 PM          │
│    (12)    │ [☐][👤] Alex Chen     Bug Fix PR #142         11:30 AM          │
│ 📝 Drafts  │ [☐][👤] Sarah Kim     Design Review           10:00 AM          │
│ ✈ Sent     │                                                                 │
│ 📦 Archive ├─────────────────── Drag Handle ────────────────────────────────┤
│ 🚫 Spam    │                                                                 │
│ 🗑 Trash   │ From: John Smith <john@example.com>                             │
│            │ To: me · Date: Feb 14, 2026 2:30 PM                            │
│ Labels     │                                                                 │
│ 🏷 Work    │ Hey, are we still on for the meeting tomorrow at 3pm?          │
│ 🏷 Personal│ I've prepared the slides and wanted to go over them...         │
│            │                                                                 │
│ [⚙]       │ [✨ AI Summarize] [💬 Smart Reply]  [Reply] [Reply All] [Fwd]  │
│  240px     │                        Flexible                                 │
└────────────┴─────────────────────────────────────────────────────────────────┘
```

**Element Details**:
- Email list spans full width above the horizontal divider
- Email rows show sender, subject, date, and indicators in a single dense line
- Reading pane below the drag handle, height adjustable (default 45% of vertical space)
- Sidebar remains fixed at 240px

### Compose Window

```
┌──────────────────────────────────────────────────┐
│  New Message                        [─] [□] [×]  │ Header (40px)
├──────────────────────────────────────────────────┤
│                                                   │
│  From: [user@gmail.com              ▾]           │ Account selector
│                                                   │
│  To:   [recipient@example.com  ×] [          ]   │ Chip input + autocomplete
│                                                   │
│  Cc:   [                                     ]   │ (expandable)
│  Bcc:  [                                     ]   │ (expandable)
│                                                   │
│  Subject: [Meeting Follow-up                 ]   │
│                                                   │
├──────────────────────────────────────────────────┤
│  [B] [I] [U] [S] | [≡] [≡] [≡] | [🔗] [📷]    │ TipTap Toolbar
│  [H1] [H2] | [<>] [—] | [✨ AI Assist ▾]       │
├──────────────────────────────────────────────────┤
│                                                   │
│  Hi team,                                        │
│                                                   │
│  Following up on our meeting today...            │
│                                                   │
│  |                                               │ Cursor position
│                                                   │
│                                                   │
│                                                   │
│                                                   │
├──────────────────────────────────────────────────┤
│  📎 presentation.pdf (2.4 MB)  [×]              │ Attachment bar
├──────────────────────────────────────────────────┤
│  [📎 Attach] [✍ Signature ▾]     [Discard]      │
│                                   [Send  ➤]     │ Footer (48px)
└──────────────────────────────────────────────────┘
```

**Element Details**:
- **Header**: "New Message" title with window controls; draggable for repositioning
- **Recipient Fields**: Chip-based input with contact autocomplete (frequency-ranked)
- **TipTap Toolbar**: Bold, italic, underline, strikethrough, lists, links, images, code blocks, AI assist dropdown
- **AI Assist Dropdown**: Options for "Write for me", "Improve writing", "Make shorter", "Make formal", "Make casual"
- **Editor Area**: TipTap rich text editor with full formatting support
- **Attachment Bar**: Shows attached files with size and remove button; supports drag-and-drop
- **Footer**: Attach button, signature selector, discard button, primary send button

### Command Palette

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                   │
│         ┌─────────────────────────────────────────────┐          │
│         │ 🔍 Type a command or search...              │          │ Overlay backdrop
│         ├─────────────────────────────────────────────┤          │ (semi-transparent)
│         │                                             │          │
│         │  📝 Compose New Email              Ctrl+N  │          │
│         │  🔍 Search Emails                  Ctrl+F  │          │
│         │  📥 Go to Inbox                    G → I   │          │
│         │  ✈  Go to Sent                     G → S   │          │
│         │  📦 Archive Selected               E       │          │
│         │  🗑  Delete Selected                #       │          │
│         │  ⭐ Toggle Star                     S       │          │
│         │  ✨ AI Summarize Thread             Ctrl+J  │          │
│         │  🔄 Sync Now                       Ctrl+R  │          │
│         │  ⚙  Open Settings                  Ctrl+,  │          │
│         │                                             │          │
│         │  ─── Recent ────────────────────────────── │          │
│         │  📥 Go to Inbox                            │          │
│         │  ✨ AI Summarize Thread                     │          │
│         │                                             │          │
│         └─────────────────────────────────────────────┘          │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

**Element Details**:
- **Trigger**: `Ctrl+K` (Windows) / `Cmd+K` (macOS)
- **Search Input**: Auto-focused, filters commands as user types
- **Command List**: Scrollable, keyboard navigable (arrow keys), shows icon + label + shortcut
- **Recent Section**: Shows recently used commands
- **Backdrop**: Semi-transparent overlay, click to dismiss, Escape to close
- Component: Angular CDK Overlay with custom styling

### AI Assistant Panel

```
┌──────────────────────────────────────────┐
│  ✨ AI Assistant          [Model ▾] [×]  │ Panel Header
├──────────────────────────────────────────┤
│                                          │
│  ┌─ Thread Summary ───────────────────┐ │
│  │                                     │ │
│  │  This thread discusses the Q1       │ │
│  │  product roadmap. Key points:       │ │
│  │                                     │ │
│  │  • Launch date moved to March 15    │ │
│  │  • Budget approved for 3 new hires  │ │
│  │  • Design review scheduled Friday   │ │
│  │                                     │ │
│  │  3 participants · 8 messages        │ │
│  └─────────────────────────────────────┘ │
│                                          │
│  ┌─ Suggested Replies ────────────────┐ │
│  │                                     │ │
│  │  [Thanks, I'll review the...]      │ │
│  │  [Sounds good! Let me know if...]  │ │
│  │  [I have a few concerns about...]  │ │
│  │                                     │ │
│  └─────────────────────────────────────┘ │
│                                          │
│  ┌─ Actions ──────────────────────────┐ │
│  │                                     │ │
│  │  [📝 Draft Reply]  [🏷 Categorize] │ │
│  │  [🔍 Find Similar] [📋 Extract]    │ │
│  │                                     │ │
│  └─────────────────────────────────────┘ │
│                                          │
│  ┌─ Ask AI ───────────────────────────┐ │
│  │ [Ask anything about this thread...]│ │
│  │                              [Ask] │ │
│  └─────────────────────────────────────┘ │
│                                          │
└──────────────────────────────────────────┘
```

**Element Details**:
- **Panel Position**: Slides in from the right side of the reading pane, 320px wide
- **Model Selector**: Dropdown showing available Ollama models
- **Thread Summary**: Auto-generated when panel opens, shows key points and metadata
- **Suggested Replies**: AI-generated reply options, click to insert into compose
- **Actions**: Quick action buttons for common AI operations
- **Ask AI**: Free-form input for asking questions about the current thread

### Settings Page

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [← Back to Mail]                  Settings                                   │
├──────────────┬───────────────────────────────────────────────────────────────┤
│              │                                                               │
│  ⚙ General  │  General Settings                                            │
│              │  ─────────────────────────────────────────────────────────── │
│  👤 Accounts │                                                               │
│              │  Theme                                                        │
│  ✨ AI       │  ○ Light   ○ Dark   ○ System                                │
│              │                                                               │
│  ⌨ Keyboard │  Layout                                                       │
│              │  ○ Three-column   ○ Bottom preview   ○ List only             │
│  🔔 Notifs  │                                                               │
│              │  Density                                                      │
│  ✍ Signatures│  ○ Compact (44px)  ● Comfortable (56px)  ○ Spacious (72px) │
│              │                                                               │
│  🔀 Filters │  Sidebar                                                      │
│              │                                                               │
│  📋 Queue   │  [Toggle] Show unread counts                                  │
│              │  [Toggle] Show unread counts                                  │
│              │  [Toggle] Collapse sidebar on startup                         │
│              │                                                               │
│              │  Sync                                                         │
│              │  Sync interval: [Every 5 minutes ▾]                          │
│              │  [Toggle] Sync on startup                                     │
│              │  [Toggle] Desktop notifications for new mail                  │
│              │                                                               │
│              │  Privacy                                                      │
│              │  [Toggle] Block remote images by default                      │
│              │  [Toggle] Show sender avatars (Gravatar)                      │
│              │                                                               │
└──────────────┴───────────────────────────────────────────────────────────────┘
```

**Element Details**:
- **Left Navigation**: mat-nav-list with setting categories, active item highlighted
- **Content Area**: Scrollable settings form with grouped sections
- **Controls**: mat-radio-group for exclusive choices, mat-slide-toggle for on/off, mat-select for dropdowns
- **Back Button**: Returns to mail view

### Auth / Welcome Page

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│                                                                              │
│                                                                              │
│                          ┌────────────────────────┐                         │
│                          │                        │                         │
│                          │     📧 MailClient      │                         │
│                          │                        │                         │
│                          │  Your email, your way. │                         │
│                          │  AI-powered. Private.  │                         │
│                          │                        │                         │
│                          │  ┌──────────────────┐  │                         │
│                          │  │                  │  │                         │
│                          │  │  [G] Sign in     │  │                         │
│                          │  │  with Google     │  │                         │
│                          │  │                  │  │                         │
│                          │  └──────────────────┘  │                         │
│                          │                        │                         │
│                          │  By signing in, you    │                         │
│                          │  agree to our Terms    │                         │
│                          │  of Service.           │                         │
│                          │                        │                         │
│                          └────────────────────────┘                         │
│                                                                              │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Element Details**:
- **Centered Card**: max-width 400px, elevation shadow, rounded corners
- **App Logo/Name**: Centered at top of card
- **Tagline**: Brief description of the app
- **Sign-in Button**: Google-branded button (mat-raised-button), full card width
- **Legal Text**: Small text below button

---

## AI Features — Ollama Integration

### Feature Matrix

| Feature | Trigger | Ollama Endpoint | System Prompt Strategy |
|---------|---------|----------------|----------------------|
| **Thread Summarize** | AI panel button, keyboard shortcut | `POST /api/chat` | Summarize email thread, extract key points, action items |
| **Smart Reply** | AI panel, reading pane button | `POST /api/chat` | Generate 3 contextual reply suggestions based on thread |
| **AI Compose** | Compose toolbar "AI Assist" | `POST /api/chat` (streaming) | Generate email draft from user prompt and context |
| **Text Transform** | Compose toolbar submenu | `POST /api/chat` | Transform selected text: improve, shorten, formalize, casualize |
| **Auto-Categorize** | Background on sync, manual trigger | `POST /api/chat` (structured output) | Classify email into categories: Primary, Updates, Promotions, Social, Newsletters |
| **Smart Filter** | AI filter builder in settings | `POST /api/chat` (structured output) | Generate filter rules from natural language description |
| **Natural Language Search** | AI search in search bar | `POST /api/chat` | Convert natural language query to structured search parameters |
| **Follow-up Reminder** | Background check on sent emails | `POST /api/chat` | Detect sent emails that likely expect a reply but haven't received one |

### AI System Prompt Design

Each AI feature uses a tailored system prompt that:
- Defines the AI's role (email assistant)
- Provides context (thread content, user preferences)
- Specifies output format (structured JSON for categorization/filters, plain text for summaries)
- Sets constraints (conciseness, tone matching, privacy awareness)

### AI Response Caching

- Results cached in `ai_cache` SQLite table keyed by operation type + content hash + model
- Cache expiry: Summaries persist until thread changes; categorizations persist indefinitely; compose suggestions not cached
- Cache invalidation: When thread receives new messages, summary cache is cleared

### Ollama Connection Management

- **Health Check**: Periodic ping to `http://localhost:11434` (configurable URL)
- **Status Display**: Connection indicator in status bar and AI settings
- **Model Selection**: User picks from available models listed via `/api/tags`
- **Graceful Degradation**: All AI features show "Ollama not connected" state and remain non-blocking; app fully functional without AI

---

## Keyboard Shortcuts

### Default Shortcut Map

| Action | Windows | macOS | Context |
|--------|---------|-------|---------|
| **Command Palette** | `Ctrl+K` | `Cmd+K` | Global |
| **Compose New** | `Ctrl+N` | `Cmd+N` | Global |
| **Search** | `Ctrl+F` or `/` | `Cmd+F` or `/` | Global |
| **Sync Now** | `Ctrl+R` | `Cmd+R` | Global |
| **Settings** | `Ctrl+,` | `Cmd+,` | Global |
| **Reply** | `R` | `R` | Email selected |
| **Reply All** | `Shift+R` | `Shift+R` | Email selected |
| **Forward** | `F` | `F` | Email selected |
| **Archive** | `E` | `E` | Email selected |
| **Delete** | `#` | `#` | Email selected |
| **Star/Unstar** | `S` | `S` | Email selected |
| **Mark Read/Unread** | `Shift+I` / `Shift+U` | `Shift+I` / `Shift+U` | Email selected |
| **Move Up** | `K` or `↑` | `K` or `↑` | Email list |
| **Move Down** | `J` or `↓` | `J` or `↓` | Email list |
| **Open Thread** | `Enter` or `O` | `Enter` or `O` | Email list |
| **Go to Inbox** | `G` then `I` | `G` then `I` | Global |
| **Go to Sent** | `G` then `S` | `G` then `S` | Global |
| **Go to Drafts** | `G` then `D` | `G` then `D` | Global |
| **AI Summarize** | `Ctrl+J` | `Cmd+J` | Email selected |
| **Toggle Sidebar** | `Ctrl+B` | `Cmd+B` | Global |
| **Toggle Reading Pane** | `Ctrl+.` | `Cmd+.` | Global |
| **Select All** | `Ctrl+A` | `Cmd+A` | Email list |
| **Escape** | `Esc` | `Esc` | Close overlay/deselect |

### Shortcut Customization

- All shortcuts are customizable via Settings > Keyboard
- Stored in settings database as key-value pairs
- Conflict detection warns when a shortcut is already assigned
- Reset to defaults option available

---

## Electron Configuration

### Main Process Setup

**Purpose of main.ts**: Application lifecycle management, window creation, IPC handler registration, system tray setup, auto-updater initialization

**Window Configuration**:
- Custom frameless window with custom titlebar (Windows) / native titlebar (macOS)
- Default size: 1280×800, minimum size: 900×600
- Remember window position and size across sessions
- Single instance enforcement (prevent multiple app windows)

**System Tray**:
- Tray icon with unread badge count
- Context menu: Show/Hide, Compose, Sync, Quit
- Click action: Show/focus main window

### Preload Script (Context Bridge)

**Purpose**: Securely expose main process APIs to the renderer via `contextBridge.exposeInMainWorld`

**Exposed API Surface**:
- `window.electronAPI.mail.*` — Email operations (fetch, send, move, flag, search)
- `window.electronAPI.auth.*` — Authentication (login, logout, refresh)
- `window.electronAPI.ai.*` — AI operations (summarize, compose, categorize, transform, search)
- `window.electronAPI.db.*` — Settings and data operations
- `window.electronAPI.system.*` — Window controls, notifications, clipboard
- `window.electronAPI.on(channel, callback)` — Event listener registration for push events

### Electron Forge Configuration

**Build Targets**:
- **Windows**: Squirrel.Windows installer (.exe) + portable
- **macOS**: DMG installer + .app bundle

**Forge Plugins**:
- `@electron-forge/plugin-vite` — Vite integration for Angular build
- `@electron-forge/plugin-auto-unpack-natives` — Native module handling (better-sqlite3)

### Security Configuration

- `nodeIntegration: false` — No direct Node.js access in renderer
- `contextIsolation: true` — Renderer runs in isolated context
- `sandbox: true` — Renderer process sandboxed
- Content Security Policy restricting inline scripts and external resources
- Email HTML rendered in sandboxed iframe with restricted permissions

### Native Module Build Notes

- **better-sqlite3** requires native compilation per Electron version and platform
- Must be rebuilt using `electron-rebuild` or `@electron/rebuild` during packaging
- Ensure the SQLite build includes FTS5 extension (verify at runtime on first launch)
- CI/CD must run native rebuilds for each target platform (Windows x64, macOS x64, macOS arm64)

### Styling Integration (Angular Material + Tailwind)

- **Angular Material**: Used for interactive components (buttons, inputs, dialogs, lists, menus, toolbars, overlays, toggles, tabs)
- **Tailwind CSS**: Used for layout utilities (flexbox, grid, spacing, sizing, positioning) and custom styling beyond Material components
- **Theme Integration**: CSS custom properties (design tokens) defined in `styles.scss` are consumed by both Angular Material's custom theme and Tailwind's `theme.extend` configuration
- **Specificity**: Tailwind utilities applied via class names; Angular Material styles via theme configuration — avoid `!important` overrides

### NgRx SignalStore Patterns

- Each store is a standalone `signalStore()` instance using `@ngrx/signals`
- Side effects (IPC calls, async operations) handled via `rxMethod` within stores
- Stores expose computed signals for derived state (e.g., unread count from email list)
- ElectronService returns Promises for request/response IPC and Observables for streaming IPC events
- Stores are provided at the root level and injected into components via Angular DI
- No traditional NgRx actions/reducers/effects — pure signal-based approach

---

## OAuth2 Authentication Flow

### Flow Diagram

1. User clicks "Sign in with Google" on auth landing page
2. Renderer sends `auth:login` IPC to main process
3. Main process OAuthService generates PKCE code verifier + challenge
4. Main process starts a local HTTP server on `http://127.0.0.1:{randomPort}`
5. Main process opens system default browser to Google's OAuth2 consent URL with PKCE challenge
6. User authenticates in their browser and grants permissions
7. Google redirects to `http://127.0.0.1:{port}/callback?code=...`
8. Local server receives the authorization code, shuts down
9. OAuthService exchanges code + PKCE verifier for access token + refresh token
10. Tokens encrypted via Electron safeStorage and stored locally
11. OAuthService fetches user profile (email, name, avatar) using the access token
12. Account record created in SQLite database
13. Main process sends success event to renderer via IPC
14. Renderer navigates to `/mail/:newAccountId/inbox`

### Token Refresh Strategy

- Access tokens are short-lived (~1 hour); refresh automatically before expiry
- If refresh fails with a retryable error: exponential backoff (1s, 2s, 4s, max 60s)
- If refresh fails with `invalid_grant` (token revoked): mark account as "needs re-authentication", show banner in UI, prompt user to sign in again
- Token refresh happens in the main process; renderer is notified of status via `auth:refresh` IPC events

### Account Removal Flow

1. User removes account in Settings > Accounts
2. Confirmation dialog shown
3. OAuth tokens revoked via Google's revoke endpoint
4. All emails, threads, contacts, and labels for that account deleted from SQLite
5. Encrypted credentials for that account removed from credential store
6. If last account removed, redirect to `/auth`

---

## Error Handling & Logging

### Error Handling Strategy

**Main Process Errors**:
- IMAP connection failures: Retry with exponential backoff (max 5 retries), then mark account as "connection error" and notify renderer
- SMTP send failures: Return error to renderer with user-friendly message; save draft locally for retry
- OAuth token errors: Attempt refresh; if refresh fails, prompt re-authentication
- Database errors: Log error, attempt recovery; if corruption detected, offer to rebuild from Gmail
- Ollama errors: Non-blocking; mark AI as unavailable, all AI features show disabled state

**Renderer Process Errors**:
- IPC timeout (default 30 seconds for most operations, 120 seconds for sync): Show timeout error toast, offer retry
- Network errors: Show offline banner, disable send operations, continue with cached data
- Component errors: Angular ErrorHandler catches and logs; show user-friendly error state in affected component

**IPC Error Protocol**:
- All IPC responses follow a consistent envelope: `{ success: boolean, data?: T, error?: { code: string, message: string } }`
- Error codes are namespaced: `IMAP_CONNECTION_FAILED`, `SMTP_SEND_FAILED`, `OAUTH_TOKEN_EXPIRED`, `AI_OLLAMA_UNAVAILABLE`, etc.

### Logging Strategy

- **Log Library**: electron-log (writes to file + console)
- **Log Levels**: `debug`, `info`, `warn`, `error` (configurable via `LOG_LEVEL` env var)
- **Log Location**:
  - **Windows**: `%APPDATA%/MailClient/logs/`
  - **macOS**: `~/Library/Logs/MailClient/`
- **Log Rotation**: Max 5 files, 10MB each
- **Privacy**: No email content logged; only metadata (message IDs, folder names, error codes)
- **No Remote Telemetry**: All logs stay local; no crash reporting to external servers

---

## Sync & Conflict Resolution

### Sync Strategy

**Initial Sync** (on account setup):
1. Fetch folder list from Gmail IMAP
2. Sync inbox headers (last 30 days by default, configurable)
3. Sync other folders in background
4. Email bodies fetched on demand (when user opens a thread) and cached locally
5. Full-text search index built incrementally as bodies are fetched

**Incremental Sync** (ongoing):
1. Use IMAP CONDSTORE/QRESYNC to detect changes since last sync
2. Fetch new messages, update changed flags, remove deleted messages
3. Update FTS5 search index for new/changed content
4. Emit progress events to renderer

**Real-time Updates**:
- IMAP IDLE connection maintained for the active account's inbox
- When IDLE notifies of new mail, trigger incremental sync for that folder
- Gmail limits: max 15 concurrent IMAP connections per account; app uses max 3

### Conflict Resolution

**Policy: Server Wins**

| Scenario | Resolution |
|----------|-----------|
| Email flagged read locally, unread on server | Server state (unread) applied |
| Email moved to folder locally, different folder on server | Server folder applied |
| Email deleted locally, still exists on server | Email restored from server |
| Email deleted on server, still cached locally | Local cache entry removed |
| Draft edited locally, different version on server | Local draft preserved (drafts are exception to server-wins) |
| UIDVALIDITY changed on server | Full resync of affected folder triggered |

### Offline Behavior

All mail operations (draft save, send, move, flag, delete) are queued via MailQueueService. When offline, operations remain in the queue and retry automatically with exponential backoff when connectivity returns.

- **Reading**: Fully functional with cached emails
- **Composing**: Drafts enqueued for save to server; queue processes them when online
- **Send Queue**: When network returns, queued sends are attempted automatically with retry logic (operations persist in memory across short disconnections; graceful shutdown warning prevents data loss on app close)
- **Sync**: Paused while offline; resumes automatically when network detected
- **UI Indicator**: Offline banner shown at top of email list when network unavailable

---

## Security & Privacy

### Email Rendering Security

- **HTML Sanitization**: DOMPurify with strict configuration — allow only safe HTML tags (p, div, span, a, img, table, br, hr, ul, ol, li, b, i, u, strong, em, h1-h6, blockquote, pre, code); strip all scripts, event handlers, and dangerous attributes
- **Sandboxed Iframe**: Email body rendered in `<iframe sandbox="allow-same-origin">` — no scripts, no forms, no popups
- **Remote Images**: Blocked by default; user can allow per-sender (stored in settings DB); tracking pixel detection via 1x1 image heuristic
- **Link Handling**: All links in email body open in system default browser (not in Electron); phishing warning for suspicious URLs (mismatched display text vs. href)
- **Content Security Policy**: Strict CSP on the main renderer window restricting script sources, disabling eval, and blocking external resource loading

### Data Privacy

- **No External Servers**: App communicates only with Gmail (IMAP/SMTP/OAuth) and local Ollama
- **No Telemetry**: No analytics, crash reporting, or usage tracking sent externally
- **Local Storage Only**: All email data, AI cache, and settings stored locally on user's machine
- **Credential Security**: OAuth tokens encrypted via Electron safeStorage (OS-level encryption)
- **Database**: SQLite database is not encrypted at rest (tokens are stored separately via safeStorage, not in the DB)
- **Account Removal**: Full data deletion when account is removed (emails, contacts, labels, credentials)

### Process Isolation

- **Main Process**: Owns all native modules (SQLite, IMAP, SMTP, file system); never exposes raw Node.js APIs to renderer
- **Renderer Process**: Sandboxed, no Node.js access; communicates exclusively via typed IPC through contextBridge
- **Preload Script**: Minimal surface area; only exposes the `window.electronAPI` object with typed methods

---

## Testing Strategy

### Testing Stack

| Layer | Tool | Purpose |
|-------|------|---------|
| **Unit Tests** | Vitest | Services, stores, pipes, utilities |
| **Component Tests** | Vitest + Angular Testing Library | Angular component rendering and interaction |
| **Integration Tests** | Vitest | IPC communication (mocked Electron), database operations |
| **E2E Tests** | Playwright | Full application flows in packaged Electron app |

### Test Coverage Targets

- **Services & Stores**: 80%+ line coverage
- **Shared Components**: 70%+ line coverage
- **Feature Components**: 60%+ line coverage (focus on critical paths)
- **E2E**: Cover all critical user flows (sign-in, read email, compose, send, search, AI summarize)

### Testing Approach

**Main Process Services**:
- Test in isolation with mocked dependencies (mock IMAP server, mock SQLite in-memory DB)
- Database tests use in-memory SQLite with the same schema
- IPC handler tests verify correct routing and error handling

**Renderer Components**:
- Use Angular Testing Library for component tests (user-centric testing)
- Mock ElectronService IPC calls with typed stubs
- Test store interactions with injected mock stores

**E2E Tests**:
- Playwright configured to launch the packaged Electron app
- Test critical flows: OAuth sign-in (mocked), inbox loading, email reading, compose and send, search, AI panel
- Run on CI for both Windows and macOS

---

## Implementation Steps

### Phase 1 — Project Scaffolding & Core Infrastructure

1. Initialize Angular 21 project with standalone components and Vite build
2. Set up Electron 40 with Electron Forge and configure the plugin-vite integration
3. Create `.env.example` with all required environment variables
4. Set up Tailwind CSS and Angular Material theming with shared design tokens
5. Create custom titlebar component (frameless on Windows, native on macOS)
6. Implement Electron main process entry with window management and single-instance lock
7. Set up preload script with typed contextBridge API
8. Create IPC channel infrastructure, channel constants, and ElectronService in renderer
9. Set up SQLite database with schema, FTS5 virtual table, and migration runner
10. Implement CredentialService using Electron safeStorage API
11. Set up electron-log for structured logging
12. Create developer README with setup instructions

### Phase 2 — Authentication & Account Management

1. Implement OAuthService with loopback server + PKCE flow
2. Build auth landing page with Google sign-in button
3. Implement OAuth loopback HTTP server for receiving redirect
4. Implement route guards (AuthGuard, SetupGuard)
5. Build AccountsStore with multi-account state management
6. Create account switcher component in sidebar
7. Implement account settings page (add/remove accounts with confirmation and data cleanup)

### Phase 3 — Email Core (IMAP/SMTP)

1. Implement ImapService with imapflow for Gmail IMAP
2. Implement SmtpService with nodemailer for sending
3. Implement MailQueueService with fastq for sequential mail operations and FolderLockManager for sync coordination
4. Build SyncService for initial and incremental sync
5. Implement DatabaseService CRUD operations for emails/threads
6. Build SearchService with FTS5 full-text search
7. Create EmailsStore and FoldersStore
8. Implement email list with virtual scrolling
9. Build reading pane with HTML sanitization and sandboxed rendering
10. Implement thread view with collapsible messages

### Phase 4 — UI Shell & Layout

1. Build mail shell component with three-panel layout
2. Implement sidebar with folder navigation and unread counts
3. Create resizable panel directive with drag handles
4. Implement switchable layouts (three-column, bottom preview, hidden)
5. Build email list header with sort/filter/density controls
6. Implement message toolbar with all email actions
7. Create status bar component
8. Implement dark/light/system theme switching
9. Build SettingsStore and UiStore

### Phase 5 — Compose & Rich Text

1. Integrate TipTap editor with Angular
2. Build compose window component (dialog and detached window modes)
3. Implement recipient input with chip-based autocomplete
4. Build formatting toolbar with TipTap commands
5. Implement attachment upload with drag-and-drop
6. Build signature management (create, edit, select)
7. Implement draft auto-save via mail operation queue (no local drafts table; server-first approach)
8. Build ComposeStore with queue-based operation tracking (queueId instead of draftId)

### Phase 6 — AI Integration (Ollama)

1. Implement OllamaService with connection management and health checks
2. Build AI settings page (URL config, model selection)
3. Create AiStore for AI state management
4. Implement thread summarization with streaming display
5. Build smart reply suggestions
6. Implement AI compose assistant in compose toolbar
7. Build text transform features (improve, shorten, formalize, casualize)
8. Implement auto-categorization (Primary, Updates, Promotions, Social, Newsletters)
9. Build AI-assisted filter creation
10. Implement natural language search
11. Build follow-up reminder detection
12. Implement AI response caching

### Phase 7 — Keyboard & Command Palette

1. Implement KeyboardService with global shortcut registration
2. Build command palette overlay component
3. Register all actions in command registry
4. Implement vim-style navigation (J/K, G+I, etc.)
5. Build keyboard settings page with customization
6. Implement shortcut conflict detection

### Phase 8 — Polish & Platform Integration

1. Implement system tray with unread badge
2. Build desktop notification system
3. Implement single-instance enforcement
4. Add window position/size persistence
5. Build splash screen for initial load
6. Implement remote image blocking with per-sender allowlist
7. Add email HTML sanitization (DOMPurify)
8. Implement snooze functionality
9. Build filter rule management UI
10. Add notification sound support

### Phase 9 — Testing & Packaging

1. Write unit tests for all main process services (Vitest, mocked dependencies)
2. Write unit tests for all NgRx SignalStores (Vitest)
3. Write component tests for key UI components (Angular Testing Library)
4. Write integration tests for IPC communication (mocked Electron)
5. Write E2E tests for critical user flows (Playwright)
6. Configure Electron Forge build for Windows x64 (.exe via Squirrel)
7. Configure Electron Forge build for macOS x64 + arm64 (.dmg)
8. Set up native module rebuilds (better-sqlite3) for each target platform
9. Test on both platforms (Windows 10+, macOS 12+)
10. Performance optimization (lazy loading, virtual scrolling, memory management)
11. Code signing setup (Windows Authenticode, macOS notarization) — for distribution

---

## Acceptance Criteria

### Core Functionality
- [ ] User can sign in with Gmail via OAuth2 and see their inbox
- [ ] User can add multiple Gmail accounts and switch between them
- [ ] Emails are synced and cached locally in SQLite for offline reading
- [ ] Full-text search works across all cached emails with Gmail-style operators
- [ ] User can compose, reply, reply-all, and forward emails with rich text formatting
- [ ] User can archive, delete, star, and move emails between folders
- [ ] Email threads display as collapsible conversations
- [ ] Attachments can be viewed, downloaded, and attached to outgoing emails

### AI Features
- [ ] Ollama connection status is visible and configurable in settings
- [ ] User can select from available Ollama models
- [ ] Thread summarization produces concise, accurate summaries
- [ ] Smart reply generates 3 contextual reply suggestions
- [ ] AI compose assistant generates email drafts from prompts
- [ ] Text transform (improve/shorten/formalize/casualize) works on selected text
- [ ] Auto-categorization classifies emails into correct categories
- [ ] Natural language search converts queries to structured search
- [ ] AI features degrade gracefully when Ollama is unavailable

### UI/UX
- [ ] Three-column, bottom-preview, and list-only layouts all function correctly
- [ ] Panels are resizable with drag handles and sizes persist
- [ ] Dark and light themes apply correctly with proper contrast ratios
- [ ] Sidebar collapses to icon-only mode
- [ ] Email list supports comfortable, compact, and spacious density modes
- [ ] All animations respect `prefers-reduced-motion`
- [ ] Command palette opens with Ctrl+K and supports fuzzy search of commands

### Keyboard
- [ ] All default shortcuts work as specified
- [ ] Shortcuts are customizable in settings
- [ ] Vim-style navigation (J/K) works in email list
- [ ] Command palette is fully keyboard navigable

### Platform
- [ ] App builds and runs on Windows 10+ as .exe installer
- [ ] App builds and runs on macOS 12+ as .dmg
- [ ] System tray shows unread badge count
- [ ] Desktop notifications appear for new emails
- [ ] Single instance enforcement prevents duplicate windows
- [ ] Window position and size persist across sessions

### Security & Privacy
- [ ] OAuth tokens encrypted via Electron safeStorage (not stored in plaintext)
- [ ] Email HTML is sanitized via DOMPurify before rendering
- [ ] Email body renders in sandboxed iframe (no script execution)
- [ ] Remote images blocked by default with per-sender allowlist
- [ ] Links in emails open in system browser, not in Electron
- [ ] No data sent to external servers (except Gmail and local Ollama)

### Error Handling & Offline
- [ ] Network loss shows offline banner; cached emails remain readable
- [ ] Queued sends are delivered automatically when network returns
- [ ] IMAP connection failures retry with backoff and show user-friendly error
- [ ] Token refresh failures prompt user to re-authenticate
- [ ] Ollama unavailability disables AI buttons with explanatory tooltip

### Mail Operation Queue
- [ ] All draft operations (create, update) go through the queue and are processed sequentially
- [ ] Send, move, flag, and delete operations go through the queue
- [ ] Each operation gets a unique queue ID returned immediately to the caller
- [ ] Draft save creates exactly one entry on the server (no duplicates)
- [ ] Local DB is only updated after server confirms the operation (server-first guarantee)
- [ ] Failed operations retry automatically with exponential backoff (max 10 attempts)
- [ ] Queue settings page shows all operations with correct status and allows retry/clear actions
- [ ] Graceful shutdown warns user if pending operations exist when closing the app
- [ ] Operations are processed in FIFO order per account
- [ ] Queue state updates are reflected in real-time via IPC events

---

## Notes and Considerations

### Performance Considerations
- **Virtual Scrolling**: Email list must use CDK virtual scroll for large mailboxes (10,000+ emails)
- **Lazy Loading**: Settings, AI, and compose modules should be lazy-loaded
- **Database Indexing**: Proper indexes on frequently queried columns (account+folder, date, thread ID)
- **Sync Throttling**: Rate-limit IMAP operations to avoid Gmail throttling
- **AI Streaming**: Stream Ollama responses token-by-token to provide immediate feedback
- **Memory Management**: Unload email bodies from memory when scrolled out of view

### Known Limitations
- **Gmail Only**: Initial version supports only Gmail; architecture should allow future IMAP provider additions
- **No Calendar**: Calendar integration deferred to future version
- **Queue State In-Memory Only**: Queue state is in-memory only. If the app is force-killed (not gracefully closed), pending operations are lost. Graceful shutdown shows a warning dialog when operations are pending. This tradeoff keeps the architecture simple while preventing accidental data loss through user confirmation.
- **Offline Send Queue**: Composing works offline (drafts enqueued for save); sends are queued and delivered automatically when network returns
- **Ollama Required for AI**: No cloud AI fallback; AI features require local Ollama installation. All AI buttons show disabled state with tooltip explaining how to install Ollama when it's not detected
- **Google API Verification**: Distribution beyond testing requires Google's OAuth verification process (privacy policy, app homepage required)
- **Initial Sync Time**: First sync of a large mailbox may take several minutes; progress indicator shown

### Future Enhancements
- Additional email providers (Outlook, Yahoo, generic IMAP)
- Google Calendar integration
- Email templates with variable substitution
- Undo send with configurable delay
- Schedule send for future delivery
- Email encryption (PGP/GPG)
- Plugin/extension system
- Contact management with detailed profiles
- Email analytics (response time, volume trends)

### Dependencies (Key npm Packages)

| Package | Purpose |
|---------|---------|
| `electron` (40+) | Desktop shell |
| `@angular/core` (21+) | Frontend framework |
| `@angular/material` | UI component library |
| `@angular/cdk` | Component Dev Kit (virtual scroll, overlay, drag-drop) |
| `@ngrx/signals` | Signal-based state management |
| `tailwindcss` | Utility-first CSS |
| `imapflow` | IMAP client library |
| `nodemailer` | SMTP email sending |
| `better-sqlite3` | SQLite database driver (with FTS5) |
| `@tiptap/core` + extensions | Rich text editor |
| `dompurify` | HTML sanitization |
| `electron-log` | Structured logging for main + renderer |
| `@electron-forge/cli` | Build and packaging |
| `@electron/rebuild` | Native module rebuilds for Electron |
| `vitest` | Unit testing |
| `@testing-library/angular` | Component testing |
| `playwright` | E2E testing |
