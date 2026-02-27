# LatentMail

A cross-platform desktop email client built with Electron 40 and Angular 21, featuring Gmail integration via IMAP/OAuth2 and local AI through Ollama.

## Prerequisites

- **Node.js** 20+ (tested with v24)
- **Yarn** 1.x (`npm install -g yarn`)
- **Google OAuth2 Client ID** — Create a "Desktop" type client in [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
- **Ollama** (optional) — For AI features, install from [ollama.com](https://ollama.com)

## Setup

```bash
# Install dependencies
yarn install

# Optional: copy .env.example to .env for local dev overrides (e.g. LOG_LEVEL, DATABASE_PATH)
# OAuth uses a built-in Desktop client ID; no .env required for packaged or dev runs.

# Optional: rebuild native modules if you add any
# npx @electron/rebuild
```

## Development

```bash
# Start Angular dev server (browser only, no Electron)
yarn start
# Open http://localhost:4200

# Build and run in Electron (dev mode)
yarn electron:dev

# Build Angular + Electron and run
yarn electron:start
```

## Build Scripts

| Command | Description |
|---------|-------------|
| `yarn start` | Start Angular dev server at localhost:4200 |
| `yarn build` | Build Angular app (development) |
| `yarn build:prod` | Build Angular app (production) |
| `yarn build:electron` | Compile Electron main process TypeScript |
| `yarn build:all` | Build both Angular (prod) and Electron |
| `yarn electron:dev` | Build Electron + run in dev mode (loads localhost:4200) |
| `yarn electron:start` | Build everything + run packaged Electron app |
| `yarn package` | Package app with Electron Forge |
| `yarn make` | Create distributable installer |

## Project Structure

```
latentmail/
├── electron/               # Electron main process
│   ├── main.ts            # App entry point, window management
│   ├── preload.ts         # Context bridge (IPC API)
│   ├── ipc/               # IPC handler modules
│   ├── services/          # Backend services (DB, credentials, etc.)
│   ├── database/          # SQLite schema and Umzug migrations (migrations/)
│   └── utils/             # Platform utilities
├── src/                   # Angular renderer process
│   ├── app/
│   │   ├── core/          # Services, guards, models
│   │   ├── features/      # Feature modules (mail, auth, settings, etc.)
│   │   ├── shared/        # Shared components, directives, pipes
│   │   └── store/         # NgRx SignalStores
│   ├── environments/      # Environment configs
│   └── styles.scss        # Global styles, themes, design tokens
├── assets/                # Icons, images, sounds
├── forge.config.ts        # Electron Forge config
├── tsconfig.electron.json # Electron TypeScript config
└── angular.json           # Angular workspace config
```

## Technology Stack

- **Shell**: Electron 40+
- **Frontend**: Angular 21+ (standalone components, signals)
- **UI**: Angular Material + custom SCSS
- **State**: NgRx SignalStore
- **Database**: SQLite via sql.js (WASM, in-memory with persist to disk); schema managed by Umzug migrations in `electron/database/migrations/`
- **Logging**: electron-log
- **Credentials**: Electron safeStorage API (DPAPI/Keychain)
- **Build**: Electron Forge

## Environment Variables

The app uses a **built-in Desktop OAuth client ID** when no custom credentials are set. You can put your own client ID (and client secret) in `electron/secrets.ts` — see `electron/secrets.example.ts` for the template; `yarn install` creates `secrets.ts` from it if missing. For local development you can also override the client ID via `GOOGLE_CLIENT_ID` in the environment or a `.env` file; see [.env.example](.env.example). If you already have an existing `electron/secrets.ts` with only the secret, add `export const GOOGLE_CLIENT_ID = '';` (or your client ID) so the file exports both.

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_ID` | No | Optional override for OAuth (default: value from `electron/secrets.ts`, or built-in Desktop client ID) |
| `DATABASE_PATH` | No | Custom SQLite database path (dev override) |
| `LOG_LEVEL` | No | Log level: debug/info/warn/error (dev override) |

Ollama URL and sync interval are **app settings** (stored in the database and configurable in the UI), not main-process environment variables.

## Native Drag-and-Drop (Windows)

This project includes an optional native C++ NAPI addon that restores OS file drag-and-drop on Windows (fixes a Chromium regression introduced in later Chromium/Electron versions).

Overview:

- On Windows we use a small native addon located at `native/win32-drop-target/`.
- It revokes Chromium's OLE drop target and accepts OS file drops, forwarding file paths/content to the Electron main process which then sends IPC push events to the renderer.

Building and running (development):

1. Install prerequisites on Windows:
   - Visual Studio Build Tools with "Desktop development with C++" workload
   - Python 3.x (required by node-gyp)

2. Build the native addon (Windows only):

```bash
yarn build:native
```

3. Run in development:

```bash
yarn electron:dev
# The app will load the .node binary from native/win32-drop-target/build/Release/
```

macOS / Linux:

- No native addon is required — OS drag-and-drop works natively via Chromium on macOS and Linux. `yarn build:native` is a no-op on those platforms and `NativeDropService` skips initialization.

Packaging for production (Windows):

```bash
# Build the native addon first (Windows CI or dev machine)
yarn build:native
# Then package
yarn package
```

Notes:

- If the addon is not built or fails to load, the app runs normally; OS explorer drops on Windows will not work (same as current Chromium behavior). A warning is logged.
- Rebuild the addon when upgrading Electron (must match Electron ABI) or after modifying any C++ source.
