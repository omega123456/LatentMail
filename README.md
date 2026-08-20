# LatentMail

A cross-platform desktop Gmail client for **Windows** and **macOS**. LatentMail uses the Gmail REST API, stores a local cache for fast mail navigation, and keeps sync, persistence, and network work in Rust.

The interface uses **React 19**, **TypeScript**, and **Tauri 2**. The project is in active development.

## Contents

- [How it works](#how-it-works)
- [Features](#features)
- [Security](#security)
- [Stack](#stack)
- [Requirements](#requirements)
- [Setup](#setup)
- [Quick start](#quick-start)
- [Scripts](#scripts)
- [Releases](#releases)
- [Project layout](#project-layout)
- [Contributing](#contributing)

## How it works

LatentMail separates the user interface from application work:

| Layer              | Responsibility                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| **Rust and Tauri** | Gmail access, OAuth, local storage, sync, queues, sanitization, attachments, settings, notifications, and updates |
| **React**          | Mail layout, interaction state, compose UI, search controls, settings screens, and keyboard interaction           |
| **SQLite**         | Local Gmail cache, search index, settings, drafts, queue state, and sync checkpoints                              |

The application reads mail from the local SQLite cache. A background sync engine fetches changes from Gmail and updates the cache. Rust events invalidate the relevant React queries when new data arrives.

## Features

- **Multiple Gmail accounts** — add accounts through Google OAuth and switch between them
- **Inbox and mailbox navigation** — Inbox, Starred, Sent, Drafts, Trash, Spam, and custom labels
- **Conversation view** — read complete threads with sender identities, quoted content, and sanitized HTML
- **Fast local search** — search cached mail with Gmail-style keywords, date filters, sender filters, and scope controls
- **Message actions** — mark read or unread, star, archive, move, delete, restore, and apply labels
- **Custom labels** — create, rename, recolor, delete, and apply labels to threads
- **Compose** — new messages, replies, reply all, forwards, drafts, Cc, Bcc, rich text, and autosave
- **Attachments** — upload files, view supported attachments, save files, and use an on-disk byte cache
- **Image controls** — block remote images by default and allow trusted senders through settings
- **Sync queue** — visible per-account sync lanes, pause and resume controls, retries, and durable operations
- **Desktop integration** — Windows tray state, macOS Dock badge, desktop notifications, `mailto:` links, and single-instance launch handling
- **Layouts and themes** — three-column, bottom-preview, and list-only layouts with light, dark, and system themes
- **Keyboard-first controls** — inspect and change shortcuts in Settings
- **In-app updates** — check GitHub Releases and install signed updates from Settings

## Security

- Google OAuth uses PKCE with refresh tokens stored in the operating system keychain.
- Email HTML is sanitized in Rust and sanitized again before React renders it.
- Message bodies render in sandboxed iframes without script permission.
- Remote images are blocked or replaced unless the user allows them.
- Gmail responses and attachment downloads have client-side size limits.
- OAuth client secrets stay in the ignored `src-tauri/secrets.json` file during local development.

## Stack

| Area                   | Technologies                                           |
| ---------------------- | ------------------------------------------------------ |
| Desktop shell          | Tauri 2, Rust 2021                                     |
| UI                     | React 19, TypeScript, Vite 8, Zustand, Tailwind CSS v4 |
| Data fetching          | TanStack Query                                         |
| Local storage          | SQLite through `rusqlite` and Refinery migrations      |
| Gmail access           | Gmail REST API, OAuth 2.0, `reqwest`                   |
| Compose editor         | Tiptap                                                 |
| Documents and previews | Mammoth and pdf.js                                     |
| Tests                  | Vitest, Rust integration tests, Playwright             |
| Updates                | Tauri updater with GitHub Releases                     |

## Requirements

| Tool                                                             | Notes                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------- |
| [Node.js](https://nodejs.org/)                                   | Node.js 24 is used by CI                              |
| [pnpm](https://pnpm.io/)                                         | The package manager; the repository pins pnpm 10.12.1 |
| [Rust](https://www.rust-lang.org/tools/install)                  | Stable toolchain, Rust 1.85 or newer                  |
| [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) | Platform build tools and WebView dependencies         |
| [cargo-nextest](https://nexte.st/)                               | Required for Rust test scripts                        |
| cargo-llvm-cov                                                   | Required for Rust coverage                            |
| Chromium                                                         | Required for Playwright tests                         |

Release builds target **Windows x64** and **macOS Apple Silicon**. The macOS deployment floor is **macOS 15.0**.

## Setup

1. Install Node.js, pnpm, Rust, and the Tauri prerequisites for your platform.
2. Clone the repository and enter its directory.

   ```bash
   git clone https://github.com/omega123456/LatentMail.git
   cd LatentMail
   ```

3. Install JavaScript dependencies.

   ```bash
   pnpm install
   ```

4. Create the local Google OAuth configuration.

   ```bash
   node scripts/create-secrets.mjs
   ```

   Add the Google OAuth client ID and client secret to `src-tauri/secrets.json`. The file is ignored by Git.

5. Install Chromium if you will run browser tests.

   ```bash
   pnpm exec playwright install chromium
   ```

6. Install the Rust test tools if you will run the full test suite.

   ```bash
   cargo install cargo-nextest
   rustup component add llvm-tools-preview
   cargo install cargo-llvm-cov
   ```

## Quick start

Run the development application from the repository root:

```bash
pnpm dev
```

The development build uses a separate bundle identifier and separate app data. Use `pnpm dev` from the repository root so that the development configuration is applied.

## Scripts

| Command                   | Purpose                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `pnpm dev`                | Run the Tauri application in development                        |
| `pnpm build`              | Type-check, build the frontend, and build the Tauri application |
| `pnpm test`               | Run Vitest once                                                 |
| `pnpm test:coverage`      | Run Vitest with coverage thresholds                             |
| `pnpm test:rust`          | Run Rust integration tests with cargo-nextest                   |
| `pnpm test:rust:coverage` | Run Rust tests with cargo-llvm-cov                              |
| `pnpm test:e2e`           | Run Playwright end-to-end and visual tests                      |
| `pnpm test:all`           | Run frontend coverage, Rust coverage, and Playwright tests      |
| `pnpm lint`               | Run ESLint                                                      |
| `pnpm format`             | Check formatting with Prettier                                  |
| `pnpm format:write`       | Format files with Prettier                                      |
| `pnpm typecheck`          | Run TypeScript type checking                                    |
| `pnpm clippy`             | Run Rust Clippy with warnings treated as errors                 |

## Releases

GitHub Actions publishes releases when you push a tag that matches `v*` or run the Release workflow manually.

| Platform            | Release assets          | Updates                                             |
| ------------------- | ----------------------- | --------------------------------------------------- |
| Windows x64         | MSI and NSIS installers | Signed updater artifact; passive install mode       |
| macOS Apple Silicon | DMG and app bundle      | Signed updater artifact; self-signed macOS identity |

The updater reads `latest.json` from GitHub Releases. LatentMail checks for updates from Rust, downloads the update, and restarts after installation when required.

The macOS release is signed but not notarized. A first launch on another Mac can show a Gatekeeper prompt.

## Project layout

```text
src/                  React UI, stores, queries, IPC types, and tests
src-tauri/src/        Rust application logic and Tauri commands
src-tauri/migrations/ SQLite migrations
src-tauri/tests/      Rust integration tests
e2e/                  Playwright end-to-end and screenshot tests
scripts/              Local development and coverage helpers
.github/workflows/    CI, release, and release cleanup workflows
```

## Contributing

Before you open a pull request, run the checks that match your change:

```bash
pnpm lint
pnpm format
pnpm typecheck
pnpm test:coverage
pnpm test:rust:coverage
pnpm test:e2e
```

Keep changes compatible with Windows and macOS. Use the shared IPC test harness for Tauri commands and update Playwright fixtures when the UI adds a new command.
